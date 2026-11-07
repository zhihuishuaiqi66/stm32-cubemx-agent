# Changelog

## 1.6.0 — 2026-11-07

用户问“时钟精调、NVIC、DMA 参数细调能不能也加进 intent”——能，已全部加进去：

- **clock 意图**：`"CLOCK max"`（F1/F4 最大 HCLK 预设）、`"CLOCK 120MHz"`（F1 解 PLLMUL，F4 解 PLLM/PLLN/PLLP/PLLQ），或用 `pllMul / pllM / pllN / pllP / pllQ / apb1Div / apb2Div / adcDiv` 显式覆盖；回读 `RCC.HCLKFreq_Value` 校验（±1%）。实测 F4：`CLOCK max`→168 MHz、`CLOCK 120MHz`→120 MHz、`CLOCK 100MHz`→100 MHz；F1 仍用 72 MHz 预设。非 F1/F4 会明确报“只支持 F1/F4”。
- **nvic 意图**：`"NVIC TIM3_IRQn"`、`"NVIC USART1_IRQn priority=2"`，中文 `"USART1 中断"`（由实例推出 `USART1_IRQn`）。写 `NVIC enable` / `NVIC set_priority`，落盘后校验 `.ioc` 里 `NVIC.<irq>=true\:...`。实测优先级 2 落到 `NVIC.USART1_IRQn=true\:2\:0\:...`。
- **DMA 参数细调**：`"DMA USART1_TX direction=P2M priority=HIGH"`，支持 Direction（P2M/M2P/M2M）、Priority（LOW/MEDIUM/HIGH/VERY_HIGH）、Mode（NORMAL/CIRCULAR）、MemInc/PeriphInc、数据宽度、FIFOMode；用 `dma set_param` 写入并按 `.ioc` 文本校验。重复请求会跳过 `dma add`（避免 CubeMX 打印 KO）。
- 组合验证：一次调用 `["CLOCK 100MHz", "NVIC TIM3_IRQn", "DMA USART1_TX priority=MEDIUM"]` → HCLK 100 MHz、`NVIC.TIM3_IRQn=true...`、`Dma.USART1_TX.0.Priority=DMA_PRIORITY_MEDIUM` 全部通过。

## 1.5.0 — 2026-11-07

意图层补齐最后一组外设：**DAC / USB / FSMC / DMA**（此前只能走 `script` 逃生通道）。

- **DAC**：`"DAC OUT1=PA4 OUT2=PA5"`（中文 `数模` 也认）。注意 CubeMX 把 DAC 引脚报成 `COMP_DAC1_group`/`COMP_DAC2_group`，`sameSignal()` 已兼容。实测写入 + 回读 + 生成 `dac.c` 通过。
- **USB**：`"USB 设备"` / `"USB Device"` → `USB_OTG_FS Device_Only`，DM/DP 自动选脚（PA11/PA12）；也支持 `Host_Only`、`OTG/Dual_Role_Device`（`主机` / `OTG`）。实测生成 `usb_otg.c` 通过。
- **DMA**：`"DMA USART1_TX"`，直接 `dma add <request>`，并从 CubeMX `dma list_all` 回读确认落到 `DMA2_Stream7`。实测 `.ioc` 落 `Dma.Request0=USART1_TX` 等 12 行参数。
- **FSMC**：`"FSMC NAND 8bit"` 自动从 MCU 引脚表挑出整组 NAND 信号（D0–D7/CLE/ALE/NCE2/NOE/NWE/NWAIT）并设 `NandChipSelect2_1 + 8b-dmux1 + Wait1`；另有 `"FSMC NOR 16bit"` 档（引脚不全时会明确报缺哪个信号）。实测 F407VGTx 自动落到 PD/PE 共 14 根脚，生成 `fsmc.c` 通过。
- 同时修复：元参数（`usbMode/profile/request`）不再被当作 IP 参数写进 CubeMX；DMA 意图的显示标签用请求名。
- 端到端实测：新建 STM32F407VGTx 工程 → intent 依次配 USART1 / DAC / USB / DMA / FSMC → `project generate` **PASS**，生成文件含 `dac.c`、`dma.c`、`fsmc.c`、`usb_otg.c`。

## 1.4.5 — 2026-11-07

补齐“冷门外设”示例并做端到端生成验证（用户要求 DAC / 输入捕获 / USB / FSMC / DMA 都过一遍）：

- 新增 `samples/f4_all/`：**STM32F407VGTx**（LQFP100，168 MHz），同一工程里同时配置：
  - **DAC**：DAC_OUT1=PA4、DAC_OUT2=PA5（生成 `dac.c/dac.h`）
  - **输入捕获**：TIM3 CH1=PA6，`Input_Capture1_from_TI1`（生成 `tim.c`）
  - **USB**：USB_OTG_FS Device_Only（PA11 DM / PA12 DP，生成 `usb_otg.c/usb_otg.h`）
  - **FSMC**：NAND 8-bit（D0–D7、CLE/A16=PD11、ALE/A17=PD12、NCE2=PD7、NOE=PD4、NWE=PD5、NWAIT=PD6；生成 `fsmc.c/fsmc.h`）
  - **DMA**：USART1_TX → DMA2_Stream7（生成 `dma.c/dma.h`）
  - 另含 USART1 115200（PA9/PA10）
  - **生成结果：PASS，1474 个文件**，`ProjectManager.functionlistsort` 里能看到 `MX_DAC_Init / MX_TIM3_Init / MX_USART1_UART_Init / MX_USB_OTG_FS_PCD_Init / MX_FSMC_Init`。
- 说明：这 5 类目前**未进意图层**（intent 只覆盖 UART/I2C/SPI/TIM PWM/ADC/CAN/GPIO），示例是用 `script` 逃生通道 + `saveas` 落盘的，命令清单在 `samples/f4_all/README.md` 里，可照抄。
- 修复：F4 的 CLI 不接受 `clock set ADCPresc`（F1 才认），F4 预设已去掉该行，避免 `new_project` 出现 preset warning；F4 启用 ADC 时需在 GUI/显式参数里调 ADC 预分频。
- 已知限制（实测）：F407 的 LQFP100 封装上 FSMC 只有 NAND 类信号（D0–D7/CLE/ALE/NCE2/NOE/NWE/NWAIT），没有 A0–A15/PF/PG，所以做 NOR/SRAM 16 位不可行，选 NAND 8-bit 才能“就绪”。

## 1.4.4 — 2026-11-07

用一颗多外设的 STM32F103RCT6 端到端实测（3×USART + I2C + SPI + CAN + ADC 4 通道 + 2×TIM PWM + 2×GPIO + 2×NVIC）时又抓到 2 个会导致 `generate` 阻塞的问题：

- **修复 F1/F4 时钟预设的 ADC 预分频**：原来写 `clock set ADCPresc 2`（72/2 = 36 MHz），但 F1 ADC 上限 14 MHz，一旦工程里启用了 ADC，CubeMX 就判 `Clock not ready`、`project generate` 永久阻塞。现在预设用 **6**（F1 72/6=12 MHz，F4 168/6=28 MHz ≤36），实测 `RCC.ADCPresc=RCC_ADCPCLK2_DIV6`、`ADCFreqValue=12 MHz`。
- **SPI 默认波特率预分频改为 /4**：F1 SPI1 在 72 MHz/2=36 MHz 超过 18 MHz 上限时，CubeMX 会把 SPI1 标成 “not ready” 并阻塞生成。意图层现在默认写 `BaudRatePrescaler=SPI_BAUDRATEPRESCALER_4`（可在 params 覆盖），实测带 SPI 的工程生成通过。
- 1.4.3 的 ADC/GPIO 验证改进（转换序列按新增索引追加、用 `.ioc` 文本核对、`PC13-TAMPER-RTC` 这类带后缀脚名）随本版一起生效；实测 ADC1 最终序列 4 通道：`CHANNEL_11 / CHANNEL_0 / CHANNEL_1 / CHANNEL_10`，rank 1–4，`NbrOfConversion=4`。
- 新增示例工程：`samples/f103_multi/`（STM32F103RCTx，LQFP64，72 MHz，23 根引脚、12 个 IP，生成 931 个文件；`generated/` 为生成的 HAL 工程）。

## 1.4.3 — 2026-11-07

用一颗外设较多的 F103（STM32F103RCTx）实测“多外设一起配”时抓到 2 个问题：

- **修复 GPIO 回读误报失败**：像 `PC13` 这种 CubeMX 内部名叫 `PC13-TAMPER-RTC` 的脚，`get signal PC13` / `get gpio parameters PC13 …` 返回 KO，之前会被判成“回读不一致”而整笔失败。现在 GPIO 引脚改用 `get pinout` 校验信号，标签/上下拉直接校验刚落盘的 `.ioc` 文本行。实测 `PC13 输出 label=LED`、`PB12 输入 上拉 label=KEY1` 通过。
- **ADC 一次只能加一个通道（明确的限制，不再静默写错）**：CubeMX 在同一个会话里连续 `set mode ADC1 IN0` + `IN1` 时，后面的 mode 会把前面已建立的转换序列顶掉（实测新工程只留下 1 条 conversion，且 Channel/Rank 指向被覆盖）。现在一次 intent 里出现 2 个以上“新 ADC 通道”会直接报错，提示拆成多次调用；单个通道逐个追加的路径不变（每加一个通道 `NbrOfConversion` +1）。
- 说明：这两个问题只影响“多外设/多通道一次性配置”的边界，F1 单外设的 15 项回归不受影响。

## 1.4.2 — 2026-11-07

- **修复 F4 时钟预设**：F4 的 `PLLM` 必须等于晶振频率（MHz），否则 VCO=336 的前提不成立。原来写死 `PLLM 8`，在 25 MHz 晶振的 F4 板上算出 525 MHz 被 CubeMX 判 “Clock is not ready”，`new_project` 生成阻塞。现在 `new_project` 按 F4 默认 25 MHz 取 PLLM，`clock preset:"max"` 从工程的 `RCC.HSE_VALUE` 读取实际晶振（8/16/25 MHz 均可），实测 **STM32F407VGTx → HCLK 168 MHz、生成 42 个文件/目录**。
- 说明：F4 的意图层（UART/GPIO/TIM/NVIC/clock）走的是 CubeMX 通用命令，链路已通；**ADC 转换序列在 F4 上的端到端生成仍需复测**（本轮在 F4 工程上被 CubeMX 报 “ADC1 not ready”，F1 上正常），暂标“部分支持”。
- 芯片支持范围见 README 的「支持哪些芯片」一节（按本机已安装固件包区分）。

## 1.4.1 — 2026-11-07

独立验收（task-6）抓出 3 个问题，已修：

- **P0 修复：TIM 频率的 Prescaler 差一（会静默输出错误频率）**。`computeTimerTiming()` 原来把 `prescaler` 当分频比（`actual = clk/(psc*(arr+1))`），但这个值直接写进 CubeMX 的 `Prescaler`（PSC 寄存器，真实分频是 `PSC+1`），所以 1 kHz 实际只有 666.7 Hz、2 kHz 实际 1 kHz。现在按 `divider = Prescaler + 1` 搜索，实测：72 MHz 定时器时钟下 1 kHz → `PSC 1 / ARR 35999 / pulse 18000`（真实 1000 Hz）、2 kHz → `PSC 0 / ARR 35999`、20 kHz → `PSC 0 / ARR 3599`、1 Hz → `PSC 1124 / ARR 63999`（真实 1.00 Hz）。duty 的 `pulse/(arr+1)` 不变。
- **P1 修复：新 ADC 通道不进转换序列（报成功但固件不会采样）**。原来只 `set pin` + `set mode`，`ADC1.NbrOfConversion` 不变、没有 `Channel-N`/`Rank-N`。现在对工程里还没有的通道补 `Channel-N#ChannelRegularConversion` / `Rank-N#ChannelRegularConversion` / `SamplingTime-N#ChannelRegularConversion` 并把 `NbrOfConversion` 加一，全部纳入回读。实测 `ADC1 IN7=PA7` → `NbrOfConversion=8`、`Channel-7=ADC_CHANNEL_7`、`Rank-7=8`。
- **P1 修复：显式脚与自动补脚混用会失败**。缓存/函数表用 CubeMX pinout 名（`PA0-WKUP`），显式脚按 `PA0` 查不到；现在查表自动匹配 `PA0-*`，自动选脚也归一化成 `PA0`。实测 `--intent "ADC1 IN0=PA0" --intent "IN1"` 成功（PA0 + PA1 自动选）。
- 文档纠正：三份 SKILL 补「ADC 采样时间不可通过 CLI 设置」；README/CHANGELOG 里错误的 20 kHz 示例数字改对。

## 1.4.0 — 2026-11-07

补齐意图层剩余外设（用户要求“缺少的全补上”）：

- **ADC 意图**：`"ADC1 IN0=PA0"`（显式通道）、`"ADC1 PA1"`（只给脚，自动识别 `ADCx_IN1`）、`"IN0"`（只给通道，自动挑脚）；可一次多个通道。mode 用 `IN0`/`IN1`…，验证走 `get pinout`（`get signal` 对 ADC 脚返回 KO，实测）。实测写入后 `.ioc`：`Mcu.IP0=ADC1`、`PA0-WKUP.Signal=ADCx_IN0`、`ADC1.Channel-0\#ChannelRegularConversion=ADC_CHANNEL_0` 等。
- **CAN 意图**：`"CAN1 TX=PA12 RX=PA11"`（单 CAN 的 F1 自动映射到 IP `CAN`、信号 `CAN_TX/CAN_RX`），mode `CAN_Activate`。实测 `.ioc`：`Mcu.IP1=CAN`、`PA11/PA12.Signal=CAN_RX/CAN_TX`、`CAN.IPParameters=CalculateTimeQuantum,…`。
- **TIM 频率/占空比**：`"TIM3 PWM CH1=PA6 1kHz"`、`"TIM3 PWM CH1=PA6 freq=1000 duty=25"`；自动从时钟树（RCC HCLK/APB1/APB2）算定时器时钟并求 Prescaler/Period/Pulse。实测（1.4.1 修正 Prescaler 语义后）：72 MHz 定时器时钟下 1 kHz → PSC 1 / ARR 35999 / pulse 18000（50%）、duty 25 → pulse 9000；20 kHz → PSC 0 / ARR 3599 / pulse 1800；1 Hz → PSC 1124 / ARR 63999。`.ioc` 落 `TIM3.Prescaler/Period/Pulse-PWM Generation1 CH1`。
- **ADC 采样时间明确不支持**：CubeMX CLI 的 `set ip parameters ADC1 SamplingTime-…#ChannelRegularConversion` 返回 OK 但存成 `null`（实测 4 种写法都一样），因此意图层直接报错提示“用 GUI 改或保持默认”，不静默失败。
- 多 mode 支持：ADC 一次配多个通道时逐个 `set mode` 并逐个回读校验（`activeModes()`）。
- 修好“只给通道/角色、不给脚”的自动补脚：`"IN1"`、`"ADC1 IN3"`、`"TIM3 PWM CH2"` 以前会因“角色已存在”跳过选脚，现在会挑脚并标 `(auto-selected)`（实测 `IN1`→PA1、`IN3`→PA3、TIM3 CH2→PB5）。
- `generate` 超时信息增强：CubeMX 6.15 遇到“IP not ready for code generation: I2C1”会**一直阻塞**，现在超时错误里会带上这条日志并提示“在 GUI 里补齐/移除该外设”，不再是干巴巴的 `did not finish within N ms`。

## 1.3.3 — 2026-11-07

- **补齐全类型真实落盘验证**（此前只有 UART/GPIO 真正写过）：`TIM3 PWM CH1=PA6`、`I2C1 SCL=PB6 SDA=PB7`、`SPI1 SCK=PA5 MISO=PA6 MOSI=PA7` 各写一次副本，均 `ok=true`，`.ioc` 落盘：
  - `Mcu.IP6=TIM3`、`PA6.Signal=S_TIM3_CH1`、`SH.S_TIM3_CH1.0=TIM3_CH1,PWM Generation1 CH1`、`TIM3.Channel-PWM\ Generation1\ CH1=TIM_CHANNEL_1`
  - `PB6.Signal=I2C1_SCL`、`PB7.Signal=I2C1_SDA`、`PB6/PB7.Mode=I2C`、`I2C1.ClockSpeed=400000`
  - `PA5/PA6/PA7.Signal=SPI1_*`、`SPI1.Mode=SPI_MODE_MASTER`、`SPI1.VirtualType=VM_MASTER`
- **修复 NVIC 写入**：CubeMX 的 `NVIC enable/disable/set_priority` 只认**向量名**（`TIM3_IRQn`），传数字会抛 `NullPointerException`。现在 `irq` 接受字符串向量名并原样传递；传数字时失败信息带 `HINT` 提示改用向量名。实测 `NVIC enable TIM3_IRQn` → `.ioc` 落 `NVIC.TIM3_IRQn=true\:0\:0\:…`（有 `.bak`）。
- 已知限制不变：意图层不支持 ADC/CAN（用 `configure`/`script`）；TIM 频率不自动换算 Prescaler/Period。

## 1.3.2 — 2026-11-07

- **修复：文件名带空格/中文时工程名仍被截断**。1.3.1 让暂存文件沿用目标文件名，但 CubeMX 在 `config saveas` 里按空白切分推导工程名（`board name.ioc` → `board`）。现在 `commitWorkingIoc()`（intent/clock/nvic）和 `configure` 的内联写回都会在落盘前把 `ProjectManager.ProjectFileName` / `ProjectName` 改回目标文件名。实测：`board name.ioc`、`点灯 板.ioc` 写入后两行均完整保留（`configure` / `intent` / `clock` 三种工具）。
- 独立验收（task-5 复验）其余项：抢脚 WARN、自动选空闲脚、ADC 文案、MCP 10 个工具与版本、smoke-test 12/12 全部通过。

## 1.3.1 — 2026-11-07

独立验收（task-5）发现的问题修复：

- **修复 P1：所有写工具会把工程名改成暂存名**。`configure` / `clock` / `nvic` / `intent` 原来把副本存成 `working.ioc` / `clock.ioc` / `nvic.ioc`，`config saveas` 会让 CubeMX 把 `ProjectManager.ProjectFileName/ProjectName` 改成暂存名（用户用 GUI 打开会看到 "working"/"intent"）。现在暂存文件使用目标 `.ioc` 的文件名，实测写入后 `ProjectManager.ProjectFileName=board.ioc`、`ProjectName=board`（configure / clock / intent 三种工具均验证）。
- **修复 P2：`ADC1 IN0=PA0` 报错文不对题**。ADC/CAN 补进 kind 表后，字符串形式也会得到 `adc is not supported by the intent layer yet; use stm32_cubemx_configure or stm32_cubemx_script`，不再是 "cannot tell the peripheral kind"。
- **新增 P2 行为：抢脚警告**。`intent` 要把引脚从原功能改走时（包括自动选脚挑到已占用脚），输出 `WARN #1 USART2: PA2 was ADCx_IN2 (label SOIL_3); it becomes USART2_TX`，不再静默丢配置。自动选脚同时改为**优先挑空闲脚**，没有空闲脚才用已占用脚。
- **文档纠正：`chromium.exe` 不是 GUI 信号**。每次 CubeMX CLI 调用都会拉起 8–9 个 `chromium.exe`（内嵌 JxBrowser）并随 JVM 退出；排查 GUI 只认 `STM32CubeMX` 主窗口标题，不要按 chromium 误杀。（DSH skill / MCP SKILL 同步修改）
- 文档数字/版本统一：MCP 包 README/SKILL/package.json/server.mjs 全部改成 10 个工具，`serverInfo.version` 与包版本对齐。

## 1.3.0 — 2026-11-07

- **新增意图层 `stm32_cubemx_intent`**：一句话配外设，不用记 CubeMX 内部名。
  - 支持 `"USART2 115200 TX=PA2 RX=PA3"`、`"I2C1 SCL=PB6 SDA=PB7"`、`"SPI1 SCK=PA5 MISO=PA6 MOSI=PA7"`、`"TIM3 PWM CH1=PA6"`、`"PB12 输入 上拉 label=KEY1"`；中文实例名 `串口2` / `定时器3` 也可以。
  - 对象形式：`{kind:"uart", instance:"USART2", pins:{TX:"PA2",RX:"PA3"}, params:{BaudRate:115200}}`。
  - 自动补引脚：只给外设不给脚时，从封装里找能承载该信号的脚（按引脚号排序），并缓存到 `%USERPROFILE%\.stm32cubemx\dsh-cubemx-intent-cache\`（每颗 MCU 只扫一次，之后免扫）。
  - 事务 + 回读：副本上 set pin → set mode → set ip parameters → saveas → reload → 逐项 `get` 回读；不一致就不写原文件。支持 `dryRun`。
  - 失败给出候选：脚上放不了该信号时返回该脚**实际可选信号清单**；mode 不对时返回该 IP 的可用 mode 列表。
  - 已验证的默认 mode（CubeMX 6.15.0 实测）：`Asynchronous`（UART）、`I2C`、`Full_Duplex_Master`（SPI）、`PWM Generation<n> CH<n>`（TIM）。
  - 重映射信号（`S_TIM3_CH1`、`S_TIM2_CH1_ETR`）视为等价，不会被误判为失败。
- 实测（2026-11-07，F103C8T6 / CubeMX 6.15.0）：UART 显式脚 46.9 s、自动补脚 25.6–26.8 s、GPIO 42.1 s、TIM PWM 43.5 s、I2C 45.4 s、SPI+GPIO 双意图 45.6 s；真实写入 USART2 921600 后 `.ioc` 落盘 `PA2/PA3.Signal=USART2_*`、`USART2.VirtualMode=VM_ASYNC`、`USART2.BaudRate=921600`，并自动 `.bak`；非法引脚（`USART2 TX=PA5`）返回候选、原文件未变。
- 新增 `tools/list` 第 10 个工具；MCP / CLI 自动继承（CLI 新增 `intent` 子命令与 `--intent` 重复参数）。

## 1.2.0 — 2026-11-04

- **修复：含空格路径不再拉起 CubeMX GUI 挂死**。所有写进 CubeMX 脚本的路径统一加双引号（`config load` / `config saveas` / `project path` / `project name` / `load`）。此前 `config load D:\My Project\x.ioc` 会被 CubeMX 按空格截断，报 "doesn't exist" 后**不退出而是打开 GUI 弹框**，调用一直卡到超时。实测：`scratch\space test\space test.ioc` 的 `inspect`（11.6 s）、`configure` dryRun（14.6 s）、`generate` 到 `...\space out\my gen`（22.6 s）全部通过。
- **新增：跨版本 `.ioc` 预检 `checkProjectVersion`（默认 true）**。读 `.ioc` 的 `MxCube.Version` 与 `ProjectManager.FirmwarePackage`，和本机 CubeMX 版本（`%USERPROFILE%\.stm32cubemx\mxinstallversion.txt`）及已装固件包（`%USERPROFILE%\STM32Cube\Repository`）比对；不一致时**直接报错、不启动 CubeMX**（否则 CLI 会弹固件迁移对话框并挂到超时）。实测：6.10.0/FW1.8.5 工程与 6.17.0 工程均在 8 ms 内被拒绝并给出原因；同版本工程不受影响。可用 `checkProjectVersion: false` 关闭。
- 配置项 `checkProjectVersion` 加入 `DEFAULT_CONFIG` 与校验。

## 1.1.0 — 2026-10-23

- 新增 `stm32_cubemx_clock`：`preset: "max"`（F1 72 MHz / F4 168 MHz）或语义参数（HSE、PLL、SYSCLK、APB/ADC 分频），事务写回 + 回读校验。
- 新增 `stm32_cubemx_nvic`：`get_interrupts` / `get_prioritygroup` / enable / disable / set_priority / set_subpriority / set_prioritygroup。
- 新增 `stm32_cubemx_dma`：只读查询（list_all / list_periph / available_periph_requests / available_streams）。
- `stm32_cubemx_configure`：`modes` 支持友好写法（如 `PWM CH1`），插件先用 `get mode available` 解析成 CubeMX 精确 mode id 再设置。
- 新增 `/cubemx` 命令：在对话框查看插件用法（pins / project / clock / rollback）。
- 新增 `verbose` 参数：默认返回短日志尾部，`verbose: true` 返回完整 CLI 日志。
- `.ioc2`（CubeMX2）工程现在给出明确错误，不再尝试用 V1 CLI 打开。
- 新增 `smoke-test.ps1` 环境自检脚本。
- 修复 GUI 检测误报（改为按窗口标题 `STM32CubeMX*` 匹配，不再匹配命令行）。

## 1.0.0 — 2026-10-21

- `stm32_cubemx_inspect` / `configure` / `generate` / `script`。
- 事务化写入：副本执行 → reload 回读 → 备份 → 替换；`dryRun`。
- UTF-8 无 BOM 脚本、GBK/UTF-8 输出解码、`KO`/`Usage:` 判据、`allowedRoots` 白名单。
