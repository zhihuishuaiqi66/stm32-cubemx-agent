#!/usr/bin/env node
/**
 * stm32-cubemx-mcp
 * ================
 * 把 DeepSeek Harness 的 STM32CubeMX 插件（同仓库的
 * ..\dsh-stm32-cubemx\index.js，共 10 个工具）包装成一个「零 npm 依赖」的
 * MCP stdio server，供 Claude Code / Codex / Cursor / WorkBuddy / Command Code
 * 等任意 MCP 客户端调用。
 *
 * 核心做法（原插件一行都不改）
 * -----------------------------
 * 插件只要求两样东西：ctx.tools.register(tool) 和 ctx.inject(deps, cb)。
 * 这里给 apply() 传一个「假 ctx」，把 10 个工具对象收集到数组里：
 *
 *   apply({ tools: { register(t) { captured.push(t) } }, inject() {} }, config)
 *
 * 传输层：MCP stdio = 「换行分隔的 JSON-RPC 2.0」，一行一条消息
 * （不是 LSP 那种 Content-Length 头）。
 *
 * 依赖：只用 node: 内置模块。
 *
 * 运行：node server.mjs    （stdin 读 JSON-RPC，stdout 写 JSON-RPC）
 * 调试：MCP_DEBUG=1，日志走 stderr，不污染协议流。
 * 配置：见同目录 README.md（CUBEMX_HOME / CUBEMX_ALLOW_ANY_PATH / ...）。
 */

import { createInterface } from "node:readline"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const SERVER_NAME = "stm32-cubemx-mcp"
const SERVER_VERSION = "1.3.0"
const LATEST_PROTOCOL = "2025-06-18"
// 本 server 已知的协议版本：客户端要哪个（已知的）就回哪个，否则回最新。
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"]
const DEBUG = process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true"

/** 调试日志只写 stderr：stdout 是协议流，写一个字符都不行。 */
function log(...parts) {
  if (!DEBUG) return
  process.stderr.write(`[${SERVER_NAME}] ${parts.join(" ")}\n`)
}

// ---------------------------------------------------------------------------
// 1. 读环境变量 -> 插件 config（等价于插件 cordis.patch.yml 里的 config）
// ---------------------------------------------------------------------------

function envBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const text = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(text)) return true
  if (["0", "false", "no", "off"].includes(text)) return false
  throw new Error(`${name} 只接受 true/false（当前值: ${raw}）`)
}

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} 必须是整数（当前值: ${raw}）`)
  return value
}

/** CUBEMX_ALLOWED_ROOTS 用 Windows 分号分隔，例如 D:\proj;E:\work。 */
function envPathList(name) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return []
  return raw.split(";").map((part) => part.trim()).filter((part) => part.length > 0)
}

function buildConfig() {
  const config = {
    mxHome: process.env.CUBEMX_HOME ?? process.env.CUBEMX_MX_HOME ?? "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX",
    allowAnyPath: envBool("CUBEMX_ALLOW_ANY_PATH", true),
    allowGuiRunning: envBool("CUBEMX_ALLOW_GUI_RUNNING", false),
    allowedRoots: envPathList("CUBEMX_ALLOWED_ROOTS"),
    timeoutMs: envInt("CUBEMX_TIMEOUT_MS", 300000),
    maxLogChars: envInt("CUBEMX_MAX_LOG_CHARS", 4000),
  }
  if (process.env.CUBEMX_JAVA_PATH !== undefined && process.env.CUBEMX_JAVA_PATH.trim().length > 0) {
    config.javaPath = process.env.CUBEMX_JAVA_PATH.trim()
  }
  // 插件 v1.2.0+ 的跨版本预检开关；不设时沿用插件默认（true）。旧插件会忽略这个键。
  if (process.env.CUBEMX_CHECK_PROJECT_VERSION !== undefined && process.env.CUBEMX_CHECK_PROJECT_VERSION.trim().length > 0) {
    config.checkProjectVersion = envBool("CUBEMX_CHECK_PROJECT_VERSION", true)
  }
  return config
}

// ---------------------------------------------------------------------------
// 2. 加载原插件：假 ctx 适配器，拿到 10 个工具对象
// ---------------------------------------------------------------------------

function pluginEntryPath() {
  const override = process.env.CUBEMX_PLUGIN_ENTRY
  if (override !== undefined && override.trim().length > 0) return resolve(override.trim())
  // 默认：本文件在 <repo>\plugins\stm32-cubemx-mcp\server.mjs，
  // 插件在 <repo>\plugins\dsh-stm32-cubemx\index.js（与本包同级）。
  return resolve(__dirname, "..", "dsh-stm32-cubemx", "index.js")
}

async function loadTools() {
  const entry = pluginEntryPath()
  const config = buildConfig()
  let plugin
  try {
    plugin = await import(pathToFileURL(entry).href)
  } catch (error) {
    throw new Error(`无法加载插件 ${entry}：${error.message}`)
  }
  if (typeof plugin.apply !== "function") {
    throw new Error(`插件 ${entry} 没有导出 apply(ctx, config)`)
  }

  // ---- 关键：假 ctx ---------------------------------------------------------
  const captured = []
  const fakeCtx = {
    tools: {
      register(tool) {
        captured.push(tool)
      },
    },
    inject(_dependencies, _callback) {
      // 插件还会注册 /cubemx 对话框命令；MCP 没有「命令」概念，直接忽略。
    },
  }
  // 同步注册；config 与原插件 cordis.patch.yml 的默认值一致。
  plugin.apply(fakeCtx, config)

  if (captured.length === 0) throw new Error("插件返回了 0 个工具，适配器可能失效")
  const toolsByName = new Map()
  for (const tool of captured) {
    if (typeof tool?.name !== "string" || typeof tool?.execute !== "function") {
      throw new Error(`插件注册了非法工具对象: ${JSON.stringify(tool?.name)}`)
    }
    toolsByName.set(tool.name, tool)
  }
  log(`已从 ${entry} 捕获 ${captured.length} 个工具: ${[...toolsByName.keys()].join(", ")}`)
  return { tools: captured, toolsByName, config, entry }
}

// ---------------------------------------------------------------------------
// 3. JSON-RPC 2.0 over stdio（换行分隔）
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function sendError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: "2.0", id, error })
}

// 工具调用串行队列：CubeMX CLI 是重进程（20–60 秒/次），并发跑容易互相踩。
// 其他方法（ping / tools/list / initialize）不进队列，立即回。
let callQueue = Promise.resolve()
const activeCalls = new Map() // String(requestId) -> AbortController

function initializeResult(params) {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : ""
  const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: [
      "STM32CubeMX 自动化工具集（10 个，底层调用官方 CubeMX CLI）。",
      "只读：stm32_cubemx_inspect、stm32_cubemx_dma、stm32_cubemx_rollback(action=list)。",
      "修改：stm32_cubemx_configure（建议先 dryRun:true）、stm32_cubemx_clock、stm32_cubemx_nvic；写入前自动留 .bak 备份。",
      "新建/生成：stm32_cubemx_new_project、stm32_cubemx_generate。逃生通道：stm32_cubemx_script。",
      "每次工具调用会启动一次 CubeMX CLI，通常耗时 20–60 秒，请给客户端留足超时（建议 ≥ 120 秒）。",
    ].join("\n"),
  }
}

function listTools(tools) {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.parameters ?? { type: "object", properties: {} },
    })),
  }
}

/** 把插件的 [{type:"text",text}] 渲染结果转成 MCP 的 content 数组。 */
function renderContent(tool, args, value) {
  const content = []
  if (typeof tool.output?.render === "function") {
    for (const part of tool.output.render(args, value) ?? []) {
      if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text })
      else content.push({ type: "text", text: JSON.stringify(part) })
    }
  }
  if (content.length === 0) content.push({ type: "text", text: JSON.stringify(value ?? null) })
  return content
}

async function dispatchToolCall(msg) {
  const { id, params } = msg
  const name = params?.name
  if (typeof name !== "string" || name.length === 0) {
    throw new RpcError(-32602, "tools/call 需要一个字符串参数 name")
  }
  const tool = toolsByName.get(name)
  if (tool === undefined) {
    throw new RpcError(-32602, `未知工具: ${name}`, { availableTools: [...toolsByName.keys()] })
  }

  const args = params?.arguments ?? {}
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(-32602, "tools/call 的 arguments 必须是对象")
  }

  // exec 只被插件用来读 exec.signal；传 AbortSignal 让 MCP 的取消能杀掉 CubeMX 子进程。
  const controller = new AbortController()
  const key = String(id)
  activeCalls.set(key, controller)
  const limitMs = Number.isFinite(tool.timeoutMs) ? tool.timeoutMs : 360000
  let timer
  const outerTimeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RpcError(-32603, `工具 ${name} 超过 ${limitMs} ms 仍未返回（已请求终止 CubeMX）`))
    }, limitMs)
  })

  try {
    const value = await Promise.race([tool.execute(args, { signal: controller.signal }), outerTimeout])
    const isError = value !== null && typeof value === "object" && value.ok === false
    return { content: renderContent(tool, args, value), isError }
  } catch (error) {
    if (error instanceof RpcError) throw error
    // 工具内部抛错（参数不合法、.ioc 不存在、CubeMX 报错…）按 MCP 约定回 isError:true。
    return { content: [{ type: "text", text: `工具执行失败：${error?.message ?? String(error)}` }], isError: true }
  } finally {
    clearTimeout(timer)
    activeCalls.delete(key)
  }
}

function handleNotification(method, params) {
  if (method === "notifications/cancelled") {
    const requestId = params?.requestId
    const controller = activeCalls.get(String(requestId))
    if (controller !== undefined) {
      log(`收到取消通知，终止请求 ${requestId}`)
      controller.abort()
    } else {
      log(`收到取消通知，但请求 ${requestId} 不在运行中`)
    }
    return
  }
  // notifications/initialized、notifications/roots/list_changed 等：无需动作。
  log(`忽略通知 ${method}`)
}

async function handleMessage(msg) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(null, -32600, "Invalid Request：消息必须是 JSON 对象")
    return
  }
  const method = msg.method
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null

  if (typeof method !== "string") {
    if (hasId) sendError(msg.id, -32600, "Invalid Request：缺少 method")
    return
  }

  if (!hasId) {
    handleNotification(method, msg.params)
    return
  }

  if (method === "tools/call") {
    callQueue = callQueue
      .then(async () => {
        try {
          sendResult(msg.id, await dispatchToolCall(msg))
        } catch (error) {
          if (error instanceof RpcError) sendError(msg.id, error.code, error.message, error.data)
          else sendError(msg.id, -32603, `内部错误：${error?.message ?? String(error)}`)
        }
      })
      .catch((error) => log("调用队列异常", error?.stack ?? String(error)))
    return
  }

  try {
    if (method === "initialize") {
      sendResult(msg.id, initializeResult(msg.params))
      return
    }
    if (method === "ping") {
      sendResult(msg.id, {})
      return
    }
    if (method === "tools/list") {
      sendResult(msg.id, listTools(tools))
      return
    }
    sendError(msg.id, -32601, `Method not found: ${method}`)
  } catch (error) {
    sendError(msg.id, -32603, `内部错误：${error?.message ?? String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// 4. 启动
// ---------------------------------------------------------------------------

let tools
let toolsByName
try {
  ;({ tools, toolsByName } = await loadTools())
} catch (error) {
  process.stderr.write(`[${SERVER_NAME}] 启动失败：${error?.message ?? String(error)}\n`)
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })

rl.on("line", (line) => {
  const text = line.trim()
  if (text.length === 0) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch (error) {
    sendError(null, -32700, `Parse error：${error.message}`)
    return
  }
  void handleMessage(msg).catch((error) => {
    log("未捕获异常", error?.stack ?? String(error))
    if (msg !== null && typeof msg === "object" && Object.prototype.hasOwnProperty.call(msg, "id")) {
      sendError(msg.id, -32603, `内部错误：${error?.message ?? String(error)}`)
    }
  })
})

let closing = false
function shutdown(exitCode) {
  if (closing) return
  closing = true
  for (const controller of activeCalls.values()) controller.abort()
  // 给 stdout 一点时间冲刷，然后退出（客户端关闭 stdin 即视为停服）。
  setTimeout(() => process.exit(exitCode), 50)
}

rl.on("close", () => {
  log("stdin 已关闭，退出")
  shutdown(0)
})
process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") {
    shutdown(0)
    return
  }
  log("stdout 错误", error?.message ?? String(error))
})
process.on("unhandledRejection", (error) => {
  log("unhandledRejection", error?.stack ?? String(error))
})
