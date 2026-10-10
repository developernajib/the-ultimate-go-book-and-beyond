## SO_REUSEPORT Sharded Accept at 10M+ QPS

Single-threaded `accept` loops top out around 200k connections per second on a modern CPU. The bottleneck is the accept-queue lock inside the kernel, not userspace. Linux's `SO_REUSEPORT` (since 3.9) lets multiple sockets bind the same port, and the kernel BPF-hashes incoming SYNs across them. Combined with CPU pinning, this pattern scales near-linearly to 64+ cores and powers every major L7 proxy (Envoy, HAProxy, Nginx).

### The pattern

- N accept sockets, one per worker thread, each bound to the same port with `SO_REUSEPORT`.
- Each worker pinned to a dedicated core via `pthread_setaffinity_np`.
- Optionally attach an eBPF program to the reuseport group to shard by source IP, guaranteeing connection affinity for stateful protocols.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <thread>
#include <vector>
#include <atomic>

int make_reuseport_listener(uint16_t port) {
    int fd = ::socket(AF_INET6, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) throw std::system_error(errno, std::generic_category(), "socket");

    int on = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, sizeof(on));

    // Disable Nagle and enable TCP fast open at accept time
    int qlen = 4096;
    ::setsockopt(fd, SOL_TCP, TCP_FASTOPEN, &qlen, sizeof(qlen));

    // Dual-stack v4/v6
    int v6only = 0;
    ::setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));

    sockaddr_in6 addr{};
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons(port);
    addr.sin6_addr = in6addr_any;

    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0)
        throw std::system_error(errno, std::generic_category(), "bind");
    if (::listen(fd, 65535) < 0)
        throw std::system_error(errno, std::generic_category(), "listen");
    return fd;
}
```

Each worker creates its own `fd` this way. The kernel maintains a reuseport hash table and delivers incoming SYNs to the matching socket's accept queue, no userspace contention.

### Worker loop with per-core epoll

```cpp
struct Worker {
    int core_id;
    int listen_fd;
    int epoll_fd;
    std::atomic<uint64_t> accepts{0};
};

void run_worker(Worker& w) {
    pin_to_core(w.core_id);
    w.listen_fd = make_reuseport_listener(8080);
    w.epoll_fd  = ::epoll_create1(EPOLL_CLOEXEC);

    epoll_event ev{.events = EPOLLIN | EPOLLEXCLUSIVE, .data = {.fd = w.listen_fd}};
    ::epoll_ctl(w.epoll_fd, EPOLL_CTL_ADD, w.listen_fd, &ev);

    std::array<epoll_event, 256> events;
    for (;;) {
        int n = ::epoll_wait(w.epoll_fd, events.data(), events.size(), -1);
        for (int i = 0; i < n; ++i) {
            if (events[i].data.fd == w.listen_fd) drain_accept(w);
            else handle_connection(w, events[i]);
        }
    }
}

void drain_accept(Worker& w) {
    for (;;) {
        sockaddr_in6 peer;
        socklen_t len = sizeof(peer);
        int cfd = ::accept4(w.listen_fd, reinterpret_cast<sockaddr*>(&peer), &len,
                            SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (cfd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            if (errno == EINTR) continue;
            return;
        }
        w.accepts.fetch_add(1, std::memory_order_relaxed);
        register_client(w, cfd);
    }
}
```

Two critical flags. `SOCK_NONBLOCK | SOCK_CLOEXEC` on `accept4` avoids a separate `fcntl` syscall per connection, saving 30 percent in microbenchmarks. `EPOLLEXCLUSIVE` prevents thundering-herd wakeups when the same listen fd would otherwise be shared across workers.

### eBPF-based custom sharding

The default reuseport hash is based on 4-tuple, which is usually fine. For sticky sharding (user-id hash, tenant-id) attach an eBPF program via `SO_ATTACH_REUSEPORT_EBPF`. The program returns the index of the target socket, the kernel dispatches accordingly. This enables zero-overhead L4 session affinity without an L7 router.

### Backpressure

Per-worker `accept` queues isolate overload, a slow worker does not starve fast ones. Monitor `netstat -s | grep overflowed`, any increase indicates a worker is not accepting fast enough. Response: add cores, or push slow handlers onto a secondary thread pool so the accept loop stays hot.

### Go comparison

Go's `net.Listen` does not expose SO_REUSEPORT, you need `github.com/libp2p/go-reuseport` or raw syscalls. Even then, Go's runtime scheduler does not pin goroutines to cores, so you lose cache locality compared to pinned C++ workers. For maximum-QPS L4 data planes, C++ with SO_REUSEPORT is the standard, Go is preferred one layer up where developer velocity dominates.

### Numbers to expect

On a 32-core Sapphire Rapids box, a well-tuned SO_REUSEPORT server with pinned workers and io_uring sustains 8 to 12 million connections per second and terminates above 20 Gbps of HTTP traffic. The same code without pinning and without `EPOLLEXCLUSIVE` caps around 2 million.
