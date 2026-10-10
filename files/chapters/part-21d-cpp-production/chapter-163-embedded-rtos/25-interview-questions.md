## Interview Questions

The following 15 questions are the technical floor for senior embedded C++ roles at Tesla Autopilot, Apple Silicon firmware, NVIDIA Drive, BMW, Mercedes, SpaceX, Rockwell, Nest, and Ring. The expected answer is a detailed technical explanation, not a one-line definition.

### 1. Walk through what happens between power-on-reset and the first line of `main` on a Cortex-M4.

A senior answer covers: silicon resets, the boot ROM (if any) checks for boot mode pins, the CPU loads the initial stack pointer from flash address 0 and the reset vector from flash address 4, the reset handler runs in privileged mode with interrupts disabled, the handler copies `.data` from flash LMA to SRAM VMA, zeroes `.bss`, enables the FPU by writing CPACR (with DSB and ISB after), iterates the `.init_array` to call C++ static constructors, then jumps to `main`. Mention that `main` returning is undefined for an embedded program and the standard pattern is `for (;;) wfi`.

### 2. Why are exceptions and RTTI typically disabled in embedded C++?

Exceptions: roughly 30 KB of unwind tables for a non-trivial program, throwing requires walking the stack with unwind info inspection, calling destructors, and possibly heap-allocating the exception object. The latency is unpredictable, which is fatal in real-time code. RTTI: every polymorphic class adds a typeinfo pointer plus a typeinfo string, costing both flash and RAM. `dynamic_cast` requires walking the inheritance graph at runtime. AUTOSAR C++14 rule A5-2-1 forbids `dynamic_cast` outright. Senior bonus: explain how C++23 `std::expected` is the modern alternative for error handling.

### 3. Describe priority inversion with a concrete example, and explain how priority inheritance fixes it.

The Mars Pathfinder example. A high-priority task waits on a mutex held by a low-priority task. A medium-priority task preempts the low-priority holder. The high-priority task is now indirectly blocked by the medium-priority task, an unbounded delay. Priority inheritance: the holder of a contested mutex temporarily inherits the priority of the highest waiter, preventing the medium task from preempting it. FreeRTOS `xSemaphoreCreateMutex` has it, `xSemaphoreCreateBinary` does not. Explain why the distinction matters: signaling does not need PI, resource protection does.

### 4. What is the purpose of `__DSB` after writing a peripheral enable bit?

Senior answer: the CPU's store buffer may hold the enable write while the next instruction (which depends on the peripheral being on) executes, leading to a fault or a wrong read. `__DSB` (data synchronization barrier) flushes the store buffer and waits for all outstanding memory operations to complete before proceeding. Required after enabling the FPU (CPACR write), enabling a peripheral, programming the MPU, modifying the vector table, and triggering DMA from a buffer the CPU just wrote.

### 5. How does tickless idle in FreeRTOS work, and what hooks must the application provide?

The kernel computes the time until the next time-based event (task delay or timer expiry), stops the SysTick, programs a low-power timer to wake at that future time, and calls `portSUPPRESS_TICKS_AND_SLEEP`. The application's port hook checks `eTaskConfirmSleepModeStatus`, programs the wake source, enters Stop mode (`SLEEPDEEP` plus `WFI`), and on wake, computes elapsed time and calls `vTaskStepTick`. Explain the failure modes: the wake source must be precise enough that no time-based events are missed.

### 6. What is the difference between MISRA C++ 2008, AUTOSAR C++14, and MISRA C++ 2023?

MISRA C++ 2008 was the original automotive subset, very restrictive, written for C++03. AUTOSAR C++14 (released 2017) modernized for C++14 and was the dominant subset until MISRA C++ 2023, which unified the AUTOSAR rules back into the MISRA family for C++17 and partly C++20. Most active programs in 2026 are migrating from AUTOSAR C++14 to MISRA C++ 2023. Explain the three rule categories: required, advisory, mandatory, and the deviation process.

### 7. Why does AUTOSAR Adaptive mandate C++ while AUTOSAR Classic uses C?

Classic targets MCUs with no operating system in the desktop sense (Cortex-M, Power, Tricore, RH850), where the C ecosystem and tooling were established. Adaptive targets POSIX-class application processors running QNX, PikeOS, or PREEMPT_RT Linux on Cortex-A. The Adaptive runtime (`ara::core`, `ara::com`) needs templates, RAII, type-safe smart pointers, and modern futures/promises, all of which are C++ features. C++14 is the minimum because it is the lowest version that supports the required language features (move semantics, lambdas, generic lambdas).

### 8. How does swap-on-reset firmware update work in MCUboot?

The flash is partitioned into a primary slot, a secondary slot, and a scratch area. The application stages a downloaded image to the secondary slot. On reboot, MCUboot verifies the staged image's signature, then performs a journaled swap using the scratch area: copy a primary page to scratch, copy a secondary page to primary, copy scratch to secondary. The swap is power-fail-safe because every step is journaled. After swap, the new image runs. If the new image does not call `boot_set_confirmed` within a window, MCUboot swaps back on the next boot.

### 9. Explain ECDSA P-256 signature verification in a bootloader context.

The bootloader holds the OEM's public key (or its hash) burned into OTP fuses. The image header contains the SHA-256 hash of the image and the ECDSA signature of that hash. The bootloader recomputes the SHA-256 hash from the actual image bytes, compares against the stored hash, then verifies the signature using the public key. ECDSA P-256 verification on Cortex-M4 with hardware crypto takes roughly 50-150 ms. Explain anti-rollback: an additional security version number in OTP, monotonically increasing, prevents installing legitimately-signed older firmware with known vulnerabilities.

### 10. What is the difference between Cortex-A, Cortex-R, and Cortex-M cores?

Cortex-A: full MMU, virtual memory, runs Linux/QNX/Android, out-of-order pipeline, optimized for average performance. Cortex-R: real-time, MPU (R5) or optional MMU (R52, R82), in-order or limited out-of-order, lockstep operation for ASIL D safety. Cortex-M: microcontroller, MPU only, no MMU, deterministic interrupt latency, optimized for code density and power. The "AE" suffix (e.g. A78AE, R52F-AE) means Automotive Enhanced with split-lock and ECC. Examples of each in production hardware required.

### 11. How does Helium (M-Profile Vector Extension) accelerate TinyML on Cortex-M55?

Helium is 128-bit SIMD reusing the FPU register file. It supports 8/16/32-bit integer and 16/32-bit float operations. CMSIS-NN's Helium kernels process 16 int8 lanes per vector multiply-accumulate, giving roughly 5x to 20x speedup over scalar kernels for typical convolution layers. Mention `vctp16q` predicates for tail handling without separate cleanup code. The silicon cost is small because the register file is shared with the FPU. Compare to Cortex-A NEON (separate 128-bit register file) and Cortex-A SVE (variable-length vectors).

### 12. Walk through the C++ class layout when a class has multiple inheritance. Why is multiple inheritance with virtual base classes banned in MISRA?

Single inheritance: the derived class layout is the base class layout followed by the derived's added members, with one vtable pointer if either has virtuals. Multiple inheritance: the layout includes each base class's layout in declaration order, with multiple vtable pointers, one per base with virtuals. Virtual inheritance: the virtual base lives at a runtime-computed offset, accessed through the vtable's virtual base offset entry. MISRA forbids virtual inheritance because the offset computation is implementation-defined, the vtables are larger, and `dynamic_cast` may need runtime walking of the inheritance graph. Senior bonus: explain CRTP as a pattern for static polymorphism that avoids the issue.

### 13. How would you debug a hard fault that fires occasionally in a release build?

Read CFSR, HFSR, MMFAR, BFAR after the fault. Determine category: imprecise vs precise bus fault, memory management fault, usage fault. From the stacked PC and LR, identify the function. If imprecise, the actual fault happened cycles before, need ETM trace. If the fault is rare, instrument with a circular buffer that logs every task switch and ISR entry, dump the buffer on fault. Save the full state (registers and RAM) to a backup region, retrieve later, post-mortem with GDB and the matching ELF. For a hangs-in-the-field bug, deploy with watchdog and assertion logging to the cloud.

### 14. What are the key tradeoffs between FreeRTOS and Zephyr for a new IoT product in 2026?

FreeRTOS: smaller kernel, easier to certify, well-integrated with vendor SDKs (Espressif, Nordic legacy), simpler for a quick project, FreeRTOS-Plus components for TCP/IP, MQTT, etc. Zephyr: full driver model with devicetree, networking and BLE/Matter/Thread built in, active LTS process, backed by Linux Foundation, native C++ support. Pick Zephyr for new IoT with BLE/Matter/Thread/LTE-M, pick FreeRTOS where vendor SDK is FreeRTOS-native or kernel surface area must be minimal. Senior bonus: explain why neither is right for hard real-time control loops sub-100us, where bare metal on a Cortex-R lockstep core wins.

### 15. Describe how you would size the stack for an RTOS task and why static allocation is preferred over dynamic.

Static allocation: the stack is a fixed-size array in `.bss`, lifetime is the program's, no risk of allocation failure at runtime. Dynamic: the kernel allocates from its heap, can fail at runtime, fragmentation is possible. For sizing: fill with 0xA5 at boot, run the worst-case code path under load, use `uxTaskGetStackHighWaterMark` to find the highest used address, add 25-50 percent margin. Use compiler `-fstack-usage` to compute static frame sizes per function, sum along the deepest call chain, verify against measurement. AUTOSAR / MISRA require static allocation for safety-critical code because dynamic allocation has unbounded latency and can fail.

---
