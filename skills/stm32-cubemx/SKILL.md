---
name: stm32-cubemx
license: MIT
description: 用 dsh-stm32-cubemx 插件通过 CubeMX 官方 CLI 查询/修改 .ioc、新建工程、调时钟、配 NVIC/DMA、回滚备份。用于所有"改 CubeMX 工程配置"的任务。
---

# STM32CubeMX 命令行自动化（插件工具）

本技能配合 `plugins/dsh-stm32-cubemx/` 插件使用。工具直接调 CubeMX 官方 `-q` 脚本模式，不打开 GUI。

**优先用意图层**：用户说人话（"配个串口2 115200，PA2/PA3 收发"）时用 `stm32_cubemx_intent`，它自动补引脚、选 mode、设波特率并回读校验：

```js
stm32_cubemx_intent(iocPath, dryRun: true, intents: ["USART2 115200 TX=PA2 RX=PA3", "TIM3 PWM CH1=PA6 1kHz", "ADC1 PA1", "CAN1 TX=PA12 RX=PA11", "PB12 输入 上拉 label=KEY1", "DAC OUT1=PA4 OUT2=PA5", "USB 设备", "DMA USART1_TX", "FSMC NAND 8bit", "CLOCK max", "NVIC TIM3_IRQn priority=2", "DMA USART1_TX direction=P2M priority=HIGH"])
```

（`串口2`→`USART2`；引脚可省略自动选；UART/I2C/SPI/TIM PWM/GPIO 都支持；ADC/CAN 暂不支持。）

## 没有这些工具时：用 CLI（能力相同）

在别的智能体里（或本机 shell）没有 `stm32_cubemx_*` 工具时，直接用命令行，效果一致：

```powershell
node "plugins\stm32-cubemx-mcp\cli.mjs" inspect   --ioc "工程.ioc" --pins PB12
node "plugins\stm32-cubemx-mcp\cli.mjs" configure --ioc "工程.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP" --dry-run
node "plugins\stm32-cubemx-mcp\cli.mjs" configure --ioc "工程.ioc" --pin "PB12:GPIO_Input:KEY1:GPIO_PULLUP"
node "plugins\stm32-cubemx-mcp\cli.mjs" clock --ioc "工程.ioc" --preset max
node "plugins\stm32-cubemx-mcp\cli.mjs" rollback --ioc "工程.ioc" --action restore
```

退出码 0 成功 / 1 工具失败 / 2 用法错误；路径含空格要加引号；每次 10–60 秒。

## 何时用哪个工具

| 任务 | 工具 |
| --- | --- |
| 看工程配置、引脚当前状态、某脚可选信号 | `stm32_cubemx_inspect` |
| 改引脚 signal / label / pull、外设 mode | `stm32_cubemx_configure` |
| 新建工程 | `stm32_cubemx_new_project` |
| 改时钟树 | `stm32_cubemx_clock` |
| 查/改 NVIC | `stm32_cubemx_nvic` |
| 查 DMA 资源 | `stm32_cubemx_dma` |
| 生成 HAL 工程 | `stm32_cubemx_generate` |
| 回滚 .ioc | `stm32_cubemx_rollback` |
| 上面都表达不了 | `stm32_cubemx_script` |

## 执行约定（工作区 AGENTS.md 已记录）

1. 写操作默认 **先验证再写**：`inspect` → `configure(dryRun:true)` → 用户确认 → 正式写入（自动 `.bak`）。
2. 写操作前检查 CubeMX GUI：GUI 开着会拒绝（GUI 保存会覆盖 CLI 改动）。
3. GPIO 标签只能 ASCII；`.ioc2`（CubeMX2）不支持，会明确报错。
4. 新建工程默认（用户习惯）：Advanced 结构、每外设单独 `.c/.h`、CMake、SYS=Serial Wire+SysTick、RCC=HSE 晶振、HCLK 取系列最大值（F1 72 MHz / F4 168 MHz）。
5. 时钟必须用 `clock set`（改 RCC 参数不会重算时钟树）；改完时钟后 PWM 等定时器预分频要按新频率重算。

#- 意图层边界：**ADC 采样时间改不了**（CubeMX CLI 的 set ip parameters …SamplingTime… 会存成 
ull），保持工程默认或用 CubeMX GUI；TIM 频率/占空比、ADC 通道、CAN 都支持。

# 已知坑（v1.2.0 起已内置防护，2026-11-04 实测）

- **路径含空格**：v1.2.0 起所有写进 CubeMX 脚本的路径都加双引号，`D:\...\UART_Test - HAL\x.ioc` 这类路径可直接用。旧版会把路径按空格截断，报 `doesn't exist` 后**拉起 CubeMX GUI 挂死**（桌面弹框，调用卡到超时）。
- **跨版本 `.ioc`**：`checkProjectVersion: true`（默认）会读 `.ioc` 的 `MxCube.Version` 和固件包，与本机 CubeMX 比对，不一致时**毫秒级报错、不启动 CubeMX**。遇到这个报错：让用户在 CubeMX GUI 里打开该工程并保存一次完成迁移（或安装对应固件包）；确认要强行尝试才改配置为 `false`。
- 真卡住时的排查：**只认 `STM32CubeMX` 主窗口标题**（出现即为 GUI，关掉重试）。每次 CLI 调用都会拉起 8–9 个 `chromium.exe`（内嵌浏览器），随 JVM 退出，**不是 GUI 信号，别误杀**。
- 写工具（`intent`/`configure`/`clock`/`nvic`）会保留工程名（v1.3.1 起）：暂存文件用目标 `.ioc` 的文件名，`ProjectManager.ProjectFileName/ProjectName` 不会再变成 `working`/`intent`。
- `intent` 抢用已有功能的引脚时会给出 `WARN PA2 was ADC1_IN2 (label SOIL_3); it becomes USART2_TX`，把这条念给用户确认。

## 失败处理

- 工具返回 `ok:false` 时**原文件未被修改**，把 `FAIL ...` 行读给用户；`available:` 后面是候选值。
- `KO`、`Usage:`、回读不一致都算失败；只有 `OK` 不算成功。
- 需要回退时用 `stm32_cubemx_rollback`，不要手工改 `.ioc`。
