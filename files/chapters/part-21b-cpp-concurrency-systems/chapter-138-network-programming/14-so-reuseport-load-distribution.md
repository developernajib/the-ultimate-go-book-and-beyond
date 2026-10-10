## SO_REUSEPORT and Kernel-Side Load Distribution

`SO_REUSEPORT` (Linux 3.9, commit `c617f398edd4`) lets multiple sockets bind the same `(addr, port)` tuple as long as every socket sets the option. The kernel then hashes incoming SYNs and dispatches each to exactly one socket from the group. Each worker has its own listen queue, its own accept path, and its own epoll. There is no userspace `accept_mutex`, no `EPOLLEXCLUSIVE`, no thundering herd. This is the foundation of nginx workers since 1.9.1, HAProxy multi-process mode, Envoy hot restart, and every Go server with `GOMAXPROCS > 1` (the runtime sets it via `setsockopt` automatically since Go 1.11 on Linux).

> Junior -> FAANG: `SO_REUSEADDR` lets a new process bind a socket in `TIME_WAIT`. `SO_REUSEPORT` lets multiple processes bind the *same* live socket. Different problem, different option, do not confuse them. On BSD `SO_REUSEPORT` predates Linux but has different semantics, the Linux flavor is what FAANG production runs on.

### 1. Kernel hash function

By default the kernel uses a 4-tuple hash (`saddr, sport, daddr, dport`) modulo the live-socket count to pick a worker. The hash is `inet_ehashfn`, it is consistent for a given connection so segments of a connection always land on the same worker. SYN-cookie processing under SYN flood may use a different path but still resolves to one socket.

What this buys you:
- Per-CPU worker affinity if you also pin worker N to CPU N (the kernel does not do this for you, you set it with `pthread_setaffinity_np`).
- No accept lock contention.
- Linear scaling up to NIC RSS queue count, then sublinear (the bottleneck moves to NIC interrupts and softirq).

What it does not buy you:
- *Balanced* distribution. Hash skew with a small number of clients (e.g., one client opens 1000 connections) can pile every connection onto two or three workers. The remedy is an attached BPF program (section 3).

### 2. Minimal C++ listener factory

```cpp
class ReuseportListener {
 public:
  static int create(uint16_t port, int backlog = 4096) {
    int fd = ::socket(AF_INET6, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) throw std::system_error(errno, std::system_category(), "socket");
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
    int v6only = 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));
    sockaddr_in6 a{};
    a.sin6_family = AF_INET6;
    a.sin6_port   = htons(port);
    a.sin6_addr   = in6addr_any;
    if (::bind(fd, (sockaddr*)&a, sizeof(a)) < 0)
      throw std::system_error(errno, std::system_category(), "bind");
    if (::listen(fd, backlog) < 0)
      throw std::system_error(errno, std::system_category(), "listen");
    return fd;
  }
};

void worker_main(int cpu, uint16_t port) {
  int fd = ReuseportListener::create(port);
  cpu_set_t s; CPU_ZERO(&s); CPU_SET(cpu, &s);
  pthread_setaffinity_np(pthread_self(), sizeof(s), &s);
  Reactor r;
  r.add(fd, EPOLLIN | EPOLLET, new Listener{fd, r});
  r.run();
}

int main() {
  std::vector<std::jthread> workers;
  unsigned n = std::thread::hardware_concurrency();
  for (unsigned i = 0; i < n; ++i) workers.emplace_back(worker_main, i, 8080);
}
```

Each worker calls `socket -> bind -> listen` itself, you do not pass the fd to children. That is the whole point: independent listen queues.

### 3. BPF reuseport program for custom dispatch

The default 4-tuple hash is rarely what you want. Possible policies:

- **CPU-affinity dispatch**: send the SYN to the worker on the CPU that received the IRQ, eliminating cross-CPU cacheline traffic on `sk_buff` data.
- **Connection migration on worker exit**: avoid stranding new connections on a draining worker.
- **Cookie-aware sharding**: route by `cmsg`-extracted SNI hash (TLS) or by HTTP `:authority`.

`SO_ATTACH_REUSEPORT_EBPF` (Linux 4.5, commit `538950a1b752`) attaches a BPF program of type `BPF_PROG_TYPE_SK_REUSEPORT` to the group. The program returns the array index of the chosen socket.

```c
// reuseport_cpu.c -- compile with clang -O2 -target bpf
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct {
  __uint(type, BPF_MAP_TYPE_REUSEPORT_SOCKARRAY);
  __uint(max_entries, 256);
  __type(key, __u32);
  __type(value, __u64);
} sock_map SEC(".maps");

SEC("sk_reuseport")
int dispatch(struct sk_reuseport_md *ctx) {
  __u32 cpu = bpf_get_smp_processor_id();
  return bpf_sk_select_reuseport(ctx, &sock_map, &cpu, 0);
}
char _license[] SEC("license") = "GPL";
```

Userspace side (using libbpf):

```cpp
bpf_object* obj = bpf_object__open_file("reuseport_cpu.bpf.o", nullptr);
bpf_object__load(obj);
int prog_fd = bpf_program__fd(bpf_object__find_program_by_name(obj, "dispatch"));
int map_fd  = bpf_object__find_map_fd_by_name(obj, "sock_map");

for (unsigned cpu = 0; cpu < n; ++cpu) {
  __u64 sk = listener_fd[cpu];
  bpf_map_update_elem(map_fd, &cpu, &sk, BPF_ANY);
}
// attach to ANY listener in the group - applies to the whole group
setsockopt(listener_fd[0], SOL_SOCKET, SO_ATTACH_REUSEPORT_EBPF,
           &prog_fd, sizeof(prog_fd));
```

Cloudflare's "How to drop 10 million packets per second" series uses this pattern. Facebook's `katran` L4LB uses an XDP variant for stateless dispatch and BPF reuseport for stateful upgrades.

### 4. Connection migration on worker exit

When a worker is draining (rolling deploy), you want:

1. The draining worker stops calling `accept`.
2. New SYNs are still hashed by the kernel, if the draining worker is in the BPF map it still receives connections that pile up in its accept queue and time out.

Two correct fixes:

a. **Remove from BPF map first, then drain.** Update the sockarray to skip the draining slot. New connections go to the remaining workers immediately. The draining worker finishes existing connections and exits.

b. **`shutdown(fd, SHUT_RD)` on the listen socket** unhooks the worker from the reuseport group (Linux 4.6+). Existing connections continue, no new SYNs land here. Cleaner than fiddling with the BPF map but requires a kernel that supports it.

```cpp
// graceful drain
bpf_map_delete_elem(map_fd, &my_cpu);   // approach (a)
// OR
::shutdown(listen_fd, SHUT_RD);          // approach (b)
// continue serving accepted connections - exit when conn count hits 0
```

If you use neither, you ship a 30-second tail of failed requests on every deploy. Production teams that ignore this have visible 5xx spikes on their dashboards every push.

### 5. Balanced vs unbalanced

Even with perfect hashing, real traffic is unbalanced because:

- Long-lived connections (HTTP/2, gRPC, WebSocket) stick to one worker for their lifetime.
- A single client behind NAT looks like one source IP, hashing to one worker.
- Application-layer state (per-conn caches, prepared statements) does not migrate.

Mitigations:

- For HTTP/2 / gRPC, periodically send `GOAWAY` to force clients to reconnect and re-shard (Envoy does this with `max_connection_duration`).
- Set `SO_INCOMING_CPU` (Linux 4.4) so the kernel records the CPU the connection landed on, pair with RFS / RPS on the NIC side to keep softirq local.
- Run more workers than CPUs (oversubscribe by 2x) when traffic is bursty, scheduler smooths the imbalance at a small context-switch cost.

### 6. Comparison with alternatives

| Approach | Pros | Cons |
|----------------------------------|--------------------------------------------|-------------------------------------------------|
| Single accept thread + worker pool | simplest | accept thread is the bottleneck |
| `EPOLLEXCLUSIVE` on shared epfd | no kernel option needed | one shared listen queue (cache contention) |
| `accept_mutex` (legacy nginx) | works on any kernel | userspace lock, abandoned post-1.11 |
| `SO_REUSEPORT` per-worker | per-CPU listen queue, scales linearly | hash skew without BPF |
| `SO_REUSEPORT` + BPF | full control of dispatch | requires kernel >= 4.5, BPF toolchain |
| HAProxy multi-process | uses `SO_REUSEPORT` under the hood | no shared state without stick-tables/peers |
| nginx workers since 1.9.1 | `SO_REUSEPORT` is a one-line directive | global config, not per-connection |

### 7. Caveats and footguns

- All processes in the reuseport group must run under the same UID (since Linux 4.4) -- security fix to prevent port hijacking.
- `SO_REUSEPORT` on UDP: yes, since the original patch. The hash is on `(saddr, sport)`. Used by every QUIC server (msquic, lsquic, quiche).
- If one of the sockets in the group does not set `SO_REUSEPORT`, the kernel rejects the bind with `EADDRINUSE`. All-or-nothing.
- TCP Fast Open (`TCP_FASTOPEN`) interacts: the cookie key is per-listener, but with reuseport the kernel internally uses one key per group. Setting different `TCP_FASTOPEN` lengths per worker is undefined, pick one.
- Container restart: if the new instance starts before the old one fully releases the listener, the bind succeeds (both have `SO_REUSEPORT`), and traffic is split between old and new for the overlap. For deploys, drain first.

### 8. When NOT to use SO_REUSEPORT

- You need a single accept queue for backpressure visibility (one queue length to monitor).
- You depend on a single-listener accept ordering for fairness (SO_REUSEPORT is hash-fair, not FIFO-fair across the group).
- You run on Windows, equivalent is IOCP per-socket, no direct port-sharing primitive.
- You run on macOS, `SO_REUSEPORT` exists but has BSD semantics (round-robin or random, kernel version dependent), not the Linux hash-dispatch.

> Senior @ FAANG: the "right" answer for an L7 proxy on Linux is `SO_REUSEPORT` + BPF reuseport program + per-worker pinned epoll + io_uring backend for upstream connections. This is the Envoy + bpf_reuseport experimental path, the architecture in Cloudflare's `pingora`, and the layout in HAProxy 2.4+.

