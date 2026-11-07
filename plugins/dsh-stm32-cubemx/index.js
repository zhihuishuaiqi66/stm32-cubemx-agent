/**
 * STM32CubeMX automation plugin for DeepSeek Harness.
 *
 * Wraps the official CubeMX command-line script mode (`-q script.txt`) so agents
 * can load .ioc projects, configure pins/peripherals, and generate HAL projects
 * without opening the GUI. Every mutation is transactional: CubeMX edits a copy,
 * the copy is reloaded and read back for verification, and only then is the
 * original .ioc replaced (with a timestamped backup).
 *
 * The plugin has no runtime imports: bare package imports would resolve from
 * this package's own location, which is not the Harness installation.
 *
 * @module @local/dsh-stm32-cubemx
 */

import { spawn } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"

/** Cordis plugin name used by loader diagnostics. */
export const name = "stm32-cubemx"

/** Services required by this plugin. */
export const inject = ["tools"]

const LOG_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} \[/u
const NOISE_LINE = /^(log4j |Configure log4j |\d+ : Invalid condition id|WARNING:|[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} [AP]M )/u
const MAX_SCRIPT_COMMANDS = 60

const DEFAULT_CONFIG = {
  mxHome: "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX",
  javaPath: "",
  allowedRoots: [],
  // true = 不限制写入路径（全局可用）；false = 只能写 allowedRoots 内的路径。
  allowAnyPath: false,
  // true = CubeMX GUI 正在运行时也允许写入（GUI 保存时可能把 CLI 的改动覆盖掉）。
  allowGuiRunning: false,
  timeoutMs: 300000,
  maxLogChars: 4000,
  // true = refuse .ioc files whose CubeMX/firmware version differs from this
  // install (the CLI would pop a migration dialog in the GUI and hang instead).
  checkProjectVersion: true,
}

/**
 * Per-family preset used by stm32_cubemx_new_project: SYS/RCC defaults plus the
 * clock-tree commands that reach each family's maximum HCLK. F1 is verified;
 * F4 is attempted with best-effort commands and reported step by step.
 */
const FAMILY_PRESETS = {
  F1: {
    hclk: 72000000,
    clock: [
      "set mode SYS Serial_Wire",
      "set mode SYS SysTick",
      "set mode RCC HSE-External-Oscillator",
      "clock set PLLSource 1",
      "clock set PLLMUL 9",
      "clock set SysClkSource 2",
      "clock set APB1CLKDivider 2",
      "clock set APB2CLKDivider 1",
      // F1 ADC max is 14 MHz: 72 MHz / 6 = 12 MHz (ADCPresc 2 would give 36 MHz).
      "clock set ADCPresc 6",
    ],
  },
  F4: {
    hclk: 168000000,
    clock: [
      "set mode SYS Serial_Wire",
      "set mode SYS SysTick",
      "set mode RCC HSE-External-Oscillator",
      "clock set PLLSource 1",
      "clock set PLLM 8",
      "clock set PLLN 336",
      "clock set PLLP 2",
      "clock set PLLQ 7",
      "clock set SysClkSource 2",
      "clock set APB1CLKDivider 4",
      "clock set APB2CLKDivider 2",
      // F4's CLI does not accept "clock set ADCPresc"; the ADC prescaler stays at its
      // CubeMX default (168/2 = 84 MHz is only a problem once ADC is enabled — pass
      // explicit clock parameters or fix it in the GUI then).
    ],
  },
}

const PULL_ALIASES = new Map([
  ["GPIO_PULLUP", "GPIO_PULLUP"], ["PULLUP", "GPIO_PULLUP"], ["PULL-UP", "GPIO_PULLUP"], ["UP", "GPIO_PULLUP"],
  ["GPIO_PULLDOWN", "GPIO_PULLDOWN"], ["PULLDOWN", "GPIO_PULLDOWN"], ["PULL-DOWN", "GPIO_PULLDOWN"], ["DOWN", "GPIO_PULLDOWN"],
  ["GPIO_NOPULL", "GPIO_NOPULL"], ["NOPULL", "GPIO_NOPULL"], ["NONE", "GPIO_NOPULL"], ["FLOAT", "GPIO_NOPULL"],
])

function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!Array.isArray(config.allowedRoots)) throw new Error("config.allowedRoots must be an array of absolute paths")
  if (typeof config.allowAnyPath !== "boolean") throw new Error("config.allowAnyPath must be true or false")
  if (typeof config.allowGuiRunning !== "boolean") throw new Error("config.allowGuiRunning must be true or false")
  if (typeof config.timeoutMs !== "number" || config.timeoutMs < 30000) throw new Error("config.timeoutMs must be a number >= 30000")
  if (typeof config.maxLogChars !== "number" || config.maxLogChars < 200) throw new Error("config.maxLogChars must be a number >= 200")
  if (typeof config.checkProjectVersion !== "boolean") throw new Error("config.checkProjectVersion must be true or false")
  return config
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizePath(path) {
  return resolve(path).replace(/\//g, "\\").replace(/\\+$/u, "")
}

/** Refuse CubeMX2 .ioc2 projects and non-.ioc files with a clear message. */
function assertIocFile(path) {
  const ext = extname(path).toLowerCase()
  if (ext === ".ioc2") {
    throw new Error(`${path} is a CubeMX2 .ioc2 project; this plugin supports classic .ioc only. Open it in STM32CubeMX2 (its CLI is not wired into this plugin yet).`)
  }
  if (ext !== ".ioc") throw new Error(`not a .ioc file: ${path}`)
}

/**
 * Quote a path (or name) for a CubeMX script line. CubeMX splits script arguments
 * on spaces: an unquoted `config load D:\My Project\x.ioc` becomes `D:\My` plus
 * leftovers, and instead of failing CubeMX falls back to opening its GUI, where a
 * modal "doesn't exist" dialog blocks the call until the timeout kills it.
 */
function q(value) {
  const text = String(value)
  if (text.includes('"')) throw new Error(`path/name must not contain a double quote: ${text}`)
  return `"${text}"`
}

/** "6.15.0-RC4" / "6.17.0" -> "6.15" / "6.17" (major.minor is what CubeMX compares). */
function majorMinor(version) {
  const match = /(\d+)\.(\d+)/u.exec(String(version))
  return match === null ? String(version) : `${match[1]}.${match[2]}`
}

/** Installed CubeMX version, read from the per-user install record; undefined if unknown. */
async function installedCubeMxVersion() {
  const text = await readFile(join(homedir(), ".stm32cubemx", "mxinstallversion.txt"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const match = /(\d+\.\d+\.\d+)/u.exec(text)
  return match === null ? undefined : match[1]
}

/** "STM32Cube FW_F1 V1.8.7" -> "STM32Cube_FW_F1_V1.8.7" (the Repository folder name). */
function firmwareFolderName(firmware) {
  const match = /^STM32Cube\s+(.+)$/u.exec(String(firmware ?? "").trim())
  if (match === null) return undefined
  return `STM32Cube_${match[1].trim().replace(/\s+/gu, "_")}`
}

/**
 * Pre-flight guard for cross-version .ioc files. CubeMX CLI loads a project that
 * was made by another CubeMX/firmware version by opening the GUI and waiting for a
 * human to answer a migration dialog, so the call would hang until the timeout.
 * Refuse such projects up front with an actionable message instead.
 */
async function assertProjectCompatible(iocPath, config) {
  if (config.checkProjectVersion === false) return
  const text = await readFile(iocPath, "utf8").catch(() => undefined)
  if (text === undefined) return
  const read = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, "mu").exec(text)
    return match === null ? undefined : match[1].trim()
  }
  const projectVersion = read("MxCube.Version")
  const firmware = read("ProjectManager.FirmwarePackage")
  const installedVersion = await installedCubeMxVersion()
  const problems = []
  if (projectVersion !== undefined && installedVersion !== undefined && majorMinor(projectVersion) !== majorMinor(installedVersion)) {
    problems.push(`the project was created with STM32CubeMX ${projectVersion}, this machine runs ${installedVersion}`)
  }
  if (firmware !== undefined) {
    const folder = firmwareFolderName(firmware)
    if (folder !== undefined && !(await pathExists(join(homedir(), "STM32Cube", "Repository", folder)))) {
      problems.push(`the project needs firmware package "${firmware}" (${folder}), which is not installed under %USERPROFILE%\\STM32Cube\\Repository`)
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `${iocPath}: ${problems.join("; ")}. Loading it through the CubeMX CLI would pop a migration dialog in the CubeMX GUI and block until the timeout. ` +
    `Open the project once in the STM32CubeMX GUI and save it (migrate), or set config checkProjectVersion=false to skip this guard.`,
  )
}

/** Log tail size: compact by default, full with verbose. */
function logTailFor(config, args, lines) {
  const limit = args.verbose === true ? config.maxLogChars : Math.min(config.maxLogChars, 1200)
  return tailOf(lines, limit)
}

/** Run one PowerShell command and return its trimmed stdout (empty string on failure). */
async function runPowerShell(script, timeoutMs = 20000) {
  return await new Promise((done) => {
    const chunks = []
    let settled = false
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      done("")
    }, timeoutMs)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(value)
    }
    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.on("error", () => finish(""))
    child.on("close", () => finish(Buffer.concat(chunks).toString("utf8").trim()))
  })
}

/** Detect a running CubeMX GUI: any process whose command line names STM32CubeMX. */
async function cubeMxGuiRunning() {
  if (process.platform !== "win32") return undefined
  // Match the GUI window title, never the command line: the detection query itself
  // contains the string "STM32CubeMX", so a command-line match also matches its own
  // transient PowerShell process (a guaranteed false positive).
  const output = await runPowerShell(
    "Get-Process | Where-Object { $_.MainWindowTitle -like 'STM32CubeMX*' } | Select-Object -First 1 -ExpandProperty Id",
  )
  if (output.length === 0 || !/^\d+/u.test(output)) return undefined
  return Number.parseInt(output, 10)
}

/** Refuse writes while a GUI session could overwrite them, unless explicitly allowed. */
async function assertNoGui(config) {
  if (config.allowGuiRunning === true) return
  const pid = await cubeMxGuiRunning()
  if (pid !== undefined) {
    throw new Error(
      `STM32CubeMX GUI is running (PID ${pid}); saving there can overwrite the .ioc this plugin writes. Close the GUI first, or set allowGuiRunning: true in the plugin config.`,
    )
  }
}

/** Decode CubeMX output: Java prints to the platform console encoding (GBK on Chinese Windows), not UTF-8. */
function decodeOutput(buffer) {
  if (process.platform === "win32") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    } catch {
      try {
        return new TextDecoder("gbk").decode(buffer)
      } catch {
        return buffer.toString("utf8")
      }
    }
  }
  return buffer.toString("utf8")
}

/** Reject writes outside the configured allow-list, unless allowAnyPath is enabled. */
function assertWritable(path, config) {
  if (config.allowAnyPath === true) return
  const target = normalizePath(path).toLowerCase()
  if (config.allowedRoots.length === 0) throw new Error("allowedRoots is empty: configure at least one project root, or set allowAnyPath: true")
  for (const root of config.allowedRoots) {
    const base = normalizePath(root).toLowerCase()
    if (target === base || target.startsWith(base + "\\")) return
  }
  throw new Error(`path is outside allowedRoots: ${path} (set allowAnyPath: true to allow writes anywhere)`)
}

/** Resolve the CubeMX executable and its bundled java, then read the JVM arguments from its l4j.ini. */
async function resolveToolchain(config) {
  const mxHome = String(config.mxHome).trim()
  if (mxHome.length === 0) throw new Error("mxHome is empty")
  const mxExe = join(mxHome, "STM32CubeMX.exe")
  if (!(await pathExists(mxExe))) throw new Error(`STM32CubeMX.exe not found under mxHome: ${mxExe}`)

  let java = String(config.javaPath).trim()
  if (java.length === 0) {
    java = join(mxHome, "jre", "bin", "java.exe")
    if (!(await pathExists(java))) java = "java"
  }

  const jvmArgs = []
  const iniPath = join(mxHome, "STM32CubeMX.l4j.ini")
  if (await pathExists(iniPath)) {
    const text = await readFile(iniPath, "utf8")
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith("#")) continue
      for (const token of line.split(/\s+/u)) {
        if (token.length > 1 && token.startsWith('"') && token.endsWith('"')) jvmArgs.push(token.slice(1, -1))
        else jvmArgs.push(token)
      }
    }
  }
  return { mxExe, java, jvmArgs }
}

function filterLog(raw) {
  const lines = []
  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, "")
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (LOG_LINE.test(trimmed) || NOISE_LINE.test(trimmed)) continue
    lines.push(line)
  }
  return lines
}

/** Write commands to a BOM-free UTF-8 script, run `CubeMX -q script`, and return the filtered output. */
async function runCubeMx(config, commands, exec) {
  if (commands.length === 0) throw new Error("empty command list")
  const { mxExe, java, jvmArgs } = await resolveToolchain(config)
  const workDir = await mkdtemp(join(tmpdir(), "dsh-cubemx-"))
  try {
    const scriptPath = join(workDir, "script.txt")
    // UTF-8 without BOM: a BOM turns the first command into "?config load ...".
    await writeFile(scriptPath, commands.join("\r\n"), "utf8")
    const args = [...jvmArgs, "-jar", mxExe, "-q", scriptPath]
    const output = await new Promise((done, fail) => {
      const child = spawn(java, args, { cwd: workDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      const chunks = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill("SIGKILL")
        const raw = decodeOutput(Buffer.concat(chunks))
        // CubeMX blocks forever on an IP it cannot generate; say which one.
        const notReady = /IP not ready for code generation:\s*([A-Za-z0-9_]+)/u.exec(raw)
        const hint = notReady === null
          ? ""
          : `\nhint: CubeMX reported "${notReady[1]} is not ready for code generation" and then blocked (no OK/KO). Open the project in the CubeMX GUI, finish or remove that peripheral, then retry.`
        fail(new Error(`CubeMX did not finish within ${config.timeoutMs} ms${hint}\n--- CubeMX output ---\n${raw}`))
      }, config.timeoutMs)
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const raw = decodeOutput(Buffer.concat(chunks))
        if (error) fail(new Error(`${error.message}\n--- CubeMX output ---\n${raw}`))
        else done(raw)
      }
      child.stdout.on("data", (chunk) => chunks.push(chunk))
      child.stderr.on("data", (chunk) => chunks.push(chunk))
      child.on("error", (error) => finish(error))
      child.on("close", (code) => finish(code === 0 ? undefined : new Error(`CubeMX exited with code ${code}`)))
      const signal = exec?.signal
      if (signal !== undefined) {
        if (signal.aborted) child.kill("SIGKILL")
        else signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true })
      }
    })
    const lines = filterLog(output)
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return { lines }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Split filtered output into one section per command. CubeMX terminates every
 * script command with OK/KO, so the terminator — not the echoed command text,
 * which may be re-encoded by the console — delimits each section.
 */
function splitSections(lines, commands) {
  const expected = commands.filter((command) => command !== "exit")
  const sections = []
  let cursor = 0
  for (const command of expected) {
    const section = { command, result: [] }
    let terminated = false
    while (cursor < lines.length) {
      const text = lines[cursor].trim()
      cursor += 1
      section.result.push(lines[cursor - 1])
      if (text === "OK" || text === "KO") {
        terminated = true
        break
      }
    }
    sections.push(section)
    if (!terminated) break
  }
  return sections
}

function sectionFailure(section) {
  const text = section.result.join("\n").trim()
  if (text.length === 0) return "no output"
  if (/\bKO\b/u.test(text) || /^Usage:/mu.test(text)) return text.split(/\r?\n/u).slice(0, 6).join(" / ")
  if (!section.result.some((line) => line.trim() === "OK")) return text.split(/\r?\n/u).slice(0, 6).join(" / ")
  return undefined
}

/** Last meaningful value in a get section: "PIN: value", quoted GPIO values, or a bare scalar line. */
function lastValue(section) {
  if (section === undefined) return undefined
  for (let index = section.result.length - 1; index >= 0; index -= 1) {
    const line = section.result[index].trim()
    if (line.length === 0 || line === "OK" || line === "KO" || line.startsWith("Usage:")) continue
    const match = /^[^:]+:\s*(.+)$/u.exec(line)
    const value = match === null ? line : match[1].trim()
    const quoted = /="(.*)"$/u.exec(value) ?? /^"(.*)"$/u.exec(value)
    return quoted === null ? value : quoted[1]
  }
  return undefined
}

/** Candidate signals from a `get functions <pin>` section ("PB12" then one signal per line). */
function availableSignals(section, pin) {
  if (section === undefined) return []
  return section.result
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "OK" && line !== "KO" && !line.startsWith("Usage:") && !/^get functions /iu.test(line) && line.toUpperCase() !== String(pin).toUpperCase() && !line.includes(":"))
}

/** Strip echoed command lines and CubeMX's doubled console echo from a section. */
function cleanOutputLines(section, prefixes) {
  if (section === undefined) return []
  const patterns = prefixes.map((prefix) => new RegExp("^" + prefix + "\\b", "i"))
  const result = []
  for (const raw of section.result) {
    const line = raw.trim()
    if (line.length === 0 || line === "OK" || line === "KO") continue
    if (patterns.some((pattern) => pattern.test(line))) continue
    const half = line.length % 2 === 0 ? line.slice(0, line.length / 2) : ""
    const value = half.length > 0 && half === line.slice(line.length / 2) ? half : line
    if (!result.includes(value)) result.push(value)
  }
  return result
}

/** Active mode id from `get mode active <ip>` lines: "Mode: active | TIM3 | PWM Generation3 CH3 | ...". */
function activeMode(section, ip) {
  if (section === undefined) return undefined
  const pattern = new RegExp(`^Mode: active \\| ${ip} \\| ([^|]+?) \\|`, "iu")
  for (const raw of section.result) {
    const match = pattern.exec(raw.trim())
    if (match !== null) return match[1].trim()
  }
  return undefined
}

/** Exact mode ids from `get mode available <ip>` lines: "Mode: available | TIM3 | PWM Generation3 CH3 | ...". */
function modeCandidates(section, ip) {
  if (section === undefined) return []
  const prefix = `Mode: available | ${ip} | `
  return section.result
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).split(" | ")[0].trim())
}

function normalizeMode(value) {
  return String(value).toLowerCase().replace(/\s+/gu, "")
}

function tailOf(lines, maxChars) {
  const text = lines.join("\n").trim()
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

function canonicalPull(value) {
  const key = String(value).trim().toUpperCase()
  const mapped = PULL_ALIASES.get(key)
  if (mapped === undefined) throw new Error(`unsupported pull value "${value}" (use GPIO_PULLUP, GPIO_PULLDOWN or GPIO_NOPULL)`)
  return mapped
}

function describePins(pins) {
  if (pins.length === 0) return "no pin changes"
  return pins
    .map((pin) => `${pin.pin}: ${pin.signal}${pin.label !== undefined ? ` label=${pin.label}` : ""}${pin.pull !== undefined ? ` pull=${pin.pull}` : ""}`)
    .join(", ")
}

async function listTree(root, depth) {
  const entries = []
  async function walk(dir, remaining) {
    if (remaining < 0) return
    let children
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      const full = join(dir, child.name)
      entries.push(full)
      if (child.isDirectory() && remaining > 0) await walk(full, remaining - 1)
    }
  }
  await walk(root, depth)
  return entries
}

function requireArgs(args, fields) {
  for (const field of fields) {
    const value = args[field]
    if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
      throw new Error(`missing required argument: ${field}`)
    }
  }
}

/** Pin/mode changes plus optional project generation, performed in one CubeMX session. */
async function configureProject(config, args, exec) {
  requireArgs(args, ["iocPath"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  if (extname(iocPath).toLowerCase() !== ".ioc") assertIocFile(iocPath)
  await assertProjectCompatible(iocPath, config)

  const pins = Array.isArray(args.pins) ? args.pins : []
  const modes = Array.isArray(args.modes) ? args.modes : []
  if (pins.length === 0 && modes.length === 0) throw new Error("no pins or modes to configure")
  for (const pin of pins) {
    if (!/^[A-Za-z]+\d+$/u.test(pin.pin ?? "")) throw new Error(`invalid pin name: ${pin.pin}`)
    if (typeof pin.signal !== "string" || pin.signal.trim().length === 0) throw new Error(`missing signal for ${pin.pin}`)
    // CubeMX accepts a non-ASCII GPIO_Label with OK but stores an empty label, so reject it up front.
    if (pin.label !== undefined && /[^\x00-\x7F]/u.test(String(pin.label))) {
      throw new Error(`GPIO label for ${pin.pin} must be ASCII: CubeMX drops non-ASCII labels (got "${pin.label}")`)
    }
  }

  const dryRun = args.dryRun === true
  const targetPath = args.saveTo === undefined ? iocPath : resolve(args.saveTo)
  if (!dryRun) assertWritable(targetPath, config)
  if (args.generate !== undefined && !dryRun) assertWritable(args.generate.outputDir, config)
  if (!dryRun) await assertNoGui(config)

  const workDir = await mkdtemp(join(tmpdir(), "dsh-cubemx-work-"))
  // Keep the staged file name identical to the target: CubeMX derives
  // ProjectManager.ProjectFileName/ProjectName from the `config saveas` file name,
  // so staging as "working.ioc" would rename the user's project.
  const workIoc = join(workDir, basename(targetPath))
  try {
    await copyFile(iocPath, workIoc)

    const workIocArg = workIoc
    // Resolve friendly peripheral modes (e.g. "PWM CH1") to CubeMX's exact mode ids.
    const resolvedModes = []
    if (modes.length > 0) {
      const ips = [...new Set(modes.map((mode) => String(mode.ip)))]
      const query = [`config load ${q(workIocArg)}`, ...ips.map((ip) => `get mode available ${ip}`), "exit"]
      const { lines: queryLines } = await runCubeMx(config, query, exec)
      const querySections = splitSections(queryLines, query)
      const modeFailures = []
      for (const mode of modes) {
        if (typeof mode.ip !== "string" || typeof mode.mode !== "string" || mode.ip.trim().length === 0 || mode.mode.trim().length === 0) {
          modeFailures.push("mode entries need non-empty ip and mode strings")
          continue
        }
        const section = querySections.find((candidate) => candidate.command === `get mode available ${mode.ip}`)
        const available = modeCandidates(section, mode.ip)
        const wanted = normalizeMode(mode.mode)
        const wantedTokens = String(mode.mode).trim().toLowerCase().split(/\s+/u).map(normalizeMode).filter((token) => token.length > 0)
        const resolved = available.find((candidate) => normalizeMode(candidate) === wanted)
          ?? available.find((candidate) => wantedTokens.every((token) => normalizeMode(candidate).includes(token)))
          ?? available.find((candidate) => normalizeMode(candidate).includes(wanted))
        if (resolved === undefined) {
          modeFailures.push(`mode "${mode.mode}" is not available for ${mode.ip}; available: ${available.length > 0 ? available.join(" | ") : "(none reported)"}`)
        } else {
          resolvedModes.push({ ip: String(mode.ip), mode: resolved })
        }
      }
      if (modeFailures.length > 0) {
        return {
          ok: false,
          summary: `CubeMX mode configuration failed for ${iocPath}; the original file was not modified.`,
          details: modeFailures.map((failure) => `FAIL ${failure}`),
          logTail: logTailFor(config, args, queryLines),
        }
      }
    }

    const commands = [`config load ${q(workIocArg)}`, "get mcu name", "get mcu package"]
    for (const pin of pins) commands.push(`get functions ${pin.pin}`)
    for (const pin of pins) commands.push(`set pin ${pin.pin} ${pin.signal}`)
    for (const pin of pins) if (pin.label !== undefined) commands.push(`set gpio parameters ${pin.pin} GPIO_Label ${pin.label}`)
    for (const pin of pins) if (pin.pull !== undefined) commands.push(`set gpio parameters ${pin.pin} GPIO_PuPd ${canonicalPull(pin.pull)}`)
    for (const mode of resolvedModes) commands.push(`set mode ${mode.ip} "${mode.mode}"`)
    commands.push(`config saveas ${q(workIocArg)}`, `config load ${q(workIocArg)}`)
    for (const pin of pins) commands.push(`get signal ${pin.pin}`)
    for (const mode of resolvedModes) commands.push(`get mode active ${mode.ip}`)
    for (const pin of pins) if (pin.label !== undefined) commands.push(`get gpio parameters ${pin.pin} GPIO_Label`)
    for (const pin of pins) if (pin.pull !== undefined) commands.push(`get gpio parameters ${pin.pin} GPIO_PuPd`)
    if (args.generate !== undefined) {
      const outputDir = resolve(args.generate.outputDir)
      await mkdir(outputDir, { recursive: true }).catch(() => {})
      commands.push(`project path ${q(outputDir)}`)
      if (args.generate.projectName !== undefined) commands.push(`project name ${q(args.generate.projectName)}`)
      if (args.generate.toolchain !== undefined) commands.push(`project toolchain ${args.generate.toolchain}`)
      commands.push("project generate")
    }
    commands.push("exit")

    const { lines } = await runCubeMx(config, commands, exec)
    const sections = splitSections(lines, commands)
    const logTail = logTailFor(config, args, lines)
    const details = []
    const failures = []

    const mcuName = lastValue(sections.find((section) => section.command === "get mcu name"))
    const mcuPackage = lastValue(sections.find((section) => section.command === "get mcu package"))
    details.push(`MCU: ${mcuName ?? "?"} (${mcuPackage ?? "?"})`)

    // Pre-flight: a signal CubeMX cannot put on this pin fails with a bare KO
    // later, so surface the pin's real candidate list instead.
    for (const pin of pins) {
      const available = availableSignals(sections.find((section) => section.command === `get functions ${pin.pin}`), pin.pin)
      if (available.length === 0) continue
      if (!available.some((signal) => signal.toLowerCase() === pin.signal.trim().toLowerCase())) {
        failures.push(`signal "${pin.signal}" is not available on ${pin.pin}; available: ${available.join(", ")}`)
      } else {
        details.push(`${pin.pin}: available signals checked (${available.length})`)
      }
    }

    const mutations = commands.filter((command) => command.startsWith("set ") || command.startsWith("config saveas"))
    for (const command of mutations) {
      const section = sections.find((candidate) => candidate.command === command)
      if (section === undefined) {
        failures.push(`${command}: not executed (CubeMX echoed no matching command)`)
        continue
      }
      const failure = sectionFailure(section)
      if (failure !== undefined) failures.push(`${command}: ${failure}`)
    }

    for (const pin of pins) {
      const actualSignal = lastValue(sections.find((section) => section.command === `get signal ${pin.pin}`))
      if (actualSignal === undefined) {
        failures.push(`readback failed for ${pin.pin} signal`)
        continue
      }
      details.push(`${pin.pin}: signal -> ${actualSignal}`)
      if (pin.label !== undefined) {
        const actualLabel = lastValue(sections.find((section) => section.command === `get gpio parameters ${pin.pin} GPIO_Label`))
        details.push(`${pin.pin}: label -> ${actualLabel ?? "?"}`)
        if (actualLabel !== pin.label) failures.push(`${pin.pin} label readback ${actualLabel ?? "<missing>"} != ${pin.label}`)
      }
      if (pin.pull !== undefined) {
        const expected = canonicalPull(pin.pull)
        const actualPull = lastValue(sections.find((section) => section.command === `get gpio parameters ${pin.pin} GPIO_PuPd`))
        details.push(`${pin.pin}: pull -> ${actualPull ?? "?"}`)
        if (actualPull !== expected) failures.push(`${pin.pin} pull readback ${actualPull ?? "<missing>"} != ${expected}`)
      }
    }

    for (const mode of resolvedModes) {
      const actualMode = activeMode(sections.find((section) => section.command === `get mode active ${mode.ip}`), mode.ip)
      if (actualMode === undefined) {
        failures.push(`readback failed for ${mode.ip} active mode`)
        continue
      }
      details.push(`${mode.ip}: mode -> ${actualMode}`)
      if (normalizeMode(actualMode) !== normalizeMode(mode.mode)) {
        failures.push(`${mode.ip} mode readback ${actualMode} != ${mode.mode}`)
      }
    }

    if (failures.length > 0) {
      return {
        ok: false,
        summary: `CubeMX configuration failed for ${iocPath}; the original file was not modified.`,
        details: [...failures.map((failure) => `FAIL ${failure}`), ...details],
        logTail,
      }
    }

    if (args.generate !== undefined) {
      const genSection = sections.find((section) => section.command === "project generate")
      const genFailure = genSection === undefined ? "not executed" : sectionFailure(genSection)
      if (genFailure !== undefined) {
        return {
          ok: false,
          summary: "pin configuration verified, but project generation failed; the original .ioc was not modified.",
          details: [`FAIL project generate: ${genFailure}`, ...details],
          logTail,
        }
      }
      const outputDir = resolve(args.generate.outputDir)
      const generated = await listTree(outputDir, 2)
      details.push(`generated: ${outputDir} (${generated.length} entries)`)
    }

    if (dryRun) {
      return {
        ok: true,
        summary: `Dry run OK: ${describePins(pins)}${modes.length > 0 ? `; modes ${modes.map((mode) => `${mode.ip}=${mode.mode}`).join(", ")}` : ""}. Nothing was written.`,
        details,
        logTail,
      }
    }

    await mkdir(dirname(targetPath), { recursive: true }).catch(() => {})
    await normalizeStagedProjectName(workIoc, targetPath)
    const backupPath = `${targetPath}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`
    const tempTarget = `${targetPath}.tmp-${process.pid}`
    const hadTarget = await pathExists(targetPath)
    await copyFile(workIoc, tempTarget)
    if (hadTarget) await copyFile(targetPath, backupPath)
    await rename(tempTarget, targetPath)

    details.push(hadTarget ? `backup: ${backupPath}` : `new file: ${targetPath}`)
    return {
      ok: true,
      summary: `Configured ${describePins(pins)}${modes.length > 0 ? `; modes ${modes.map((mode) => `${mode.ip}=${mode.mode}`).join(", ")}` : ""}. Verified by reload+readback and written to ${targetPath}.`,
      details,
      logTail,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function inspectProject(config, args, exec) {
  requireArgs(args, ["iocPath"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  const requested = Array.isArray(args.pins) ? args.pins.map((pin) => String(pin).toUpperCase()) : []
  await assertProjectCompatible(iocPath, config)
  const commands = [`config load ${q(iocPath)}`, "get mcu name", "get mcu package", "get pinout"]
  for (const pin of requested.slice(0, 32)) commands.push(`get functions ${pin}`)
  commands.push("exit")
  const { lines } = await runCubeMx(config, commands, exec)
  const sections = splitSections(lines, commands)
  const read = (command) => sections.find((section) => section.command === command)
  const mcu = read("get mcu name")
  if (mcu === undefined) throw new Error(`CubeMX did not load ${iocPath}: ${logTailFor(config, args, lines)}`)

  const pins = []
  for (const raw of read("get pinout")?.result ?? []) {
    let line = raw.trim()
    if (line.length === 0 || !line.includes(":")) continue
    if (line.length % 2 === 0 && line.slice(0, line.length / 2) === line.slice(line.length / 2)) line = line.slice(0, line.length / 2)
    const match = /^([^:]+):\s*(.+)$/u.exec(line)
    if (match === null) continue
    pins.push({ pin: match[1].trim(), signal: match[2].trim() })
  }
  const byPin = new Map(pins.map((pin) => [pin.pin.toUpperCase(), pin]))

  const optionalFunctions = (pin) => availableSignals(read(`get functions ${pin}`), pin)

  const details = [`MCU: ${lastValue(mcu) ?? "?"} (${lastValue(read("get mcu package")) ?? "?"})`]
  if (requested.length === 0) {
    const assigned = pins.filter((pin) => pin.signal !== "Reset_State")
    details.push(...assigned.map((pin) => `${pin.pin}: ${pin.signal}`))
    details.push(`pins: ${pins.length} in package, ${assigned.length} assigned`)
  } else {
    for (const pin of requested) {
      const current = byPin.get(pin)
      if (current === undefined) {
        details.push(`${pin}: not present in this package`)
        continue
      }
      const functions = optionalFunctions(pin)
      const now = current.signal === "Reset_State" ? "unassigned" : current.signal
      details.push(`${pin}: current=${now} | available: ${functions.length > 0 ? functions.join(", ") : "(none reported)"}`)
    }
  }
  return {
    ok: true,
    summary: `Loaded ${iocPath} without changing it.`,
    details,
    logTail: "",
  }
}

async function generateProject(config, args, exec) {
  requireArgs(args, ["iocPath", "outputDir", "projectName", "toolchain"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  const outputDir = resolve(args.outputDir)
  assertWritable(outputDir, config)
  await assertNoGui(config)
  await assertProjectCompatible(iocPath, config)
  await mkdir(outputDir, { recursive: true }).catch(() => {})
  const commands = [`config load ${q(iocPath)}`, `project path ${q(outputDir)}`, `project name ${q(args.projectName)}`, `project toolchain ${args.toolchain}`, "project generate", "exit"]
  const { lines } = await runCubeMx(config, commands, exec)
  const sections = splitSections(lines, commands)
  const generation = sections.find((section) => section.command === "project generate")
  const failure = generation === undefined ? "not executed" : sectionFailure(generation)
  if (failure !== undefined) {
    return { ok: false, summary: `Generation failed for ${iocPath}.`, details: [`FAIL project generate: ${failure}`], logTail: logTailFor(config, args, lines) }
  }
  const files = await listTree(outputDir, 2)
  return {
    ok: true,
    summary: `Generated HAL project into ${outputDir} (${files.length} files/dirs).`,
    details: files.slice(0, 60),
    logTail: logTailFor(config, args, lines),
  }
}

async function runRawScript(config, args, exec) {
  if (!Array.isArray(args.commands) || args.commands.length === 0 || args.commands.length > MAX_SCRIPT_COMMANDS) {
    throw new Error(`commands must be an array of 1..${MAX_SCRIPT_COMMANDS} lines`)
  }
  const commands = args.commands.map((command) => String(command))
  const { lines } = await runCubeMx(config, commands, exec)
  return {
    ok: !lines.some((line) => line.trim() === "KO"),
    summary: `Ran ${commands.length} CubeMX script command(s).`,
    details: [],
    logTail: logTailFor(config, args, lines),
  }
}

/** Preset for one MCU name such as STM32F103C8Tx -> F1. */
function familyPreset(mcu) {
  const match = /STM32([A-Z])(\d)/iu.exec(String(mcu).toUpperCase())
  if (match === null) return undefined
  return FAMILY_PRESETS[`${match[1]}${match[2]}`]
}

/**
 * F4 boards differ in crystal (8/16/25 MHz); the preset's PLLM must be the HSE in
 * MHz so that VCO=336 MHz and SYSCLK=168 MHz whatever the crystal is.
 */
function presetWithHse(preset, hseHz) {
  if (preset === undefined || !(hseHz > 0)) return preset
  const mhz = Math.round(hseHz / 1_000_000)
  if (!(mhz >= 4 && mhz <= 26)) return preset
  return { ...preset, clock: preset.clock.map((command) => (/^clock set PLLM \d+$/u.test(command) ? `clock set PLLM ${mhz}` : command)) }
}

/**
 * Clock intent -> CubeMX `clock set` command list. Supports the family max preset and
 * an arbitrary HCLK (solved for F1/F4; explicit PLL/APB knobs win over the solver).
 */
function clockIntentPlan(intent, iocText) {
  const mcu = /^ProjectManager\.DeviceId=(\S+)/mu.exec(iocText)?.[1]
  const family = mcu === undefined ? undefined : familyKey(mcu)
  if (family !== "F1" && family !== "F4") return { error: `clock fine-tuning is only implemented for F1/F4 (this project is ${family ?? "unknown"})` }
  const hse = Number(/^RCC\.HSE_VALUE=(\d+)/mu.exec(iocText)?.[1] ?? (family === "F4" ? 25_000_000 : 8_000_000))
  const params = intent.params ?? {}
  const preset = family === "F4" ? presetWithHse(FAMILY_PRESETS.F4, hse) : FAMILY_PRESETS.F1
  if (params.max === true || params.hclk === undefined) {
    return { commands: [...preset.clock], expectedHclk: preset.hclk }
  }
  const target = Number(params.hclk)
  if (!(target > 0)) return { error: `invalid clock target "${params.hclk}"` }
  const commands = ["set mode SYS Serial_Wire", "set mode SYS SysTick", "set mode RCC HSE-External-Oscillator", "clock set PLLSource 1"]
  if (family === "F1") {
    const pllMul = params.pllMul === undefined ? Math.round(target / hse) : Number(params.pllMul)
    if (!(pllMul >= 2 && pllMul <= 16) || Math.abs(pllMul * hse - target) > hse / 2) {
      return { error: `F1 cannot reach ${target} Hz from a ${hse} Hz HSE with one PLL multiplier (use pllMul=...)` }
    }
    commands.push(`clock set PLLMUL ${pllMul}`)
    const apb1 = params.apb1Div === undefined ? [1, 2, 4, 8, 16].find((div) => pllMul * hse / div <= 36_000_000) : Number(params.apb1Div)
    const apb2 = params.apb2Div === undefined ? [1, 2, 4, 8, 16].find((div) => pllMul * hse / div <= 72_000_000) : Number(params.apb2Div)
    commands.push("clock set SysClkSource 2", `clock set APB1CLKDivider ${apb1}`, `clock set APB2CLKDivider ${apb2}`)
    if (params.adcDiv !== undefined) commands.push(`clock set ADCPresc ${Number(params.adcDiv)}`)
    else commands.push("clock set ADCPresc 6")
    return { commands, expectedHclk: pllMul * hse }
  }
  const pllM = params.pllM === undefined ? Math.round(hse / 1_000_000) : Number(params.pllM)
  const pllP = params.pllP === undefined ? 2 : Number(params.pllP)
  const pllN = params.pllN === undefined ? Math.round(target * pllP * pllM / hse) : Number(params.pllN)
  if (!(pllN >= 50 && pllN <= 432)) return { error: `F4 PLLN=${pllN} outside 50..432; pass pllM/pllN/pllP explicitly` }
  const pllQ = params.pllQ === undefined ? Math.max(2, Math.min(15, Math.round(pllN / 48))) : Number(params.pllQ)
  commands.push(`clock set PLLM ${pllM}`, `clock set PLLN ${pllN}`, `clock set PLLP ${pllP}`, `clock set PLLQ ${pllQ}`)
  const expectedHclk = Math.round(hse / pllM * pllN / pllP)
  const apb1 = params.apb1Div === undefined ? [1, 2, 4, 8, 16].find((div) => expectedHclk / div <= 42_000_000) : Number(params.apb1Div)
  const apb2 = params.apb2Div === undefined ? [1, 2, 4, 8, 16].find((div) => expectedHclk / div <= 84_000_000) : Number(params.apb2Div)
  commands.push("clock set SysClkSource 2", `clock set APB1CLKDivider ${apb1}`, `clock set APB2CLKDivider ${apb2}`)
  return { commands, expectedHclk }
}

/** Normalize "direction=P2M / priority=HIGH" style DMA parameters to CubeMX constants. */
function dmaIntentParams(intent) {
  const result = new Map()
  for (const [rawKey, rawValue] of Object.entries(intent.params ?? {})) {
    if (rawKey === "request") continue
    const key = INTENT_DMA_PARAM_ALIASES.get(String(rawKey).toLowerCase()) ?? String(rawKey)
    const lower = String(rawValue).toLowerCase()
    const value = INTENT_DMA_VALUE_ALIASES.get(lower) ?? String(rawValue)
    result.set(key, value)
  }
  return result
}

/** Create a new .ioc project and generate code, applying the user's house defaults. */
async function newProject(config, args, exec) {
  requireArgs(args, ["mcu", "projectDir", "projectName"])
  const projectDir = resolve(args.projectDir)
  assertWritable(projectDir, config)
  await assertNoGui(config)
  await mkdir(projectDir, { recursive: true }).catch(() => {})

  const toolchain = args.toolchain === undefined ? "CMake" : String(args.toolchain)
  // A brand-new CubeMX F4 project defaults to a 25 MHz HSE; set PLLM accordingly.
  const preset = presetWithHse(familyPreset(args.mcu), 25_000_000)
  const applyDefaults = args.applyDefaults !== false

  const loadCommand = `load ${q(args.mcu)}`
  const commands = [loadCommand, `project name ${q(args.projectName)}`, "SetStructure Advanced", "project couplefilesbyip 1", `project toolchain ${toolchain}`]
  const presetCommands = []
  if (applyDefaults) {
    if (preset !== undefined) presetCommands.push(...preset.clock)
    else presetCommands.push("set mode SYS Serial_Wire", "set mode SYS SysTick", "set mode RCC HSE-External-Oscillator")
  }
  commands.push(...presetCommands, "get ip parameters RCC HCLKFreq_Value", `project path ${q(projectDir)}`, "project generate", "exit")

  const { lines } = await runCubeMx(config, commands, exec)
  const sections = splitSections(lines, commands)
  const logTail = logTailFor(config, args, lines)
  const read = (command) => sections.find((section) => section.command === command)
  const details = []
  const warnings = []
  const failures = []

  const loadSection = read(loadCommand)
  if (loadSection === undefined) failures.push(`${loadCommand}: not executed`)
  else {
    const failure = sectionFailure(loadSection)
    if (failure !== undefined) failures.push(`${loadCommand}: ${failure}`)
  }
  for (const command of presetCommands) {
    const section = read(command)
    if (section === undefined) warnings.push(`${command}: not executed`)
    else {
      const failure = sectionFailure(section)
      if (failure !== undefined) warnings.push(`${command}: ${failure}`)
    }
  }

  const generation = read("project generate")
  const generationFailure = generation === undefined ? "not executed" : sectionFailure(generation)
  const generatedDir = join(projectDir, String(args.projectName))
  if (generationFailure !== undefined || !(await pathExists(generatedDir))) {
    return {
      ok: false,
      summary: `New project generation failed for ${args.mcu}.`,
      details: [
        ...failures.map((failure) => `FAIL ${failure}`),
        `FAIL project generate: ${generationFailure ?? `project directory not found: ${generatedDir}`}`,
        ...warnings.map((warning) => `WARN ${warning}`),
        ...details,
      ],
      logTail,
    }
  }

  const iocName = `${String(args.projectName)}.ioc`
  const iocPath = join(generatedDir, iocName)
  const files = await listTree(generatedDir, 2)
  const clock = lastValue(read("get ip parameters RCC HCLKFreq_Value"))
  details.push(`project: ${generatedDir}`)
  if (await pathExists(iocPath)) details.push(`ioc: ${iocPath}`)
  details.push(`files: ${files.length}`)
  if (clock !== undefined) details.push(`HCLK: ${clock}${preset === undefined ? " (no family preset applied)" : ` (preset target ${preset.hclk})`}`)
  details.push(...warnings.map((warning) => `WARN ${warning}`))
  return {
    ok: failures.length === 0 && generationFailure === undefined,
    summary: `Created ${args.mcu} project ${args.projectName} in ${generatedDir} (${files.length} files/dirs${warnings.length > 0 ? `, ${warnings.length} preset warning(s)` : ""}).`,
    details,
    logTail,
  }
}

/** List or restore timestamped .bak-* files created by configure. */
async function rollbackProject(config, args, exec) {
  requireArgs(args, ["iocPath", "action"])
  const iocPath = resolve(args.iocPath)
  const dir = dirname(iocPath)
  const base = basename(iocPath)
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.bak-`))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  const action = String(args.action)
  if (action === "list") {
    return {
      ok: true,
      summary: `${entries.length} backup(s) for ${base}.`,
      details: entries.slice(0, 20),
      logTail: "",
    }
  }
  if (action !== "restore") throw new Error('action must be "list" or "restore"')
  if (entries.length === 0) throw new Error(`no ${base}.bak-* files next to ${iocPath}`)

  let chosen = entries[0]
  if (args.backup !== undefined) {
    const wanted = String(args.backup)
    chosen = entries.find((entry) => entry === wanted || entry === `${base}.bak-${wanted}`)
    if (chosen === undefined) throw new Error(`backup not found: ${wanted}`)
  }
  assertWritable(iocPath, config)
  await assertNoGui(config)

  const backupPath = join(dir, chosen)
  const safetyPath = `${iocPath}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`
  if (await pathExists(iocPath)) await copyFile(iocPath, safetyPath)
  const temp = `${iocPath}.restore-${process.pid}`
  await copyFile(backupPath, temp)
  await rename(temp, iocPath)
  return {
    ok: true,
    summary: `Restored ${base} from ${chosen}.`,
    details: [
      `source: ${backupPath}`,
      await pathExists(safetyPath) ? `current state saved to: ${safetyPath}` : "no previous file to back up",
    ],
    logTail: "",
  }
}

/**
 * CubeMX derives ProjectManager.ProjectFileName / ProjectName from the `config
 * saveas` file name and splits it on whitespace, so a target like
 * "board name.ioc" would be committed as ProjectName=board. Rewrite those two
 * lines to the real target name before the staged file replaces the original.
 */
async function normalizeStagedProjectName(workIoc, targetPath) {
  const base = basename(targetPath)
  const name = base.replace(/\.ioc$/iu, "")
  const text = await readFile(workIoc, "utf8").catch(() => undefined)
  if (text === undefined) return
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  let changed = false
  const lines = text.split(/\r?\n/u).map((line) => {
    if (line.startsWith("ProjectManager.ProjectFileName=")) {
      changed = true
      return `ProjectManager.ProjectFileName=${base}`
    }
    if (line.startsWith("ProjectManager.ProjectName=")) {
      changed = true
      return `ProjectManager.ProjectName=${name}`
    }
    return line
  })
  if (!changed) return
  await writeFile(workIoc, lines.join(eol), "utf8")
}

/** Copy a verified working .ioc over its target, keeping a timestamped backup. */
async function commitWorkingIoc(workIoc, targetPath, dryRun) {
  if (dryRun) return { backupPath: undefined, newFile: false }
  await normalizeStagedProjectName(workIoc, targetPath)
  await mkdir(dirname(targetPath), { recursive: true }).catch(() => {})
  const backupPath = `${targetPath}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`
  const temp = `${targetPath}.tmp-${process.pid}`
  const hadTarget = await pathExists(targetPath)
  await copyFile(workIoc, temp)
  if (hadTarget) await copyFile(targetPath, backupPath)
  await rename(temp, targetPath)
  return { backupPath: hadTarget ? backupPath : undefined, newFile: !hadTarget }
}

function familyKey(mcu) {
  const match = /STM32([A-Z])(\d)/iu.exec(String(mcu).toUpperCase())
  return match === null ? undefined : `${match[1]}${match[2]}`
}

/** Set the clock tree with semantic arguments or the family's max preset. */
async function clockTool(config, args, exec) {
  requireArgs(args, ["iocPath"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  await assertProjectCompatible(iocPath, config)
  const dryRun = args.dryRun === true
  if (!dryRun) {
    assertWritable(iocPath, config)
    await assertNoGui(config)
  }

  const workDir = await mkdtemp(join(tmpdir(), "dsh-cubemx-clock-"))
  // Staged file name must match the target, or saveas renames the project.
  const workIoc = join(workDir, basename(iocPath))
  try {
    await copyFile(iocPath, workIoc)

    let preset
    let family = args.family === undefined ? undefined : String(args.family).toUpperCase()
    if (args.preset === "max") {
      if (family === undefined) {
        const probe = [`config load ${q(workIoc)}`, "get mcu name", "exit"]
        const { lines } = await runCubeMx(config, probe, exec)
        const name = lastValue(splitSections(lines, probe).find((section) => section.command === "get mcu name"))
        family = familyKey(name ?? "")
      }
      preset = family === undefined ? undefined : FAMILY_PRESETS[family]
      if (preset === undefined) throw new Error(`no max-HCLK preset for family "${family ?? "unknown"}"; pass explicit clock arguments instead`)
      // F4's PLLM has to match the board crystal (8/16/25 MHz); read it from the project.
      if (family === "F4") {
        const text = await readFile(workIoc, "utf8").catch(() => "")
        const match = /^RCC\.HSE_VALUE=(\d+)/mu.exec(text)
        preset = presetWithHse(preset, match === null ? 25_000_000 : Number(match[1]))
      }
    }

    const commands = [`config load ${q(workIoc)}`, "get mcu name", "get mcu package"]
    const sets = []
    if (preset !== undefined) {
      sets.push(...preset.clock)
    } else {
      if (args.hse === true) sets.push("set mode RCC HSE-External-Oscillator")
      if (args.pllSource !== undefined) sets.push(`clock set PLLSource ${/^HSE$/iu.test(String(args.pllSource)) ? 1 : 0}`)
      if (args.pllMul !== undefined) sets.push(`clock set PLLMUL ${Number(args.pllMul)}`)
      if (args.sysclkSource !== undefined) {
        const source = String(args.sysclkSource).toUpperCase()
        const index = source === "PLL" || source === "PLLCLK" ? 2 : source === "HSE" ? 1 : 0
        sets.push(`clock set SysClkSource ${index}`)
      }
      if (args.apb1Div !== undefined) sets.push(`clock set APB1CLKDivider ${Number(args.apb1Div)}`)
      if (args.apb2Div !== undefined) sets.push(`clock set APB2CLKDivider ${Number(args.apb2Div)}`)
      if (args.adcDiv !== undefined) sets.push(`clock set ADCPresc ${Number(args.adcDiv)}`)
      if (sets.length === 0) throw new Error("nothing to set: pass preset \"max\" or at least one of hse/pllMul/sysclkSource/apb1Div/apb2Div/adcDiv")
    }
    commands.push(...sets)
    commands.push(
      "get ip parameters RCC HCLKFreq_Value",
      "get ip parameters RCC SYSCLKFreq_VALUE",
      "get ip parameters RCC APB1Freq_Value",
      "get ip parameters RCC APB2Freq_Value",
      `config saveas ${q(workIoc)}`,
      "exit",
    )

    const { lines } = await runCubeMx(config, commands, exec)
    const sections = splitSections(lines, commands)
    const logTail = logTailFor(config, args, lines)
    const details = []
    const failures = []
    const mcu = lastValue(sections.find((section) => section.command === "get mcu name"))
    details.push(`MCU: ${mcu ?? "?"}`)
    for (const command of sets) {
      const section = sections.find((candidate) => candidate.command === command)
      if (section === undefined) failures.push(`${command}: not executed`)
      else {
        const failure = sectionFailure(section)
        if (failure !== undefined) failures.push(`${command}: ${failure}`)
      }
    }
    const readClock = (command) => lastValue(sections.find((section) => section.command === command))
    const hclk = readClock("get ip parameters RCC HCLKFreq_Value")
    const sysclk = readClock("get ip parameters RCC SYSCLKFreq_VALUE")
    const apb1 = readClock("get ip parameters RCC APB1Freq_Value")
    const apb2 = readClock("get ip parameters RCC APB2Freq_Value")
    details.push(`HCLK: ${hclk ?? "?"}`, `SYSCLK: ${sysclk ?? "?"}`, `APB1: ${apb1 ?? "?"}`, `APB2: ${apb2 ?? "?"}`)
    const expected = preset?.hclk ?? (args.hclk === undefined ? undefined : Number(args.hclk))
    if (expected !== undefined && hclk !== undefined && Number(hclk) !== expected) {
      failures.push(`HCLK readback ${hclk} != expected ${expected}`)
    }
    if (failures.length > 0) {
      return { ok: false, summary: `Clock configuration failed for ${iocPath}; the original file was not modified.`, details: [...failures.map((failure) => `FAIL ${failure}`), ...details], logTail }
    }
    const commit = await commitWorkingIoc(workIoc, iocPath, dryRun)
    if (dryRun) details.push("dry run: nothing written")
    else if (commit.backupPath !== undefined) details.push(`backup: ${commit.backupPath}`)
    return {
      ok: true,
      summary: `Clock tree updated for ${iocPath}${dryRun ? " (dry run)" : ""}.`,
      details,
      logTail,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** CubeMX's NVIC commands take a vector *name* (TIM3_IRQn); a bare number makes it
 * throw a NullPointerException, so pass strings through and keep numbers for legacy. */
function nvicVectorArg(args) {
  const value = args.irq
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  return String(Number(value))
}

const NVIC_WRITE_ACTIONS = new Map([
  ["enable", (args) => `NVIC enable ${nvicVectorArg(args)}`],
  ["disable", (args) => `NVIC disable ${nvicVectorArg(args)}`],
  ["set_priority", (args) => `NVIC set_priority ${nvicVectorArg(args)} ${Number(args.value)}`],
  ["set_subpriority", (args) => `NVIC set_subpriority ${nvicVectorArg(args)} ${Number(args.value)}`],
  ["set_prioritygroup", (args) => `NVIC set_prioritygroup ${Number(args.value)}`],
])

/** Query or change NVIC settings through CubeMX's NVIC command group. */
async function nvicTool(config, args, exec) {
  requireArgs(args, ["iocPath", "action"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  await assertProjectCompatible(iocPath, config)
  const action = String(args.action)
  const write = NVIC_WRITE_ACTIONS.has(action)
  if (!write && action !== "get_interrupts" && action !== "get_prioritygroup") {
    throw new Error(`unsupported action "${action}"; use ${[...NVIC_WRITE_ACTIONS.keys(), "get_interrupts", "get_prioritygroup"].join(", ")}`)
  }
  const dryRun = args.dryRun === true
  if (write && !dryRun) {
    assertWritable(iocPath, config)
    await assertNoGui(config)
  }

  const workDir = await mkdtemp(join(tmpdir(), "dsh-cubemx-nvic-"))
  // Staged file name must match the target, or saveas renames the project.
  const workIoc = join(workDir, basename(iocPath))
  try {
    await copyFile(iocPath, workIoc)
    const target = write ? workIoc : iocPath
    const commands = [`config load ${q(target)}`]
    if (write) commands.push(NVIC_WRITE_ACTIONS.get(action)(args), `config saveas ${q(workIoc)}`)
    else commands.push(action === "get_interrupts" ? "NVIC get_interrupts" : "NVIC get_prioritygroup")
    commands.push("exit")
    const { lines } = await runCubeMx(config, commands, exec)
    const sections = splitSections(lines, commands)
    const logTail = logTailFor(config, args, lines)
    const queried = sections.find((section) => section.command === (action === "get_interrupts" ? "NVIC get_interrupts" : "NVIC get_prioritygroup"))
    const details = cleanOutputLines(queried, ["NVIC"]).slice(0, 200)
    if (write) {
      const command = NVIC_WRITE_ACTIONS.get(action)(args)
      const section = sections.find((candidate) => candidate.command === command)
      const failure = section === undefined ? "not executed" : sectionFailure(section)
      if (failure !== undefined) {
        const details = [`FAIL ${command}: ${failure}`]
        if (/NullPointerException/u.test(failure)) {
          details.push('HINT CubeMX expects the IRQ vector name (for example "TIM3_IRQn"); run action "get_interrupts" to list the valid names.')
        }
        return { ok: false, summary: `NVIC change failed for ${iocPath}; the original file was not modified.`, details, logTail }
      }
      const commit = await commitWorkingIoc(workIoc, iocPath, dryRun)
      return {
        ok: true,
        summary: `${command} applied${dryRun ? " (dry run)" : ""}.`,
        details: [commit.backupPath === undefined ? "no previous file to back up" : `backup: ${commit.backupPath}`],
        logTail,
      }
    }
    return { ok: true, summary: `${action} for ${iocPath}.`, details, logTail }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

const DMA_READ_COMMANDS = new Map([
  ["list_all", () => "dma list_all"],
  ["list_periph", (args) => `dma list_periph ${args.peripheral}`],
  ["available_periph_requests", (args) => `dma available_periph_requests ${args.peripheral}`],
  ["available_streams", (args) => `dma available_streams ${args.request}`],
])

/** Read-only DMA discovery (writes stay in the raw script tool). */
async function dmaTool(config, args, exec) {
  requireArgs(args, ["iocPath", "action"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  await assertProjectCompatible(iocPath, config)
  const action = String(args.action)
  const build = DMA_READ_COMMANDS.get(action)
  if (build === undefined) throw new Error(`unsupported action "${action}"; use ${[...DMA_READ_COMMANDS.keys()].join(", ")}`)
  if ((action === "list_periph" || action === "available_periph_requests") && args.peripheral === undefined) throw new Error(`${action} needs peripheral`)
  if (action === "available_streams" && args.request === undefined) throw new Error("available_streams needs request")
  const command = build(args)
  const commands = [`config load ${q(iocPath)}`, command, "exit"]
  const { lines } = await runCubeMx(config, commands, exec)
  const sections = splitSections(lines, commands)
  const section = sections.find((candidate) => candidate.command === command)
  const details = cleanOutputLines(section, ["dma"]).slice(0, 200)
  return { ok: true, summary: `${command} for ${iocPath}.`, details, logTail: logTailFor(config, args, lines) }
}

/* ============================ intent layer ============================ */
/*
 * The intent layer turns a short request ("USART2 115200 TX=PA2 RX=PA3",
 * "PB12 输入 上拉 label=KEY1", "TIM3 PWM CH1=PA6") into the exact CubeMX CLI
 * commands, then verifies the result by reloading the staged .ioc and reading
 * every value back. It is deliberately closed-loop: when a signal cannot be put
 * on a pin, or a mode id does not exist, nothing is written and the candidate
 * list is returned instead.
 */

const INTENT_KIND_BY_HEAD = new Map([
  ["USART", "uart"], ["UART", "uart"], ["I2C", "i2c"], ["SPI", "spi"], ["TIM", "tim"], ["GPIO", "gpio"],
  ["ADC", "adc"], ["CAN", "can"], ["DAC", "dac"], ["USB_OTG_FS", "usb"], ["USB", "usb"], ["FSMC", "fsmc"],
])

const INTENT_KIND_WORDS = new Map([
  ["uart", "uart"], ["usart", "uart"], ["serial", "uart"], ["串口", "uart"], ["串行口", "uart"],
  ["i2c", "i2c"], ["spi", "spi"], ["tim", "tim"], ["timer", "tim"], ["pwm", "tim"], ["定时器", "tim"], ["定时", "tim"],
  ["gpio", "gpio"], ["pin", "gpio"], ["引脚", "gpio"],
  ["adc", "adc"], ["can", "can"], ["dac", "dac"], ["数模", "dac"], ["usb", "usb"], ["fsmc", "fsmc"],
  ["dma", "dma"], ["串口设备", "usb"],
  ["clock", "clock"], ["时钟", "clock"], ["rcc", "clock"],
  ["nvic", "nvic"], ["irq", "nvic"], ["interrupt", "nvic"], ["中断", "nvic"],
])

/** Friendly DMA parameter names/values -> CubeMX constants. */
const INTENT_DMA_PARAM_ALIASES = new Map([
  ["direction", "Direction"],
  ["priority", "Priority"],
  ["mode", "Mode"],
  ["meminc", "MemInc"],
  ["mem_inc", "MemInc"],
  ["periphinc", "PeriphInc"],
  ["periph_inc", "PeriphInc"],
  ["memdataalignment", "MemDataAlignment"],
  ["periphdataalignment", "PeriphDataAlignment"],
  ["fifomode", "FIFOMode"],
])
const INTENT_DMA_VALUE_ALIASES = new Map([
  ["p2m", "DMA_PERIPH_TO_MEMORY"], ["periph_to_mem", "DMA_PERIPH_TO_MEMORY"],
  ["m2p", "DMA_MEMORY_TO_PERIPH"], ["mem_to_periph", "DMA_MEMORY_TO_PERIPH"],
  ["m2m", "DMA_MEMORY_TO_MEMORY"], ["mem_to_mem", "DMA_MEMORY_TO_MEMORY"],
  ["low", "DMA_PRIORITY_LOW"], ["medium", "DMA_PRIORITY_MEDIUM"], ["high", "DMA_PRIORITY_HIGH"], ["veryhigh", "DMA_PRIORITY_VERY_HIGH"],
  ["very_high", "DMA_PRIORITY_VERY_HIGH"],
  ["normal", "DMA_NORMAL"], ["circular", "DMA_CIRCULAR"],
  ["enable", "DMA_MINC_ENABLE"], ["disable", "DMA_MINC_DISABLE"],
  ["byte", "DMA_MDATAALIGN_BYTE"], ["halfword", "DMA_MDATAALIGN_HALFWORD"], ["word", "DMA_MDATAALIGN_WORD"],
])

/** FSMC needs a whole pin group, so the intent takes a profile name instead of pins. */
const INTENT_FSMC_PROFILES = new Map([
  ["nand8", {
    roles: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "CLE", "ALE", "NCE2", "NOE", "NWE", "NWAIT"],
    modes: ["NandChipSelect2_1", "8b-dmux1", "Wait1"],
  }],
  ["nor16", {
    roles: ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D14", "D15",
      "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "NBL0", "NBL1", "NE1", "NOE", "NWE"],
    modes: ["NorPsramChipSelect1_1", "16b-d1", "2ByteEnable1"],
  }],
])

const INTENT_ROLE_ALIASES = new Map([
  ["tx", "TX"], ["rx", "RX"], ["cts", "CTS"], ["rts", "RTS"], ["de", "DE"],
  ["scl", "SCL"], ["sda", "SDA"], ["sclk", "SCK"], ["sck", "SCK"], ["miso", "MISO"], ["mosi", "MOSI"], ["nss", "NSS"],
  ["ch1", "CH1"], ["ch2", "CH2"], ["ch3", "CH3"], ["ch4", "CH4"], ["ch5", "CH5"], ["ch6", "CH6"],
  ["通道1", "CH1"], ["通道2", "CH2"], ["通道3", "CH3"], ["通道4", "CH4"],
  ["out1", "OUT1"], ["out2", "OUT2"], ["dm", "DM"], ["dp", "DP"],
])

const INTENT_PULL_WORDS = new Map([
  ["pullup", "GPIO_PULLUP"], ["pull-up", "GPIO_PULLUP"], ["up", "GPIO_PULLUP"], ["上拉", "GPIO_PULLUP"],
  ["pulldown", "GPIO_PULLDOWN"], ["pull-down", "GPIO_PULLDOWN"], ["down", "GPIO_PULLDOWN"], ["下拉", "GPIO_PULLDOWN"],
  ["nopull", "GPIO_NOPULL"], ["none", "GPIO_NOPULL"], ["float", "GPIO_NOPULL"], ["无上拉", "GPIO_NOPULL"],
])

// Mode ids verified on CubeMX 6.15.0 (see the 2026-11-07 probe in README).
const INTENT_DEFAULT_MODE = new Map([
  ["uart", "Asynchronous"],
  ["i2c", "I2C"],
  ["spi", "Full_Duplex_Master"],
  ["can", "CAN_Activate"],
  ["usb", "Device_Only"],
])

/** DMA request names CubeMX accepts, for example USART1_TX / ADC1 / TIM2_UP. */
const INTENT_DMA_REQUEST = /^[A-Za-z][A-Za-z0-9]{1,30}(?:_[A-Za-z0-9]+)?$/u

/** The FSMC profile of an intent ("nand8" when the user only said FSMC/NAND). */
function intentFsmcProfile(intent) {
  const key = intent.params?.profile === undefined ? "nand8" : String(intent.params.profile).toLowerCase()
  return INTENT_FSMC_PROFILES.get(key)
}

/** CubeMX ADC sample-time constants (F1/F4 style), keyed by cycles. */
const INTENT_ADC_SAMPLING = new Map([
  ["1.5", "ADC_SAMPLETIME_1CYCLE_5"],
  ["7.5", "ADC_SAMPLETIME_7CYCLES_5"],
  ["13.5", "ADC_SAMPLETIME_13CYCLES_5"],
  ["28.5", "ADC_SAMPLETIME_28CYCLES_5"],
  ["41.5", "ADC_SAMPLETIME_41CYCLES_5"],
  ["55.5", "ADC_SAMPLETIME_55CYCLES_5"],
  ["71.5", "ADC_SAMPLETIME_71CYCLES_5"],
  ["239.5", "ADC_SAMPLETIME_239CYCLES_5"],
])

const INTENT_SCAN_CHUNK = 50

const INTENT_INSTANCE_PATTERN = /^(USART|UART|I2C|SPI|TIM|GPIO|ADC|CAN|DAC|USB_OTG_FS|USB|FSMC)(\d+)?$/iu

function intentPinName(value) {
  const match = /^P([A-Ka-k])(\d{1,2})$/u.exec(String(value).trim())
  if (match === null) return undefined
  return `P${match[1].toUpperCase()}${Number(match[2])}`
}

/** "串口2"/"usart2"/"USART2"/"I2C1"/"CAN"/"USB"/"DAC1" -> canonical CubeMX IP name. */
function intentCanonicalInstance(raw) {
  const text = String(raw).trim()
  const zh = /^(串口|串行口|定时器|定时)(\d+)$/u.exec(text)
  if (zh !== null) return `${zh[1].startsWith("串") ? "USART" : "TIM"}${zh[2]}`
  const ascii = INTENT_INSTANCE_PATTERN.exec(text)
  if (ascii === null) return undefined
  const head = ascii[1].toUpperCase()
  if (head === "USB" || head === "USB_OTG_FS") return "USB_OTG_FS"
  if (head === "DAC") return "DAC"
  if (head === "FSMC") return "FSMC"
  return `${head}${ascii[2] ?? ""}`
}

function intentKindOfInstance(instance) {
  const match = INTENT_INSTANCE_PATTERN.exec(String(instance))
  return match === null ? undefined : INTENT_KIND_BY_HEAD.get(match[1].toUpperCase())
}

/** Roles an intent must fill; missing ones are auto-selected from the package. */
function intentRequiredRoles(intent) {
  if (intent.kind === "uart") return ["TX", "RX"]
  if (intent.kind === "i2c") return ["SCL", "SDA"]
  if (intent.kind === "spi") return ["SCK", "MISO", "MOSI"]
  if (intent.kind === "can") return ["TX", "RX"]
  if (intent.kind === "tim") return [intent.pins.find((entry) => /^CH\d$/u.test(entry.role))?.role ?? "CH1"]
  if (intent.kind === "dac") {
    const channels = [...new Set(intent.pins.map((entry) => entry.role).filter((role) => /^OUT\d$/u.test(role)))]
    return channels.length > 0 ? channels : ["OUT1"]
  }
  if (intent.kind === "usb") return ["DM", "DP"]
  if (intent.kind === "fsmc") return intentFsmcProfile(intent)?.roles ?? []
  if (intent.kind === "adc") {
    // Channels come from the pins themselves; only a channel without a pin is auto-placed.
    const withPin = intent.pins.filter((entry) => entry.pin !== undefined)
    if (withPin.length > 0) return []
    return intent.pins.map((entry) => entry.role).filter((role) => /^IN\d+$/u.test(role))
  }
  return []
}

/** Treat S_TIM3_CH1 / REMAPPED_USART1_TX / ADCx_IN1 as the same signal as TIM3_CH1 / USART1_TX / ADC1_IN1. */
function sameSignal(expected, actual) {
  const norm = (value) => String(value).toUpperCase().replace(/^REMAPPED_/u, "").replace(/^S_/u, "")
  const wanted = norm(expected)
  const got = norm(actual)
  if (got === wanted || got.startsWith(`${wanted}_`)) return true
  // CubeMX reports ADC channels generically (ADCx_IN1) even for ADC1_IN1.
  const adcWanted = /^(?:ADC\d*|ADCX)_IN(\d+)$/u.exec(wanted)
  const adcGot = /^(?:ADC\d*|ADCX)_IN(\d+)$/u.exec(got)
  if (adcWanted !== null && adcGot !== null && adcWanted[1] === adcGot[1]) return true
  // DAC pins report as COMP_DAC1_group / DAC1_OUT1 regardless of the OUTn we asked for.
  const dacWanted = /(?:^|_)(?:DAC\d*_?OUT|COMP_DAC)(\d?)/u.exec(wanted)
  const dacGot = /(?:^|_)(?:DAC\d*_?OUT|COMP_DAC)(\d?)/u.exec(got)
  if (dacWanted !== null && dacGot !== null) return true
  return false
}

/** All CubeMX mode ids an intent needs: ADC drives one mode per channel, others one mode. */
function intentModesOf(intent) {
  if (intent.kind === "adc") {
    const channels = intent.pins.filter((entry) => /^IN\d+$/u.test(entry.role)).map((entry) => entry.role)
    return channels.length > 0 ? channels : ["IN0"]
  }
  if (intent.kind === "dac") {
    const channels = [...new Set(intent.pins.map((entry) => entry.role).filter((role) => /^OUT\d$/u.test(role)))]
    return (channels.length > 0 ? channels : ["OUT1"]).map((role) => `DAC_${role}`)
  }
  if (intent.kind === "fsmc") return intentFsmcProfile(intent)?.modes ?? []
  if (intent.kind === "dma" || intent.kind === "clock" || intent.kind === "nvic") return []
  if (intent.mode !== undefined) return [intent.mode]
  if (intent.kind === "tim") {
    const channel = intent.pins.find((entry) => /^CH\d$/u.test(entry.role))?.role ?? "CH1"
    const number = channel.replace("CH", "")
    return [`PWM Generation${number} CH${number}`]
  }
  const fallback = INTENT_DEFAULT_MODE.get(intent.kind)
  return fallback === undefined ? [] : [fallback]
}

/**
 * Timer input clock from the project clock tree: the APBx timer clock is the APB
 * frequency doubled when that bus runs slower than HCLK (STM32 rule).
 */
function timerClockHz(instance, clock) {
  if (clock === undefined) return undefined
  const advanced = /^TIM(1|8|9|10|11)$/u.test(String(instance).toUpperCase())
  const bus = advanced ? clock.apb2 : clock.apb1
  if (bus === undefined || !(bus > 0)) return undefined
  const multiplier = clock.hclk === undefined || Math.abs(bus - clock.hclk) < 1 ? 1 : 2
  return bus * multiplier
}

/** Prescaler/period/pulse for a target frequency (50% duty by default).
 * CubeMX's Prescaler field is the PSC register: the divider is Prescaler+1. */
function computeTimerTiming(timerHz, targetHz, dutyPercent = 50) {
  if (!(timerHz > 0) || !(targetHz > 0)) return undefined
  let best
  for (let prescaler = 0; prescaler <= 65535; prescaler += 1) {
    const divider = prescaler + 1
    const period = Math.round(timerHz / (targetHz * divider)) - 1
    if (period < 0 || period > 65535) continue
    const actual = timerHz / (divider * (period + 1))
    const error = Math.abs(actual - targetHz) / targetHz
    if (best === undefined || error < best.error || (error === best.error && period > best.period)) best = { prescaler, period, actual, error }
  }
  if (best === undefined) return undefined
  const pulse = Math.max(0, Math.min(best.period, Math.round((best.period + 1) * dutyPercent / 100)))
  return { prescaler: best.prescaler, period: best.period, pulse, actualHz: best.actual }
}

/** Pin name as CubeMX writes it in the .ioc file (PC13 -> PC13-TAMPER-RTC). */
function iocPinLabel(iocText, pin) {
  const pattern = new RegExp(`^(${pin}(?:-[^.=\\s]+)?)\\.`, "mu")
  const match = pattern.exec(iocText)
  return match === null ? pin : match[1]
}

/** Look up a pin in a pinout-keyed map, accepting CubeMX names like "PA0-WKUP" for "PA0". */
function pinRow(map, pin) {
  if (map === undefined) return undefined
  if (map[pin] !== undefined) return map[pin]
  const key = Object.keys(map).find((candidate) => candidate.startsWith(`${pin}-`))
  return key === undefined ? undefined : map[key]
}

/** Normalize one string intent ("USART2 115200 TX=PA2 RX=PA3") into the object form. */
function parseIntenText(text) {
  const tokens = String(text).split(/[\s,，、;；]+/u).filter((token) => token.length > 0)
  const intent = { kind: undefined, instance: undefined, mode: undefined, pins: [], params: {}, gpio: undefined, warnings: [] }
  let direction
  let pull
  let label
  let barePin
  let role
  for (const token of tokens) {
    const lower = token.toLowerCase()
    const pair = /^([^=]+)=(.+)$/u.exec(token)
    if (pair !== null) {
      const key = pair[1].trim()
      const value = pair[2].trim()
      const genericRole = /^(OUT[12]|DM|DP|D\d|A\d+|CLE|ALE|NCE2|NOE|NWE|NWAIT|NBL[01])$/iu.test(key) ? key.toUpperCase() : undefined
      const roleName = INTENT_ROLE_ALIASES.get(key.toLowerCase()) ?? (/^IN\d+$/iu.test(key) ? key.toUpperCase() : genericRole)
      const pin = intentPinName(value)
      if (roleName !== undefined && pin !== undefined) {
        intent.pins.push({ role: roleName, pin })
        continue
      }
      if (/^(baud|baudrate|波特率)$/u.test(key)) { intent.params.BaudRate = Number(value); continue }
      if (/^(label|标签)$/u.test(key)) { label = value; continue }
      if (/^(pull|上下拉)$/u.test(key)) {
        pull = INTENT_PULL_WORDS.get(value.toLowerCase()) ?? value
        continue
      }
      if (/^(mode|模式)$/u.test(key)) { intent.mode = value; continue }
      if (/^(channel|通道)$/u.test(key)) { role = INTENT_ROLE_ALIASES.get(value.toLowerCase()) ?? value.toUpperCase(); continue }
      if (/^(freq|frequency|hz|频率)$/u.test(key)) { intent.params.frequency = Number(value); continue }
      if (/^(duty|占空比)$/u.test(key)) { intent.params.duty = Number(value); continue }
      if (/^(sampling|sample|采样)$/u.test(key)) { intent.params.sampling = String(value); continue }
      if (/^(profile|配置)$/u.test(key)) { intent.params.profile = String(value).toLowerCase(); continue }
      if (/^(request|请求)$/u.test(key)) { intent.params.request = value.toUpperCase(); continue }
      if (/^(irq|vector|中断号)$/u.test(key)) { intent.params.irq = value; continue }
      if (/^(priority|优先级)$/u.test(key)) { intent.params.priority = value; continue }
      if (/^(hclk|pllmul|plln|pllm|pllp|pllq|apb1div|apb2div|adcdiv)$/iu.test(key)) { intent.params[key.toLowerCase()] = Number(value); continue }
      intent.params[key] = Number.isFinite(Number(value)) && String(Number(value)) === value ? Number(value) : value
      continue
    }
    const instance = intentCanonicalInstance(token)
    if (instance !== undefined) { intent.instance = instance; continue }
    const pin = intentPinName(token)
    if (pin !== undefined) { barePin = pin; continue }
    if (INTENT_ROLE_ALIASES.has(lower)) { role = INTENT_ROLE_ALIASES.get(lower); continue }
    if (/^IN\d+$/iu.test(token)) { role = token.toUpperCase(); continue }
    if (/^CH\d+$/iu.test(token)) { role = token.toUpperCase(); continue }
    // FSMC profile, USB role, DMA request words.
    if (/^(nand|nand8|8bit|8位)$/iu.test(token)) { intent.params.profile = "nand8"; continue }
    if (/^(nor|nor16|sram|sram16|16bit|16位)$/iu.test(token)) { intent.params.profile = "nor16"; continue }
    if (/^(device|设备|从机)$/iu.test(token)) { intent.params.usbMode = "Device_Only"; continue }
    if (/^(host|主机)$/iu.test(token)) { intent.params.usbMode = "Host_Only"; continue }
    if (/^(otg|双角色)$/iu.test(token)) { intent.params.usbMode = "OTG/Dual_Role_Device"; continue }
    if (intent.kind === "dma" && INTENT_DMA_REQUEST.test(token)) { intent.params.request = token.toUpperCase(); continue }
    // Clock / NVIC words.
    if (/^(max|最大|最高)$/iu.test(token)) { intent.params.max = true; continue }
    if (/^[A-Za-z][A-Za-z0-9]*_IRQn$/iu.test(token)) { intent.params.irq = token; continue }
    if (lower === "中断" && intent.instance !== undefined) { intent.params.irq = `${String(intent.instance).toUpperCase()}_IRQn`; continue }
    if (INTENT_PULL_WORDS.has(lower)) { pull = INTENT_PULL_WORDS.get(lower); continue }
    if (/^(input|in|输入)$/u.test(lower)) { direction = "input"; continue }
    if (/^(output|out|输出)$/u.test(lower)) { direction = "output"; continue }
    const freq = /^(\d+(?:\.\d+)?)(k|khz|m|mhz|hz)$/iu.exec(token)
    if (freq !== null) {
      const unit = freq[2].toLowerCase()
      const multiplier = unit.startsWith("k") ? 1_000 : unit.startsWith("m") ? 1_000_000 : 1
      const hertz = Number(freq[1]) * multiplier
      if (intent.kind === "clock") intent.params.hclk = hertz
      else intent.params.frequency = hertz
      continue
    }
    if (/^\d+(?:\.\d+)?$/u.test(token)) {
      if (intent.kind === undefined || intent.kind === "uart") intent.params.BaudRate = Number(token)
      else if (intent.kind === "tim") intent.params.frequency = Number(token)
      continue
    }
    if (INTENT_KIND_WORDS.has(lower)) { intent.kind = intent.kind ?? INTENT_KIND_WORDS.get(lower); continue }
    intent.warnings.push(`ignored token "${token}"`)
  }

  // A pin plus a direction/pull is a GPIO request; an instance tells the kind.
  if (intent.instance !== undefined) {
    intent.kind = intent.kind ?? intentKindOfInstance(intent.instance)
    if (barePin !== undefined) {
      if (intent.kind === "tim") intent.pins.push({ role: role ?? "CH1", pin: barePin })
      else if (intent.kind === "adc") intent.pins.push({ role: role !== undefined && /^IN\d+$/u.test(role) ? role : "AUTO", pin: barePin })
      else if (intent.kind === "dac") intent.pins.push({ role: role !== undefined && /^OUT\d$/u.test(role) ? role : "OUT1", pin: barePin })
      else if (role !== undefined) intent.pins.push({ role, pin: barePin })
      else intent.warnings.push(`pin ${barePin} has no role (use TX=PA2 / SCL=PB6 / CH1=PA6 / IN0=PA0 / OUT1=PA4)`)
    } else if (role !== undefined && (/^IN\d+$/u.test(role) || (/^CH\d+$/u.test(role) && intent.kind === "tim") || (/^OUT\d$/u.test(role) && intent.kind === "dac"))) {
      intent.pins.push({ role })
    }
  } else if (barePin !== undefined || (role !== undefined && /^IN\d+$/u.test(role))) {
    // No instance: "PA0" is GPIO, "IN0" means ADC channel 0.
    if (role !== undefined && /^IN\d+$/u.test(role)) {
      intent.kind = "adc"
      intent.instance = "ADC1"
      intent.pins.push(barePin === undefined ? { role } : { role, pin: barePin })
    } else {
      intent.kind = "gpio"
      intent.pins.push({ role: "GPIO", pin: barePin })
    }
  }
  if (intent.kind === "adc" && intent.instance === undefined) intent.instance = "ADC1"
  if (intent.kind === "can" && intent.instance === undefined) intent.instance = "CAN"
  if (intent.kind === "dac" && intent.instance === undefined) intent.instance = "DAC"
  if (intent.kind === "fsmc" && intent.instance === undefined) intent.instance = "FSMC"
  if (intent.kind === "usb") {
    intent.instance = "USB_OTG_FS"
    if (intent.mode === undefined) intent.mode = intent.params.usbMode ?? "Device_Only"
  }
  if (intent.kind === "dma" && intent.params.request === undefined) {
    // "DMA" alone is not enough; the request name is required (checked later).
  }
  // Clock/NVIC post-processing: accept reversed token order and derive the IRQ name.
  if (intent.kind === "clock") {
    intent.instance = undefined
    if (intent.params.hclk === undefined && intent.params.frequency !== undefined) intent.params.hclk = intent.params.frequency
    delete intent.params.frequency
  }
  if (intent.params?.irq !== undefined) intent.kind = "nvic"
  if (intent.kind === "nvic" && intent.params.irq === undefined && intent.instance !== undefined) {
    intent.params.irq = `${String(intent.instance).toUpperCase()}_IRQn`
  }
  if (intent.kind === "gpio" || (intent.kind === undefined && (direction !== undefined || pull !== undefined || label !== undefined))) {
    intent.kind = "gpio"
    if (barePin !== undefined) intent.pins = [{ role: "GPIO", pin: barePin }]
    intent.gpio = { direction: direction ?? "input", pull, label }
  }
  return intent
}

/** Normalize one object intent from the tool arguments. */
function normalizeIntent(raw) {
  if (typeof raw === "string") return parseIntenText(raw)
  if (raw === null || typeof raw !== "object") throw new Error(`intent must be a string or an object, got ${typeof raw}`)
  const intent = {
    kind: raw.kind === undefined ? undefined : String(raw.kind).toLowerCase(),
    instance: raw.instance === undefined ? undefined : intentCanonicalInstance(raw.instance) ?? String(raw.instance).toUpperCase(),
    mode: raw.mode,
    pins: [],
    params: raw.params === undefined || raw.params === null ? {} : { ...raw.params },
    gpio: undefined,
    warnings: [],
  }
  const defaultRole = intent.kind === "gpio" ? "GPIO" : intent.kind === "adc" ? "AUTO" : intent.kind === "dac" ? "OUT1" : intent.kind === "tim" ? "CH1" : ""
  if (raw.pin !== undefined) intent.pins.push({ role: String(raw.role ?? defaultRole).toUpperCase(), pin: intentPinName(raw.pin) ?? String(raw.pin).toUpperCase() })
  if (raw.channel !== undefined) {
    let channel = String(raw.channel).toUpperCase().replace(/^CHANNEL/iu, "CH")
    if (intent.kind === "adc" && /^\d+$/u.test(channel)) channel = `IN${channel}`
    if (intent.pins.length > 0) intent.pins[0].role = channel
    else intent.pins.push({ role: channel })
  }
  if (raw.pins !== undefined) {
    if (Array.isArray(raw.pins)) {
      for (const entry of raw.pins) {
        intent.pins.push({ role: String(entry.role ?? entry.name ?? "").toUpperCase(), pin: intentPinName(entry.pin) ?? String(entry.pin ?? "").toUpperCase() })
      }
    } else if (typeof raw.pins === "object") {
      for (const [role, pin] of Object.entries(raw.pins)) {
        intent.pins.push({ role: String(role).toUpperCase(), pin: intentPinName(pin) ?? String(pin).toUpperCase() })
      }
    }
  }
  if (raw.baud !== undefined) intent.params.BaudRate = Number(raw.baud)
  if (raw.freq !== undefined || raw.frequency !== undefined) intent.params.frequency = Number(raw.freq ?? raw.frequency)
  if (raw.duty !== undefined) intent.params.duty = Number(raw.duty)
  if (raw.sampling !== undefined) intent.params.sampling = String(raw.sampling)
  if (raw.request !== undefined) intent.params.request = String(raw.request).toUpperCase()
  if (raw.profile !== undefined) intent.params.profile = String(raw.profile).toLowerCase()
  if (raw.irq !== undefined) intent.params.irq = String(raw.irq).toUpperCase()
  if (raw.priority !== undefined) intent.params.priority = Number(raw.priority)
  if (raw.max === true) intent.params.max = true
  for (const key of ["hclk", "pllMul", "pllN", "pllM", "pllP", "pllQ", "apb1Div", "apb2Div", "adcDiv"]) {
    if (raw[key] !== undefined) intent.params[key] = Number(raw[key])
  }
  if (intent.kind === undefined && raw.irq !== undefined) intent.kind = "nvic"
  if (raw.mode !== undefined) intent.mode = String(raw.mode)
  if (raw.kind === undefined && raw.request !== undefined) intent.kind = "dma"
  if (intent.kind === "dma" && intent.instance !== undefined) intent.instance = undefined
  if (intent.kind === "dac" && intent.instance === undefined) intent.instance = "DAC"
  if (intent.kind === "fsmc" && intent.instance === undefined) intent.instance = "FSMC"
  if (intent.kind === "usb") {
    intent.instance = "USB_OTG_FS"
    if (intent.mode === undefined) intent.mode = intent.params.usbMode ?? "Device_Only"
  }
  if (raw.direction !== undefined || raw.pull !== undefined || raw.label !== undefined) {
    intent.kind = intent.kind ?? "gpio"
    intent.gpio = {
      direction: raw.direction === undefined ? "input" : String(raw.direction).toLowerCase(),
      pull: raw.pull === undefined ? undefined : (INTENT_PULL_WORDS.get(String(raw.pull).toLowerCase()) ?? String(raw.pull).toUpperCase()),
      label: raw.label,
    }
  }
  if (intent.kind === undefined && intent.instance !== undefined) intent.kind = intentKindOfInstance(intent.instance)
  if (intent.kind === undefined && intent.gpio !== undefined) intent.kind = "gpio"
  if (intent.kind === "gpio") {
    if (intent.gpio === undefined) intent.gpio = { direction: "input" }
    if (intent.pins.length === 0) throw new Error("gpio intent needs pin (for example PB12)")
    intent.pins = intent.pins.map((entry) => ({ role: "GPIO", pin: entry.pin }))
  }
  return intent
}

/** Validate that an intent has the minimum fields its kind needs (pins are optional: auto-picked). */
function assertIntentComplete(intent, label) {
  if (intent.kind === undefined) throw new Error(`intent ${label}: cannot tell the peripheral kind; add a kind or an instance like USART2`)
  if (intent.kind === "gpio") {
    if (intent.pins.length === 0) throw new Error(`intent ${label}: gpio needs a pin (PA5, PB12, ...)`)
    return
  }
  if (intent.kind === "dma") {
    const request = intent.params?.request
    if (request === undefined || !INTENT_DMA_REQUEST.test(String(request))) {
      throw new Error(`intent ${label}: dma needs a request name like USART1_TX / ADC1 (for example "DMA USART1_TX")`)
    }
    return
  }
  if (intent.kind === "clock") return
  if (intent.kind === "nvic") {
    if (intent.params?.irq === undefined) throw new Error(`intent ${label}: nvic needs an IRQ name like TIM3_IRQn (for example "NVIC TIM3_IRQn")`)
    if (intent.params.priority !== undefined && !Number.isFinite(Number(intent.params.priority))) {
      throw new Error(`intent ${label}: nvic priority must be a number (0-15), got "${intent.params.priority}"`)
    }
    return
  }
  if (intent.kind === "fsmc" && intentFsmcProfile(intent) === undefined) {
    throw new Error(`intent ${label}: unknown FSMC profile "${intent.params?.profile ?? "(none)"}"; use NAND 8bit (default) or NOR 16bit`)
  }
  if (intent.kind === "adc" && intent.pins.length === 0) throw new Error(`intent ${label}: adc needs a channel or pin (IN0=PA0, or IN0 alone to auto-pick)`)
  if (intent.kind === "adc" && intent.params?.sampling !== undefined) {
    throw new Error(`intent ${label}: CubeMX CLI cannot set the ADC sampling time ("set ip parameters" stores null); keep the default or set it in the CubeMX GUI`)
  }
  if (intent.instance === undefined) throw new Error(`intent ${label}: ${intent.kind} needs an instance like ${intent.kind.toUpperCase()}2`)
  if (intentModesOf(intent).length === 0) throw new Error(`intent ${label}: no default mode for ${intent.kind}; pass mode explicitly`)
}

/** Expected signal names for a role, including S_/remap variants like S_TIM3_CH1. */
function intentSignalCandidates(intent, role) {
  if (intent.kind === "gpio") return [intent.gpio?.direction === "output" ? "GPIO_OUTPUT" : "GPIO_INPUT"]
  const inst = String(intent.instance).toUpperCase()
  const suffix = `${inst}_${String(role).toUpperCase()}`
  const candidates = [suffix, `S_${suffix}`, `REMAPPED_${suffix}`]
  // F1-style single-CAN parts name the signals CAN_TX/CAN_RX and the IP "CAN".
  if (intent.kind === "can") {
    const base = inst.replace(/\d+$/u, "")
    candidates.push(`${base}_${String(role).toUpperCase()}`, `S_${base}_${String(role).toUpperCase()}`)
  }
  // CubeMX lists ADC channels generically (ADCx_IN1) even for ADC1.
  if (intent.kind === "adc" && /^IN\d+$/u.test(String(role).toUpperCase())) {
    candidates.push(`ADCX_${String(role).toUpperCase()}`, `S_ADCX_${String(role).toUpperCase()}`)
  }
  return candidates
}

/** Pick the real signal for a pin from `get functions <pin>` output. */
function pickIntentSignal(intent, role, available) {
  const wanted = intentSignalCandidates(intent, role).map((value) => value.toUpperCase())
  const upper = available.map((value) => String(value).toUpperCase())
  for (const candidate of wanted) {
    const index = upper.indexOf(candidate)
    if (index >= 0) return available[index]
  }
  for (const candidate of wanted) {
    const index = upper.findIndex((value) => value.endsWith(`_${candidate}`))
    if (index >= 0) return available[index]
  }
  return undefined
}

/** Every `get mode active <ip>` line for an IP (ADC reports one per enabled channel). */
function activeModes(section, ip) {
  if (section === undefined) return []
  const pattern = new RegExp(`^Mode: active \\| ${ip} \\| ([^|]+?) \\|`, "iu")
  const result = []
  for (const raw of section.result) {
    const match = pattern.exec(raw.trim())
    if (match !== null) result.push(match[1].trim())
  }
  return result
}

/** Pick the first ADC channel a pin can do: "ADC1_IN5" -> { role: "IN5", signal }. */
function pickAdcChannel(intent, available) {
  const pattern = new RegExp(`^(S_)?${String(intent.instance).toUpperCase()}_IN(\\d+)$`, "iu")
  for (const signal of available) {
    const match = pattern.exec(String(signal).trim())
    if (match !== null) return { role: `IN${match[2]}`, signal }
  }
  return undefined
}

/** Parse `get pinout` into [{pin, signal}] like inspectProject does. */
function parseIntenPinout(section) {
  const pins = []
  for (const raw of section?.result ?? []) {
    let line = raw.trim()
    if (line.length === 0 || !line.includes(":")) continue
    if (line.length % 2 === 0 && line.slice(0, line.length / 2) === line.slice(line.length / 2)) line = line.slice(0, line.length / 2)
    const match = /^([^:]+):\s*(.+)$/u.exec(line)
    if (match === null) continue
    pins.push({ pin: match[1].trim(), signal: match[2].trim() })
  }
  return pins
}

function intentCachePath(mcuName, packageName) {
  const safe = (value) => String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/gu, "_")
  return join(homedir(), ".stm32cubemx", "dsh-cubemx-intent-cache", `${safe(mcuName)}__${safe(packageName)}.json`)
}

async function loadIntentCache(mcuName, packageName) {
  const path = intentCachePath(mcuName, packageName)
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

async function saveIntentCache(mcuName, packageName, data) {
  const path = intentCachePath(mcuName, packageName)
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  await writeFile(path, JSON.stringify(data), "utf8").catch(() => {})
}

/**
 * Build/extend the pin -> available signals map for one MCU. Uses a JSON cache in
 * %USERPROFILE%\.stm32cubemx\dsh-cubemx-intent-cache so auto pin selection costs
 * one CubeMX run per MCU (not per call).
 */
async function intentPinMap(config, workIoc, iocText, exec) {
  const read = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, "mu").exec(iocText)
    return match === null ? undefined : match[1].trim()
  }
  const mcuName = read("Mcu\\.Name")
  const packageName = read("Mcu\\.Package")
  const cached = await loadIntentCache(mcuName, packageName)
  if (cached !== undefined && cached.pins !== undefined) return { ...cached, fromCache: true }

  const probe = [`config load ${q(workIoc)}`, "get mcu name", "get mcu package", "get pinout", "exit"]
  const { lines } = await runCubeMx(config, probe, exec)
  const sections = splitSections(lines, probe)
  const pinout = parseIntenPinout(sections.find((section) => section.command === "get pinout"))
  const pins = {}
  for (let start = 0; start < pinout.length; start += INTENT_SCAN_CHUNK) {
    const chunk = pinout.slice(start, start + INTENT_SCAN_CHUNK)
    const commands = [`config load ${q(workIoc)}`, ...chunk.map((entry) => `get functions ${entry.pin}`), "exit"]
    const response = await runCubeMx(config, commands, exec)
    const chunkSections = splitSections(response.lines, commands)
    for (const entry of chunk) {
      pins[entry.pin] = availableSignals(chunkSections.find((section) => section.command === `get functions ${entry.pin}`), entry.pin)
    }
  }
  const data = { mcu: lastValue(sections.find((section) => section.command === "get mcu name")) ?? mcuName, package: lastValue(sections.find((section) => section.command === "get mcu package")) ?? packageName, pins, savedAt: new Date().toISOString() }
  await saveIntentCache(mcuName, packageName, data)
  return { ...data, fromCache: false }
}

/** Current .ioc pin state (signal + GPIO label) parsed from the text, no CubeMX run needed. */
function parseIocPinStates(text) {
  const states = new Map()
  for (const line of String(text).split(/\r?\n/u)) {
    const signal = /^(P[A-K]\d{1,2})\.Signal=(.*)$/u.exec(line)
    if (signal !== null) {
      const entry = states.get(signal[1]) ?? {}
      entry.signal = signal[2].trim()
      states.set(signal[1], entry)
      continue
    }
    const label = /^(P[A-K]\d{1,2})\.GPIO_Label=(.*)$/u.exec(line)
    if (label !== null) {
      const entry = states.get(label[1]) ?? {}
      entry.label = label[2].trim()
      states.set(label[1], entry)
    }
  }
  return states
}

/** Read HCLK/APB1/APB2 (timer frequency math needs the real clock tree). */
async function readClockTree(config, workIoc, exec) {
  const commands = [
    `config load ${q(workIoc)}`,
    "get ip parameters RCC HCLKFreq_Value",
    "get ip parameters RCC APB1Freq_Value",
    "get ip parameters RCC APB2Freq_Value",
    "exit",
  ]
  const { lines } = await runCubeMx(config, commands, exec)
  return clockFromSections(splitSections(lines, commands))
}

function clockFromSections(sections) {
  const value = (command) => Number(lastValue(sections.find((section) => section.command === command)))
  const hclk = value("get ip parameters RCC HCLKFreq_Value")
  const apb1 = value("get ip parameters RCC APB1Freq_Value")
  const apb2 = value("get ip parameters RCC APB2Freq_Value")
  return hclk > 0 && apb1 > 0 && apb2 > 0 ? { hclk, apb1, apb2 } : undefined
}

/** Resolve all intents to concrete pin/signal/mode/param assignments. */
async function resolveIntents(config, intents, workIoc, iocText, exec) {
  const pinStates = parseIocPinStates(iocText)
  const pinStateFor = (pin) => {
    if (pin === undefined) return undefined
    const direct = pinStates.get(pin)
    if (direct !== undefined) return direct
    const key = [...pinStates.keys()].find((candidate) => candidate.startsWith(`${pin}-`))
    return key === undefined ? undefined : pinStates.get(key)
  }
  const isBusy = (pin) => {
    const current = pinStateFor(pin)?.signal
    return current !== undefined && current !== "" && current !== "Reset_State"
  }
  // ADC regular-conversion sequence: which channels the project already samples.
  const adcState = new Map()
  // Parse the project's regular-conversion sequence: ordered channels with their sample time.
  // NbrOfConversion is unreliable (CubeMX omits it when 1), so count Channel-N lines.
  const adcConversionState = (instance) => {
    if (!adcState.has(instance)) {
      const prefix = `${instance}.`
      const channelMarker = "#ChannelRegularConversion="
      const samplingMarker = "#ChannelRegularConversion="
      const channels = new Map()
      const samplings = new Map()
      for (const line of iocText.split(/\r?\n/u)) {
        if (!line.startsWith(prefix)) continue
        const head = line.slice(prefix.length)
        if (head.startsWith("Channel-") && line.includes(channelMarker)) {
          const index = Number(head.slice("Channel-".length, head.indexOf("\\")))
          const match = /ADC_CHANNEL_(\d+)/u.exec(line.slice(line.indexOf(channelMarker) + channelMarker.length))
          if (Number.isFinite(index) && match !== null) channels.set(index, Number(match[1]))
        } else if (head.startsWith("SamplingTime-") && line.includes(samplingMarker)) {
          const index = Number(head.slice("SamplingTime-".length, head.indexOf("\\")))
          const value = line.slice(line.indexOf(samplingMarker) + samplingMarker.length).trim()
          if (Number.isFinite(index) && value.length > 0) samplings.set(index, value)
        }
      }
      const sequence = [...channels.keys()].sort((a, b) => a - b).map((index) => ({
        channel: channels.get(index),
        sampling: samplings.get(index) ?? "ADC_SAMPLETIME_55CYCLES_5",
      }))
      adcState.set(instance, { sequence })
    }
    return adcState.get(instance)
  }
  // A role counts as "auto" when it has no pin yet (ADC channel only, timer PWM without CHx=).
  const needsAuto = intents.some((intent) => intentRequiredRoles(intent).some((role) => !intent.pins.some((entry) => entry.role === role && entry.pin !== undefined)))
  const explicitPins = [...new Set(intents.flatMap((intent) => intent.pins.map((entry) => entry.pin)))]
  const wantsClock = intents.some((intent) => intent.kind === "tim" && Number(intent.params?.frequency) > 0)
  const clockCommands = [
    "get ip parameters RCC HCLKFreq_Value",
    "get ip parameters RCC APB1Freq_Value",
    "get ip parameters RCC APB2Freq_Value",
  ]
  let functionMap
  let clock
  let pinoutRows = []
  const wantsGpioNames = intents.some((intent) => intent.kind === "gpio")
  if (needsAuto) {
    functionMap = (await intentPinMap(config, workIoc, iocText, exec)).pins
    if (wantsClock) clock = await readClockTree(config, workIoc, exec)
  } else if (explicitPins.length > 0) {
    const commands = [`config load ${q(workIoc)}`, ...explicitPins.map((pin) => `get functions ${pin}`), ...(wantsGpioNames ? ["get pinout"] : []), ...(wantsClock ? clockCommands : []), "exit"]
    const { lines } = await runCubeMx(config, commands, exec)
    const sections = splitSections(lines, commands)
    functionMap = {}
    for (const pin of explicitPins) {
      functionMap[pin] = availableSignals(sections.find((section) => section.command === `get functions ${pin}`), pin)
    }
    if (wantsGpioNames) pinoutRows = parseIntenPinout(sections.find((section) => section.command === "get pinout"))
    if (wantsClock) clock = clockFromSections(sections)
  } else {
    functionMap = {}
    if (wantsClock) clock = await readClockTree(config, workIoc, exec)
  }

  const assigned = []
  const issues = []
  for (const [index, intent] of intents.entries()) {
    const label = `#${index + 1} ${intent.instance ?? intent.pins[0]?.pin ?? (intent.kind === "dma" ? intent.params?.request : intent.kind)}`
    const pinEntries = [...intent.pins]
    const resolved = { intent, label, pins: [], modes: [], issues: [] }
    // Fill missing roles from the package (auto pin selection). Prefer pins the
    // project does not use yet; only fall back to a busy pin when nothing is free.
    const used = new Set(pinEntries.map((entry) => entry.pin))
    for (const role of intentRequiredRoles(intent)) {
      if (pinEntries.some((entry) => entry.role === role && entry.pin !== undefined)) continue
      if (Object.keys(functionMap).length === 0) continue
      const candidates = Object.entries(functionMap)
        .map(([key, signals]) => ({ pin: intentPinName(key) ?? key, signals }))
        .filter((entry) => !used.has(entry.pin) && pickIntentSignal(intent, role, entry.signals) !== undefined)
        .sort((a, b) => {
          const busyA = isBusy(a.pin) ? 1 : 0
          const busyB = isBusy(b.pin) ? 1 : 0
          return busyA === busyB ? a.pin.localeCompare(b.pin, "en", { numeric: true }) : busyA - busyB
        })
      if (candidates.length === 0) {
        resolved.issues.push(`no pin in this package provides ${role} for ${intent.instance}`)
        continue
      }
      const { pin, signals } = candidates[0]
      const signal = pickIntentSignal(intent, role, signals)
      // A channel/role given without a pin (ADC "IN1", timer "CH2") gets its pin filled here.
      const existing = pinEntries.find((entry) => entry.role === role && entry.pin === undefined)
      if (existing !== undefined) {
        existing.pin = pin
        existing.auto = true
        existing.signal = signal
      } else {
        pinEntries.push({ role, pin, auto: true, signal })
      }
      used.add(pin)
    }
    for (const entry of pinEntries) {
      const signals = pinRow(functionMap, entry.pin) ?? []
      if (intent.kind === "adc" && entry.role === "AUTO") {
        const pick = pickAdcChannel(intent, signals)
        if (pick === undefined) {
          resolved.issues.push(`${entry.pin} has no ${intent.instance} channel; available: ${signals.length > 0 ? signals.join(", ") : "(none)"}`)
          continue
        }
        resolved.pins.push({ ...entry, role: pick.role, signal: pick.signal })
        continue
      }
      const signal = entry.signal ?? pickIntentSignal(intent, entry.role, signals)
      if (signal === undefined) {
        const wanted = intentSignalCandidates(intent, entry.role).join(" / ")
        resolved.issues.push(`${entry.pin} cannot be ${wanted}; available: ${signals.length > 0 ? signals.join(", ") : "(pin not in this package)"}`)
        continue
      }
      resolved.pins.push({ ...entry, signal })
    }
    // F1-style MCUs name the CAN instance "CAN" while the intent says CAN1.
    if (intent.kind === "can" && /^CAN\d+$/u.test(String(intent.instance)) && resolved.pins.some((entry) => /^S?CAN_/u.test(entry.signal))) {
      intent.instance = "CAN"
    }
    // GPIO params need the pin name CubeMX writes in the .ioc (PC13-TAMPER-RTC).
    if (intent.kind === "gpio" && resolved.pins.length > 0) {
      const pin = resolved.pins[0].pin
      const fromPinout = pinoutRows.find((row) => row.pin === pin || row.pin.startsWith(`${pin}-`))?.pin
      const fromMap = Object.keys(functionMap).find((key) => key === pin || key.startsWith(`${pin}-`))
      resolved.gpioPin = fromPinout ?? fromMap ?? iocPinLabel(iocText, pin)
    }
    resolved.modes = intent.kind === "adc" ? resolved.pins.map((entry) => entry.role) : intentModesOf(intent)
    // A new ADC channel also has to enter ADCx's regular conversion sequence, or the
    // generated code never samples it. CubeMX only accepts writes at NEW indices
    // (existing Channel-N entries cannot be changed), so append at the end.
    if (intent.kind === "adc" && resolved.pins.length > 0) {
      const state = adcConversionState(intent.instance)
      const present = new Set(state.sequence.map((entry) => entry.channel))
      const additions = []
      for (const entry of resolved.pins) {
        const channel = Number(String(entry.role).replace(/^IN/u, ""))
        if (!Number.isFinite(channel) || present.has(channel)) continue
        additions.push({ channel, sampling: state.sequence[0]?.sampling ?? "ADC_SAMPLETIME_55CYCLES_5" })
        present.add(channel)
      }
      if (additions.length > 0) {
        const entries = additions.map((entry, offset) => {
          const index = state.sequence.length + offset
          return { index, channel: entry.channel, rank: index + 1, sampling: entry.sampling }
        })
        resolved.adcConvert = { ip: intent.instance, entries, finalCount: state.sequence.length + additions.length }
        state.sequence = [...state.sequence, ...additions]
      }
    }
    if (intent.kind === "clock") {
      const plan = clockIntentPlan(intent, iocText)
      if (plan.error !== undefined) resolved.issues.push(plan.error)
      else resolved.clockPlan = plan
    }
    if (intent.kind === "nvic") {
      const irq = String(intent.params.irq)
      if (!/^[A-Za-z0-9]+_IRQn$/u.test(irq)) resolved.issues.push(`"${irq}" is not an IRQ vector name (use TIM3_IRQn / USART1_IRQn)`)
    }
    if (intent.kind === "dma") {
      const request = String(intent.params.request)
      resolved.dmaExisting = iocText.split(/\r?\n/u).some((line) => new RegExp(`^Dma\\.Request\\d+=${request}$`, "u").test(line))
    }
    if (intent.kind === "tim" && Number(intent.params?.frequency) > 0) {
      const timerHz = timerClockHz(intent.instance, clock)
      const timing = timerHz === undefined ? undefined : computeTimerTiming(timerHz, Number(intent.params.frequency), Number(intent.params.duty ?? 50))
      if (timing === undefined) {
        resolved.issues.push(`cannot compute Prescaler/Period for ${intent.params.frequency} Hz on ${intent.instance}: the clock tree (RCC HCLK/APB) could not be read`)
      } else {
        resolved.timing = timing
        resolved.timerHz = timerHz
      }
    }
    // Warn when a pin is taken away from its current function (CubeMX would silently
    // drop the old signal and its GPIO label).
    for (const entry of resolved.pins) {
      const current = pinStateFor(entry.pin)
      if (current?.signal === undefined || current.signal === "Reset_State" || sameSignal(entry.signal, current.signal)) continue
      const labelText = current.label === undefined ? "" : ` (label ${current.label})`
      resolved.warnings = resolved.warnings ?? []
      resolved.warnings.push(`${entry.pin} was ${current.signal}${labelText}; it becomes ${entry.signal}`)
    }
    if (resolved.issues.length > 0) issues.push(...resolved.issues.map((issue) => `${label}: ${issue}`))
    else if (intent.kind === "gpio" || intent.kind === "dma" || intent.kind === "clock" || intent.kind === "nvic" || resolved.modes.length > 0) assigned.push(resolved)
    else issues.push(`${label}: no mode for ${intent.kind}; pass mode explicitly`)
  }
  const warnings = assigned.flatMap((resolved) => (resolved.warnings ?? []).map((warning) => `${resolved.label}: ${warning}`))
  return { assigned, issues, warnings, clock }
}

/** Quote an IP parameter name when it contains spaces ("Pulse-PWM Generation1 CH1"). */
function paramKeyText(key) {
  const text = String(key)
  return /[\s"']/u.test(text) ? q(text) : text
}

/** Apply resolved intents in one CubeMX session and verify every value by readback. */
async function applyIntents(config, args, resolvedList, workIoc, clock, exec) {
  const commands = [`config load ${q(workIoc)}`]
  const expectSignals = []
  const expectAdcPins = []
  const expectModes = []
  const gpioChecks = []
  const adcChecks = []
  const dmaChecks = []
  const dmaParamChecks = []
  const clockChecks = []
  const nvicChecks = []
  const expectParams = []
  const extraDetails = []

  for (const resolved of resolvedList) {
    const { intent } = resolved
    for (const entry of resolved.pins) {
      commands.push(`set pin ${entry.pin} ${entry.signal}`)
      // `get signal <pin>` returns KO for ADC pins and for pins whose CubeMX name carries
      // a suffix (PC13-TAMPER-RTC), so those are verified via `get pinout`.
      if (intent.kind === "adc" || intent.kind === "gpio" || intent.kind === "fsmc") expectAdcPins.push({ pin: entry.pin, signal: entry.signal, auto: entry.auto === true })
      else expectSignals.push({ pin: entry.pin, signal: entry.signal, role: entry.role, auto: entry.auto === true })
    }
    if (intent.kind === "dma") {
      // Re-adding an existing request makes CubeMX print KO; only add it when missing.
      if (resolved.dmaExisting !== true) commands.push(`dma add ${intent.params.request}`)
      dmaChecks.push(String(intent.params.request))
      for (const [key, value] of dmaIntentParams(intent)) {
        commands.push(`dma set_param ${intent.params.request} ${key} ${value}`)
        dmaParamChecks.push({ request: String(intent.params.request), key, value })
      }
      continue
    }
    if (intent.kind === "clock") {
      commands.push(...resolved.clockPlan.commands)
      clockChecks.push(resolved.clockPlan.expectedHclk)
      continue
    }
    if (intent.kind === "nvic") {
      commands.push(`NVIC enable ${intent.params.irq}`)
      if (intent.params.priority !== undefined) commands.push(`NVIC set_priority ${intent.params.irq} ${Number(intent.params.priority)}`)
      nvicChecks.push({ irq: String(intent.params.irq), priority: intent.params.priority })
      continue
    }
    if (intent.kind === "gpio") {
      const settings = intent.gpio ?? {}
      const gpioPin = resolved.gpioPin ?? resolved.pins[0].pin
      if (settings.label !== undefined) {
        commands.push(`set gpio parameters ${gpioPin} GPIO_Label ${settings.label}`)
        gpioChecks.push({ pin: gpioPin, key: "GPIO_Label", value: settings.label })
      }
      const pull = settings.pull === undefined ? undefined : canonicalPull(settings.pull)
      if (pull !== undefined) {
        commands.push(`set gpio parameters ${gpioPin} GPIO_PuPd ${pull}`)
        gpioChecks.push({ pin: gpioPin, key: "GPIO_PuPd", value: pull })
      }
      continue
    }
    for (const mode of resolved.modes) {
      commands.push(`set mode ${intent.instance} ${q(mode)}`)
      expectModes.push({ ip: intent.instance, mode })
    }
    // New ADC channels: add Channel/Rank/SamplingTime and bump NbrOfConversion, else
    // the generated ADC sequence never samples them.
    if (resolved.adcConvert !== undefined) {
      const { ip, entries, finalCount } = resolved.adcConvert
      for (const entry of entries) {
        for (const [key, value] of [
          [`Channel-${entry.index}#ChannelRegularConversion`, `ADC_CHANNEL_${entry.channel}`],
          [`Rank-${entry.index}#ChannelRegularConversion`, String(entry.rank)],
          [`SamplingTime-${entry.index}#ChannelRegularConversion`, entry.sampling],
        ]) {
          commands.push(`set ip parameters ${ip} ${paramKeyText(key)} ${value}`)
        }
        adcChecks.push({ ip, index: entry.index, channel: entry.channel, rank: entry.rank })
      }
      commands.push(`set ip parameters ${ip} NbrOfConversion ${finalCount}`)
      adcChecks.push({ ip, finalCount })
    }
    const params = intent.params ?? {}
    // SPI defaults: CubeMX marks an SPI IP "not ready" when the baud rate exceeds the
    // chip's maximum (F1 SPI1: 72 MHz / 2 = 36 > 18 Mbit/s). Prescaler /4 is safe.
    if (intent.kind === "spi" && params.BaudRatePrescaler === undefined) {
      commands.push(`set ip parameters ${intent.instance} BaudRatePrescaler SPI_BAUDRATEPRESCALER_4`)
      expectParams.push({ ip: intent.instance, key: "BaudRatePrescaler", value: "SPI_BAUDRATEPRESCALER_4" })
    }
    // Timer frequency: Prescaler/Period/Pulse computed from the real APB timer clock.
    if (intent.kind === "tim" && resolved.timing !== undefined) {
      const timing = resolved.timing
      const channel = resolved.pins.find((entry) => /^CH\d$/u.test(entry.role))?.role ?? "CH1"
      const number = channel.replace("CH", "")
      const modeId = resolved.modes[0] ?? `PWM Generation${number} CH${number}`
      const pulseKey = `Pulse-${modeId}`
      for (const [key, value] of [["Prescaler", timing.prescaler], ["Period", timing.period], [pulseKey, timing.pulse]]) {
        commands.push(`set ip parameters ${intent.instance} ${paramKeyText(key)} ${value}`)
        expectParams.push({ ip: intent.instance, key, value: String(value) })
      }
      extraDetails.push(`${intent.instance}: ${timing.actualHz.toFixed(2)} Hz (PSC ${timing.prescaler}, ARR ${timing.period}, pulse ${timing.pulse})`)
    }
    // ADC sampling time cannot be applied through the CLI (CubeMX stores null), so
    // assertIntentComplete rejects it before we get here; only generic params run.
    for (const [key, value] of Object.entries(params)) {
      // Meta keys drive the intent itself; the rest are real CubeMX IP parameters.
      if (key === "frequency" || key === "duty" || key === "sampling" || key === "usbMode" || key === "profile" || key === "request") continue
      commands.push(`set ip parameters ${intent.instance} ${paramKeyText(key)} ${value}`)
      expectParams.push({ ip: intent.instance, key, value: String(value) })
    }
  }
  // Staged copy keeps the target file name so CubeMX does not rename the project.
  const stagedDir = join(dirname(workIoc), "staged")
  await mkdir(stagedDir, { recursive: true }).catch(() => {})
  const staged = join(stagedDir, basename(workIoc))
  commands.push(`config saveas ${q(staged)}`, `config load ${q(staged)}`)
  for (const entry of expectSignals) commands.push(`get signal ${entry.pin}`)
  if (expectAdcPins.length > 0) commands.push("get pinout")
  if (dmaChecks.length > 0) commands.push("dma list_all")
  if (clockChecks.length > 0) commands.push("get ip parameters RCC HCLKFreq_Value")
  for (const ip of [...new Set(expectModes.map((entry) => entry.ip))]) {
    commands.push(`get mode active ${ip}`)
    commands.push(`get mode available ${ip}`)
  }
  for (const entry of expectParams) commands.push(`get ip parameters ${entry.ip} ${paramKeyText(entry.key)}`)
  commands.push("exit")
  if (commands.length > MAX_SCRIPT_COMMANDS) {
    throw new Error(`this change needs ${commands.length} CubeMX commands (max ${MAX_SCRIPT_COMMANDS}); split the intents into two calls`)
  }

  const { lines } = await runCubeMx(config, commands, exec)
  const sections = splitSections(lines, commands)
  const read = (command) => sections.find((section) => section.command === command)
  const details = []
  const failures = []

  for (const entry of expectSignals) {
    const actual = lastValue(read(`get signal ${entry.pin}`))
    const where = entry.auto === true ? " (auto-selected)" : ""
    if (actual === undefined || !sameSignal(entry.signal, actual)) {
      failures.push(`${entry.pin}: signal readback ${actual ?? "(none)"} != ${entry.signal}`)
    } else {
      details.push(`${entry.pin}: ${entry.role} -> ${String(actual).trim()}${where}`)
    }
  }
  // GPIO label/pull and the ADC conversion sequence are checked in the saved .ioc:
  // `get gpio parameters` returns KO for suffixed pin names, and `get ip parameters`
  // reports stale channel mappings after CubeMX renumbers conversions.
  const stagedText = gpioChecks.length + adcChecks.length + nvicChecks.length + dmaParamChecks.length > 0 ? await readFile(staged, "utf8").catch(() => "") : ""
  if (gpioChecks.length > 0) {
    for (const entry of gpioChecks) {
      const found = stagedText.split(/\r?\n/u).some((line) => {
        const dot = line.indexOf(".")
        if (dot < 0) return false
        const pinName = line.slice(0, dot)
        if (pinName !== entry.pin && !pinName.startsWith(`${entry.pin}-`)) return false
        return line === `${pinName}.${entry.key}=${entry.value}`
      })
      if (!found) failures.push(`${entry.pin} ${entry.key}: not found in the saved .ioc (expected ${entry.value})`)
      else details.push(`${entry.pin}: ${entry.key}=${entry.value}`)
    }
  }
  if (adcChecks.length > 0) {
    const savedLines = stagedText.split(/\r?\n/u)
    const hasLine = (pattern) => savedLines.some((line) => pattern.test(line))
    for (const entry of adcChecks) {
      if (entry.finalCount !== undefined) {
        if (entry.finalCount > 1 && !hasLine(new RegExp(`^${entry.ip}\\.NbrOfConversion=${entry.finalCount}$`, "u"))) {
          failures.push(`${entry.ip}: saved .ioc does not contain NbrOfConversion=${entry.finalCount}`)
        } else {
          details.push(`${entry.ip}: NbrOfConversion=${entry.finalCount}`)
        }
        continue
      }
      const expectedChannel = `ADC_CHANNEL_${entry.channel}`
      const channelOk = hasLine(new RegExp(`^${entry.ip}\\.Channel-${entry.index}\\\\#ChannelRegularConversion=${expectedChannel}$`, "u"))
      const rankOk = hasLine(new RegExp(`^${entry.ip}\\.Rank-${entry.index}\\\\#ChannelRegularConversion=${entry.rank}$`, "u"))
      if (!channelOk || !rankOk) {
        failures.push(`${entry.ip} rank ${entry.index}: saved .ioc misses Channel-${entry.index}=${expectedChannel} / Rank-${entry.index}=${entry.rank}`)
      } else {
        details.push(`${entry.ip}: conversion ${entry.index} -> ${expectedChannel} (rank ${entry.rank})`)
      }
    }
  }
  if (expectAdcPins.length > 0) {
    const pinout = parseIntenPinout(read("get pinout"))
    for (const entry of expectAdcPins) {
      const match = pinout.find((row) => row.pin === entry.pin || row.pin.startsWith(`${entry.pin}-`))
      const where = entry.auto === true ? " (auto-selected)" : ""
      if (match === undefined) failures.push(`${entry.pin}: not found in get pinout`)
      else if (!sameSignal(entry.signal, match.signal)) failures.push(`${entry.pin}: pinout readback ${match.signal} != ${entry.signal}`)
      else details.push(`${entry.pin}: ${match.signal}${where}`)
    }
  }
  for (const entry of expectModes) {
    const modes = activeModes(read(`get mode active ${entry.ip}`), entry.ip)
    if (!modes.some((mode) => normalizeMode(mode) === normalizeMode(entry.mode))) {
      failures.push(`${entry.ip}: mode readback ${modes.length > 0 ? modes.join(", ") : "(none)"} does not include ${entry.mode}`)
      const available = modeCandidates(read(`get mode available ${entry.ip}`), entry.ip)
      if (available.length > 0) failures.push(`${entry.ip}: available modes: ${available.join(" | ")}`)
    } else {
      details.push(`${entry.ip}: mode -> ${entry.mode}`)
    }
  }
  if (dmaChecks.length > 0) {
    const section = read("dma list_all")
    const text = section === undefined ? "" : section.result.join("\n")
    for (const request of dmaChecks) {
      const match = new RegExp(`(^|[\\s:])${request}:`, "u").test(text) || text.includes(request)
      if (!match) failures.push(`DMA: request ${request} was not added`)
      else details.push(`DMA: ${request}`)
    }
    for (const entry of dmaParamChecks) {
      const line = `Dma.${entry.request}.0.${entry.key}=${entry.value}`
      if (!stagedText.split(/\r?\n/u).includes(line)) failures.push(`DMA ${entry.request}: saved .ioc does not contain ${entry.key}=${entry.value}`)
      else details.push(`DMA ${entry.request}: ${entry.key}=${entry.value}`)
    }
  }
  if (clockChecks.length > 0) {
    const actual = Number(lastValue(read("get ip parameters RCC HCLKFreq_Value")))
    for (const expected of clockChecks) {
      if (!(actual > 0) || Math.abs(actual - expected) / expected > 0.01) {
        failures.push(`clock: HCLK readback ${Number.isFinite(actual) ? actual : "(none)"} != ${expected}`)
      } else {
        details.push(`clock: HCLK=${actual}`)
      }
    }
  }
  if (nvicChecks.length > 0) {
    for (const entry of nvicChecks) {
      const prefix = `NVIC.${entry.irq}=`
      const line = stagedText.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix))
      if (line === undefined || !line.startsWith(`${prefix}true`)) failures.push(`NVIC ${entry.irq}: saved .ioc does not show it enabled`)
      else details.push(`NVIC ${entry.irq}: enabled${entry.priority === undefined ? "" : ` (priority ${entry.priority})`}`)
    }
  }
  for (const entry of expectParams) {
    const actual = lastValue(read(`get ip parameters ${entry.ip} ${paramKeyText(entry.key)}`))
    if (actual === undefined || String(actual).toUpperCase() !== entry.value.toUpperCase()) {
      failures.push(`${entry.ip} ${entry.key}: readback ${actual ?? "(none)"} != ${entry.value}`)
    } else {
      details.push(`${entry.ip}: ${entry.key}=${actual}`)
    }
  }
  return { failures, details: [...details, ...extraDetails], lines, staged }
}

/** Intent tool: short request -> resolved pins/modes/params, verified by readback. */
async function intentTool(config, args, exec) {
  requireArgs(args, ["iocPath", "intents"])
  const iocPath = resolve(args.iocPath)
  if (!(await pathExists(iocPath))) throw new Error(`.ioc not found: ${iocPath}`)
  assertIocFile(iocPath)
  await assertProjectCompatible(iocPath, config)
  if (!Array.isArray(args.intents) || args.intents.length === 0) throw new Error("intents must be a non-empty array (strings or objects)")
  const dryRun = args.dryRun === true
  if (!dryRun) {
    assertWritable(iocPath, config)
    await assertNoGui(config)
  }

  const intents = args.intents.map((raw, index) => {
    const intent = normalizeIntent(raw)
    try {
      assertIntentComplete(intent, `#${index + 1}`)
    } catch (error) {
      throw new Error(error.message.replace(/^intent #/u, "intent #"))
    }
    return intent
  })
  const iocText = await readFile(iocPath, "utf8")

  const workDir = await mkdtemp(join(tmpdir(), "dsh-cubemx-intent-"))
  // Staged file name must match the target, or saveas renames the project.
  const workIoc = join(workDir, basename(iocPath))
  try {
    await copyFile(iocPath, workIoc)
    const { assigned, issues, warnings: pinWarnings = [], clock } = await resolveIntents(config, intents, workIoc, iocText, exec)
    const warnings = [
      ...intents.flatMap((intent, index) => (intent.warnings ?? []).map((warning) => `#${index + 1}: ${warning}`)),
      ...pinWarnings.map((warning) => `WARN ${warning}`),
    ]
    if (issues.length > 0) {
      return {
        ok: false,
        summary: `Intent could not be resolved for ${iocPath}; nothing was written.`,
        details: [...issues.map((issue) => `FAIL ${issue}`), ...warnings],
        logTail: "",
      }
    }
    const applied = await applyIntents(config, args, assigned, workIoc, clock, exec)
    const describe = (resolved) => {
      const { intent } = resolved
      if (intent.kind === "gpio") return `${resolved.label}: ${intent.gpio?.direction === "output" ? "GPIO_Output" : "GPIO_Input"}`
      if (intent.kind === "dma") return `${resolved.label}: DMA ${intent.params.request}`
      if (intent.kind === "clock") return `${resolved.label}: CLOCK ${resolved.clockPlan.expectedHclk} Hz`
      if (intent.kind === "nvic") return `${resolved.label}: NVIC ${intent.params.irq}`
      return `${resolved.label}: ${resolved.modes.join(" + ")}`
    }
    const details = [...assigned.map(describe), ...applied.details, ...warnings]
    if (applied.failures.length > 0) {
      return {
        ok: false,
        summary: `Intent verification failed for ${iocPath}; the original file was not modified.`,
        details: [...applied.failures.map((failure) => `FAIL ${failure}`), ...details],
        logTail: logTailFor(config, args, applied.lines),
      }
    }
    let backupPath
    if (!dryRun) {
      const commit = await commitWorkingIoc(applied.staged, iocPath, false)
      backupPath = commit.backupPath
    }
    details.push(dryRun ? "dry run: nothing written" : backupPath === undefined ? "written (no previous file to back up)" : `backup: ${backupPath}`)
    return {
      ok: true,
      summary: dryRun
        ? `Dry run OK: ${intents.length} intent(s) resolved and verified; nothing was written.`
        : `Applied ${intents.length} intent(s) to ${iocPath} (verified by reload+readback).`,
      details,
      logTail: logTailFor(config, args, applied.lines),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      summary: { type: "string" },
      details: { type: "array", items: { type: "string" } },
      logTail: { type: "string" },
    },
    required: ["ok", "summary"],
  },
  render: (_args, value) => [{
    type: "text",
    text: [value.summary, ...(value.details ?? []), value.logTail !== undefined && value.logTail.length > 0 ? `--- CubeMX CLI tail ---\n${value.logTail}` : ""]
      .filter((part) => part.length > 0)
      .join("\n"),
  }],
}

function makeTools(config) {
  const timeoutMs = config.timeoutMs + 60000
  return [
    {
      name: "stm32_cubemx_inspect",
      description: "Read-only: load an STM32 .ioc project through the official STM32CubeMX CLI and report the MCU, package, and current pin assignment. Does not modify the project.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          pins: { type: "array", items: { type: "string" }, description: "Optional pin filter, for example [\"PB12\", \"PA5\"]." },
        },
        required: ["iocPath"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return inspectProject(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_configure",
      description: "Configure STM32 pins (signal, label, pull) and peripheral modes in an .ioc project by driving the official CubeMX CLI. Transactional: edits a copy, reloads and reads back every change, then backs up and replaces the original only when verification passes. Optionally generates the HAL project in the same session.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the existing .ioc file." },
          pins: {
            type: "array",
            description: "Pins to configure. Each entry needs pin and signal (for example GPIO_Input, GPIO_Output, USART2_TX); label and pull are optional.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                pin: { type: "string" },
                signal: { type: "string" },
                label: { type: "string" },
                pull: { type: "string", description: "GPIO_PULLUP / GPIO_PULLDOWN / GPIO_NOPULL (short aliases accepted)." },
              },
              required: ["pin", "signal"],
            },
          },
          modes: {
            type: "array",
            description: "Peripheral modes to set, for example [{ ip: \"USART2\", mode: \"Asynchronous\" }].",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                ip: { type: "string" },
                mode: { type: "string" },
              },
              required: ["ip", "mode"],
            },
          },
          saveTo: { type: "string", description: "Optional alternative .ioc output path; defaults to replacing iocPath." },
          dryRun: { type: "boolean", description: "When true, verify on the copy but write nothing." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
          generate: {
            type: "object",
            description: "Optional HAL project generation in the same CubeMX session.",
            additionalProperties: false,
            properties: {
              outputDir: { type: "string", description: "Absolute output directory (must be inside allowedRoots)." },
              projectName: { type: "string" },
              toolchain: { type: "string", description: "CubeMX toolchain name, for example CMake." },
            },
            required: ["outputDir"],
          },
        },
        required: ["iocPath"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return configureProject(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_generate",
      description: "Generate the HAL project for an existing .ioc through the official CubeMX CLI (config load + project generate) without opening the GUI.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          outputDir: { type: "string", description: "Absolute output directory; must be writable (allowAnyPath: true, or inside allowedRoots)." },
          projectName: { type: "string", description: "CubeMX project name." },
          toolchain: { type: "string", description: "CubeMX toolchain name, for example CMake, STM32CubeIDE, MDK-ARM." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
        },
        required: ["iocPath", "outputDir", "projectName", "toolchain"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return generateProject(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_script",
      description: "Escape hatch: run an arbitrary CubeMX CLI command sequence through `-q`. Commands are executed verbatim (config load / set / get / project generate / exit). Use only when the structured tools cannot express the change.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          commands: { type: "array", items: { type: "string" }, description: "Command lines, executed in order. Include `exit` last; at most 60 lines." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
        },
        required: ["commands"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return runRawScript(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_clock",
      description: "Set the clock tree through CubeMX's `clock set` commands, either with the family's maximum-HCLK preset (F1 72 MHz, F4 168 MHz) or with semantic arguments (HSE on/off, PLL multiplier, SYSCLK source, APB1/APB2/ADC dividers). Transactional: applies to a copy, reads HCLK/SYSCLK/APB back, then backs up and replaces the .ioc.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          preset: { type: "string", enum: ["max"], description: "\"max\" applies the family maximum-HCLK preset." },
          family: { type: "string", description: "Optional family override for the preset, for example F1 or F4." },
          hse: { type: "boolean", description: "Enable HSE crystal (Crystal/Ceramic Resonator)." },
          pllSource: { type: "string", enum: ["HSI", "HSE"], description: "PLL source." },
          pllMul: { type: "number", description: "F1 PLL multiplier, for example 9." },
          sysclkSource: { type: "string", enum: ["HSI", "HSE", "PLL"], description: "SYSCLK source." },
          hclk: { type: "number", description: "Expected HCLK in Hz for verification, for example 72000000." },
          apb1Div: { type: "number", description: "APB1 divider (1/2/4/8/16)." },
          apb2Div: { type: "number", description: "APB2 divider (1/2/4/8/16)." },
          adcDiv: { type: "number", description: "ADC prescaler (2/4/6/8)." },
          dryRun: { type: "boolean", description: "Verify on the copy but write nothing." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
        },
        required: ["iocPath"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return clockTool(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_nvic",
      description: "Query or change NVIC settings through CubeMX's NVIC command group: enable/disable an IRQ, set preemption/sub priority, set the priority group, or list interrupts. Changes are applied to a copy and committed with a .bak backup.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          action: { type: "string", enum: ["get_interrupts", "get_prioritygroup", "enable", "disable", "set_priority", "set_subpriority", "set_prioritygroup"], description: "Operation to run." },
          irq: {
            anyOf: [{ type: "number" }, { type: "string" }],
            description: "IRQ vector name like TIM3_IRQn / USART1_IRQn (preferred; CubeMX rejects bare numbers on most MCUs) or a number if the MCU accepts it. `get_interrupts` lists the valid names.",
          },
          value: { type: "number", description: "Priority, subpriority, or priority-group value." },
          dryRun: { type: "boolean", description: "Verify on the copy but write nothing." },
          verbose: { type: "boolean", description: "Return the full CubeMX log." },
        },
        required: ["iocPath", "action"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return nvicTool(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_dma",
      description: "Read-only DMA discovery through CubeMX's dma command group: list all requests, list a peripheral's requests, list available requests/streams. Mutating DMA configuration still goes through stm32_cubemx_script (dma add/set_param/...).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          action: { type: "string", enum: ["list_all", "list_periph", "available_periph_requests", "available_streams"], description: "Read-only query." },
          peripheral: { type: "string", description: "Peripheral name for list_periph / available_periph_requests, for example USART2." },
          request: { type: "string", description: "DMA request name for available_streams." },
          verbose: { type: "boolean", description: "Return the full CubeMX log." },
        },
        required: ["iocPath", "action"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return dmaTool(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_new_project",
      description: "Create a brand-new STM32CubeMX project from an MCU part number and generate its HAL code, applying the user's house defaults: Advanced structure (Core/Src), separate .c/.h per peripheral, CMake toolchain, SYS = Serial Wire + SysTick, RCC = HSE crystal, and the family's maximum HCLK (F1 72 MHz, F4 168 MHz; other families get SYS/RCC only plus a warning).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          mcu: { type: "string", description: "CubeMX MCU name, for example STM32F103C8Tx." },
          projectDir: { type: "string", description: "Absolute parent directory; the project folder <projectDir>\\<projectName> is created inside it." },
          projectName: { type: "string", description: "Project name, also the generated folder and .ioc name." },
          toolchain: { type: "string", description: "CubeMX toolchain, defaults to CMake." },
          applyDefaults: { type: "boolean", description: "false disables the SYS/RCC/clock house defaults (structure, per-peripheral files and toolchain still apply)." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
        },
        required: ["mcu", "projectDir", "projectName"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return newProject(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_rollback",
      description: "List or restore the timestamped .bak-* backups that stm32_cubemx_configure leaves next to an .ioc file. restore copies the chosen (or latest) backup over the .ioc and first snapshots the current file, so the action itself is reversible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          action: { type: "string", enum: ["list", "restore"], description: "list available backups, or restore one." },
          backup: { type: "string", description: "restore only: exact backup file name or its timestamp suffix; defaults to the latest." },
        },
        required: ["iocPath", "action"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return rollbackProject(config, args, exec)
      },
    },
    {
      name: "stm32_cubemx_intent",
      description: "Configure peripherals from a short intent instead of CubeMX ids. Supports UART (\"USART2 115200 TX=PA2 RX=PA3\"), I2C (\"I2C1 SCL=PB6 SDA=PB7\"), SPI (\"SPI1 SCK=PA5 MISO=PA6 MOSI=PA7\"), timer PWM with optional frequency/duty (\"TIM3 PWM CH1=PA6 1kHz duty=25\"), ADC channels (\"ADC1 IN0=PA0\", \"ADC1 PA1\" auto channel), CAN (\"CAN1 TX=PA12 RX=PA11\"), GPIO (\"PB12 输入 上拉 label=KEY1\"), DAC (\"DAC OUT1=PA4 OUT2=PA5\"), USB (\"USB 设备\" = USB_OTG_FS Device_Only, DM/DP auto), DMA (\"DMA USART1_TX\", plus parameters like direction=P2M / priority=HIGH), FSMC (\"FSMC NAND 8bit\" auto-assigns the NAND pin group; profile NAND8 or NOR16), NVIC (\"NVIC TIM3_IRQn\" or \"USART1 中断\", optional priority=2) and clock (\"CLOCK max\" or \"CLOCK 120MHz\"; explicit pllMul/apb1Div/apb2Div/adcDiv overrides). Object form also accepted ({kind,instance,pins,params,...}). Resolves pin signals, mode ids and IP parameters, applies them in one transactional CubeMX session, then reloads and verifies every value by readback (dryRun supported). Missing pins are auto-selected from the package and cached per MCU. CubeMX CLI cannot set the ADC sampling time; that stays at the project default.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          iocPath: { type: "string", description: "Absolute path to the .ioc file." },
          intents: {
            type: "array",
            description: "Intents as strings (\"USART2 115200 TX=PA2 RX=PA3\") or objects ({kind,instance,pins:{TX:PA2},params:{BaudRate:115200}}).",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    kind: { type: "string", description: "uart | i2c | spi | tim | adc | can | dac | usb | fsmc | dma | nvic | clock | gpio (optional when instance is given)." },
                    instance: { type: "string", description: "Peripheral instance, for example USART2, I2C1, TIM3, ADC1, CAN1." },
                    pin: { type: "string", description: "Single pin (GPIO), the channel pin of a timer, or an ADC pin." },
                    channel: { type: "string", description: "Timer channel (CH1) or ADC channel (IN0)." },
                    role: { type: "string", description: "Role for pin, for example TX / RX / SCL / SDA / SCK / MISO / MOSI / CH1 / IN0." },
                    pins: {
                      anyOf: [
                        { type: "object", additionalProperties: { type: "string" } },
                        { type: "array", items: { type: "object", additionalProperties: true } },
                      ],
                      description: "Role -> pin map, for example {\"TX\":\"PA2\",\"RX\":\"PA3\"}.",
                    },
                    params: { type: "object", additionalProperties: true, description: "IP parameters, for example {\"BaudRate\":115200}." },
                    mode: { type: "string", description: "Explicit CubeMX mode id; normally inferred." },
                    direction: { type: "string", enum: ["input", "output"] },
                    pull: { type: "string", description: "up / down / none (GPIO only)." },
                    label: { type: "string", description: "GPIO label (ASCII)." },
                    baud: { type: "number", description: "UART baud rate shortcut." },
                    freq: { type: "number", description: "Timer PWM frequency in Hz (Prescaler/Period are computed from the APB timer clock)." },
                    duty: { type: "number", description: "Timer PWM duty in percent, default 50." },
                    sampling: { type: "string", description: "ADC sampling time (accepted for clarity but rejected: CubeMX CLI cannot store it)." },
                    request: { type: "string", description: "DMA request name for kind \"dma\", for example USART1_TX or ADC1." },
                    profile: { type: "string", description: "FSMC profile for kind \"fsmc\": nand8 (default) or nor16." },
irq: { type: "string", description: "NVIC vector name for kind \"nvic\", for example TIM3_IRQn." },
priority: { anyOf: [{ type: "number" }, { type: "string" }], description: "NVIC priority (0-15) for kind \"nvic\", or DMA priority (LOW/MEDIUM/HIGH/VERY_HIGH) for kind \"dma\"." },
max: { type: "boolean", description: "Clock intent: apply the family maximum-HCLK preset." },
hclk: { type: "number", description: "Clock intent: target HCLK in Hz (solved for F1/F4)." },
pllMul: { type: "number", description: "Clock intent (F1): explicit PLL multiplier." },
pllM: { type: "number", description: "Clock intent (F4): explicit PLLM." },
pllN: { type: "number", description: "Clock intent (F4): explicit PLLN." },
pllP: { type: "number", description: "Clock intent (F4): explicit PLLP (2/4/6/8)." },
pllQ: { type: "number", description: "Clock intent (F4): explicit PLLQ." },
apb1Div: { type: "number", description: "Clock intent: APB1 divider." },
apb2Div: { type: "number", description: "Clock intent: APB2 divider." },
adcDiv: { type: "number", description: "Clock intent (F1): ADC prescaler." },
                  },
                },
              ],
            },
          },
          dryRun: { type: "boolean", description: "When true, resolve and verify on a copy but write nothing." },
          verbose: { type: "boolean", description: "Return the full CubeMX log instead of a short tail." },
        },
        required: ["iocPath", "intents"],
      },
      output: OUTPUT,
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return intentTool(config, args, exec)
      },
    },
  ]
}

/** Text shown by the /cubemx human command. */
function cubemxHelp(topic) {
  const wanted = String(topic ?? "").trim().toLowerCase()
  const sections = {
    pins: [
      "配引脚：直接说「把 <ioc> 的 PB12 配成 GPIO_Input 上拉」或贴清单。",
      "流程：stm32_cubemx_inspect → stm32_cubemx_configure(dryRun:true) → 确认后写入（自动 .bak）。",
    ],
    project: [
      "新建工程：stm32_cubemx_new_project（Advanced、每外设 .c/.h、CMake、SWD、HSE、系列最大 HCLK）。",
      "生成已有工程：stm32_cubemx_generate。",
    ],
    clock: [
      "时钟：stm32_cubemx_clock(preset:\"max\") 或 pllMul/sysclkSource/apb1Div 等语义参数；dryRun 可先验证。",
    ],
    rollback: [
      "回滚：stm32_cubemx_rollback(action:\"list\"|\"restore\")，恢复 configure 留下的 .bak。",
    ],
  }
  const head = "STM32CubeMX 插件：直接说需求即可调用工具，无需写 JSON。"
  if (sections[wanted] !== undefined) return [head, ...sections[wanted]].join("\n")
  return [
    head,
    ...Object.values(sections).flat(),
    "开始：说“看看 <ioc> 的配置”或“把 PB12 配成输入上拉”。",
  ].join("\n")
}

/** Register the CubeMX tool family and the /cubemx help command. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  for (const tool of makeTools(resolved)) ctx.tools.register(tool)
  ctx.inject(["commands"], (scope) => {
    scope.commands.register({
      name: "cubemx",
      description: "STM32CubeMX 插件用法速查（pins / project / clock / rollback）",
      input: { hint: "可选主题：pins | project | clock | rollback" },
      handler: (invocation) => ({ kind: "success", text: cubemxHelp(invocation.rawInput) }),
    })
  })
}
