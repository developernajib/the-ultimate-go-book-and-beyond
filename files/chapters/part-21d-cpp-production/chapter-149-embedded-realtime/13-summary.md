## Key Takeaways

- **The heap is banned for a reason.** Dynamic allocation introduces non-deterministic latency, fragmentation failure, and an unverifiable memory budget. In hard real-time and safety-critical systems, all memory is allocated statically at compile time or at startup with a sealed pool. The `operator new` override that calls `abort()` is the fastest way to discover heap use in a codebase that should not have any.

- **Fixed-point arithmetic is deterministic math.** On MCUs without an FPU, floating-point is software-emulated and non-deterministic in timing. Q16.16 fixed-point provides ~15 μm resolution, bounded WCET, and runs entirely on integer instructions. The multiplication pattern, 64-bit intermediate shifted right by FRAC bits, is the one operation to internalize. Saturation on overflow is mandatory for control loops to prevent integral windup from causing undefined behavior.

- **Placement new puts you in control of construction.** When you cannot use the heap but need to construct a C++ object in a specific memory region (CCM, DMA buffer, pre-allocated pool), placement new constructs an object in-place without any allocation. The `alignas(T)` on the storage buffer is not optional, misaligned access causes a hard fault on Cortex-M.

- **WCET is a design requirement, not a measurement.** You measure WCET with the DWT cycle counter to verify your design. But WCET is first established as a budget from the system requirements (task period, scheduling analysis), then architecturally enforced by avoiding non-deterministic operations. Any function with dynamic allocation, virtual dispatch through unknown implementations, or recursion without a bounded depth is suspicious until proven otherwise.

- **ISRs must be fast, non-blocking, and non-allocating.** An ISR that spends more than a few hundred cycles delays every lower-priority interrupt and can violate the WCET budget of the interrupted task. The correct pattern is: ISR does minimum work (read hardware register, push to ring buffer, set atomic flag), main thread does the rest. The SPSC ring buffer with `std::atomic` head/tail is the canonical tool for ISR-to-main-thread communication.

- **CRTP provides HAL abstraction at zero runtime cost.** Virtual dispatch costs an indirect branch, possible I-cache miss, and D-cache miss for the vtable lookup, measurable on Cortex-M7 at high frequencies. CRTP resolves the dispatch at compile time, generating a direct inlined call. The same interface works with a mock implementation for host-based unit testing, making embedded firmware testable on a developer's laptop without hardware.

- **`volatile` is for hardware registers, not thread synchronization.** `volatile` prevents compiler register caching and coalescing of memory accesses, essential for memory-mapped peripheral registers. It does not generate memory barriers, does not prevent tearing on multi-byte values, and does not establish happens-before relationships. Use `std::atomic` for shared state between ISRs and the main thread. Use `volatile` only for hardware register types.

- **MISRA C++ and AUTOSAR are subsets, not supersets.** They restrict C++ to a formally analyzable subset by prohibiting dynamic allocation, exceptions, RTTI, and implicit conversions. This does not make code bug-free, it eliminates the category of bugs caused by undefined behavior and hidden language corners. Compliance requires static analysis tools (Polyspace, Klocwork, LDRA) because manual review misses violations.

- **The startup sequence is part of your code.** On bare-metal, the Reset_Handler copies `.data`, zeros `.bss`, runs global constructors, and calls `main()`. The vector table must be in the right section with the right linkage. Misplacing the vector table or forgetting `extern "C"` on a handler produces a silent bug: the CPU jumps to the wrong address and executes garbage as instructions. Understanding the startup sequence is non-negotiable for bare-metal C++.

- **Embedded disciplines transfer to all systems programming.** Explicit allocation awareness, lock-free ring buffers, interface-driven HAL design, stack depth analysis, and WCET measurement are not archaic embedded concerns, they are the substrate that modern abstractions like Go's channels, garbage collector, and interface system are built on. Working at the bare-metal level makes the abstractions less magical and more controllable.

- **Dual-bank flash and quiescence ensure crash-safe live updates.** Upgrading long-running embedded systems without physical access requires hardware-assisted fallback (A/B memory banks with watchdog validation) and strict ABI discipline. Hot-swapping code at runtime is fundamentally about finding safe points where state can be quiesced or migrated without interrupting critical execution loops.

---

| [◀ Chapter 148: GPU Programming (CUDA/Compute)](../chapter-148-gpu-programming/00-introduction.md) | [Chapter 149: Embedded and Real-Time C++](00-introduction.md) | [Chapter 150: Security in C++](../chapter-150-security-cpp/00-introduction.md) ▶ |

