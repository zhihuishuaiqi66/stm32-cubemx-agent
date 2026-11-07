# stm32-cubemx-mcp

把 `dsh-stm32-cubemx`（DeepSeek Harness 插件）的 **10 个 STM32CubeMX 工具**原样包装成一个**零 npm 依赖**的标准 **MCP stdio server**，供任何 MCP 客户端调用：Claude Code、Codex、WorkBuddy、Command Code、Cursor、Cline、Continue、Zed、Claude Desktop，以及装了 MCP client 的 DSH 自己。

底层不打开 CubeMX 图形界面，走官方命令行脚本模式（`-q script.txt`）。

## 为什么可以「原插件一行不改」

`../dsh-stm32-cubemx/index.js` 对宿主只要求两件事：`ctx.tools.register(tool)` 和 `ctx.inject(deps, cb)`。本 server 给 `apply()` 传一个「假 ctx」，把工具对象收集起来：

```js
apply({ tools: { register(t) { captured.push(t) } }, inject() {} }, config)
```

每个工具对象本身就带着 MCP 需要的全部内容：`name`、`description`、`parameters`（JSON Schema，直接当 `inputSchema`）、`execute(args, exec)`、`output.render(...)`。所以本 server 只有 **1 层适配**，插件的业务逻辑（CubeMX 调用、事务写回、`.bak` 备份、回读校验）全部原样复用；**插件以后新增工具，这里不用改代码**，`tools/list` 自动跟着变。

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | MCP server 本体（约 380 行，只用 `node:` 内置模块） |
| `SKILL.md` | 说明层：给没有 MCP 的智能体看的使用流程与坑 |
| `README.md` | 本文 |

## 快速验证（不启动 CubeMX）

```powershell
# 从 stdin 读、stdout 写 JSON-RPC；手打一行 initialize 就能看到 10 个工具
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' | node "plugins\stm32-cubemx-mcp\server.mjs"
```

注意：MCP stdio 是**换行分隔单行 JSON-RPC 2.0**，不是 LSP 的 `Content-Length` 头；stdout 只允许协议消息，日志走 stderr（`MCP_DEBUG=1` 打开）。

## 配到各家客户端

所有客户端都用同一份：`command` = node 绝对路径（`node`），`args` = 本 server 的绝对路径。Windows 的 JSON 里反斜杠要写两个。

### WorkBuddy

`%USERPROFILE%\.workbuddy\mcp.json`（与现有 `playwright` / `easyeda-agent` 同级）：

```json
{
  "mcpServers": {
    "stm32-cubemx": {
      "command": "node",
      "args": ["<本仓库>/plugins/stm32-cubemx-mcp\\server.mjs"],
      "env": {
        "CUBEMX_HOME": "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX",
        "CUBEMX_ALLOW_ANY_PATH": "true"
      }
    }
  }
}
```

### Claude Code

```powershell
claude mcp add --scope user stm32-cubemx -- node "plugins\stm32-cubemx-mcp\server.mjs"
claude mcp list   # 确认出现 stm32-cubemx
```

或写进 `~/.claude.json`（用户级）根部的 `mcpServers`，结构同上。

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.stm32-cubemx]
command = "node"
args = ["<本仓库>/plugins/stm32-cubemx-mcp\\server.mjs"]
env = { CUBEMX_HOME = "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX", CUBEMX_ALLOW_ANY_PATH = "true" }
```

### Command Code

```powershell
cmd mcp add stm32-cubemx -- node "plugins\stm32-cubemx-mcp\server.mjs"
```

配置落在 `~/.commandcode/mcp.json`；也支持 `/import claude|codex|cursor` 直接导入别家配置。

### Cursor / Claude Desktop / Cline / Continue / Zed

- Cursor：项目 `.cursor/mcp.json` 或 `%USERPROFILE%\.cursor\mcp.json`，结构同 WorkBuddy。
- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`，结构同上。
- Cline：`~/.cline/data/settings/cline_mcp_settings.json`。
- Continue：`config.yaml` 的 `mcpServers` 段，或 `.continue/mcpServers/*.yaml`。
- Zed：`settings.json` 的 `context_servers`。

### DeepSeek Harness（本机已在用的原生插件）

DSH 里保持原生插件 `dsh-stm32-cubemx` 即可（有 `/cubemx` 命令、走 `plugin_manager` 安装）。如要用 MCP 版，需装 `@deepseek-ai/dsh-mcp-client` 并在 profile 的 `cordis.patch.yml` 里加一条。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CUBEMX_HOME`（别名 `CUBEMX_MX_HOME`） | `<CubeMX 安装目录>` | CubeMX 安装目录，需含 `STM32CubeMX.exe` 和 `jre\` |
| `CUBEMX_ALLOW_ANY_PATH` | `true` | 是否允许写任意路径；**给别人用时改 `false`** |
| `CUBEMX_ALLOWED_ROOTS` | 空 | `CUBEMX_ALLOW_ANY_PATH=false` 时的写入白名单，分号分隔，例如 `D:\proj;E:\work` |
| `CUBEMX_ALLOW_GUI_RUNNING` | `false` | CubeMX GUI 开着时是否仍允许写（GUI 保存会覆盖 CLI 改动） |
| `CUBEMX_TIMEOUT_MS` | `300000` | 单次 CubeMX CLI 超时（≥30000） |
| `CUBEMX_MAX_LOG_CHARS` | `4000` | 回传日志尾部字符数（≥200） |
| `CUBEMX_JAVA_PATH` | 空 | 自定义 `java.exe`；默认用 `<CUBEMX_HOME>\jre\bin\java.exe` |
| `CUBEMX_CHECK_PROJECT_VERSION` | 跟随插件默认（`true`） | 插件 v1.2.0+ 的跨版本 `.ioc` 预检；设 `false` 跳过（不推荐，旧工程会拉起 GUI） |
| `CUBEMX_PLUGIN_ENTRY` | 自动推导 `..\dsh-stm32-cubemx\index.js` | 插件换了位置时显式指定 |
| `MCP_DEBUG` | 关 | `1` 时调试日志写 stderr |

## 10 个工具

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `stm32_cubemx_intent` | 写（事务） | **一句话配外设**：`"USART2 115200 TX=PA2 RX=PA3"`、`"I2C1 SCL=PB6 SDA=PB7"`、`"TIM3 PWM CH1=PA6 1kHz"`、`"ADC1 IN0=PA0"`、`"CAN1 TX=PA12 RX=PA11"`、`"DAC OUT1=PA4 OUT2=PA5"`、`"USB 设备"`、`"DMA USART1_TX"`、`"FSMC NAND 8bit"、`"CLOCK max"`、`"NVIC TIM3_IRQn"```、`"PB12 输入 上拉 label=KEY1"`；自动补引脚/选 mode/设参数（波特率等），回读校验 |
| `stm32_cubemx_inspect` | 只读 | 加载 `.ioc`，回 MCU/封装/引脚分配；带 `pins` 时回每个脚的可选信号 |
| `stm32_cubemx_configure` | 写（事务） | 引脚 signal/label/pull、外设 mode；`dryRun:true` 只验证；自动 `.bak` |
| `stm32_cubemx_generate` | 写 | 已有 `.ioc` 生成 HAL 工程 |
| `stm32_cubemx_clock` | 写（事务） | `preset:"max"`（F1 72 MHz / F4 168 MHz）或语义参数，回读 HCLK 校验 |
| `stm32_cubemx_nvic` | 写（事务） | 中断开关 / 优先级 / 优先级分组 |
| `stm32_cubemx_dma` | 只读 | DMA 查询：`list_all` / `list_periph` / `available_*` |
| `stm32_cubemx_new_project` | 写 | 按本机默认（Advanced、每外设 `.c/.h`、CMake、SWD、HSE、系列最大 HCLK）新建并生成 |
| `stm32_cubemx_rollback` | 写 | 列出 / 恢复 `.bak-*` |
| `stm32_cubemx_script` | 逃生 | 任意 CubeMX CLI 命令序列（≤60 行） |

推荐流程（与 DSH 里一致）：`inspect` → `configure(dryRun:true)` → 确认 → `configure` → `generate`；写操作自动留 `.bak-<时间戳>`，可用 `rollback` 回退。

## 没有 MCP 客户端 / MCP 没加载？用命令行 `cli.mjs`

`cli.mjs` 把**同样 10 个工具**做成普通命令，零依赖。任何能执行 shell 的智能体都能用（WorkBuddy、Codex、Cursor、批处理、人或 PowerShell 都行）：

```powershell
# 一句话配外设（v1.4.0）：串口/GPIO/TIM 频率/ADC/CAN 都行，先 dry-run
node "...\cli.mjs" intent --ioc "D:\work\board.ioc" --intent "USART2 115200 TX=PA2 RX=PA3" --intent "PB12 输入 上拉 label=KEY1" --dry-run
node "...\cli.mjs" intent --ioc "D:\work\board.ioc" --intent "USART2 115200"   # 引脚自动选
node "...\cli.mjs" intent --ioc "D:\work\board.ioc" --intent "TIM3 PWM CH1=PA6 1kHz duty=25" --intent "ADC1 IN0=PA0" --intent "CAN1 TX=PA12 RX=PA11"
# TIM 频率会自动算 PSC/ARR：1 kHz@72 MHz → Prescaler=1 / Period=35999 / Pulse=18000（0 误差）；20 kHz → PSC 0 / ARR 3599
```

```powershell
# 只读：看 MCU 和引脚
node "plugins\stm32-cubemx-mcp\cli.mjs" inspect --ioc "D:\work\board.ioc" --pins PB10

# 配引脚：先 dry-run（不动文件），回读表 OK 再去掉 --dry-run
node "...\cli.mjs" configure --ioc "D:\work\board.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP" --dry-run
node "...\cli.mjs" configure --ioc "D:\work\board.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP"

# 改时钟 / 回滚 / 生成代码
node "...\cli.mjs" clock --ioc "D:\work\board.ioc" --preset max
node "...\cli.mjs" rollback --ioc "D:\work\board.ioc" --action list
node "...\cli.mjs" generate --ioc "D:\work\board.ioc" --output "D:\work\gen" --name Demo --toolchain CMake
```

- `--pin "PIN:signal[:label[:pull]]"` 可重复；复杂参数（`--pins` / `--modes` / `--commands`）也可写成 JSON 或 `@文件.json`（避免 shell 吃掉引号）。
- `--json` 输出原始结果；退出码 `0` 成功、`1` 工具失败或抛错、`2` 用法错误。
- CLI 默认 `allowAnyPath=true`（本机单用户工具）；要收紧用 `CUBEMX_ALLOW_ANY_PATH=false` + `CUBEMX_ALLOWED_ROOTS`。
- 每次调用同样启动一次 CubeMX CLI，**10–60 秒**，shell 超时别设太短。

实测（2026-11-05）：`configure --dry-run` 14.7 s（文件未改）、正式写入 14.9 s（`.ioc` 中 `PB12.Signal/GPIO_Label/GPIO_PuPd` 三项正确、自动留 `.bak`）、`rollback restore` 0.5 s 恢复原状。

> WorkBuddy 桌面版：条目写进 `%USERPROFILE%\.workbuddy\mcp.json` 后，如果工具列表里看不到 `stm32_cubemx_*`（实测 2026-11-05：配置文件在位，但 `mcp-tool-list.json` 无对应工具、日志无启动记录），说明 MCP 服务器还没被它启用/加载。这时用上面的 CLI 路线即可，不依赖 MCP。

## 已知边界

1. **慢**：每次工具调用启动一次 CubeMX CLI（JVM），实测 `inspect` 18.7 秒、`dma list_all` 17.3 秒；冷启动可能到 60 秒。客户端单次工具超时请设 **≥120 秒**（server 内部上限取插件的 `timeoutMs`，默认 300 秒）。
2. **串行**：`tools/call` 在 server 内排队，避免多个 CubeMX 进程同时写同一个 `.ioc`；`initialize`/`ping`/`tools/list` 不进队列。
3. **只有 tools**：未实现 resources / prompts / sampling / completions；`initialize` 的 `capabilities` 只声明 `tools`。协议版本回显客户端请求的已知版本（2024-11-05 / 2025-03-26 / 2025-06-18），否则回 `2025-06-18`；MCP 官方最新规范（2026-07-28）改成了「无握手 + 每请求协商」，本 server 按现役客户端仍普遍使用的 legacy 流程实现。
4. **结果在文本里**：没有 `outputSchema`/`structuredContent`，工具结果以文本放在 `content[0].text`（给人/模型看），不是结构化字段。
5. **取消**：客户端发 `notifications/cancelled` 会 abort 对应的 CubeMX 子进程；stdin 关闭 / SIGTERM 时也会终止在跑的 CubeMX。
6. **CubeMX 只能本机跑**：这不是云服务，别的机器要用必须装 CubeMX（同系列固件包）并有 `.ioc`。
7. **GUI 冲突**：默认检测到 CubeMX GUI 在运行会拒绝写操作（GUI 保存会覆盖 CLI 改动）。

### 两个环境坑（已在 2026-11-04 实测踩到）

| 坑 | 触发 | 现象 | 处理 |
| --- | --- | --- | --- |
| 路径含空格 | `.ioc` / 输出目录路径带空格（如 `UART_Test - HAL`） | CubeMX 把路径按空格截断，报 `doesn't exist`，**并拉起 GUI 卡死** | 插件 **v1.2.0 已修**：所有脚本路径加双引号；旧版插件才会有此问题 |
| `.ioc` 跨版本 | 工程的 `MxCube.Version` 与本机 CubeMX 不一致（如本机 6.15.0 打开 6.17.0 / 6.10.0 工程） | 弹「固件包迁移」对话框，CLI 挂死到超时 | 插件 **v1.2.0 已修**：`checkProjectVersion` 预检直接报错（毫秒级、不启动 CubeMX）；旧工程先在 GUI 里迁移保存一次 |

这两条都属于**原插件（`dsh-stm32-cubemx`）**，与本 MCP 适配层无关；已在插件 v1.2.0 修复，本 server 直接受益。如果你用 `CUBEMX_PLUGIN_ENTRY` 指回旧版插件，仍会遇到这两个坑。

## 安全建议

- 默认 `CUBEMX_ALLOW_ANY_PATH=true` 等于允许改本机任意 `.ioc`、往任意目录生成工程。**给别人用**时设 `CUBEMX_ALLOW_ANY_PATH=false` + `CUBEMX_ALLOWED_ROOTS`。
- 写操作有 `.bak-<时间戳>` 备份，恢复用 `stm32_cubemx_rollback(action:"restore")`。
- 不要与 CubeMX GUI 同时改同一个工程。

## 回退（从客户端移除）

```powershell
# WorkBuddy：删掉 mcp.json 里的 stm32-cubemx 条目（或还原备份 mcp.json.bak-<时间戳>）
# Claude Code：
claude mcp remove --scope user stm32-cubemx
```

## 实测记录（2026-11-04 / 2026-11-07，本机 CubeMX 6.15.0 / FW_F1 V1.8.7）

| 步骤 | 结果 | 耗时 |
| --- | --- | --- |
| `initialize` | PASS（`protocolVersion:"2025-06-18"`、`capabilities:{tools:{}}`） | 34 ms |
| `tools/list` | 10/10 个工具，`inputSchema` 完整（v1.3.0 起含 `stm32_cubemx_intent`） | 0 ms |
| `tools/call stm32_cubemx_inspect` | PASS，回 `MCU: STM32F103C(8-B)Tx (LQFP48)` + 全引脚 | 18.7 s |
| `tools/call stm32_cubemx_dma action=list_all` | PASS，CLI 回 `OK` / `Bye bye` | 17.3 s |
| `tools/call stm32_cubemx_intent`（`"USART2 9600 TX=PA2 RX=PA3"`，dryRun） | PASS，回读 USART2 模式 + 引脚 + BaudRate | 44.7 s |
| 失败路径（不存在 `.ioc` / 未知工具） | `isError:true` / JSON-RPC `-32602` | 1 ms |
