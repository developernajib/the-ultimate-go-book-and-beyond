## eBPF Programming from C++

> **Senior @ FAANG**: eBPF is the kernel's plugin ABI. It is how Meta runs Katran, how Google runs `bpfilter`, how Cilium replaces kube-proxy, how `bcc`/`bpftrace` replaces SystemTap. The C++ side is the **frontend**, loading programs, owning maps, consuming ring buffers. Knowing libbpf at the C++ level is the difference between using `bpftrace` one-liners and shipping a production observability agent.

### 1. The Mental Model

eBPF programs:

1. Are written in restricted C, compiled to eBPF bytecode by clang (`-target bpf`).
2. Loaded into the kernel via `bpf(2)` (syscall 321 on x86_64).
3. Verified by the in-kernel verifier, bounded loops, no unbounded pointer arithmetic, no unbounded stack.
4. JIT-compiled to native instructions on x86_64/arm64.
5. Attached to a hook (kprobe, tracepoint, XDP, cgroup, LSM, ...).
6. Communicate with userspace via **maps** and **ring buffers**.

The eBPF program runs **in kernel context**, with strict limits (~512 B stack, no recursion in older kernels, function calls only via `bpf_*` helpers or compiled-in functions). The C++ side does **not** run in the kernel, it owns the lifecycle.

### 2. CO-RE. Compile Once, Run Everywhere

Pre-2020: every BPF program had to be recompiled for each target kernel because struct field offsets differed. CO-RE solves this with:

- **BTF** (BPF Type Format): kernels expose their type info at `/sys/kernel/btf/vmlinux`.
- **Relocations**: clang emits `BPF_CORE_READ` accesses with relocation records, libbpf rewrites them at load time using the running kernel's BTF.

CO-RE is the only way to ship a BPF binary as part of a C++ application without bundling kernel headers per distro.

```c
// trace.bpf.c, kernel-side, compiled with clang -target bpf -g -O2
#include "vmlinux.h"            // generated: bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

struct event { __u32 pid; __u32 syscall_nr; __s64 ret; char comm[16]; };

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 20);  // 1 MiB
} events SEC(".maps");

SEC("tracepoint/syscalls/sys_exit_openat")
int handle_openat_exit(struct trace_event_raw_sys_exit *ctx) {
    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;
    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->syscall_nr = 257;        // openat
    e->ret = ctx->ret;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));
    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

`SEC("...")` is libbpf's attach-point hint. Build:

```bash
clang -target bpf -O2 -g -D__TARGET_ARCH_x86 \
      -I. -c trace.bpf.c -o trace.bpf.o
bpftool gen skeleton trace.bpf.o > trace.skel.h
```

The skeleton header is what your C++ includes.

### 3. The C++ Frontend with libbpf

libbpf is a C library, the idiomatic C++ wrapper uses RAII for skeleton load/unload, ring buffer poll, and map handles.

```cpp
// tracer.cpp, production-shape skeleton
#include "trace.skel.h"
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <memory>
#include <stdexcept>
#include <span>
#include <atomic>
#include <csignal>
#include <chrono>

// RAII for skeleton.
template <class Skel, auto* Open, auto* Load, auto* Attach, auto* Destroy>
class BpfSkel {
public:
    BpfSkel() : skel_(Open()) {
        if (!skel_) throw std::runtime_error("skel_open");
        if (Load(skel_)   != 0) throw std::runtime_error("skel_load");
        if (Attach(skel_) != 0) throw std::runtime_error("skel_attach");
    }
    ~BpfSkel() { if (skel_) Destroy(skel_); }
    Skel* operator->() { return skel_; }
    Skel* get() { return skel_; }
private:
    Skel* skel_;
};

using TraceSkel = BpfSkel<trace_bpf,
    trace_bpf__open, trace_bpf__load, trace_bpf__attach, trace_bpf__destroy>;

// Event type matches kernel struct.
struct Event { uint32_t pid; uint32_t syscall_nr; int64_t ret; char comm[16]; };

static std::atomic<bool> g_stop{false};

static int on_event(void* /*ctx*/, void* data, size_t /*sz*/) {
    auto* e = static_cast<const Event*>(data);
    std::printf("pid=%u comm=%-16s syscall=%u ret=%lld\n",
                e->pid, e->comm, e->syscall_nr, (long long)e->ret);
    return 0;
}

int main() {
    libbpf_set_strict_mode(LIBBPF_STRICT_ALL);

    // Bump RLIMIT_MEMLOCK on older kernels - not needed on 5.11+ (memcg-accounted).
    struct rlimit r{ RLIM_INFINITY, RLIM_INFINITY };
    setrlimit(RLIMIT_MEMLOCK, &r);

    TraceSkel skel;

    int rb_fd = bpf_map__fd(skel->maps.events);
    std::unique_ptr<ring_buffer, decltype(&ring_buffer__free)>
        rb(ring_buffer__new(rb_fd, on_event, nullptr, nullptr), ring_buffer__free);
    if (!rb) throw std::runtime_error("ring_buffer__new");

    std::signal(SIGINT,  [](int){ g_stop = true; });
    std::signal(SIGTERM, [](int){ g_stop = true; });

    while (!g_stop.load(std::memory_order_relaxed)) {
        int n = ring_buffer__poll(rb.get(), /*timeout ms*/ 100);
        if (n < 0 && n != -EINTR) { std::fprintf(stderr, "poll err %d\n", n); break; }
    }
}
```

This is the shape of every production eBPF tool: skeleton-load, attach, ring-buffer poll. ~80 lines for a real syscall tracer.

### 4. Map Types You Actually Use

| Map | Use |
|-----|-----|
| `BPF_MAP_TYPE_HASH` | Generic key→value, BPF-side and userspace-side updates. |
| `BPF_MAP_TYPE_LRU_HASH` | Bounded, evicts LRU. Critical for any per-pid/per-conn tracker. |
| `BPF_MAP_TYPE_PERCPU_ARRAY` | Lock-free per-CPU counters, userspace aggregates. |
| `BPF_MAP_TYPE_RINGBUF` | Lock-free MPSC, single ring shared across CPUs. **Default for events** since 5.8. |
| `BPF_MAP_TYPE_PERF_EVENT_ARRAY` | Pre-ringbuf event channel, per-CPU. Still needed for older kernels. |
| `BPF_MAP_TYPE_STACK_TRACE` | Capture kernel/user stacks, key is opaque id. |
| `BPF_MAP_TYPE_HASH_OF_MAPS` / `ARRAY_OF_MAPS` | Inner-map indirection, config switches without reload. |
| `BPF_MAP_TYPE_LPM_TRIE` | Longest-prefix-match (CIDR lookups). |
| `BPF_MAP_TYPE_SK_STORAGE` | Per-socket storage tracked by kernel sock lifecycle. |

`BPF_MAP_TYPE_RINGBUF` replaces `PERF_EVENT_ARRAY` for new code: lower overhead, MPSC, supports `bpf_ringbuf_reserve` zero-copy.

Userspace operations on a map fd:

```cpp
int fd = bpf_map__fd(skel->maps.counts);
uint64_t key = 1234, value = 0;
bpf_map_lookup_elem(fd, &key, &value);
bpf_map_update_elem(fd, &key, &value, BPF_ANY);
bpf_map_delete_elem(fd, &key);

// Iteration:
uint64_t nk, prev_k = 0; bool first = true;
while (bpf_map_get_next_key(fd, first ? nullptr : &prev_k, &nk) == 0) {
    bpf_map_lookup_elem(fd, &nk, &value);
    // ...
    prev_k = nk; first = false;
}
```

For per-CPU maps, `value` is an array of `nr_cpus` values, sum them in userspace.

### 5. Attach Points

| Type | Hook | What you see |
|------|------|--------------|
| `kprobe` / `kretprobe` | Any kernel function entry/return | Function args, retval. ABI-fragile across versions. |
| `fentry` / `fexit` | BPF trampoline, cheaper than kprobe | Same data. CO-RE-friendly, kernel 5.5+. |
| `tracepoint` | Static stable trace events | Listed in `/sys/kernel/debug/tracing/events/`. **Prefer these.** |
| `raw_tracepoint` | Tracepoint without arg-cooking | Cheaper, you parse raw args. |
| `uprobe` / `uretprobe` | Userspace function entry/return | Trace your own or another process's binary. |
| `USDT` | Userspace pre-defined static probes | DTrace-style probes (Postgres, Python, OpenJDK). |
| `XDP` | NIC driver hook before sk_buff | Highest-performance packet path. |
| `tc` (clsact) | Linux traffic control | Egress + ingress, after sk_buff. |
| `cgroup_skb` | Per-cgroup ingress/egress | Pod-level firewall. |
| `cgroup_sock_addr` | bind/connect/sendmsg per cgroup | Service-mesh-style redirect. |
| `LSM` | Linux Security Module hooks | Kernel 5.7+, replace SELinux pieces. |
| `sched_*` | Process events | execve, exit, fork tracepoints. |

### 6. The Verifier, and How to Live With It

Common rejections:

- **"unbounded loop"**: use `#pragma unroll`, `bpf_loop()` (5.17+), or rewrite with bounded count.
- **"variable stack offset"**: index a stack array with `&buf[i & (N-1)]` not `&buf[i]`.
- **"R1 type=inv expected=fp"**: you forgot to validate a pointer from `bpf_probe_read_kernel`.
- **"register fill not in range"**: a value read from a map must be bounds-checked before pointer arithmetic.

Use `bpftool prog load ... type kprobe` and read the verifier log, it tells you the offending instruction. For complex programs, set `BPF_F_TEST_STATE_FREQ` to debug verifier state explosion.

### 7. BPF LSM. Replacing SELinux Pieces

```c
SEC("lsm/file_open")
int BPF_PROG(deny_secrets, struct file *file) {
    // Return -EPERM to deny.
    char path[128];
    bpf_d_path(&file->f_path, path, sizeof(path));
    if (__builtin_memcmp(path, "/etc/secret", 11) == 0)
        return -1;  // -EPERM
    return 0;
}
```

Requires kernel built with `CONFIG_BPF_LSM=y` and `lsm=...,bpf` on the kernel command line. This is how recent Meta and Google sandbox new untrusted code paths without writing a new LSM in C.

### 8. Ring Buffer Semantics

The ring buffer is a single **shared** MPSC ring (vs the per-CPU perf event array). Design implications:

- Producers (kernel-side BPF) reserve a slot atomically with `bpf_ringbuf_reserve(map, size, 0)` returning a pointer. Submit with `bpf_ringbuf_submit(rec, flags)`. If you cannot fully populate, `bpf_ringbuf_discard(rec, 0)` releases the reservation without delivering, better than partial events.
- Consumer wakeups: `BPF_RB_FORCE_WAKEUP` on submit forces immediate poll-wake, default is "wakeup if consumer idle." Tune for latency vs throughput.
- Userspace polling: `ring_buffer__poll` (libbpf) or `epoll_wait` on `bpf_map__fd`.

### 9. Production Patterns

- **Per-CPU LRU hash for connection tracking**: `BPF_MAP_TYPE_LRU_PERCPU_HASH`. No locking, bounded memory, survives storms.
- **Stack-trace dedup**: emit only `(stack_id, count)` to ringbuf, userspace resolves stack_id once via the stack-trace map.
- **Tail calls** for plugin pipelines: `bpf_tail_call(ctx, &progs, idx)`, chain BPF programs without exceeding instruction limits.
- **Pinned maps** survive program reload: `bpf_obj_pin(fd, "/sys/fs/bpf/myapp_counts")`. Userspace reattaches without losing state.

### 10. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `bcc` Python wrapper | libbpf + skeleton + CO-RE, ship a single static binary. |
| `kprobe` everywhere | `tracepoint` or `fentry/fexit` first, kprobe only when nothing else fits. |
| `BPF_MAP_TYPE_HASH` unbounded | `LRU_HASH` or `LRU_PERCPU_HASH` always. |
| `perf_event_array` | `ringbuf` on 5.8+. |
| Re-build per kernel | CO-RE + vmlinux.h, ship one .o for all targets. |
| Logs via `bpf_printk` | Only for development. Production: ringbuf events. |
| Forget `LIBBPF_STRICT_ALL` | Always set it, no silent legacy fallbacks. |

eBPF is the single most used kernel skill for systems engineers right now. A C++ engineer who can ship a libbpf agent ranks above one who only writes user-space code.
