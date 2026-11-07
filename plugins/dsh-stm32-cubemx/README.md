# dsh-stm32-cubemx

一个 DeepSeek Harness **Host 插件**：用 STM32CubeMX 官方命令行脚本模式（`-q`）让 agent 直接查询 `.ioc`、配置引脚/外设、生成 HAL 工程，全程不打开 CubeMX 图形界面。

它把「agent 操作 CubeMX」做成 10 个模型可直接调用的工具，而不是 GUI 自动化：

| 工具 | 作用 | 写文件 |
| --- | --- | --- |
| `stm32_cubemx_intent` | **一句话配外设**（UART/I2C/SPI/TIM PWM/GPIO）：自动补引脚、自动选 mode、自动设参数（波特率等），事务写回 + 回读 | 是（有备份） |
| `stm32_cubemx_inspect` | 加载 `.ioc`，返回 MCU/封装/已分配引脚；带 `pins` 时还返回每个脚的**可选信号** | 否 |
| `stm32_cubemx_configure` | 设置引脚 signal / label / pull、外设 mode（支持友好写法）；事务化写回 | 是（有备份） |
| `stm32_cubemx_generate` | 对已有 `.ioc` 执行 `config load` + `project generate` | 是 |
| `stm32_cubemx_clock` | `preset:"max"`（F1 72 MHz / F4 168 MHz）或语义参数调时钟树，回读校验 | 是（有备份） |
| `stm32_cubemx_nvic` | 查/改 NVIC：enable/disable、优先级、子优先级、priority group；`irq` 用向量名（`TIM3_IRQn`，先 `get_interrupts` 查），传数字会被 CubeMX 拒绝 | 是（有备份） |
| `stm32_cubemx_dma` | 只读 DMA 查询：list_all / list_periph / available_periph_requests / available_streams | 否 |
| `stm32_cubemx_new_project` | 从 MCU 型号**新建工程**并生成代码，自动套用默认（Advanced、每外设 `.c/.h`、CMake、SWD、HSE、最大 HCLK） | 是 |
| `stm32_cubemx_rollback` | 列出 / 恢复 `configure` 留下的 `.bak-*` 备份 | 是（恢复时） |
| `stm32_cubemx_script` | 原生脚本逃生通道（`config load` / `set` / `get` / `project generate`） | 视脚本而定 |

另外注册了 `/cubemx` 对话框命令（`pins` / `project` / `clock` / `rollback` 主题速查），并有 `smoke-test.ps1` 环境自检脚本。

所有工具支持 `verbose: true` 返回完整 CubeMX 日志；默认只回短尾部。`.ioc2`（CubeMX2）工程会明确拒绝。

## 支持哪些芯片（2026-11-07 实测）

插件本身**不写死芯片表**：它把 .ioc 交给 CubeMX 6.15（本机识别 4801 款 MCU），引脚复用、mode id、时钟树都从 CubeMX 实时查询。所以"能不能用"取决于两件事：**①本机装了对应系列的固件包；②该系列外设命名与已验证的一致**（不一致会返回候选清单，不会静默写错）。

| 系列 | 本机固件包 | 实测状态 |
| --- | --- | --- |
| **F1**（STM32F103C8T6 等） | `STM32Cube_FW_F1_V1.8.7` | ✅ **全面验证**：inspect / configure / intent（UART/I2C/SPI/TIM 频率/ADC/CAN/GPIO）/ clock / nvic / generate / rollback 全部通过（15 项回归 + 4 轮独立验收，最大误差 0.001%） |
| **F4**（STM32F407VGTx 等） | `STM32Cube_FW_F4_V1.28.3` | 🟡 **部分验证**：`new_project` + 168 MHz 时钟 + 生成代码已实测通过（42 文件）；意图层的 UART/GPIO/TIM/NVIC/clock 走通用命令可用；**ADC 转换序列的端到端生成待复测**（本轮在 F4 上被 CubeMX 报 “ADC1 not ready”） |
| F0 / F2 / F3 / F7 / G0 / G4 / H5 / H7 / L0 / L1 / L4 / L5 / U0 / U3 / U5 / WB / WBA / WL / C0 / N6 / MP1 / MP2 等 | ❌ 未安装 | 需先在 CubeMX 里下载对应固件包（联网），插件会做版本预检并**明确报缺失**，不会硬跑 |

补充：

- **`clock preset:"max"`** 只实现 F1（72 MHz）和 F4（168 MHz，自动按晶振算 PLLM）；其他系列请传 `pllMul/sysclkDiv/adcDiv` 等语义参数或用 `script`。
- **ADC 新通道**的采样时间默认值由 CubeMX 自己填（F1/F4 实测都填 `ADC_SAMPLETIME_55CYCLES_5`）；采样时间本身不能通过 CLI 指定。
- 想确认某颗具体型号：直接说型号（如 `STM32G431CBTx`），先装它的固件包，再跑一次 `new_project` + intent 即可按同样标准验收。
## 意图层：一句话配外设（v1.6.0：外设 + NVIC + DMA 参数 + 时钟）

不用记 `USART2_TX` / `VM_ASYNC` 这些内部名，直接写人话：

```js
stm32_cubemx_intent(iocPath, dryRun: true, intents: [
  "USART2 115200 TX=PA2 RX=PA3",          // 串口：引脚 + 波特率 + 异步模式
  "I2C1 SCL=PB6 SDA=PB7",                 // I2C
  "SPI1 SCK=PA5 MISO=PA6 MOSI=PA7",       // SPI 全双工主机
  "TIM3 PWM CH1=PA6 1kHz duty=25",        // 定时器 PWM：自动算 Prescaler/Period/Pulse
  "ADC1 IN0=PA0",                         // ADC 通道（也可 "ADC1 PA1" 自动识别通道）
  "CAN1 TX=PA12 RX=PA11",                 // CAN
  "PB12 输入 上拉 label=KEY1",             // GPIO：方向 + 上下拉 + 标签
  "DAC OUT1=PA4 OUT2=PA5",                // DAC 双通道（v1.5.0）
  "USB 设备",                              // USB_OTG_FS Device_Only，DM/DP 自动（v1.5.0）
  "DMA USART1_TX",                        // 加 DMA 请求，自动落到 DMA2_Stream7（v1.5.0）
  "FSMC NAND 8bit",                       // 自动挑整组 NAND 引脚（v1.5.0）
  "CLOCK max",                            // 时钟：最大 HCLK，或 "CLOCK 120MHz"（v1.6.0）
  "NVIC TIM3_IRQn priority=2",            // 开中断 + 优先级（v1.6.0）
  "DMA USART1_TX direction=P2M priority=HIGH", // DMA 参数细调（v1.6.0）
])
```

- 中文实例名也认：`串口2` → `USART2`，`定时器3` → `TIM3`；`上拉/下拉/输入/输出` 同理。
- **引脚可以不给**：`"USART2 9600"` 会自动从封装里挑能承载 TX/RX 的脚（按引脚号排序），并标注 `(auto-selected)`。
- 对象形式：`{kind:"uart", instance:"USART2", pins:{TX:"PA2",RX:"PA3"}, params:{BaudRate:115200}}`；`mode` 可显式覆盖默认值。
- 已验证的默认 mode（CubeMX 6.15.0 实测）：UART `Asynchronous`、I2C `I2C`、SPI `Full_Duplex_Master`、TIM `PWM Generation<n> CH<n>`、ADC `IN<n>`（每通道一个 mode）、CAN `CAN_Activate`、DAC `DAC_OUT<n>`、USB `Device_Only`、FSMC `NandChipSelect2_1 + 8b-dmux1 + Wait1`。
- **TIM 频率**：`1kHz` / `freq=1000` + 可选 `duty=25`，用 RCC HCLK/APB 算真实定时器时钟（APB 分频≠1 时 ×2）。实测（Prescaler 是 PSC 寄存器，真实分频 = PSC+1）：72 MHz→1 kHz：PSC 1 / ARR 35999 / pulse 18000；20 kHz：PSC 0 / ARR 3599 / pulse 1800；1 Hz：PSC 1124 / ARR 63999。
- **ADC**：`IN0=PA0` 显式通道、`ADC1 PA1` 由脚反查通道、`IN0` 单独出现则自动选脚；验证用 `get pinout`（`get signal` 对 ADC 脚返回 KO）。
- **CAN**：F1 单 CAN 会自动把 `CAN1` 映射成 IP `CAN` + 信号 `CAN_TX/CAN_RX`。
- **DAC**：`OUT1`/`OUT2` 可单独或一起；CubeMX 把引脚报成 `COMP_DAC1_group`/`COMP_DAC2_group`，插件已按 DAC 组兼容。
- **USB**：`USB 设备`（`Device_Only`）/`USB 主机`（`Host_Only`）/`USB OTG`（`OTG/Dual_Role_Device`），DM/DP 自动落到 PA11/PA12（F4）。
- **DMA**：`DMA <请求名>`，请求名就是 CubeMX 的 DMA request（`USART1_TX`、`ADC1`、`TIM2_UP`…）；写入后从 `dma list_all` 回读确认落到哪条 Stream。
- **FSMC**：`FSMC NAND 8bit`（默认）或 `FSMC NOR 16bit`；插件按 MCU 引脚表自动挑整组信号，LQFP100 这类封装只有 NAND 信号时会明确提示缺哪个信号。
- **时钟**：`CLOCK max` 用 F1/F4 预设；`CLOCK 120MHz` 自动解 PLL（F1 解 PLLMUL，F4 解 PLLM/PLLN/PLLP/PLLQ），也可显式给 `pllMul/pllN/apb1Div/apb2Div/adcDiv`；回读 HCLK ±1% 校验。非 F1/F4 会明确报不支持。
- **NVIC**：`NVIC TIM3_IRQn`（可选 `priority=2`），中文 `USART1 中断`；校验 `.ioc` 里 `NVIC.<irq>=true...`。
- **DMA 参数**：`DMA USART1_TX direction=P2M priority=HIGH`，支持方向/优先级/模式/MemInc/数据宽度/FIFO，按 `.ioc` 文本校验。
- 事务：副本上 `set pin` → `set mode` → `set ip parameters` → `saveas` → `reload` → 逐项回读；不一致不写原文件，写成功自动 `.bak-<时间戳>`。
- 失败给候选：脚放不下该信号 → 返回该脚可选信号清单；mode 不对 → 返回该 IP 的可用 mode 列表；**原文件不动**。
- 引脚函数表缓存在 `%USERPROFILE%\.stm32cubemx\dsh-cubemx-intent-cache\<MCU>__<封装>.json`（每颗 MCU 只扫一次，之后免扫；删掉即可重建）。
- 实测耗时（F103C8T6）：显式引脚 27–50 s；自动补脚首次 +1 次扫描、之后 25–27 s。
- 冲突提示：某个脚原本是别的功能时（例如原为 `ADCx_IN2` 且带标签），输出 `WARN #1 USART2: PA2 was ADCx_IN2 (label SOIL_3); it becomes USART2_TX`；自动选脚优先挑空闲脚。
- 写工具（`intent` / `configure` / `clock` / `nvic`）会保留工程名（1.3.2 修复）：暂存文件沿用目标 `.ioc` 文件名，并在落盘前把 `ProjectManager.ProjectFileName/ProjectName` 改回目标名，带空格/中文的文件名也不会被截断。
- 边界：**ADC 采样时间改不了**（CubeMX CLI `set ip parameters …SamplingTime…` 会存成 `null`，实测 4 种写法），保持工程默认或用 GUI；GPIO 标签仍限 ASCII。
- `generate` 边界：工程里有“未就绪”外设时（日志 `IP not ready for code generation: I2C1`，例如 `smart_agri_f103`），CubeMX 6.15 的 `project generate` 会**一直阻塞**；插件超时错误会点名该外设并提示去 GUI 补齐/移除。干净工程实测 33 s、921 个文件。

## 默认使用约定：先验证再写

用户已确认：配引脚默认走「`inspect` 查现状 → `configure(dryRun: true)` 给出回读表 → 确认后正式写入（自动备份）」；只有用户明确说「直接写」时才跳过 dryRun。该约定已记录在工作区 `AGENTS.md`，后续会话自动遵守。

## 安装与配置

本目录是 bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），安装：

```text
plugin_manager(action="install_bundle", target="<本仓库>/plugins/dsh-stm32-cubemx")
```

配置写在 `cordis.patch.yml` 的插件行里；改完后重新安装（remove_bundle + install_bundle）即生效，因为本地目录是链接安装、模块会被缓存：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mxHome` | `<CubeMX 安装目录>` | CubeMX 安装目录（含 `STM32CubeMX.exe`、`jre/`） |
| `javaPath` | 空 | 显式指定 java；空则用 `<mxHome>/jre/bin/java.exe`，再退回 PATH |
| `allowAnyPath` | `false` | `true` = 不限制写入路径（全局可用）；`false` = 只能写 `allowedRoots` 内 |
| `allowGuiRunning` | `false` | `false` = 检测到 CubeMX GUI 在运行就**拒绝写入**（GUI 保存会覆盖 CLI 改动）；`true` = 跳过检查 |
| `allowedRoots` | `[]` | `allowAnyPath: false` 时的写入白名单；为空则拒绝一切写入 |
| `timeoutMs` | `300000` | 单次 CubeMX 调用超时 |
| `maxLogChars` | `4000` | 返回给模型的日志尾部字符上限 |
| `checkProjectVersion` | `true` | 预检 `.ioc` 的 CubeMX 版本与固件包版本；与本机不一致时直接报错、不启动 CubeMX（否则 CLI 会弹迁移对话框并挂死）。确认要强行尝试时设为 `false` |

当前本机配置为 `allowAnyPath: true`：任意盘的工程都能直接改，不再需要"先拷到允许目录再拷回"。

JVM 参数不写死：插件读取安装目录的 `STM32CubeMX.l4j.ini`，与该安装的启动配置保持一致。

## 事务与安全设计

`stm32_cubemx_configure` 不是「直接改原文件」：

1. 复制原 `.ioc` 到临时目录；
2. 先 `get functions <pin>` 预检目标信号，不合法直接返回该脚**可选信号清单**；
3. 在一个 CubeMX 会话里 `config load` → `set ...` → `config saveas` → 重新 `config load` → 逐项 `get` 回读；
4. 回读不一致、出现 `KO`、或 `Usage:` 错误 → 返回失败并**不碰原文件**；
5. 全部通过才写回原文件，并先留 `<原文件>.bak-<时间戳>`（可用 `stm32_cubemx_rollback` 恢复）；
6. `dryRun: true` 只验证不写；写操作前还会检测 CubeMX GUI 是否在运行（`allowGuiRunning`）。

这正好补上 CubeMX CLI 的坑：它**不严格校验枚举值**——例如 `set gpio parameters PB12 GPIO_PuPd PULLUP` 也返回 `OK`，但生成的是非法 C（`GPIO_InitStruct.Pull = PULLUP;`）。插件把 `pullup` 归一化为 `GPIO_PULLUP`，并且以「回读 + 生成代码」而不是「单个 OK」作为成功判据。

## 实测（本机 2026-10-21）

```text
stm32_cubemx_configure(iocPath=PID_Car.ioc, pins=[{pin:PB12, signal:GPIO_Input, label:KEY1, pull:GPIO_PULLUP}], saveTo=copy.ioc)
→ Configured ... Verified by reload+readback and written to copy.ioc
stm32_cubemx_generate(iocPath=copy.ioc, outputDir=..., toolchain=CMake)
→ Generated HAL project (17 files/dirs)

生成的 Core/Src/gpio.c：
  /*Configure GPIO pin : KEY1_Pin */
  GPIO_InitStruct.Pin = KEY1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
```

失败路径同样实测：`signal=GPIO_Bogus` → 预检直接返回 `available: ADC1_IN5, ADC2_IN5, SPI1_SCK, GPIO_Input, ...`，原 `.ioc` 未改动。

## 2026-10-23 新增能力实测

```text
stm32_cubemx_new_project(mcu=STM32F103C8Tx, projectDir=..., projectName=PresetTest)
→ Created ... (42 files/dirs)，HCLK: 7.2E7 (preset target 72000000)
  .ioc: CoupleFile=true、PA13/PA14=SWD、PLLMUL=RCC_PLL_MUL9、SYSCLK=PLL
  cmake --preset Debug + build：通过（RAM 1584 B / FLASH 3644 B）

stm32_cubemx_rollback(iocPath=..., action=list)   → 1 backup(s)
stm32_cubemx_rollback(iocPath=..., action=restore) → 恢复成功，当前状态先存为新的 .bak

GUI 检测：CubeMX GUI 运行中（PID 32128）时 configure 直接拒绝：
"STM32CubeMX GUI is running (PID 32128); saving there can overwrite the .ioc this plugin writes."
```

## 2026-11-04 两个 bug 修复实测

两个会让 CubeMX CLI **不报错、直接拉起 GUI 挂死**的坑（表现为桌面上弹一个框，工具调用卡到 300 s 超时）：

```text
1) 含空格路径（旧行为）
   config load D:\Downloads\UART_Test - HAL\UART_Test.ioc
   → CubeMX 按空格截断成 D:\Downloads\UART_Test，报 "Load Project ... doesn't exist" 后拉起 GUI

2) 跨版本 .ioc
   WS2812.ioc（6.10.0 / FW1.8.5）→ 弹 "New STM32Cube firmware version available / Migrate·Continue·Cancel"
```

修复后（本机 CubeMX 6.15.0 / FW_F1 V1.8.7）：

```text
含空格路径 inspect      (scratch\space test\space test.ioc)  → ok, 11.6 s
含空格路径 configure    (PB0 → GPIO_Output, dryRun)                        → ok, 14.6 s，回读一致
含空格路径 generate     (…\space out\my gen, 工程名含空格)                  → ok, 22.6 s, 17 files
版本不符 WS2812(6.10.0) → 8 ms 内拒绝：was created with 6.10.0, this machine runs 6.15.0;
                          needs firmware "STM32Cube FW_F1 V1.8.5"（未安装）
版本不符 UART_Test(6.17.0) → 7 ms 内拒绝：created with 6.17.0, machine runs 6.15.0
同版本 smart_agri_f103  → inspect ok, 12.1 s（未受影响）
```

## 已知边界

- **GPIO 标签必须是 ASCII**。CubeMX 对非 ASCII 标签返回 `OK` 却存成空字符串，所以插件提前拒绝（避免“假成功”）。
- 中文路径可用：`.ioc` 路径不需要转 8.3 短名（CubeMX 用 UTF-8 读脚本）；CubeMX 的 stdout 是系统代码页（中文 Windows 为 GBK），插件做了 UTF-8/GBK 自动解码，否则中文路径回显会乱码并导致命令分段失败。
- **路径里不能有双引号**：插件给所有 CubeMX 脚本路径加双引号（1.2.0 起），含 `"` 的路径会直接报错。
- **跨版本工程必须先迁一次**：`.ioc` 的 CubeMX 版本或固件包与本机不一致时，插件会提前拒绝（`checkProjectVersion`）。先在 CubeMX GUI 里打开并保存一次完成迁移，或装对应版本固件包；确要强行尝试才设 `checkProjectVersion: false`（大概率仍会弹 GUI 挂死）。
- GUI 弹框只在**启动前**检测：如果 CubeMX 在运行中途自己弹窗（极少数，多与工程资源缺失有关），调用会卡到 `timeoutMs` 才被杀掉；遇到这种先看日志尾部里的 `[ERROR]` 行。
- CubeMX CLI 不暴露完整引脚编辑器 API（复杂复用功能/参数组合仍建议先改 `.ioc` 再用本插件做加载/回读/生成验收）。
- 写操作前会检测 CubeMX GUI：默认（`allowGuiRunning: false`）通过**窗口标题**（`STM32CubeMX*`）判断 GUI 是否在运行，检测到就拒绝写入，因为 GUI 保存时会把它内存里的旧配置覆盖回 `.ioc`。要么先关 GUI，要么把开关设为 `true`。（早期版本用命令行匹配，会把自己的检测进程也算进去，已修复。）
- CubeMX2（`.ioc2`）尚未适配，本插件只处理传统 `.ioc`。
