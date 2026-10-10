## Summary

Systems programming in C++ operates at the interface between your code and the operating system kernel. The techniques covered in this chapter, file I/O, sockets, I/O multiplexing, async I/O, zero-copy transfer, signal handling, dynamic libraries, IPC, and cross-language bridging, form the foundation that higher-level abstractions are built upon.

The key themes to carry forward:

- **RAII everywhere.** File descriptors, memory mappings, library handles, and shared memory segments are all resources that must be released. Wrap them in RAII classes.
- **Handle every error.** System calls fail in production. Partial I/O is normal. Signals interrupt blocking calls. Code defensively.
- **Understand the abstraction stack.** Go's goroutines use epoll. Go's `net.Conn` wraps sockets. Go's runtime handles signals. Knowing what happens underneath makes you effective in both languages.
- **Choose the right mechanism.** `mmap` for large file access, epoll for many connections, `io_uring` for maximum throughput, `sendfile` for static file serving, shared memory for lowest-latency IPC. Each tool has a sweet spot.
- **Respect language boundaries.** Whether bridging C++/C or C++/Go, exceptions must not cross, memory ownership must be explicit, and calling conventions must be honored.

The next chapter builds on these foundations to explore advanced networking patterns, connection pooling, protocol state machines, and building production-grade network services.

---

| [◀ Chapter 136: Coroutines (C++20)](../chapter-136-coroutines/00-introduction.md) | [Chapter 137: Systems Programming](00-introduction.md) | [Chapter 138: Network Programming](../chapter-138-network-programming/00-introduction.md) ▶ |

