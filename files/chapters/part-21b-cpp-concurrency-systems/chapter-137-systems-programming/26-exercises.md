## Exercises

### Exercise 1: High-Performance File Copy

Implement a file copy utility that selects the optimal strategy based on file size:

- Under 64KB: read/write with stack buffer
- 64KB to 1GB: mmap source, write destination
- Over 1GB: use `sendfile` or `splice` in a loop

Benchmark all three strategies and measure throughput in GB/s.

### Exercise 2: Multi-Protocol Echo Server

Build an echo server that simultaneously handles TCP, UDP, and Unix domain socket clients using a single epoll event loop. Requirements:

- Non-blocking I/O on all sockets
- Edge-triggered epoll
- Graceful shutdown via SIGINT using `signalfd`
- Track per-protocol connection counts and bytes transferred

### Exercise 3: io_uring Web Server

Write a minimal HTTP/1.1 static file server using `io_uring` for all I/O (accept, read, write, file open/read). Compare its throughput against an epoll-based version using `wrk` or `ab`.

### Exercise 4: Plugin-Based Data Pipeline

Design a data processing pipeline where each stage is a dynamically loaded plugin:

1. Define a `IStage` interface with `process(const std::vector<uint8_t>& input) -> std::vector<uint8_t>`
2. Implement at least three plugins: compress (zlib), encrypt (AES-256), encode (base64)
3. Load plugins from a configuration file specifying the pipeline order
4. Support hot-reloading: watch for updated `.so` files and reload without restarting

### Exercise 5: CGO Performance Benchmark

Create a Go program that calls a C++ matrix multiplication library via CGO. Measure:

- CGO call overhead for different matrix sizes (1x1 through 1024x1024)
- Throughput compared to pure Go and pure C++ implementations
- Memory allocation patterns across the language boundary

Find the crossover point where CGO overhead becomes negligible relative to computation time.

### Exercise 6: Shared Memory Ring Buffer

Implement a lock-free single-producer, single-consumer ring buffer in shared memory:

- Use POSIX shared memory (`shm_open`) for the backing store
- Atomic head/tail pointers for synchronization
- Support variable-length messages with a length-prefixed framing protocol
- Benchmark throughput and compare with Unix domain sockets and pipes

---
