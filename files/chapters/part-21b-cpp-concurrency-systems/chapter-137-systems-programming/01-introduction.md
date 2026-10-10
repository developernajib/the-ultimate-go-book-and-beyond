## Overview

Systems programming is the art of writing software that talks directly to the operating system. Where application code works through frameworks and abstractions, systems code operates at the boundary between userspace and the kernel, managing files, sockets, signals, shared memory, and dynamically loaded libraries. C++ remains the dominant language in this domain because it offers zero-cost abstractions over raw system calls while letting you drop to the metal whenever necessary.

This chapter covers the essential systems programming techniques every serious C++ engineer must master. We begin with file I/O and memory-mapped files, move through socket programming and I/O multiplexing, explore modern async I/O with `io_uring`, examine zero-copy data transfer, handle signals safely, work with shared libraries and plugin architectures, implement inter-process communication, and finally bridge between C++ and both C and Go. Each section includes production-grade code examples and highlights the tradeoffs you will face in real systems.

Throughout, we compare C++ approaches with Go's equivalent facilities. Go deliberately hides most of these mechanisms behind its runtime, goroutines abstract over epoll, the `net` package wraps sockets, and CGO bridges the C boundary. Understanding what Go's runtime does internally makes you a better Go programmer. Understanding how to do it yourself in C++ makes you a better systems engineer.

---
