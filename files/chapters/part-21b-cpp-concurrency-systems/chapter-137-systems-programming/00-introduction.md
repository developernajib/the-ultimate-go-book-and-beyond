# Chapter 137: Systems Programming

*"Systems programming is not about writing fast code; it is about writing software that has a mechanical sympathy with the underlying machine and operating system."*

---

### Why Systems Programming Matters for Modern Engineers

Systems programming operates directly at the boundary between userspace software and the operating system kernel. Where application services rely on high-level frameworks and network abstraction libraries, systems software communicates directly with kernel interfaces—managing file descriptors, memory-mapped pages, network sockets, asynchronous I/O completion rings, signal delivery, and inter-process communication channels.

While Go abstracts many of these facilities behind its runtime scheduler (multiplexing goroutines over OS threads using non-blocking `epoll`/`kqueue`), understanding what happens beneath the runtime is what distinguishes an everyday developer from a senior infrastructure engineer. Mastering systems programming in C++ reveals how operating systems actually execute your software, how zero-copy network paths function, and how to build components that drop to the bare metal when standard runtimes hit their performance limits.

```
┌──────────────────────────────────────────────────────────────┐
│                    Userspace Application                     │
│                                                              │
│      C++ / Go Engine  │  Custom Allocators  │  io_uring Rings│
└──────────────────────────────┬───────────────────────────────┘
                               │ System Calls (syscall / vDSO)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     Linux Kernel Boundary                    │
│                                                              │
│   Virtual File System (VFS) │ Page Cache │ Inode Management  │
│   Network Stack (TCP/IP)    │ Sockets    │ Zero-Copy splice  │
│   I/O Multiplexing          │ epoll      │ io_uring SQ/CQ    │
│   Memory Management Unit    │ Hugepages  │ NUMA Topology     │
│   Process & Signal Tables   │ cgroups v2 │ Namespaces        │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Learn in This Chapter

In this chapter, you will master the foundational pillars of low-level Linux systems programming:

- **1. File I/O & Memory-Mapped Files (`mmap`)**: Bypassing standard user buffers, managing OS page caches, and implementing zero-copy memory-mapped file access.
- **2 & 3. Sockets & I/O Multiplexing**: Deep dive into non-blocking network sockets and event-driven polling mechanisms (`select`, `poll`, `epoll`, `kqueue`, and Windows `IOCP`).
- **4. Asynchronous I/O with `io_uring`**: Harnessing the modern Linux kernel submission and completion queue architecture for ultra-high-throughput disk and network I/O.
- **5. Zero-Copy Data Transfer**: Using `sendfile`, `splice`, and `vmsplice` to stream gigabytes of data between descriptors without bouncing through userspace memory.
- **6 & 7. Signal Handling & Shared Libraries**: Writing async-signal-safe handlers, avoiding deadlocks in signal handlers, and architecting dynamic runtime plugin loaders (`dlopen`/`dlsym`).
- **8 & 9. IPC & Interfacing with Go**: High-speed Inter-Process Communication (Unix Domain Sockets, shared memory POSIX shm, lockless queues), and bridging C++ systems code to Go via CGO.
- **Advanced Systems Topics**: Custom memory allocators with `std::pmr`, SIMD vectorization in hot loops, Linux process internals, hugepages, NUMA affinity, and crash dump analysis.
