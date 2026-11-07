---
name: stm32-cubemx-mcp
license: MIT
description: 用 MCP 工具（stm32-cubemx-mcp server，或 DSH 原生插件 dsh-stm32-cubemx）或同目录 CLI（cli.mjs）通过 STM32CubeMX 官方 CLI 查询/修改 .ioc、新建工程、调时钟、配 NVIC/DMA、生成 HAL 代码、回滚备份。用于所有「查/改 CubeMX 工程配置」的任务。
---

# STM32CubeMX 命令行自动化（MCP 工具 / CLI）

本技能对应 10 个工具，它们由 MCP server `stm32-cubemx-mcp` 暴露（DSH 里则是原生插件 `dsh-stm32-cubemx`，工具名与行为完全一致）。底层调用 CubeMX 官方 `-q` 脚本模式，**不打开图形界面**。

**没有 MCP 工具时**用同目录的 `cli.mjs`，能力完全一样：

```powershell
node "plugins\stm32-cubemx-mcp\cli.mjs" inspect   --ioc "工程.ioc" --pins PB12
node "plugins\stm32-cubemx-mcp\cli.mjs" configure --ioc "工程.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP" --dry-run
node "plugins\stm32-cubemx-mcp\cli.mjs" configure --ioc "工程.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP"
node "plugins\stm32-cubemx-mcp\cli.mjs" rollback  --ioc "工程.ioc" --action restore
```

退出码 0 成功 / 1 失败 / 2 用法错误；路径含空格加引号；每次 10–60 秒。

## 何时用哪个工具

| 任务 | 工具 |
| --- | --- |
| **一句话配外设 + NVIC + DMA 参数 + 时钟**（UART/I2C/SPI/TIM PWM/ADC/CAN/GPIO/DAC/USB/FSMC/DMA；`CLOCK max`、`NVIC TIM3_IRQn`、`DMA USART1_TX priority=HIGH`） | `stm32_cubemx_intent` ← 优先用这个 |
| 看工程配置、MCU/封装、引脚当前状态、某脚可选信号 | `stm32_cubemx_inspect` |
| 改引脚 signal / label / pull、外设 mode | `stm32_cubemx_configure` |
| 新建工程 | `stm32_cubemx_new_project` |
| 改时钟树 | `stm32_cubemx_clock` |
| 查/改 NVIC 中断 | `stm32_cubemx_nvic` |
| 查 DMA 资源（只读） | `stm32_cubemx_dma` |
| 生成 HAL 工程 | `stm32_cubemx_generate` |
| 回滚 `.ioc` | `stm32_cubemx_rollback` |
| 上面都表达不了 | `stm32_cubemx_script`（逃生通道，≤60 行命令） |

## 执行约定：先验证再写

1. `stm32_cubemx_inspect` 看现状（只读，不动文件）；
2. 有歧义/多引脚改动时，先 `stm32_cubemx_configure(dryRun: true)`，把「期望值 vs 回读值」摆给用户；
3. 用户确认（或明确说「直接写」）后再正式写入——插件自动留 `<原文件>.bak-<时间戳>`；
4. 需要代码再 `stm32_cubemx_generate`，并核对生成的 `Core/Src/gpio.c` 与 `.ioc` 字段；
5. 改坏了用 `stm32_cubemx_rollback(action: "list" | "restore")`，不要手工改 `.ioc`。

硬性规则：

- **GPIO 标签只能用 ASCII**（CubeMX 对非 ASCII 标签返回 OK 却存成空字符串，插件会提前拒绝）。
- `.ioc2`（CubeMX2）工程不支持，工具会明确报错。
- 写操作前插件会检测 CubeMX GUI 是否在运行，检测到就拒绝（GUI 保存会覆盖 CLI 改动）——先在图形界面里关掉工程再改。
- 时钟必须用 `stm32_cubemx_clock`；改完后 PWM 等定时器预分频要按新频率重算（F1：APB1=36 MHz 时定时器时钟 72 MHz）。

## 耗时与超时

每次工具调用都会启动一次 CubeMX CLI（JVM），**通常 20–60 秒**。实测：`inspect` 18.7 秒、`dma list_all` 17.3 秒；冷启动可能到 60 秒。

- 客户端工具超时设 **≥120 秒**；
- 一次任务里不要并发调多个 CubeMX 工具（server 内部已串行排队，但客户端侧并发没意义）；
- 调用时告诉用户「正在跑 CubeMX，约半分钟」，避免以为卡死。

- 意图层边界：**ADC 采样时间改不了**（CubeMX CLI 的 set ip parameters …SamplingTime… 会存成 
ull），保持工程默认或用 CubeMX GUI；TIM 频率/占空比、ADC 通道、CAN 都支持。

## 两个已知坑（2026-11-04 实测）

| 坑 | 触发 | 现象 | 处理 |
| --- | --- | --- | --- |
| 路径含空格 | `.ioc` 或输出目录带空格（如 `D:\Downloads\UART_Test - HAL\...`） | CubeMX 把路径按空格截断，报 `doesn't exist`，**还会拉起 GUI 卡死** | 插件 **v1.2.0 已修**（脚本路径加双引号）；只在旧版插件上会复现 |
| `.ioc` 跨版本 | 工程 `MxCube.Version` 与本机 CubeMX 不一致（例：本机 6.15.0 打开 6.17.0 或 6.10.0 工程） | 弹「固件包迁移」对话框，CLI 挂死到超时（默认 300 秒） | 插件 **v1.2.0 已修**：`checkProjectVersion` 预检毫秒级报错、不启动 CubeMX；旧工程先在 CubeMX GUI 里迁移保存一次 |

如果工具卡住：**只认 `STM32CubeMX` 主窗口标题**（出现即 GUI 被拉起，关掉重试）。注意每次 CLI 调用都会拉起 8–9 个 `chromium.exe`（CubeMX 内嵌浏览器），随 JVM 一起退出，**这不是 GUI 信号，不要误杀**。插件 v1.2.0 起上面两个坑不会再把 CLI 拖进 GUI。

## 新建工程的默认配置（用户习惯）

`stm32_cubemx_new_project` 已内置：Advanced 结构（`Core/Src`）、每个外设单独 `.c/.h`、CMake 工具链、SYS = Serial Wire + SysTick、RCC = HSE 晶振、HCLK 取系列最大值（F1 72 MHz / F4 168 MHz）。除非用户当次明确要求别的，不要改这些默认值。

## 失败处理

- 工具返回 `ok: false` 时**原文件未被修改**；把 `FAIL ...` 行读给用户，`available:` 后面是候选值。
- `KO`、`Usage:`、回读不一致都算失败；只有 `OK` 不算成功。
- 不确定怎么表达的需求，用 `stm32_cubemx_script` 执行原生 CLI 命令，但**优先用结构化工具有事务与回读校验**。
