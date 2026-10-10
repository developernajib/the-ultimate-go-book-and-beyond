## 10. Go net Package vs C++ Socket Programming

Go's `net` package and C++ socket programming solve the same problem with fundamentally different philosophies.

### Go: Simplicity Through Goroutines

Go's `net` package hides the event loop entirely: one goroutine per connection, blocking reads and writes, and the runtime multiplexes everything onto epoll under the hood.
```go
package main

import (
    "fmt"
    "io"
    "net"
)

func handleConn(conn net.Conn) {
    defer conn.Close()
    buf := make([]byte, 4096)
    for {
        n, err := conn.Read(buf)
        if err != nil {
            if err != io.EOF {
                fmt.Println("read error:", err)
            }
            return
        }
        conn.Write(buf[:n])
    }
}

func main() {
    ln, _ := net.Listen("tcp", ":8080")
    for {
        conn, _ := ln.Accept()
        go handleConn(conn)  // one goroutine per connection
    }
}
```

Go uses blocking I/O per goroutine, but the runtime multiplexes goroutines onto OS threads using `epoll`/`kqueue` internally. The programmer writes straightforward sequential code. The runtime handles the event loop. This is Go's greatest network programming strength: the code reads like blocking I/O but performs like non-blocking I/O.

### C++: Control Through Explicitness

The C++ version makes every decision explicit: socket options, the event loop, buffer lifetimes, and error handling are all yours, which is both the cost and the point.
```cpp
// Equivalent echo server in C++ - the programmer manages everything
void run_echo_server_threaded(uint16_t port) {
    int server_fd = create_tcp_server(port);

    while (true) {
        int client_fd = accept(server_fd, nullptr, nullptr);
        if (client_fd < 0) continue;

        // One thread per connection - simple but does not scale
        std::thread([client_fd] {
            char buf[4096];
            while (true) {
                ssize_t n = read(client_fd, buf, sizeof(buf));
                if (n <= 0) break;
                write(client_fd, buf, n);
            }
            close(client_fd);
        }).detach();
    }
}
```

The thread-per-connection model above mirrors Go's goroutine-per-connection, but threads are expensive (1-8MB stack each). For high concurrency, C++ requires the Reactor/Proactor patterns shown earlier, which are more complex but give precise control over memory, scheduling, and system calls.

### Comparison Table

| Aspect | Go `net` | C++ Sockets |
|--------|----------|-------------|
| Concurrency model | Goroutine per connection | Reactor/Proactor or thread pool |
| Blocking model | Blocking API, async runtime | Non-blocking API, explicit event loop |
| Memory per connection | ~4KB (goroutine stack) | ~4KB (buffer) or ~1-8MB (thread stack) |
| TLS | `crypto/tls`, built-in, simple | OpenSSL, powerful, complex |
| HTTP server | `net/http`, production-ready in stdlib | Build from scratch or use libraries |
| DNS resolution | Built-in, goroutine-safe | `getaddrinfo` blocks. Need async resolver |
| Raw socket access | Limited (possible via `syscall`) | Full control over every option |
| Typical latency | Good (~microseconds overhead from runtime) | Excellent (zero runtime overhead) |
| Development speed | Fast | Slow (more code, more error handling) |
| Debugging network issues | `GODEBUG=netdns=2`, pprof | strace, tcpdump, manual instrumentation |

### When to Choose Which

**Choose Go** when: development speed matters, the team is larger and varied in skill, you need a production HTTP server quickly, or connection counts are moderate (up to hundreds of thousands).

**Choose C++** when: you need sub-microsecond latency (HFT, game servers), you are building infrastructure (proxies, load balancers, databases), you need precise control over memory and system calls, or you are working within an existing C++ codebase.

The hybrid approach is common in practice: build the service mesh proxy in C++ (Envoy), run application services in Go. Each language plays to its strengths.

---
