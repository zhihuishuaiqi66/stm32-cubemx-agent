# STM32 CubeMX Agent

**让 AI 智能体直接操作 STM32CubeMX**：通过 CubeMX 官方命令行读写 `.ioc` 工程、配置引脚/外设/时钟/NVIC/DMA，并生成 HAL 代码——不用打开 GUI、不用手点界面。

提供三种接入方式，同一套工具、同一套行为：

| 接入方式 | 适合谁 | 入口 |
| --- | --- | --- |
| **DeepSeek Harness 插件** | 用 DSH 桌面的用户 | `plugins/dsh-stm32-cubemx/` |
| **MCP stdio server** | Claude Code / WorkBuddy / Codex / Cursor 等任意 MCP 客户端 | `plugins/stm32-cubemx-mcp/server.mjs` |
| **CLI** | 不想配 MCP 的智能体或脚本 | `plugins/stm32-cubemx-mcp/cli.mjs` |

> 状态：**v1.6.0**（2026-11）。在 STM32CubeMX 6.15.0 + FW_F1 V1.8.7 / FW_F4 V1.28.3 上实测；F1 全量回归通过，F4 部分验证（见「已知边界」）。

---

## 能做什么

10 个工具（插件 / MCP / CLI 完全一致）：

| 工具 | 作用 |
| --- | --- |
| `stm32_cubemx_intent` | **一句话配外设**（推荐入口）：UART / I2C / SPI / TIM PWM（含频率占空比）/ ADC / CAN / GPIO / DAC / USB / FSMC / DMA / NVIC / 时钟 |
| `stm32_cubemx_inspect` | 只读查看 `.ioc`：MCU、引脚、可选功能 |
| `stm32_cubemx_configure` | 事务性改引脚/外设（支持友好 mode 写法，dryRun 先验证） |
| `stm32_cubemx_generate` | 对已有 `.ioc` 生成 HAL 工程 |
| `stm32_cubemx_clock` | 时钟树：`preset:"max"` 或语义参数（PLL/APB/ADC） |
| `stm32_cubemx_nvic` | 中断开关 / 优先级（向量名，如 `TIM3_IRQn`） |
| `stm32_cubemx_dma` | 只读查询 DMA 请求/流 |
| `stm32_cubemx_new_project` | 按默认配置新建工程（Advanced 结构、每外设独立文件、CMake、SWD、最大 HCLK） |
| `stm32_cubemx_rollback` | 恢复自动备份的 `.bak-<时间戳>` |
| `stm32_cubemx_script` | 逃生通道：直接执行 CubeMX CLI 命令 |

### 意图层示例

```js
stm32_cubemx_intent(iocPath, dryRun: true, intents: [
  "USART2 115200 TX=PA2 RX=PA3",
  "I2C1 SCL=PB6 SDA=PB7",
  "SPI1 SCK=PA5 MISO=PA6 MOSI=PA7",
  "TIM3 PWM CH1=PA6 1kHz duty=25",       // 自动算 Prescaler/Period/Pulse
  "ADC1 IN0=PA0",
  "CAN1 TX=PA12 RX=PA11",
  "PB12 输入 上拉 label=KEY1",
  "DAC OUT1=PA4 OUT2=PA5",
  "USB 设备",                             // USB_OTG_FS Device_Only，DM/DP 自动选脚
  "DMA USART1_TX direction=P2M priority=HIGH",
  "FSMC NAND 8bit",                      // 自动挑整组 NAND 引脚
  "CLOCK max",                           // 或 "CLOCK 120MHz"
  "NVIC TIM3_IRQn priority=2",
])
```

引脚可以不给（自动从封装里挑并标注 `auto-selected`）；中文实例/角色也认（`串口2`、`定时器3`、`上拉`、`中断`）。

---

## 快速开始

### 0. 前置条件

- **STM32CubeMX 6.x**（含自带的 Java，无需另装 JDK）
- 对应芯片系列的 **固件包**（CubeMX 里下载；例如 F1 需要 `STM32Cube_FW_F1_V1.8.7`）
- **Node.js ≥ 18**（MCP / CLI 需要；DSH 插件用 DSH 自带 Node 即可）

> 本仓库**不包含** CubeMX、固件包或 ST 的 HAL 源码，全部需要你自行安装（ST 的许可不允许转分发）。

### 1. DeepSeek Harness（DSH）插件

```text
plugin_manager(action="install_bundle", target="<本仓库>/plugins/dsh-stm32-cubemx")
```

然后编辑插件配置里的 `mxHome`（默认按 ST 标准安装路径，若你的 CubeMX 装在别处要改）：

```yaml
# plugins/dsh-stm32-cubemx/cordis.patch.yml
mxHome: 'C:\Program Files\STMicroelectronics\STM32Cube\STM32CubeMX'
```

### 2. MCP 客户端（Claude Code / WorkBuddy / Codex / Cursor）

```json
{
  "mcpServers": {
    "stm32-cubemx": {
      "command": "node",
      "args": ["<本仓库>/plugins/stm32-cubemx-mcp/server.mjs"],
      "env": {
        "CUBEMX_HOME": "C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeMX"
      }
    }
  }
}
```

- Claude Code：`claude mcp add stm32-cubemx -- node <本仓库>/plugins/stm32-cubemx-mcp/server.mjs`
- WorkBuddy：写入 `%USERPROFILE%\.workbuddy\mcp.json` 后，确认它真的加载了（部分版本需要重启/手动启用）
- 每次工具调用会起一次 CubeMX CLI，耗时 10–60 s，客户端超时建议 ≥ 120 s

### 3. CLI（最稳，任何智能体都能用）

```bash
node plugins/stm32-cubemx-mcp/cli.mjs inspect   --ioc "工程.ioc"
node plugins/stm32-cubemx-mcp/cli.mjs intent    --ioc "工程.ioc" --intent "USART2 115200 TX=PA2 RX=PA3" --dry-run
node plugins/stm32-cubemx-mcp/cli.mjs generate  --ioc "工程.ioc" --out "生成目录"
```

完整命令见 [`plugins/stm32-cubemx-mcp/README.md`](plugins/stm32-cubemx-mcp/README.md)。

### 4. 技能（Skills）

把 [`skills/stm32-cubemx/SKILL.md`](skills/stm32-cubemx/SKILL.md) 装进智能体的 skills 目录（如 `~/.agents/skills/stm32-cubemx/` 或 `%USERPROFILE%\.workbuddy\skills\stm32-cubemx\`），它会让智能体优先用这些工具而不是猜配置。

---

## 仓库结构

```text
plugins/dsh-stm32-cubemx/   DSH 插件（index.js + 配置 + 文档，v1.6.0）
plugins/stm32-cubemx-mcp/   MCP server + CLI（零 npm 依赖）
skills/stm32-cubemx/        技能说明（装到智能体的 skills 目录）
samples/f4_all/             F407VGTx：DAC/输入捕获/USB/FSMC/DMA/USART1（.ioc）
samples/f103_multi/         F103RCTx：3×USART/I2C/SPI/CAN/ADC×4/PWM/GPIO/NVIC（.ioc）
```

> 示例工程只提交 `.ioc` 配置；`generated/` 里的 HAL 代码由你本地 `generate` 得到（含 ST 版权，不入库）。

---

## 安全设计（重要）

1. **先验证再写**：所有写操作先在副本上执行、`saveas` 后重新加载逐项回读，全部一致才写回原文件；写入前自动留 `.bak-<时间戳>`，`rollback` 一条命令回退。
2. **GUI 保护**：检测到 `STM32CubeMX*` 窗口时默认拒绝写入（避免 GUI 保存覆盖 CLI 改动）。
3. **路径范围**：`allowAnyPath` 默认可写任意 `.ioc`；给别人用/放到服务器时建议改成 `allowAnyPath: false` + `allowedRoots`。
4. MCP/CLI 的环境变量：`CUBEMX_HOME`、`CUBEMX_ALLOW_ANY_PATH`、`CUBEMX_ALLOWED_ROOTS`、`CUBEMX_TIMEOUT_MS`。

---

## 已知边界

- **芯片**：只实测 F1（全量：15 项回归 + 4 轮独立验收）与 F4（部分：new_project / 168 MHz / 生成通过）。其他系列需先装对应固件包。
- **ADC 采样时间**：CubeMX CLI 写不进（`set ip parameters …SamplingTime…` 落盘为 `null`），插件直接报错，请在 GUI 或用默认值。
- **F4 的 ADC 预分频**：F4 CLI 不支持 `clock set ADCPresc`；启用 ADC 时需另行处理。
- **FSMC**：取决于封装引脚；LQFP100 只有 NAND 信号，NOR/SRAM 16 位需 144/176 脚封装。
- **时钟精调**：intent 的 `CLOCK` 只实现 F1/F4；其他系列请用 `clock` 工具显式参数或 GUI。
- **生成阻塞**：工程里有“未就绪”外设时（日志 `IP not ready for code generation: X`），CubeMX 会一直阻塞；插件超时信息会点名该外设。

---

## 实测记录

- v1.4.1：15 项回归 + 4 轮独立验收（F1）
- v1.5.0：F407 上 DAC / USB / FSMC / DMA 意图端到端 + 生成
- v1.6.0：`CLOCK max/120MHz/100MHz`、`NVIC TIM3_IRQn priority=2`、`DMA direction/priority` 实测
- 两套示例工程生成验证：F103 931 文件、F407 1474 文件

---

## 许可证

- 本仓库自有代码：**MIT**（见 [LICENSE](LICENSE)）
- STM32CubeMX、STM32Cube HAL、固件包：**不包含**在本仓库中，版权归 STMicroelectronics，使用需遵守 ST 的许可协议
- STM32 / STM32CubeMX 是 STMicroelectronics 的商标；本项目与 ST 无关联

---

## English

An MCP server + CLI + DeepSeek Harness plugin that drives **STM32CubeMX's official CLI** to inspect/configure `.ioc` projects (pins, clocks, NVIC, DMA, peripherals), with an intent layer (`"USART2 115200 TX=PA2"`, `"FSMC NAND 8bit"`, `"CLOCK max"`…), transactional verification, automatic backups and HAL generation. Zero npm dependencies. Requires a locally installed STM32CubeMX + the matching firmware package; none of ST's software is redistributed here. MIT licensed.
