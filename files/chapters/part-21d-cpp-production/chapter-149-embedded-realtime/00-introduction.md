# Chapter 149: Embedded and Real-Time C++

> "Embedded systems are everywhere, in your car, your pacemaker, your aircraft. They must be correct the first time.", Jack Ganssle

There is a version of C++ that bears little resemblance to what you write on a server or workstation. No `new`, no `delete`, no exceptions, no standard containers that allocate, no garbage collector, no operating system scheduler to lean on. The heap is either absent or deliberately sealed off. The stack is a few kilobytes, sometimes less. The CPU runs at 72 MHz and shares silicon with real-world physics: spark plug timing, insulin pump dosing, anti-lock brake pressure, fly-by-wire control surfaces.

This is embedded and real-time C++. The constraints are not arbitrary conservatism. They exist because in a hard real-time system, a missed deadline is not a latency spike in a dashboard, it is a car that does not stop, a valve that does not close, a dose that does not halt. The rules of the discipline are the accumulated consequence of catastrophic failures that happened when programmers ignored them.

**What "real-time" actually means.** Real-time does not mean fast. It means *deterministic*. A system that responds in exactly 10 ms, every time, is more real-time than one that averages 1 ms but occasionally stalls for 50 ms. Hard real-time systems have deadlines that, if missed even once, constitute system failure. Soft real-time systems degrade gracefully under deadline misses. The C++ features that make server code expressive, exceptions, virtual dispatch in hot paths, heap allocation, `std::string`, are either prohibited or carefully managed in hard real-time contexts because they introduce non-deterministic latency.

**The hardware context.** Embedded targets range from 8-bit AVR microcontrollers with 2 KB of RAM to 32-bit ARM Cortex-M7 cores with 1 MB of flash. The architectures this chapter focuses on, ARM Cortex-M, are the dominant platform in new embedded designs: STM32, NXP LPC/iMX, Nordic nRF, Renesas RA. They share common features: a fixed-priority interrupt controller (NVIC), no MMU (no virtual memory, no page faults), Harvard-ish memory layout (flash separate from SRAM), and hardware peripherals accessed by writing to memory-mapped registers.

**What Go engineers will recognize.** Go's runtime was designed by engineers who thought carefully about the problems this chapter covers. The escape analysis that decides whether a value goes on the heap or the stack is Go's answer to the embedded programmer's constant question: "where does this live?" The `sync/atomic` package's primitives are the Go-level expression of the lock-free ring buffer patterns ISR authors have used for decades. Interface-driven driver abstractions in Go mirror the Hardware Abstraction Layer patterns that embedded C++ architects refined over years of painful MCU migrations. You already think about many of these problems, this chapter names them properly and shows you what they look like when the abstractions are stripped away.

**Chapter roadmap.** This chapter covers:

- No-heap programming: why the heap is banned and how to live without it
- Deterministic memory: static allocation, memory regions, linker section placement
- WCET analysis: measuring and bounding worst-case execution time
- Bare-metal C++: startup sequence, vector tables, no OS, no standard library
- Interrupt handlers: ISR requirements, volatile, lock-free ISR-to-main communication
- Fixed-point arithmetic: deterministic math without an FPU
- Hardware Abstraction Layers: CRTP-based zero-overhead portability
- Safety-critical standards: MISRA C++, AUTOSAR, ISO 26262, DO-178C
- The Go engineer's perspective: TinyGo, Gokrazy, honest limits
- Hot-patching and live update: dual-bank flash, dynamic symbol reloading, and zero-downtime MCU recovery

By the end you will understand why a professional embedded engineer reacts with genuine alarm to `std::map` appearing in safety-critical code, and you will have the vocabulary and patterns to write correct, deterministic, auditable embedded C++.

---
