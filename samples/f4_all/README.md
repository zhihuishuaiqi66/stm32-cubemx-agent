# STM32F407VGTx 全外设示例工程（f4_all）

由 dsh-stm32-cubemx 插件（v1.4.5）自动生成，CubeMX 6.15.0 + FW_F4 V1.28.3，工具链 CMake。
覆盖用户点名的 **DAC / 输入捕获 / USB / FSMC / DMA** 五类外设，以及 USART1。

- 主工程：`f4_all.ioc`（CubeMX 直接打开）
- 生成代码：`generated/f4_all/`（**1474 个文件**）
- 芯片：STM32F407VGT6（LQFP100），HCLK 168 MHz，USB 48 MHz（PLLQ=7）

## 已配置外设

| 外设 | 配置 | 引脚 | 生成文件 |
| --- | --- | --- | --- |
| **DAC** | DAC_OUT1 + DAC_OUT2 | PA4 / PA5 | `dac.c/h` |
| **输入捕获** | TIM3 CH1，`Input_Capture1_from_TI1`（直连） | PA6 | `tim.c/h` |
| **USB** | USB_OTG_FS，Device_Only | PA11 DM / PA12 DP | `usb_otg.c/h` |
| **FSMC** | NAND 8-bit：CLE/A16、ALE/A17、NCE2、NOE、NWE、NWAIT | PD14/PD15/PD0/PD1/PE7-10（D0-D7）、PD11、PD12、PD7、PD4、PD5、PD6 | `fsmc.c/h` |
| **DMA** | USART1_TX → **DMA2_Stream7**（MEM→PERIPH，Normal，Byte） | — | `dma.c/h` |
| USART1 | 异步 115200 | PA9 TX / PA10 RX | `usart.c/h` |

## 怎么复现（命令清单）

> 插件 **v1.5.0 起这些外设已进 `intent`**，可以直接一条命令配：
>
> ```js
> ["DAC OUT1=PA4 OUT2=PA5", "USB 设备", "DMA USART1_TX", "FSMC NAND 8bit"]
> ```
>
> 下面保留的是最早的 `script` 逃生通道写法（v1.4.5 时用来验证 CubeMX 行为）。

```text
# A: USART1 + DAC + 输入捕获 + USB
config load "<工程>.ioc"
set pin PA9 USART1_TX
set pin PA10 USART1_RX
set mode USART1 Asynchronous
set ip parameters USART1 BaudRate 115200
set pin PA4 DAC_OUT1
set pin PA5 DAC_OUT2
set mode DAC DAC_OUT1
set mode DAC DAC_OUT2
set pin PA6 TIM3_CH1
set mode TIM3 Input_Capture1_from_TI1
set pin PA11 USB_OTG_FS_DM
set pin PA12 USB_OTG_FS_DP
set mode USB_OTG_FS Device_Only
config saveas "stageA.ioc"
exit

# B: FSMC NAND 8-bit
config load "stageA.ioc"
set pin PD14 FSMC_D0 … set pin PE10 FSMC_D7   # D0-D7
set pin PD11 FSMC_CLE
set pin PD12 FSMC_ALE
set pin PD7 FSMC_NCE2
set pin PD4 FSMC_NOE
set pin PD5 FSMC_NWE
set pin PD6 FSMC_NWAIT
set mode FSMC NandChipSelect2_1
set mode FSMC 8b-dmux1
set mode FSMC Wait1
config saveas "stageB.ioc"
exit

# C: DMA
config load "stageB.ioc"
dma add USART1_TX          # 自动落到 DMA2_Stream7
config saveas "stageC.ioc"
exit
```

## 实测发现（值得记）

1. **F407 LQFP100 的 FSMC 只有 NAND 类信号**（没有 A0–A15、没有 PF/PG 口），所以做不了 NOR/SRAM 16 位，选 NAND 8-bit 才能生成。
2. **F4 的 CLI 不支持 `clock set ADCPresc`**（F1 才支持）；F4 工程一旦启用 ADC，需要显式处理 ADC 预分频（否则 `Clock not ready`）。
3. DAC 引脚在 `.ioc` 里显示为 `COMP_DAC1_group` / `COMP_DAC2_group`（CubeMX 把 DAC 和比较器合并成 group），属正常。
4. 生成通过的关键：CubeMX 认为 IP “就绪”才不阻塞 `project generate`；缺信号/波特率超限都会被判 not ready（F1 的 SPI / ADC 预分频两个坑已在 1.4.3/1.4.4 修掉）。