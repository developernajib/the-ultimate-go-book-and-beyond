# Chapter 163: Embedded C++ and RTOS Programming

> "The compiler is your friend. The hardware is your judge.", Anonymous firmware engineer

Embedded C++ is the version of C++ that runs without a kernel under it, without a heap to fall back on, and often without enough RAM to hold the standard library that desktop programmers take for granted. It runs the brake controller in a Tesla, the radio firmware in an iPhone, the flight computer on a Falcon 9 booster, the smart thermostat in a Nest, the industrial PLC on a Rockwell production line, and the GPU bring-up code on an NVIDIA Drive Orin. Every one of those products ships C++ where the constraints are not "make it fast," they are "make it fit, make it deterministic, make it never crash."

This chapter is about that version of C++. It is the C++ that senior firmware engineers at Apple, Tesla, SpaceX, NVIDIA, BMW, Mercedes, and Rockwell write every day. It is also the C++ that most application engineers have never seen, because the rules are different: no exceptions, no RTTI, no `std::vector` in the hot path, no dynamic dispatch where a vtable miss costs you a deadline, and a coding standard (MISRA, AUTOSAR, CERT) that forbids language features you would consider mundane.

## Why C++ at All on a Microcontroller

A common myth is that embedded means C. It does not. Modern embedded shops have been moving to C++ for two decades because C++ pays for itself when you exploit it correctly:

**Zero-cost abstractions.** A `constexpr` register-bit accessor compiles to a single `STR` instruction, identical to the hand-written `*(volatile uint32_t*)0x40020000 = 0x4` that a C engineer would write. The C++ version is type-safe, the C version is not. You pay nothing in flash or cycles for the safety.

**RAII for hardware peripherals.** A `SpiTransaction` object whose constructor asserts the chip-select line and whose destructor releases it is impossible to leak across an early return. C requires `goto cleanup` patterns. C++ makes correct cleanup the default.

**Templates for type-safe registers.** The Kvasir, CMSIS-RTOS2 C++, and Embo libraries use templates to encode peripheral layouts at compile time so that writing a reserved bit becomes a compilation error. The compiler refuses to emit the bad instruction.

**`constexpr` lookup tables.** Sine tables, CRC tables, gamma curves, and Reed-Solomon constants can all be computed at compile time and placed in `.rodata`, eating zero cycles at boot and zero RAM at runtime.

## Real Codebases You Will Encounter

The C++ in this chapter is the C++ that ships in production. A short tour of the codebases you will read or contribute to:

**Arduino core.** `HardwareSerial`, `Wire`, `SPI`, the `String` class, and the `Print` interface are all C++ classes. The framework hides the C++-ness from beginners, but underneath, every `digitalWrite` call goes through a virtual method table on most variants. The Arduino core is the largest hobbyist embedded C++ codebase in the world and the entry point for millions of engineers.

**ESP-IDF (Espressif).** The ESP32 SDK is C with a C++ application layer. Espressif moved Arduino-ESP32, BLE Mesh, ESP-Matter, and ESP-RainMaker to C++17 because the type safety of templates makes the protocol stacks easier to maintain. ESP-IDF runs FreeRTOS underneath and is the dominant Wi-Fi and Bluetooth platform for IoT.

**STM32 HAL and CMSIS.** STMicroelectronics ships their HAL in C, but Arm Mbed, ChibiOS, and modern STM32CubeIDE projects let you write the application in C++. CMSIS-Core defines the Cortex-M register layouts as C structs that compile equally well from C++.

**Apple Secure Enclave Processor.** The SEPOS firmware in every iPhone since the A7 is C++ running on a small Arm core inside the SoC. It handles Touch ID, Face ID, Secure Boot keys, and Apple Pay. Public details are scarce, but Apple job postings and security disclosures confirm a C++14 codebase with a custom lightweight RTOS.

**Tesla Autopilot ECU.** Tesla's vehicle controllers run a mixture of C++ on Cortex-A cores and C on Cortex-M safety cores. The HW3 and HW4 inference accelerator drivers are C++. Tesla has publicly stated they use a custom Linux variant on the main Autopilot board with the inference path written in C++.

**SpaceX Falcon 9 and Dragon flight software.** SpaceX flight software runs on dual-redundant x86 plus Arm boards. The flight code is C++14 with a heavily restricted subset, no exceptions, no heap after init, and a verification pipeline that includes static analysis with Coverity and runtime monitoring with custom assertion macros.

**NVIDIA Drive AGX Orin and Thor.** The autonomous driving stack at NVIDIA is C++17 on top of QNX or Linux on the Cortex-A78AE cores, with safety co-processors running C on Cortex-R52 cores. The ASIL-D safety partition is the C side, the perception and planning stack on the performance partition is C++.

**BMW iX and Mercedes EQS.** Both vehicles run AUTOSAR Adaptive on their high-performance compute units. AUTOSAR Adaptive mandates C++14 or later. The infotainment, ADAS planner, and over-the-air update agents are all C++.

**Nest Thermostat and Ring Doorbell.** Google Nest devices run Zephyr or a custom Linux build on Arm Cortex-A or Cortex-M33 SoCs. Ring devices run FreeRTOS on Espressif hardware with custom C++ application code on top.

**Rockwell ControlLogix.** Industrial PLCs from Rockwell Automation run a real-time kernel on a PowerPC or Arm core. The IEC 61131-3 ladder-logic engine is implemented in C++, and the I/O scanners that talk EtherNet/IP, ControlNet, and DeviceNet are C++.

## What This Chapter Covers

This chapter walks the full embedded C++ stack from silicon to firmware update.

It starts with the hardware: the Cortex-M and Cortex-R processors, RISC-V cores from Espressif and SiFive, and the application-class Cortex-A cores in modern automotive SoCs. It then walks through bare-metal startup, the C++ subset that survives in 64 KB of flash, and the register abstractions that make peripheral code type-safe.

The middle of the chapter is RTOS-heavy. FreeRTOS is the most-deployed RTOS in the world. Zephyr is the most-deployed open-source RTOS in new IoT designs. ThreadX (now Microsoft Azure RTOS), Mbed OS, NuttX, ChibiOS, and CMSIS-RTX5 each fit specific niches. Real-time Linux with PREEMPT_RT is the option when you need an MMU and full POSIX. Each gets a full treatment with code.

The latter half covers the production realities: AUTOSAR Adaptive for automotive C++, ISO 26262 safety classifications, MISRA C++ and AUTOSAR C++14 coding rules, secure boot and OTA, CAN/I2C/SPI bus drivers, on-MCU machine learning with TFLite Micro and CMSIS-NN, formal verification with Astree and Frama-C, and JTAG-based debugging with OpenOCD and Segger SystemView.

## Who This Chapter Is For

This chapter is written for senior engineers. It assumes you know C++17, you have written a non-trivial application in C, and you understand pointers, alignment, and the memory hierarchy. It does not teach C++ syntax. It teaches what C++ becomes when the operating system disappears, when the heap is forbidden, and when a missed deadline crashes a car.

If you are interviewing at Tesla Autopilot, Apple Silicon firmware, NVIDIA Drive, BMW, Mercedes, SpaceX, Rockwell, Nest, or Ring, the material here is the technical floor. Hiring managers at all of those companies expect candidates to be fluent in the topics in this chapter before the on-site loop.

---
