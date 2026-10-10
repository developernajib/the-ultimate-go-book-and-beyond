## Interview Questions

---

**Q1: Why is dynamic memory allocation (malloc/new) prohibited in many embedded and safety-critical systems?**

Three independent reasons, each sufficient on its own:

**Non-determinism:** `malloc` traverses a free list whose length and content depend on the entire runtime history of allocations and frees. The time taken is proportional to heap fragmentation, which cannot be bounded at design time. A hard real-time system requires bounded WCET for every operation. `malloc` cannot provide that.

**Fragmentation failure:** After extended operation, a heap with sufficient total free space may be unable to satisfy a request for a smaller contiguous block. The allocator returns `nullptr`. In a system that checks return values properly, this triggers an error handler. In legacy embedded code, dereferencing `nullptr` corrupts memory silently. On bare-metal without an MMU, there is no segfault, the write goes somewhere, and the corruption appears far from the cause.

**Unverifiable memory budget:** Safety certification requires proof that the system can never run out of memory during operation. With dynamic allocation, this proof requires exhaustive testing of all possible allocation sequences. With static allocation only, the total memory consumption equals `text + data + bss`, which the linker reports and the build system can verify against the available flash and RAM at build time.

---

**Q2: What is WCET and what makes it hard to compute on modern hardware?**

WCET (Worst-Case Execution Time) is the maximum time any execution of a given function or task can take, across all possible inputs and hardware states. In real-time system design, WCET bounds are required to verify that tasks will meet their deadlines under the selected scheduling algorithm.

Computing WCET is trivially easy on a simple processor with no cache, no branch prediction, and no pipeline: instruction count × cycle time. On modern hardware, the following factors make it difficult:

**Cache behavior:** A cache miss takes 10-100× the time of a cache hit. Whether a memory access is a hit or miss depends on the full history of preceding accesses (cache state). Static WCET analysis tools model all possible cache states using abstract interpretation to compute a safe upper bound.

**Branch prediction:** Modern pipelines speculatively execute the predicted path. A misprediction causes a pipeline flush costing 3-15 cycles. The misprediction rate depends on runtime data patterns.

**OS preemption and scheduling:** In an RTOS, a higher-priority task can preempt the current task at any point, adding unbounded latency if priority analysis is not done correctly. Bare-metal Cortex-M avoids this: no OS preemption, interrupt latency bounded at 12 cycles.

**Memory bus sharing:** DMA controllers share the memory bus with the CPU. A DMA transfer in progress can cause the CPU to stall waiting for bus access. On STM32 devices with CCM, placing critical data in CCM avoids this contention.

---

**Q3: What is priority inversion, and how does priority inheritance solve it?**

Priority inversion occurs when a high-priority task is indirectly delayed by a lower-priority task, through a shared resource.

Scenario: Task H (priority 3) and Task L (priority 1) share a mutex. Task L holds the mutex. Before L releases it, Task M (priority 2) becomes ready and preempts L (since M > L). Now H is blocked waiting for the mutex, L cannot run to release it because M is running, and M has nothing to do with the mutex. H's deadline may be missed. This is the Mars Pathfinder bug, it used `vxTaskPrioritySet` manually to work around the same issue before priority inheritance was enabled.

**Priority inheritance:** When Task L holds a resource that Task H is waiting for, L temporarily runs at H's priority level. This prevents M from preempting L. L runs to completion, releases the mutex, reverts to its normal priority, and H acquires the mutex and proceeds. The high-priority task's latency is bounded by the duration of the critical section in the low-priority task, not by the execution time of any medium-priority tasks.

FreeRTOS implements priority inheritance in its mutex primitives (`xSemaphoreCreateMutex`). Counting semaphores and binary semaphores do not implement priority inheritance, use mutexes when sharing resources between tasks of different priorities.

---

**Q4: What is `volatile` in embedded C++ and what does it NOT do?**

`volatile` tells the compiler that a variable can change outside the normal program execution flow, from hardware, from an ISR, or from another execution context. The compiler must:
- Re-read the variable from its memory location on every use (no caching in a register)
- Write the variable to its memory location on every assignment (no deferred/coalesced writes)
- Not reorder or eliminate reads/writes to volatile objects relative to other volatile accesses

**Practical uses:** Memory-mapped peripheral registers (the hardware changes them without CPU instruction), flags modified by ISRs (`volatile bool data_ready`), variables accessed from multiple interrupt levels.

**What `volatile` does NOT do:**

1. **It is not a synchronization primitive.** `volatile` does not generate memory barriers. On architectures with out-of-order memory (Cortex-M7, multi-core ARMv8), a volatile write may still be observed in a different order by another core. Use `std::atomic` with appropriate memory ordering for inter-thread or inter-ISR communication where ordering matters.

2. **It does not prevent tearing.** On a 32-bit Cortex-M, reading a 64-bit `volatile uint64_t` is two separate 32-bit load instructions. An ISR can fire between them and write the high and low words in an inconsistent state. Use `std::atomic<uint64_t>` or disable interrupts around the read.

3. **It does not imply atomicity.** A `++volatile_counter` is a read-modify-write that can be interrupted between the read and the write.

---

**Q5: What are the key MISRA C++ rules and why do they exist?**

MISRA C++ rules exist to eliminate C++'s undefined behavior, implementation-defined behavior, and implicit language features that commonly produce bugs in safety-critical code.

**Rule 18-4-1 (No dynamic heap allocation):** Addressed above. Non-deterministic latency, fragmentation, and unverifiable memory budget.

**Rule 15-0-1/15-0-3 (No exceptions / exceptions only for error handling):** Exception propagation is non-deterministic in time (stack unwinding traverses frames and runs destructors), and on many embedded compilers the exception runtime is several KB. Safety-critical code uses explicit error codes.

**Rule 5-0-5 (No implicit floating-integral conversions):** Silent precision loss. `float f = 123456789` silently becomes `123456792.0f` on IEEE 754 single precision. The programmer must explicitly acknowledge the conversion.

**Rule 6-6-1 (No goto outside enclosing block):** Jumping over initializations can leave objects in undefined state. Restricting goto to the same block bounds its scope. Most safety guidelines treat this as "no goto at all."

**Rule 10-8-1 (No implicit integer conversions to different type):** Prevents silent sign extension or narrowing. `uint8_t a = 256` silently becomes 0. All conversions must be explicit casts.

The common thread: MISRA rules prohibit features where the language specification permits an outcome the programmer did not intend and the compiler does not warn about. Safety certification requires that every program statement has a single well-defined behavior provable from the source text alone.

---

**Q6: When should you use fixed-point arithmetic instead of floating-point, and what are the tradeoffs?**

**Use fixed-point when:**
- The MCU has no FPU (Cortex-M0, Cortex-M3): software float is 10-100× slower than hardware integer operations
- Deterministic timing is required: fixed-point arithmetic runs in bounded, predictable time. Soft-float's WCET varies with operand values (denormals, NaN)
- Exact range and resolution are known at design time: Q16.16 gives 1/65536 ≈ 15 μm resolution for position in a millimeter-scale system
- Code will be subjected to MISRA/AUTOSAR review: `float` comparisons trigger advisory rules about precision

**Use floating-point when:**
- The MCU has a hardware FPU and deterministic latency is not critical
- The range of values spans many orders of magnitude (temperature sensor calibration curve fitting)
- Numerical algorithms are complex enough that fixed-point overflow analysis is impractical
- Portability across platforms with different integer widths matters

**Key tradeoffs:**
- Fixed-point: programmer responsible for range analysis, overflow detection, and choosing the right Q format for each variable
- Fixed-point multiplication requires double-width intermediate: `int32 × int32 → int64 >> FRAC`, consuming a 64-bit multiply instruction on Cortex-M4 (single-cycle) but two instructions on Cortex-M0
- Floating-point: hardware handles range automatically. Programmer responsibility is precision loss and NaN/Inf propagation
- `float` division is slower than `double` on some FPUs. Fixed-point division is slower than multiplication due to the pre-shift

---

**Q7: What is DMA and when should it be used instead of interrupt-driven I/O?**

DMA (Direct Memory Access) is a hardware controller that transfers data between peripherals and memory (or between memory regions) without CPU involvement. The CPU initiates the transfer by writing configuration registers, then the DMA controller handles the byte-by-byte transfer autonomously. The CPU receives a single interrupt when the entire transfer is complete.

**Use DMA when:**
- Transfer rate exceeds what the CPU can handle with per-byte interrupts: at 115200 baud, UART generates ~11.5 KB/s, manageable. At 10 Mbit/s SPI, that is 1.25 MB/s, one interrupt per byte at 1 MHz overhead is 7.4% of a 168 MHz CPU.
- The CPU must run other work during the transfer: without DMA, a 4 MB SPI flash read at 50 Mbit/s would consume the CPU for 640 ms
- Latency of individual bytes does not matter, but throughput and completeness do

**Interrupt-driven I/O when:**
- Per-byte reaction is required (UART command parsing where each byte triggers state machine advancement)
- DMA is unavailable or the peripheral does not support it
- Transfer sizes are small and variable (command/response protocols)
- The DMA channel is reserved for a higher-priority peripheral

**Critical constraint:** DMA buffers must reside in main SRAM. On STM32 devices, CCM (Core Coupled Memory) is not accessible to the DMA controller, DMA transfers to/from CCM silently fail or hard fault. This is one of the reasons CCM placement is not always appropriate for every data structure.

---

**Q8: Describe the ARM Cortex-M bare-metal startup sequence from reset to `main()`.**

1. **Hardware reset:** The CPU asserts the reset signal (power-on, brown-out, watchdog, software reset). All registers except the stack pointer and PC are reset to implementation-defined values.

2. **Initial SP load:** The CPU reads a 32-bit value from address `0x00000000` (the first word of the interrupt vector table) and loads it into the stack pointer (SP/MSP). This is the top-of-stack address defined in the linker script.

3. **Reset handler address load:** The CPU reads the 32-bit value at address `0x00000004` (second word of the vector table) and loads it into the PC. Execution begins at the `Reset_Handler` function.

4. **Copy `.data` from flash to SRAM:** The startup code reads initialized variable values from flash (where they are stored as ROM constants) and copies them to their SRAM addresses. The linker provides `_sidata` (source in flash), `_sdata` (destination start in SRAM), and `_edata` (destination end) symbols.

5. **Zero `.bss` in SRAM:** All zero-initialized and uninitialized static variables must be zeroed. The startup code fills from `_sbss` to `_ebss` with zeros. This is required by the C/C++ standard (static storage duration objects with no explicit initializer are zero-initialized).

6. **Run global constructors:** `__libc_init_array()` iterates the `.preinit_array`, `.init_array`, and `.fini_array` linker sections, calling each constructor function pointer. This is where C++ global object constructors run.

7. **Call `main()`:** Control transfers to `main()`. In bare-metal code, `main()` never returns (or if it does, the startup code halts in an infinite loop).

The entire startup sequence takes approximately 1-10 μs on a Cortex-M4 depending on the size of `.data` and `.bss` and the number of global constructors.

---

**Q9: Why is Go's runtime incompatible with safety-critical embedded systems, and what would need to change for that to be different?**

Go's runtime makes three assumptions that are incompatible with the requirements of safety-critical systems:

**Garbage collection:** The GC runs concurrently with the application but requires occasional stop-the-world pauses and write barriers on every pointer store. These pauses are non-deterministic in duration at worst-case scenarios (large heap under pressure). ISO 26262 ASIL-D and DO-178C DAL-A require formal WCET bounds. The Go GC cannot provide certified WCET bounds. A language/runtime without GC, or one with a provably bounded, incremental GC with certified WCET, would be required.

**Goroutine scheduler:** Go's scheduler is an M:N preemptive scheduler that can pause any goroutine at function call points (and at any safe point since Go 1.14). There is no priority concept, goroutines run in approximately FIFO order on available OS threads. Real-time scheduling requires fixed-priority preemptive scheduling with priority inheritance, which Go's runtime does not provide.

**Toolchain qualification:** Safety standards require that any tool that generates code or checks requirements be qualified according to DO-330 (for aviation) or ISO 26262 Part 8 (automotive). The `gc` compiler (the reference Go compiler) and TinyGo are not qualified under these standards. Qualification requires extensive documentation, testing, and a formal process that commercial tool vendors (Green Hills, IAR, TASKING) maintain for their C++ compilers.

What would need to change: a formally verified Go subset compiler with certified WCET analysis, deterministic memory management (no GC or a fully bounded incremental collector with proof), a fixed-priority RTOS-compatible scheduler, and full tool qualification. This does not exist today and would be a multi-year engineering effort with no clear commercial sponsor.

---
