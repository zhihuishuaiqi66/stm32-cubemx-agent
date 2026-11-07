#!/usr/bin/env node
/**
 * Command-line front end for the stm32-cubemx tools.
 *
 * The MCP server (server.mjs) needs a client that speaks the protocol. This CLI
 * exposes the very same 10 tools as plain commands, so any agent that can run a
 * shell command can drive STM32CubeMX — WorkBuddy, Codex, Cursor, a batch file,
 * or a human in PowerShell.
 *
 * Usage:
 *   node cli.mjs <tool> [--option value ...] [--json]
 *   node cli.mjs --help
 *
 * Examples:
 *   node cli.mjs inspect --ioc "D:\work\my project\board.ioc"
 *   node cli.mjs configure --ioc board.ioc --pins '[{"pin":"PB12","signal":"GPIO_Input","label":"KEY1","pull":"GPIO_PULLUP"}]' --dry-run
 *   node cli.mjs clock --ioc board.ioc --preset max
 *   node cli.mjs rollback --ioc board.ioc --action list
 *
 * Zero npm dependencies: the tools come from ../dsh-stm32-cubemx/index.js through
 * the same fake-ctx adapter the MCP server uses.
 */
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { readFileSync } from "node:fs"

const here = dirname(fileURLToPath(import.meta.url))
const pluginEntry = process.env.CUBEMX_PLUGIN_ENTRY ?? join(here, "..", "dsh-stm32-cubemx", "index.js")

/** Tool aliases so agents can use short kebab-case names. */
const ALIASES = new Map([
  ["inspect", "stm32_cubemx_inspect"],
  ["configure", "stm32_cubemx_configure"],
  ["generate", "stm32_cubemx_generate"],
  ["script", "stm32_cubemx_script"],
  ["clock", "stm32_cubemx_clock"],
  ["nvic", "stm32_cubemx_nvic"],
  ["dma", "stm32_cubemx_dma"],
  ["intent", "stm32_cubemx_intent"],
  ["intents", "stm32_cubemx_intent"],
  ["new-project", "stm32_cubemx_new_project"],
  ["new_project", "stm32_cubemx_new_project"],
  ["rollback", "stm32_cubemx_rollback"],
])

const TOOL_OPTIONS = new Map([
  ["stm32_cubemx_inspect", ["iocPath", "pins"]],
  ["stm32_cubemx_configure", ["iocPath", "pins", "pin", "modes", "mode", "saveTo", "dryRun", "verbose", "generate"]],
  ["stm32_cubemx_generate", ["iocPath", "outputDir", "projectName", "toolchain", "verbose"]],
  ["stm32_cubemx_script", ["commands", "verbose"]],
  ["stm32_cubemx_clock", ["iocPath", "preset", "family", "hse", "pllSource", "pllMul", "sysclkSource", "hclk", "apb1Div", "apb2Div", "adcDiv", "dryRun", "verbose"]],
  ["stm32_cubemx_nvic", ["iocPath", "action", "irq", "value", "dryRun", "verbose"]],
  ["stm32_cubemx_dma", ["iocPath", "action", "peripheral", "request", "verbose"]],
  ["stm32_cubemx_intent", ["iocPath", "intents", "intent", "dryRun", "verbose"]],
  ["stm32_cubemx_new_project", ["mcu", "projectDir", "projectName", "toolchain", "applyDefaults", "verbose"]],
  ["stm32_cubemx_rollback", ["iocPath", "action", "backup"]],
])

const HELP = `stm32-cubemx CLI — drive STM32CubeMX through its official command line

Tools:
  inspect      --ioc <path> [--pins PA5,PB10]          read MCU/pins (read-only)
  intent       --ioc <path> --intent "USART2 115200 TX=PA2 RX=PA3" [--intent ...] [--dry-run]
               (understands 串口2 / 定时器3 / 上拉 / 输入; object form via --intents @file.json)
  configure    --ioc <path> --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP" [--pin ...] [--dry-run]
               (or --pins '[{"pin":"PB12","signal":"GPIO_Input"}]')
  generate     --ioc <path> --output <dir> --name <n> [--toolchain CMake]
  clock        --ioc <path> --preset max | --pll-mul 9 --sysclk PLL ...
  nvic         --ioc <path> --action get_interrupts|enable|... [--irq N] [--value V]
  dma          --ioc <path> --action list_all|list_periph|...
  new-project  --mcu STM32F103C8Tx --dir <parent> --name <project> [--toolchain CMake]
  rollback     --ioc <path> --action list|restore [--backup <name>]
  script       --commands <json array of CLI lines>  (or --commands @file.json)

Common:
  --json       print the raw tool result instead of the rendered text
  --verbose    ask CubeMX for the full log tail
  --help       this text

Environment: CUBEMX_HOME, CUBEMX_JAVA, CUBEMX_ALLOW_ANY_PATH, CUBEMX_ALLOWED_ROOTS,
CUBEMX_ALLOW_GUI_RUNNING, CUBEMX_TIMEOUT_MS, CUBEMX_CHECK_PROJECT_VERSION, CUBEMX_PLUGIN_ENTRY

Each call starts one CubeMX CLI session: expect 10-60 s.
`

/** "--dry-run" -> dryRun; "--pll-mul" -> pllMul; "--ioc" -> iocPath. */
function optionName(flag) {
  const parts = flag.replace(/^--/u, "").split("-")
  return parts[0] + parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")
}

const OPTION_ALIASES = new Map([["ioc", "iocPath"], ["output", "outputDir"], ["dir", "projectDir"], ["name", "projectName"]])

/** Parse a CLI string into the JSON type the tool schema expects. */
function coerce(value) {
  const text = value.trim()
  if (text === "true") return true
  if (text === "false") return false
  if (/^-?\d+(\.\d+)?$/u.test(text)) return Number(text)
  if (text.startsWith("[") || text.startsWith("{")) {
    try { return JSON.parse(text) } catch (error) { throw new Error(`invalid JSON for an option: ${error.message}`) }
  }
  if (text.startsWith("@")) {
    // @file.json  -> read JSON from a file (keeps long pin lists out of the shell)
    const raw = readFileSync(resolve(text.slice(1)), "utf8").replace(/^\uFEFF/u, "")
    return JSON.parse(raw)
  }
  return value
}

function parseArgs(argv) {
  const args = { _: [], json: false }
  const repeated = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--json") { args.json = true; continue }
    if (token === "--help" || token === "-h") { args.help = true; continue }
    if (!token.startsWith("--")) { args._.push(token); continue }
    const key = optionName(token)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) { args[key] = true; continue }
    const value = coerce(next)
    // --pin / --mode / --intent may be repeated to describe several items in one call.
    if (key === "pin" || key === "mode" || key === "intent") {
      const list = repeated.get(key) ?? []
      list.push(value)
      repeated.set(key, list)
      args[key] = list
    } else {
      args[key] = value
    }
    index += 1
  }
  return args
}

/** "PB12:GPIO_Input:KEY1:GPIO_PULLUP" -> { pin, signal, label, pull } (label/pull optional). */
function parsePinSpec(spec) {
  const [pin, signal, label, pull] = String(spec).split(":")
  if (pin === undefined || signal === undefined) throw new Error(`--pin needs "PIN:signal[:label[:pull]]", got "${spec}"`)
  const entry = { pin: pin.trim(), signal: signal.trim() }
  if (label !== undefined && label.trim().length > 0) entry.label = label.trim()
  if (pull !== undefined && pull.trim().length > 0) entry.pull = pull.trim()
  return entry
}

async function loadTools() {
  const plugin = await import(pathToFileURL(pluginEntry).href)
  const captured = []
  const ctx = { tools: { register: (tool) => captured.push(tool) }, inject() {} }
  const config = {}
  if (process.env.CUBEMX_HOME) config.mxHome = process.env.CUBEMX_HOME
  if (process.env.CUBEMX_JAVA) config.javaPath = process.env.CUBEMX_JAVA
  // The CLI is a local, single-user tool: default to global writes (like this
  // machine's cordis.patch.yml) so agents do not have to export env vars first.
  // Set CUBEMX_ALLOW_ANY_PATH=false (plus CUBEMX_ALLOWED_ROOTS) to restrict it.
  config.allowAnyPath = process.env.CUBEMX_ALLOW_ANY_PATH === undefined ? true : process.env.CUBEMX_ALLOW_ANY_PATH === "true"
  if (process.env.CUBEMX_ALLOWED_ROOTS) config.allowedRoots = process.env.CUBEMX_ALLOWED_ROOTS.split(";").filter((part) => part.length > 0)
  if (process.env.CUBEMX_ALLOW_GUI_RUNNING !== undefined) config.allowGuiRunning = process.env.CUBEMX_ALLOW_GUI_RUNNING === "true"
  if (process.env.CUBEMX_TIMEOUT_MS) config.timeoutMs = Number(process.env.CUBEMX_TIMEOUT_MS)
  if (process.env.CUBEMX_CHECK_PROJECT_VERSION !== undefined) config.checkProjectVersion = process.env.CUBEMX_CHECK_PROJECT_VERSION === "true"
  plugin.apply(ctx, config)
  return new Map(captured.map((tool) => [tool.name, tool]))
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP)
  process.exit(argv.length === 0 ? 1 : 0)
}

const parsed = (() => {
  try { return parseArgs(argv) } catch (error) {
    process.stderr.write(`error: ${error.message}\n`)
    process.exit(2)
  }
})()
if (parsed.help) { process.stdout.write(HELP); process.exit(0) }
const requested = parsed._[0]
const toolName = ALIASES.get(requested) ?? (requested !== undefined && requested.startsWith("stm32_cubemx_") ? requested : undefined)
if (toolName === undefined) {
  process.stderr.write(`unknown tool "${requested ?? ""}"\n\n${HELP}`)
  process.exit(2)
}

const tools = await loadTools()
const tool = tools.get(toolName)
if (tool === undefined) {
  process.stderr.write(`tool ${toolName} is not registered by ${pluginEntry}\n`)
  process.exit(2)
}

const allowed = new Set(TOOL_OPTIONS.get(toolName) ?? [])
const args = {}
for (const [key, value] of Object.entries(parsed)) {
  if (key === "_" || key === "json" || key === "help") continue
  const name = OPTION_ALIASES.get(key) ?? key
  if (!allowed.has(name)) {
    process.stderr.write(`warning: ${toolName} has no option "${name}" (ignored)\n`)
    continue
  }
  args[name] = value
}

// Array-shaped options: accept friendly, shell-safe forms too.
if (Array.isArray(args.pin) || typeof args.pin === "string") {  const specs = Array.isArray(args.pin) ? args.pin : [args.pin]
  const pins = specs.map(parsePinSpec)
  if (args.pins !== undefined) process.stderr.write("warning: --pins overrides --pin\n")
  else args.pins = pins
  delete args.pin
}
if (Array.isArray(args.mode) || typeof args.mode === "string") {
  const specs = Array.isArray(args.mode) ? args.mode : [args.mode]
  args.modes = specs.map((spec) => {
    const [ip, mode] = String(spec).split(":")
    if (ip === undefined || mode === undefined) throw new Error(`--mode needs "IP:mode", got "${spec}"`)
    return { ip: ip.trim(), mode: mode.trim() }
  })
  delete args.mode
}
if (Array.isArray(args.intent) || typeof args.intent === "string") {
  const specs = Array.isArray(args.intent) ? args.intent : [args.intent]
  if (Array.isArray(args.intents)) args.intents.push(...specs)
  else args.intents = specs
  delete args.intent
}
if (typeof args.intents === "string") args.intents = [args.intents]
if (typeof args.pins === "string") {
  if (toolName === "stm32_cubemx_inspect") {
    args.pins = args.pins.split(/[,;\s]+/u).map((pin) => pin.trim()).filter((pin) => pin.length > 0)
  } else {
    process.stderr.write("error: --pins for configure takes a JSON array; simpler: --pin PIN:signal[:label[:pull]] (repeatable)\n")
    process.exit(2)
  }
}
if (toolName === "stm32_cubemx_script" && typeof args.commands === "string") args.commands = [args.commands]

try {
  const value = await tool.execute(args, {})
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  } else {
    const parts = tool.output.render(args, value)
    process.stdout.write(`${parts.map((part) => part.text).join("\n")}\n`)
  }
  process.exit(value.ok === false ? 1 : 0)
} catch (error) {
  process.stderr.write(`FAIL ${toolName}: ${error.message}\n`)
  process.exit(1)
}
