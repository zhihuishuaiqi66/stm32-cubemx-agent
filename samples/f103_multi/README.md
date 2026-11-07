# STM32F103RCTx 多外设示例工程（f103_multi）

由 dsh-stm32-cubemx 插件（v1.4.4）自动生成，CubeMX 6.15.0 + FW_F1 V1.8.7，工具链 CMake。

- 主工程：`f103_multi.ioc`（CubeMX 直接打开即可）
- 生成代码：`generated/f103_multi/`（931 个文件/目录）
- 芯片：STM32F103RCT6（LQFP64），HCLK 72 MHz，APB1 36 MHz，APB2 72 MHz，ADC 12 MHz

## 已配置外设

| 外设 | 配置 | 引脚 |
| --- | --- | --- |
| USART1 | 异步 115200，中断已开 | PA9 TX / PA10 RX |
| USART2 | 异步 9600 | PA2 TX / PA3 RX |
| USART3 | 异步 115200 | PB10 TX / PB11 RX |
| I2C1 | 标准 I2C（默认 400 kHz） | PB6 SCL / PB7 SDA |
| SPI1 | 全双工主机，NSS 硬件（PA4），预分频 /4（18 MHz） | PA4 NSS / PA5 SCK / PA6 MISO / PA7 MOSI |
| CAN1 | Activated 模式（默认 500 kbps 参数） | PA11 RX / PA12 TX |
| ADC1 | 规则转换 4 通道：IN0/IN1/IN10/IN11，序列 rank1–4，采样 55.5 cycles | PA0 / PA1 / PC0 / PC1 |
| TIM3 | PWM CH1，1 kHz，占空比 25%（PSC 1 / ARR 35999 / Pulse 9000），中断已开 | PC6 |
| TIM4 | PWM CH3，20 kHz，占空比 50%（PSC 0 / ARR 3599 / Pulse 1800） | PB8 |
| GPIO | PC13 输出（label LED） | PC13 |
| GPIO | PB12 输入上拉（label KEY1） | PB12 |
| SYS | Serial Wire（SWD）+ SysTick | PA13 / PA14 |
| NVIC | USART1_IRQn、TIM3_IRQn 已启用 | — |

## 说明

- `.ioc.bak-*` 是逐次写入时插件自动留的备份，可删。
- 这个工程是**逐外设写入**的：ADC 每加一个通道单独一次调用（CubeMX CLI 在同一会话里连续设置多个 ADC mode 会顶掉前面的转换序列，插件已改为“按新索引追加”）。
- SPI 的 `BaudRatePrescaler` 用 /4 是因为 F1 SPI1 上限 18 Mbit/s，默认 /2 会得到 36 Mbit/s 被 CubeMX 判 “SPI1 not ready” 并阻塞生成。