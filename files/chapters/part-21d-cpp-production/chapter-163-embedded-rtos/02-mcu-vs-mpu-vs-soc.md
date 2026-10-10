## MCU vs MPU vs SoC

The first decision on any embedded program is which class of silicon to use. The wrong choice locks you into a part with insufficient memory, the wrong peripherals, or a power budget you cannot meet. Senior engineers make this call before any C++ is written.

### The Three Classes

A microcontroller (MCU) integrates CPU, flash, SRAM, and peripherals on a single die. There is no MMU. Code executes in place from internal flash. Boot is deterministic and measured in milliseconds. RAM is between 4 KB and 1 MB. Examples: STM32F4, STM32H7, NXP RT1170, Nordic nRF5340, Espressif ESP32, Raspberry Pi RP2040.

A microprocessor (MPU) is a CPU plus optional cache and MMU that requires external DRAM and external flash to run. It boots a real operating system. RAM is in hundreds of megabytes to gigabytes. Examples: NXP i.MX 8, TI Sitara AM62, Allwinner H6.

A system-on-chip (SoC) is an MPU with significant additional silicon on the same die: GPU, NPU, ISP, DSP, modem, video codec. The line between MPU and SoC is fuzzy. Examples: Apple A17, NVIDIA Orin, Qualcomm Snapdragon 8 Gen 3, Tesla FSD chip.

### Cortex-M Lineup

The Arm Cortex-M family is the dominant MCU architecture in the world. Each generation trades silicon area and power for performance and features.

**Cortex-M0 and M0+** are the smallest. Two-stage pipeline, 56 instructions in the Thumb subset, no FPU, no DSP, no MPU on the M0 (optional on M0+). Used in 8 cent parts where C++ has to fit in 16 KB. Found in Nordic nRF52810, NXP LPC800, Raspberry Pi RP2040 (dual-core M0+).

**Cortex-M3** added the full Thumb-2 instruction set, hardware divide, bit-banding, and an optional MPU. Mostly superseded by the M4 but still ships in low-cost STM32F1 and LPC1700 parts.

**Cortex-M4** added a single-precision FPU and DSP extensions (saturating math, SIMD, MAC instructions). This is the workhorse for motor control, audio processing, and sensor fusion. Found in STM32F4, NXP K series, Nordic nRF52840.

**Cortex-M7** added a six-stage superscalar pipeline, double-precision FPU, instruction and data caches, and tightly coupled memories (TCMs) that give single-cycle access for hard real-time code. STM32H7, NXP RT1170. The RT1170 actually pairs an M7 with an M4 on the same die for asymmetric multiprocessing.

**Cortex-M33** introduced TrustZone for ARMv8-M, a coprocessor interface, and improved DSP. The M33 is the modern security-focused core. Nordic nRF9160 and nRF5340, NXP LPC55, STM32L5 and U5.

**Cortex-M55** added Helium, the M-profile Vector Extension (MVE), giving 128-bit SIMD on a microcontroller for AI inference. Helium reuses the FPU register file for vector ops, so the silicon cost is small. The M55 also supports half-precision floats. Used in Alif Ensemble, Himax WE2.

**Cortex-M85** is the highest-performance Cortex-M, an out-of-order pipeline with Helium, branch prediction, and pointer authentication. Targets 6.0+ CoreMark/MHz. Found in Renesas RA8 series and the Alif Balletto.

### RISC-V in Embedded

RISC-V has gone from research project to mainstream embedded core in less than a decade. The two big shops are Espressif and SiFive.

**Espressif.** The ESP32-C3, C6, H2, P4, and the upcoming C5 use RISC-V cores ranging from RV32IMC to RV32IMAFC. The ESP32-P4 has dual high-performance RV32 cores at 400 MHz with vector extensions and is positioned as a smart-home and industrial part. Espressif is the largest commercial deployment of RISC-V cores in the world.

**SiFive.** SiFive sells RISC-V IP cores from the small E20 (32-bit, no FPU) up to the P870 (out-of-order 64-bit application processor). SiFive cores ship in NXP RT700, Renesas RZ-Five, and the Tenstorrent BlackHole AI accelerator.

The reason embedded shops care about RISC-V is licensing. Arm charges per-chip royalties. RISC-V does not. For a high-volume IoT part shipping a billion units, that is real money. The downside is fragmentation: every vendor adds custom extensions, so a binary that runs on an ESP32-C6 will not run on a SiFive E21.

### Cortex-A vs Cortex-R

When the application needs an MMU, virtual memory, or a full operating system, the choice is between Cortex-A (application) and Cortex-R (real-time).

**Cortex-A** runs Linux, Android, QNX, or VxWorks. The MMU provides full virtual memory. The cores are out-of-order, deeply pipelined, and aggressive about prefetching. They are fast on average but have unpredictable worst-case latency because of cache misses, TLB misses, and branch mispredictions. Used in NVIDIA Drive Orin (Cortex-A78AE), Apple Silicon (custom ARMv8 cores), Tesla Autopilot HW3 (Cortex-A72), Qualcomm 8155 cockpit SoC (Cortex-A76).

**Cortex-R** is the real-time application core. It has an MPU instead of an MMU (or an optional MMU on R52 and later). The pipeline is in-order or limited out-of-order. The R5F, R52, and R82 support lockstep operation, where two cores execute the same instruction stream and compare results every cycle, detecting silicon faults instantly. This is the standard for ASIL-D safety critical compute. Used in NVIDIA Drive Orin safety MCU (Cortex-R52), Renesas RH850 successors, and the Aurix TC4x family at Infineon.

The "AE" suffix on cores like the Cortex-A78AE and Cortex-R52 stands for "Automotive Enhanced" and adds split-lock support, ECC on caches, and ISO 26262 documentation packages.

### When to Use What

A few rules of thumb that experienced firmware leads use:

**Use a Cortex-M0/M0+ or RV32IMC** when the BOM cost is the constraint and the firmware fits in 32 KB of flash. Battery sensors, simple motor drivers, lighting controls.

**Use a Cortex-M4** when you need DSP for audio or motor control and can spend 200 KB of flash on the application.

**Use a Cortex-M7** when you need hard real-time performance over 200 MHz with cache and TCM. Industrial controllers, high-speed printer controllers, drone flight controllers.

**Use a Cortex-M33 with TrustZone** when secure key storage and root of trust are required. Smart locks, payment terminals, modern IoT gateways.

**Use a Cortex-M55 or M85** when you need TinyML inference or vector DSP on a microcontroller. Anomaly detection, keyword spotting, low-resolution vision.

**Use a Cortex-R52 in lockstep** when you need ISO 26262 ASIL-D. Brake controllers, electric power steering, battery management for high-voltage packs.

**Use a Cortex-A** when you need Linux, complex networking, a display stack, or machine learning beyond what a vector MCU can do. Infotainment, ADAS perception, gateway routers.

### Memory Budgets in Practice

The following are realistic budgets that ship in production today. They are useful as sanity checks when you are early in a design.

| Class | Flash | SRAM | Power (active) | Power (sleep) |
|---|---|---|---|---|
| Cortex-M0+ class | 32 to 256 KB | 4 to 32 KB | 1 to 5 mA | 1 to 5 uA |
| Cortex-M4 class | 256 KB to 2 MB | 64 to 512 KB | 10 to 30 mA | 2 to 10 uA |
| Cortex-M7 class | 1 to 2 MB internal + 64 MB external QSPI | 256 KB to 1 MB | 50 to 150 mA | 10 to 50 uA |
| Cortex-M33 with TrustZone | 1 to 2 MB | 256 KB to 1 MB | 5 to 20 mA | 1 to 5 uA |
| Cortex-M55 with Helium | 2 MB | 1 MB | 30 to 80 mA | 5 to 20 uA |
| Cortex-A class | external 16 to 128 MB QSPI/eMMC | 128 MB to 4 GB DDR | 200 mA to 5 W | 1 to 50 mA |

Engineers who have built shipping products develop a feel for these numbers. If a product manager asks for "a Bluetooth sensor that runs 5 years on a coin cell," you know immediately that the SRAM budget is below 64 KB, the duty cycle is below 0.1 percent, and the chip is going to be a Nordic nRF52 or Silicon Labs EFR32 with a Cortex-M4.

### GPU and NPU Coprocessors

Modern automotive and consumer SoCs add specialized accelerators on the same die.

NVIDIA Drive Orin pairs Cortex-A78AE cores with a 254 TOPS GPU and dedicated DLA (Deep Learning Accelerator) cores. The driver software talks to the DLA over a hardware mailbox.

Apple Silicon pairs the application cores with a custom Neural Engine and a custom GPU. The C++ that drives the Neural Engine on Apple is private firmware running on a coprocessor.

Tesla FSD HW4 has two custom NPUs on a Samsung-fabricated SoC, each capable of dozens of TOPS. The neural network weights are loaded from flash by C++ application code on the Cortex-A side and then dispatched to the NPUs over a hardware ring buffer.

The pattern is the same across vendors. The application cores run C++ application code, the accelerators run vendor-specific instruction streams generated by a compiler that understands TensorFlow or PyTorch graphs. The C++ side is a driver and a queue manager, not the math.

---
