## Learning Objectives

After working through this chapter, you should be able to do the following without consulting documentation.

### Hardware and Architecture

You should be able to pick the right Arm core for a product brief. Given a spec like "1.5 W power budget, 512 KB SRAM, hard real-time motor control loop at 20 kHz," you should immediately reach for a Cortex-M7 or M33 with a tightly coupled memory and reject a Cortex-A application processor.

You should know the difference between a Cortex-M (microcontroller, no MMU, deterministic interrupt latency), a Cortex-R (real-time, optional MMU or MPU, lockstep cores for safety), and a Cortex-A (full MMU, virtual memory, runs Linux or QNX). You should know when a RISC-V core from Espressif or SiFive is the right answer and when it is not.

You should know the typical SRAM, flash, and power budgets for each class of part, and you should be able to estimate whether a given C++ design will fit before you compile it.

### Bare-Metal Startup

You should be able to read a Cortex-M reset vector table, walk the assembly that copies `.data` from flash to SRAM, zeros `.bss`, and then calls C++ static constructors in priority order before jumping to `main`.

You should be able to write a linker script that places `.text` in flash, `.data` in SRAM with a load address in flash, `.bss` in SRAM, the stack at the top of SRAM, and a `.ramfunc` section for code that must execute from RAM for performance.

You should be able to explain why `newlib-nano` and `picolibc` are smaller than full `newlib` and what features you give up.

### C++ Subset

You should be able to enumerate which C++ features are safe in a 64 KB flash budget and which are not. You should know that exceptions cost roughly 30 KB of unwind tables and a heap allocation per throw, that RTTI costs roughly one pointer per polymorphic class plus type-info strings, and that `std::function` allocates on the heap unless small-buffer optimization fits the lambda.

You should be able to write a class hierarchy without `virtual` when you cannot afford the vtable, and you should know how to use CRTP to get the same effect with zero runtime cost.

### RTOS Fundamentals

You should be able to explain priority inversion, demonstrate it in code, and show how priority inheritance in `xSemaphoreCreateMutex` fixes it. You should know why a binary semaphore is not a mutex and when the distinction matters.

You should be able to write FreeRTOS or Zephyr code that creates tasks with explicit stack sizes, communicates through queues without blocking the wrong way, and uses event groups or notifications instead of polling.

You should know what tickless idle is, why it matters for battery life, and how to write a hook that turns off peripherals before sleep.

### Safety and Compliance

You should be able to explain the four ASIL ratings (A, B, C, D), give an example of a system at each level, and know that ASIL-D applies to brake-by-wire and steer-by-wire while ASIL-A applies to instrument cluster lighting.

You should know why AUTOSAR Adaptive mandates C++14 minimum, why MISRA C++ 2008 forbids dynamic memory after init, and why AUTOSAR C++14 superseded MISRA C++ 2008 for many automotive shops before MISRA C++ 2023 reunified the standards.

You should be able to read a static analyzer report from Polyspace, LDRA, or Coverity and know which violations are blockers, which need deviations, and which are false positives.

### Buses and Peripherals

You should be able to write a CAN driver that handles arbitration, error counters, and bus-off recovery. You should be able to write an I2C driver that handles clock stretching and address conflicts. You should be able to write a SPI driver with DMA double-buffering for an SD card or display.

You should know the framing for ISO-TP on top of CAN, the OBD-II PIDs that diagnostic tools query, and the differences between SMBus and I2C.

### Debugging and Verification

You should be able to bring up a board with OpenOCD and a J-Link or ST-Link, set a breakpoint, dump the fault status registers after a hard fault, and unwind the stack from a post-mortem RAM dump.

You should know what Segger SystemView shows you, what ITM trace is useful for, and how to use Frama-C or Astree to prove the absence of runtime errors in safety-critical code.

### What You Should Walk Away With

The unifying theme is determinism. Application C++ is about throughput. Embedded C++ is about meeting every deadline, every cycle, every time the part is powered on for the next ten years in a car or industrial controller. By the end of this chapter, you should be able to look at a C++ source file and predict its worst-case execution time, its worst-case stack usage, and its worst-case memory footprint, because the customer is going to measure all three.

---
