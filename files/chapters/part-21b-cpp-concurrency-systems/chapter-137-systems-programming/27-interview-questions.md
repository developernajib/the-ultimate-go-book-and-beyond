## Interview Questions

### Conceptual

1. **Why must you handle partial reads and writes in systems programming, and under what conditions do they occur?**

 Partial I/O occurs when the kernel transfers fewer bytes than requested. For reads: network sockets deliver data in segments, pipes have limited buffers, and signals can interrupt blocking calls (EINTR). For writes: socket send buffers may be full, pipe buffers finite, and non-blocking mode can cause short writes. Always loop until all bytes are transferred or an error/EOF occurs. The `EINTR` case is particularly important, a signal delivered during a blocking `read` or `write` returns -1 with `errno == EINTR`, and the operation must be retried.

2. **Explain the difference between edge-triggered and level-triggered epoll. When would you choose each?**

 Level-triggered (LT): epoll reports a descriptor as ready whenever data is available. If you read only part of the buffer, the next `epoll_wait` will report it again. Simple to program but may cause redundant wakeups. Edge-triggered (ET): epoll reports only when the state *changes*, new data arrives, space becomes available. You must drain the entire buffer in one pass or you will miss events until new data arrives. ET is more efficient under high load (fewer wakeups) but requires non-blocking I/O and careful drain loops. Choose LT for simplicity, ET for performance-critical servers.

3. **What makes `io_uring` fundamentally different from epoll?**

 Epoll is a *readiness notification* mechanism, it tells you when an fd is ready for I/O, but you still issue the actual `read`/`write` syscalls. `io_uring` is a *completion-based* mechanism, you submit I/O operations, and the kernel completes them and posts results. This eliminates the syscall per I/O operation in the fast path (submissions and completions go through shared ring buffers). Additionally, `io_uring` supports a much wider range of operations, can batch multiple submissions, and can even run in a fully polled mode with zero syscalls.

4. **Why is it dangerous to use `printf`, `malloc`, or mutex locks inside a signal handler?**

 Signal handlers execute asynchronously, they can interrupt the main program at any point, including inside `printf` (which holds a stdio lock), `malloc` (which holds a heap lock), or a mutex operation. If the interrupted code was already holding one of these locks, the signal handler will deadlock trying to acquire the same lock. Only *async-signal-safe* functions (defined by POSIX) may be called in handlers. These include `write`, `_exit`, and atomic flag operations. The standard practice is to set a flag or write a byte to a self-pipe, then handle the signal in the main event loop.

5. **What are the security implications of loading shared libraries with `dlopen`?**

 Arbitrary code execution: if an attacker can place a malicious `.so` at the path you load, they control your process. Mitigations: use absolute paths, verify library checksums/signatures before loading, restrict search paths (avoid `RTLD_DEFAULT`), set `RPATH`/`RUNPATH` at build time instead of relying on `LD_LIBRARY_PATH`. Symbol injection: `LD_PRELOAD` can override symbols in your library. Constructors/destructors: `.init`/`.fini` sections in shared libraries run automatically on load/unload. For security-critical systems, prefer static linking or use `dlopen` with `RTLD_NOW | RTLD_LOCAL` to fail fast on missing symbols and contain the library's symbol scope.

### Coding Challenges

6. **Write a function that transfers data between two sockets with zero copies to userspace.**

 Use `splice` with a pipe intermediary. Create a pipe, splice from the source socket into the pipe's write end, then splice from the pipe's read end into the destination socket. Handle partial transfers and `EAGAIN` for non-blocking sockets. This is exactly how the kernel-mode `tee`/`splice` proxy works.

7. **Design a thread-safe plugin registry that supports concurrent reads and single-writer updates (hot-reloading).**

 Use a readers-writer lock (`std::shared_mutex`) or, for lock-free access, an RCU-like pattern: maintain a `std::shared_ptr<PluginMap>` that readers copy atomically and writers replace atomically. Writers create a new map, populate it, and `atomic_store` the shared pointer. Readers see a consistent snapshot. Old maps are freed when the last reader releases its copy.

8. **Explain how you would safely pass a Go slice to a C function via CGO, considering garbage collection.**

 Pass `unsafe.Pointer(&slice[0])` for the data pointer and `C.size_t(len(slice))` for the length. This is safe *only* for the duration of the CGO call, the Go GC will not move the slice while C code is executing on the same goroutine. Never store the pointer on the C side for later use. For long-lived references, allocate with `C.malloc`, copy the data, and manage the lifetime manually. Go 1.17+ enforces these rules with the `cgocheck` setting.

9. **Implement a minimal `select`-equivalent using only `poll` that handles both TCP and UDP on the same event loop.**

 Create a `pollfd` array containing both the TCP listen socket and the UDP socket. For TCP events, accept and add client fds to the array. For UDP events, `recvfrom` and `sendto` directly. For client TCP events, read/write and remove on disconnect. This is straightforward with `poll` because all socket types use the same `POLLIN`/`POLLOUT` events.

10. **What happens if a C++ exception propagates through a C stack frame (e.g., through a callback invoked via `extern "C"`)? How do you prevent this?**

 The behavior is undefined. Most implementations will call `std::terminate` because the C stack frame has no unwind information. On some platforms, the exception may appear to work but corrupt the stack. Prevention: wrap every `extern "C"` function body in a `try/catch(...)` block. Convert exceptions to error codes at the boundary. For callbacks, use `std::nothrow` allocations and check return values instead of throwing. This rule is absolute, no exceptions may cross a language boundary.

---
