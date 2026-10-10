## `/proc` and `/sys` Deep Dive

> **Senior @ FAANG**: `top`, `ps`, `htop`, `iostat`, `vmstat`, `lsof`, `pmap`, every one of them is a fancy `cat` over `/proc` and `/sys`. Knowing the underlying files lets you build observability that costs **microseconds**, not milliseconds, and surfaces signals nobody else is watching.

### 1. `/proc/[pid]/`. Per-Process Truth

| File | Content | Cost to read |
|------|---------|--------------|
| `status` | Human-readable: Vm*, signal masks, CapInh/Prm/Eff/Bnd/Amb, uid/gid, Threads | ~5 µs (warm) |
| `stat` | Single-line: scheduling stats, utime/stime, rss, vsize, start_time | ~2 µs |
| `statm` | 7 numbers: size, resident, shared, text, lib, data, dt | ~1 µs |
| `cmdline` | argv joined by NULs | ~2 µs |
| `environ` | Initial environ, NULs | snapshot only, does not update |
| `comm` | Thread name (`PR_SET_NAME`) | ~1 µs |
| `maps` | One line per VMA | O(VMAs), ms on 100k mappings |
| `smaps` | maps + per-VMA RSS/PSS/swap/THP | 10×-50× cost of `maps` |
| `smaps_rollup` | `smaps` aggregated to a single record | O(1), preferred for monitoring |
| `io` | rchar, wchar, syscr, syscw, read_bytes, write_bytes, canceled_write_bytes | ~2 µs |
| `limits` | Effective `RLIMIT_*` | ~3 µs |
| `oom_score` / `oom_score_adj` | Killer ranking | ~1 µs |
| `cgroup` | Resolved cgroup path (v2: single line) | ~2 µs |
| `mountinfo` | Mount table for the mount-ns | O(mounts) |
| `wchan` | Kernel function the task is sleeping in | ~1 µs |
| `stack` | Kernel stack of the task (root only, CONFIG_STACKTRACE) | ~5 µs |
| `syscall` | Current syscall + args | ~1 µs |
| `task/` | One subdir per thread (tid) | scan = O(threads) |
| `fd/` | One symlink per open fd | scan = O(fds) |
| `fdinfo/<n>` | Per-fd state: pos, flags, mnt_id, eventfd-count, signalfd-mask, inotify-watches | ~3 µs/fd |
| `ns/` | Symlinks to namespaces, inode = ns identity | ~1 µs |
| `coredump_filter` | Bitmask of which VMAs land in cores | tunable |
| `personality` | Linux personality flags | rare |
| `timerslack_ns` | Timer rounding (battery vs precision) | tunable |

#### 1.1 `status`, what to actually read

Selected fields:

```
Name:         myservice
Umask:        0022
State:        S (sleeping)
Tgid:         12345
Pid:          12345
PPid:         1
TracerPid:    0
Uid:          1000 1000 1000 1000
Gid:          1000 1000 1000 1000
FDSize:       128
Groups:       1000 27
NStgid:       12345           # tgid in each pid-ns level
NSpid:        12345
NSpgid:       12345
NSsid:        12345
VmPeak:        524288 kB      # peak virtual size
VmSize:        458752 kB
VmLck:           1024 kB
VmHWM:         262144 kB      # peak resident
VmRSS:         245760 kB
RssAnon:       212000 kB
RssFile:        33760 kB
RssShmem:           0 kB
VmData:        405504 kB
VmStk:            132 kB
VmExe:            512 kB
VmLib:           4196 kB
VmPTE:            896 kB      # page table memory!
VmSwap:             0 kB
HugetlbPages:       0 kB
Threads:           17
SigQ:           0/63452
SigPnd:    0000000000000000
SigBlk:    0000000000010000
SigIgn:    0000000000001000
SigCgt:    0000000180014002
CapInh:    0000000000000000
CapPrm:    000001ffffffffff
CapEff:    000001ffffffffff
CapBnd:    000001ffffffffff
CapAmb:    0000000000000000
NoNewPrivs:    0
Seccomp:        2             # 0=disabled 1=strict 2=filter
Speculation_Store_Bypass: thread vulnerable
Cpus_allowed:  ffffffff,ffffffff
Cpus_allowed_list: 0-63
Mems_allowed_list: 0-1
voluntary_ctxt_switches:    1234
nonvoluntary_ctxt_switches:    56
```

Actionable signals:

- `VmPTE` > 50 MB indicates excessive page-table memory, usually massive sparse mappings (Java, Go runtimes, mmap-heavy DBs). Consider hugepages.
- `voluntary` vs `nonvoluntary_ctxt_switches`: ratio shifted toward nonvoluntary indicates CPU contention or preemption.
- `Seccomp: 2` confirms a filter is active. Verify in security audits.

#### 1.2 `smaps` and `smaps_rollup`

Per-VMA breakdown. The fields that matter:

```
Size:                   4096 kB    # VMA size
Rss:                    1024 kB    # resident
Pss:                     512 kB    # proportional set: shared/N + private
Shared_Clean:              0 kB
Shared_Dirty:              0 kB
Private_Clean:             0 kB
Private_Dirty:          1024 kB
Referenced:             1024 kB
Anonymous:              1024 kB
LazyFree:                  0 kB
AnonHugePages:             0 kB    # transparent hugepages backing this VMA
ShmemPmdMapped:            0 kB
FilePmdMapped:             0 kB
Shared_Hugetlb:            0 kB
Private_Hugetlb:           0 kB
Swap:                      0 kB
SwapPss:                   0 kB
Locked:                    0 kB    # mlocked bytes
THPeligible:    1
ProtectionKey:  0
VmFlags: rd wr mr mw me ac
```

**PSS** (Proportional Set Size) is the only honest "memory usage" number for processes that share pages. It is what Android's lowmemorykiller, `smem`, and Meta's CPI metric use.

`smaps_rollup` (kernel 4.14+) gives one rollup record at O(1) cost. **Always prefer it** in monitoring agents.

#### 1.3 `io`

```
rchar: 12345678          # bytes read via syscall (incl. cache hits)
wchar: 1234567
syscr: 9876
syscw: 1234
read_bytes:  4096000     # bytes from block layer (real disk)
write_bytes: 0
canceled_write_bytes: 0
```

`read_bytes - 0` versus `rchar - 0` gives the page-cache hit ratio of this process's read path. `write_bytes` is what hit the disk, `canceled_write_bytes` accounts for files truncated before flush.

### 2. System-Wide `/proc` Files

| File | Content |
|------|---------|
| `/proc/meminfo` | Memtotal, MemAvailable, Slab, Buffers, Cached, Active/Inactive, Hugepages_*, AnonHugePages |
| `/proc/vmstat` | Page-fault counters, PSI accounting source, pgscan/pgsteal, compact_*, thp_* |
| `/proc/stat` | Per-CPU jiffies (user, nice, sys, idle, iowait, irq, softirq, steal, guest, guest_nice) |
| `/proc/loadavg` | 1/5/15-min runnable+uninterruptible average, `runnable/total` |
| `/proc/diskstats` | Per-device IO counters, what `iostat` reads |
| `/proc/net/dev`, `/proc/net/tcp`, `/proc/net/sockstat` | Per-interface, per-socket, summary |
| `/proc/interrupts` | Per-IRQ per-CPU counts, identify lopsided NIC handling |
| `/proc/softirqs` | Per-softirq per-CPU counts |
| `/proc/buddyinfo` | Free-page fragmentation per order, tells you why hugepage allocation is failing |
| `/proc/zoneinfo` | Per-NUMA-zone water marks, free pages |
| `/proc/slabinfo` | Per-slab cache (root only) |
| `/proc/pressure/{cpu,memory,io}` | PSI: `some` and `full` stall %. The metric that should drive autoscaling. |

#### 2.1 PSI. Pressure Stall Information (the modern saturation signal)

```
$ cat /proc/pressure/memory
some avg10=0.00 avg60=0.00 avg300=0.00 total=0
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
```

`some` = at least one task stalled on this resource. `full` = **all** non-idle tasks stalled. PSI replaces load average for capacity planning: load average conflates CPU contention with disk I/O wait. PSI separates them. Per-cgroup PSI is at `/sys/fs/cgroup/<cg>/{cpu,memory,io}.pressure`.

You can also `poll(2)` PSI for thresholds:

```cpp
int fd = open("/proc/pressure/memory", O_RDWR | O_NONBLOCK);
const char* trigger = "some 150000 1000000";  // 150ms within 1s window
write(fd, trigger, strlen(trigger));
struct pollfd pf = { .fd = fd, .events = POLLPRI };
poll(&pf, 1, -1);   // blocks until threshold crossed
```

This is how `oomd`, Meta's userspace OOM killer, decides to act.

### 3. `/sys`. Kobject Filesystem

`/sys` is **not** a copy of `/proc`. It exposes the kernel object model: every device, bus, kobject, and kset has a directory. Files are typically one-line attributes.

#### 3.1 CPU topology

```
/sys/devices/system/cpu/
├── cpu0/
│   ├── topology/
│   │   ├── core_id
│   │   ├── core_cpus_list           # SMT siblings
│   │   ├── package_cpus_list        # whole socket
│   │   └── die_cpus_list
│   ├── cpufreq/
│   │   ├── scaling_governor         # performance/powersave/schedutil
│   │   ├── scaling_cur_freq
│   │   └── scaling_max_freq
│   ├── cache/
│   │   ├── index0/  (L1d)
│   │   ├── index1/  (L1i)
│   │   ├── index2/  (L2)
│   │   └── index3/  (L3, shared)
│   └── online                        # 0/1; offline a CPU
├── online                             # range list
├── possible
└── isolated                           # `isolcpus=` boot param result
```

Setting governor:

```bash
echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
```

For HFT, set `performance` and disable C-states (`/sys/devices/system/cpu/cpu0/cpuidle/state*/disable`).

#### 3.2 cgroup v2

`/sys/fs/cgroup/<path>/{memory.max, memory.high, memory.current, memory.events, memory.pressure, cpu.weight, cpu.max, cpu.pressure, io.max, io.cost.qos, pids.max, cgroup.procs, cgroup.threads, cgroup.subtree_control}`. Covered fully in Process Isolation: Namespaces and cgroups v2.

#### 3.3 Block devices

`/sys/block/<dev>/queue/{nr_requests, scheduler, rotational, max_sectors_kb, read_ahead_kb, nomerges, rq_affinity}`. The `scheduler` attribute selects mq-deadline / kyber / bfq / none.

#### 3.4 Network

`/sys/class/net/<iface>/{mtu, operstate, address, statistics/{rx_bytes,tx_bytes,...}, queues/{rx-N,tx-N}/{rps_cpus,xps_cpus}}`. RPS/XPS distribute soft-IRQs across CPUs, critical at high pps.

### 4. C++ "Process Snapshot" Library

A reusable RAII helper that reads a consistent snapshot in a few syscalls:

```cpp
// proc_snapshot.hpp
#pragma once
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <expected>
#include <string>
#include <string_view>
#include <unistd.h>
#include <fcntl.h>

namespace sysx {

struct ProcSnapshot {
    pid_t      pid{};
    std::string comm;
    char       state{};
    pid_t      ppid{};
    long       num_threads{};
    uint64_t   utime_ticks{};
    uint64_t   stime_ticks{};
    uint64_t   start_time_ticks{};
    uint64_t   vsize_bytes{};
    int64_t    rss_pages{};
    uint64_t   rss_anon_kb{};
    uint64_t   rss_file_kb{};
    uint64_t   rss_shmem_kb{};
    uint64_t   pss_kb{};               // from smaps_rollup
    uint64_t   swap_kb{};
    uint64_t   read_bytes{};
    uint64_t   write_bytes{};
    uint64_t   voluntary_ctxt{};
    uint64_t   nonvoluntary_ctxt{};
    int        oom_score{};
    int        oom_score_adj{};
};

class ProcDir {
public:
    explicit ProcDir(pid_t pid) {
        std::string path = "/proc/" + std::to_string(pid);
        fd_ = ::open(path.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC);
    }
    ~ProcDir() { if (fd_ >= 0) ::close(fd_); }

    bool ok() const { return fd_ >= 0; }
    int  fd() const { return fd_; }

    std::expected<std::string, std::error_code>
    read(std::string_view name) const;

private:
    int fd_ = -1;
};

std::expected<ProcSnapshot, std::error_code> snapshot(pid_t pid);

} // namespace sysx
```

```cpp
// proc_snapshot.cpp, selected hot paths
#include "proc_snapshot.hpp"
#include <sys/uio.h>
#include <charconv>
#include <vector>

namespace sysx {

std::expected<std::string, std::error_code>
ProcDir::read(std::string_view name) const {
    int rfd = openat(fd_, std::string(name).c_str(), O_RDONLY | O_CLOEXEC);
    if (rfd < 0) return std::unexpected(std::error_code(errno, std::system_category()));
    std::string out;
    char buf[4096];
    for (;;) {
        ssize_t n = ::read(rfd, buf, sizeof buf);
        if (n < 0) { if (errno == EINTR) continue; ::close(rfd);
                     return std::unexpected(std::error_code(errno, std::system_category())); }
        if (n == 0) break;
        out.append(buf, n);
    }
    ::close(rfd);
    return out;
}

static uint64_t parse_kb_field(std::string_view body, std::string_view key) {
    auto pos = body.find(key);
    if (pos == std::string_view::npos) return 0;
    pos = body.find_first_of("0123456789", pos);
    uint64_t v = 0;
    auto end = body.data() + body.size();
    std::from_chars(body.data() + pos, end, v);
    return v;
}

std::expected<ProcSnapshot, std::error_code> snapshot(pid_t pid) {
    ProcDir d(pid);
    if (!d.ok()) return std::unexpected(std::error_code(errno, std::system_category()));

    ProcSnapshot s; s.pid = pid;

    // /proc/[pid]/stat, single fast read.
    auto stat = d.read("stat");
    if (!stat) return std::unexpected(stat.error());
    // Parse: pid (comm) state ppid pgrp ... utime stime ... starttime vsize rss
    // Comm is in parens and may contain spaces, find LAST ')'.
    auto& ss = *stat;
    auto rp = ss.rfind(')');
    s.comm = ss.substr(ss.find('(') + 1, rp - ss.find('(') - 1);
    // Tokenize from rp+2.
    std::vector<std::string_view> f;
    std::string_view rest{ ss.data() + rp + 2, ss.size() - rp - 2 };
    while (!rest.empty()) {
        auto sp = rest.find(' ');
        f.push_back(rest.substr(0, sp));
        if (sp == std::string_view::npos) break;
        rest.remove_prefix(sp + 1);
    }
    auto to_u64 = [](std::string_view v) { uint64_t x{}; std::from_chars(v.data(), v.data()+v.size(), x); return x; };
    auto to_l   = [](std::string_view v) { long x{};     std::from_chars(v.data(), v.data()+v.size(), x); return x; };
    s.state            = f[0][0];
    s.ppid             = to_l(f[1]);
    s.utime_ticks      = to_u64(f[11]);
    s.stime_ticks      = to_u64(f[12]);
    s.num_threads      = to_l(f[17]);
    s.start_time_ticks = to_u64(f[19]);
    s.vsize_bytes      = to_u64(f[20]);
    s.rss_pages        = to_l(f[21]);

    // /proc/[pid]/status, pull a few fields.
    auto status = d.read("status");
    if (status) {
        s.rss_anon_kb           = parse_kb_field(*status, "RssAnon:");
        s.rss_file_kb           = parse_kb_field(*status, "RssFile:");
        s.rss_shmem_kb          = parse_kb_field(*status, "RssShmem:");
        s.voluntary_ctxt        = parse_kb_field(*status, "voluntary_ctxt_switches:");
        s.nonvoluntary_ctxt     = parse_kb_field(*status, "nonvoluntary_ctxt_switches:");
    }

    // /proc/[pid]/smaps_rollup. Pss & Swap in one read.
    auto rollup = d.read("smaps_rollup");
    if (rollup) {
        s.pss_kb  = parse_kb_field(*rollup, "Pss:");
        s.swap_kb = parse_kb_field(*rollup, "Swap:");
    }

    // /proc/[pid]/io
    auto io = d.read("io");
    if (io) {
        s.read_bytes  = parse_kb_field(*io, "read_bytes:");
        s.write_bytes = parse_kb_field(*io, "write_bytes:");
    }

    auto oom_s   = d.read("oom_score");
    auto oom_adj = d.read("oom_score_adj");
    if (oom_s)   { int v{}; std::from_chars(oom_s->data(),   oom_s->data()+oom_s->size(),   v); s.oom_score = v; }
    if (oom_adj) { int v{}; std::from_chars(oom_adj->data(), oom_adj->data()+oom_adj->size(), v); s.oom_score_adj = v; }

    return s;
}

} // namespace sysx
```

Why this shape:

- **`O_PATH` directory fd**, then `openat` per file: avoids re-walking the path for every read, saves dentry lookups.
- **One read per file** with a 4 KiB buffer: most `/proc` files fit in one buffer, and short-read loops are cheap.
- **`smaps_rollup`** instead of `smaps`: O(1) regardless of VMA count.
- All parsers use `std::from_chars`, no allocation, no locale.

A snapshot of one process costs ~30 µs on a typical box, thousands per second is feasible.

### 5. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| Run `ps` in a loop | Open `/proc/<pid>` directly with `O_PATH` and `openat` per field. |
| Parse `/proc/[pid]/smaps` | Read `smaps_rollup`. |
| Use `RSS` for memory billing | Use `PSS` (`smaps_rollup` Pss). |
| Trust load average | Use PSI, `/proc/pressure/{cpu,memory,io}`. |
| `top` for hot CPU | `perf top` + `/proc/[pid]/sched` for per-task latency. |
| Hardcode `/proc/[pid]` strings | Cache an `O_PATH` fd, race-free against pid reuse via `pidfd`. |
| Only read `/proc` | Read `/sys` for hardware truth (cache size, cpufreq, NUMA). |

`/proc` and `/sys` are the original observability API. Knowing them at this depth makes you the engineer the SRE pages **first**.
