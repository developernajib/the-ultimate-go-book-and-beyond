# Chapter 168: CPU and OS Concurrency Foundations

## Why Programmers Need to Understand the Hardware Under the OS

Most application developers learn to treat the CPU and operating system as a black box. You write code, it runs, and if you need speed you reach for threads. This works fine until it does not. You hit a race condition you cannot reproduce. Your multithreaded code runs slower on more cores. Your lock-free algorithm corrupts memory on ARM but passes every test on x86. You do not understand why `sleep(1)` does not sleep for exactly one second.

These failures are not bad luck. They come from a gap between how you think the machine works and how it actually works.

This chapter fills that gap. It covers the hardware and operating system concepts that underpin every concurrency primitive you use in Go, Rust, C, and any other systems language. None of this is Go-specific. These are the mechanisms that every language runtime sits on top of, and understanding them makes you a better programmer in all of them.

---

## What This Chapter Covers

The chapter is organized as a bottom-up tour from silicon to scheduler:

| File | Topic |
|------|-------|
| 01-how-cpus-work | Transistors, logic gates, ALU, fetch-decode-execute |
| 02-cpu-architectures-and-isa | ISA, x86, ARM, RISC-V |
| 03-how-cpus-run-functions | Call stack, stack frames, ABI |
| 04-cpu-privilege-rings | Kernel mode, user mode, syscalls, interrupts |
| 05-processes-and-programs | PCB, address space, process states |
| 06-threads-and-concurrency | Threads vs processes, SMT, concurrency vs parallelism |
| 07-cpu-scheduling | Preemption, time slices, context switching |
| 08-race-conditions-and-atomics | Non-atomic ops, memory barriers, CAS |
| 09-linux-processes-fork-exec | fork, exec, copy-on-write |
| 10-ipc-shared-memory-vs-messages | Address isolation, pipes, shared memory |
| 11-microchip-manufacturing | Photolithography, transistor density, Moore's law |

---

## Who This Is For

This chapter is written for developers who know how to write concurrent code but have not spent time learning what the hardware is actually doing. If you have used goroutines or threads but felt uneasy when someone asked what a context switch costs, or why you need a memory fence after setting a shared flag, this is the material you need.

If you come from JavaScript or Python, this chapter also explains the specific tradeoffs those languages made and why systems languages expose the underlying complexity directly.

---

## The Core Argument

Every abstraction in your language runtime maps to something real at the hardware level.

A goroutine maps to a hardware register file being saved and restored. A mutex maps to a single atomic compare-and-swap instruction. A channel maps to memory shared between OS threads with explicit synchronization. A process boundary maps to base and limit registers on the memory bus that the hardware checks on every address.

When the abstraction works correctly, you do not need to think about the hardware. When it breaks or performs badly, you do. The material in this chapter is what you reach for when the abstraction breaks.

---

## How to Read This Chapter

Each section is self-contained. You can read them in order for a complete picture or jump directly to the topic you need. The sections build on each other conceptually, so if something in the scheduling section feels unclear, the earlier sections on fetch-decode-execute and privilege rings will fill in the gaps.

Code examples appear in C and Go. The C examples show what the hardware is actually doing. The Go examples show how Go exposes or abstracts the same mechanism.

---

## A Note on Go's Scheduler

Go does not use one OS thread per goroutine. It uses an M:N scheduler that multiplexes many goroutines onto a smaller number of OS threads. This is one of Go's core design choices, and it only makes sense if you understand what OS threads cost, what context switching costs, and why creating thousands of OS threads is a problem.

By the time you finish this chapter, you will understand exactly why Go made this choice and what it means for how you write concurrent Go programs.

---

**Read:** [The Size of Your Variables Matters](https://www.youtube.com/watch?v=hwyRnHA54lI), a short introduction to why systems programming languages expose type sizes explicitly, which connects to everything this chapter covers about memory layout and hardware.
