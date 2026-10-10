## Process Isolation: Namespaces and cgroups v2

> **Senior @ FAANG**: Containers are a marketing term for the bundle "namespaces + cgroups + chroot/pivot_root + seccomp + capabilities." Knowing each piece lets you build, debug, and harden them. The kernel docs are `Documentation/admin-guide/cgroup-v2.rst` and the `namespaces(7)` man page, read both.

### 1. The 8 Namespaces

Each namespace virtualizes one kernel resource. All accessed via `clone(2)`, `unshare(2)`, or `setns(2)`.

| Namespace | Flag | Virtualizes | First in kernel |
|-----------|------|-------------|-----------------|
| Mount | `CLONE_NEWNS` | Mount table, `pivot_root` works inside | 2.4.19 |
| UTS | `CLONE_NEWUTS` | hostname, domainname | 2.6.19 |
| IPC | `CLONE_NEWIPC` | SysV IPC + POSIX MQ | 2.6.19 |
| PID | `CLONE_NEWPID` | pid 1 inside, /proc remap | 2.6.24 |
| Network | `CLONE_NEWNET` | Interfaces, routes, sockets, iptables | 2.6.29 |
| User | `CLONE_NEWUSER` | uid/gid maps, non-root users get caps inside | 3.8 |
| Cgroup | `CLONE_NEWCGROUP` | /proc/self/cgroup view shows cgroup root | 4.6 |
| Time | `CLONE_NEWTIME` | CLOCK_MONOTONIC + CLOCK_BOOTTIME offsets | 5.6 |

You can inspect a process's namespaces:

```bash
ls -l /proc/self/ns/
# lrwxrwxrwx 1 user user 0 mnt -> 'mnt:[4026531841]'
# ...
```

The inode number is the **namespace identity**. Two processes in the same namespace share inodes for that entry.

`setns(2)` joins an existing namespace via fd:

```cpp
int fd = open("/proc/123/ns/net", O_RDONLY|O_CLOEXEC);
setns(fd, CLONE_NEWNET);  // this thread now in pid 123's network namespace
```

`nsenter(1)` is the userspace tool for the same.

#### 1.1 User namespace, the privilege primitive

A user namespace gives a process **CAP_SYS_ADMIN inside** while remaining unprivileged outside. The trick: the uid/gid mapping. Non-root creates a user-ns, inside, uid 0 maps to the real uid (e.g., 1000). All capability checks inside that user-ns succeed, checks against the host fail.

```cpp
// Unshare into a user-ns, become "root" inside.
unshare(CLONE_NEWUSER);
// Write the mapping (must be done by the parent, OR by the same process
// via /proc/self/uid_map / gid_map AFTER also writing setgroups=deny).
int fd = open("/proc/self/setgroups", O_WRONLY); write(fd, "deny", 4); close(fd);
fd = open("/proc/self/uid_map", O_WRONLY);
char map[64]; int n = snprintf(map, sizeof map, "0 %u 1\n", getuid());
write(fd, map, n); close(fd);
```

This is how rootless Podman, rootless Docker, and Kubernetes UserNS support work.

#### 1.2 PID namespace + `/proc`

`CLONE_NEWPID` makes the cloned task pid 1. To make `/proc` reflect this, you must remount it:

```cpp
// Inside child after CLONE_NEWNS | CLONE_NEWPID:
mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr);  // detach from parent's mount events
mount("proc", "/proc", "proc", 0, nullptr);
```

Without the remount, `/proc` shows the host's pid table, a common container build bug.

The pid-1 has special semantics: it must reap children (signal handler for SIGCHLD), and if it dies the entire pid namespace is torn down. **`tini`**, **`dumb-init`**, and `s6` exist to be a correct pid-1 with reap + signal forwarding. In your own container, write the same logic.

### 2. cgroups v2. Unified Hierarchy

cgroups v1 had per-controller hierarchies (memory, cpu, pids, ...), a process could be in different cgroups per controller. v2 unifies them: one tree, every cgroup can enable any subset of controllers via `cgroup.subtree_control`.

Mount point (almost always pre-mounted on modern distros):

```
/sys/fs/cgroup/
├── cgroup.controllers       # "cpu memory io pids cpuset hugetlb rdma misc"
├── cgroup.subtree_control   # which controllers are pushed to children
├── cgroup.procs             # pids in this cgroup (one per line)
├── memory.current
├── memory.max
├── memory.high
├── memory.swap.max
├── cpu.weight
├── cpu.max
├── io.max
├── io.cost.qos
├── pids.max
└── system.slice/
    └── nginx.service/
        ├── cgroup.procs
        ├── memory.max
        └── ...
```

To create a cgroup and put a process in it:

```cpp
mkdir("/sys/fs/cgroup/myapp", 0755);
write_file("/sys/fs/cgroup/myapp/cgroup.subtree_control", "+memory +cpu +io");
write_file("/sys/fs/cgroup/myapp/memory.max", "2G");
write_file("/sys/fs/cgroup/myapp/memory.high", "1800M");
write_file("/sys/fs/cgroup/myapp/cpu.weight", "200");
write_file("/sys/fs/cgroup/myapp/cgroup.procs", std::to_string(getpid()));
```

#### 2.1 Memory controller, what each knob means

| File | Semantics |
|------|-----------|
| `memory.current` | Anonymous + page cache + kernel charged to this cg. |
| `memory.max` | Hard limit. Exceed → OOM kill inside cg. |
| `memory.high` | Throttle threshold. Above this, allocations stall and reclaim runs aggressively. **No OOM**, process keeps making progress, slowly. |
| `memory.low` | Best-effort protection from reclaim. Kernel avoids reclaiming this cg until others are exhausted. |
| `memory.min` | Hard protection, never reclaim below this. |
| `memory.swap.max` | Cap swap usage (set 0 to disable swap for cg). |
| `memory.events` | Counters: `low high max oom oom_kill`. |
| `memory.pressure` | PSI: `some` and `full` stall %. The signal you alert on. |

The combination `memory.high=1800M` + `memory.max=2G` is the FAANG default: graceful slowdown before hard OOM, with PSI metrics in monitoring.

#### 2.2 CPU controller

| File | Meaning |
|------|---------|
| `cpu.weight` | Relative share, default 100, range 1-10000. |
| `cpu.max` | `<quota> <period>` in µs. `"50000 100000"` = 0.5 CPU. `"max 100000"` = uncapped. |
| `cpu.pressure` | PSI for CPU stalls. |
| `cpuset.cpus`, `cpuset.mems` | Pin to specific CPUs / NUMA nodes (controller `cpuset`). |

#### 2.3 I/O controller

`io.max` is a hard cap per device:

```
8:0 rbps=10485760 wbps=10485760 riops=1000 wiops=1000
```

`io.cost` (cost-based scheduler, kernel 5.4+, default in modern systemd) is the FAANG-grade IO QoS. `io.cost.qos` holds latency targets per device, the kernel throttles cgroups to keep them.

#### 2.4 cgroup-level OOM and `oom.group`

Set `memory.oom.group=1` on a cgroup to make the OOM killer kill **every** process in the cgroup atomically, so you don't have a half-dead service. Without it, only the worst-scoring process dies, leading to inconsistent state.

### 3. `pivot_root` and Mount Propagation

Inside a mount namespace:

```cpp
mount("/", "/", nullptr, MS_REC | MS_PRIVATE, nullptr);   // detach propagation
mount(rootfs, rootfs, nullptr, MS_BIND | MS_REC, nullptr); // make it a mount point
chdir(rootfs);
syscall(SYS_pivot_root, ".", ".old");
umount2(".old", MNT_DETACH);
```

`pivot_root` swaps the calling process's root with a new one and stashes the old somewhere. Far safer than `chroot` because the new root must already be a mount point, can't escape via `..`.

Mount **propagation** (`MS_SHARED`, `MS_PRIVATE`, `MS_SLAVE`, `MS_UNBINDABLE`) controls whether mount events cross namespaces. Containers want `MS_PRIVATE` recursive on the new namespace, otherwise host mounts leak in.

### 4. Building a Minimal Container in C++

```cpp
// minicontainer.cpp, ~150 lines, real namespaces + cgroup + pivot_root
// build: g++ -std=c++23 -O2 minicontainer.cpp -o minicontainer
// run:   sudo ./minicontainer ./rootfs /bin/sh

#include <sched.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <linux/sched.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <fstream>

namespace {

constexpr size_t STACK_SIZE = 1 << 20;

struct ChildArgs { const char* rootfs; char** argv; };

void must(int rc, const char* msg) {
    if (rc < 0) { perror(msg); std::exit(1); }
}

void write_file(const std::string& path, const std::string& v) {
    int fd = open(path.c_str(), O_WRONLY);
    must(fd, path.c_str());
    must(write(fd, v.data(), v.size()), "write");
    close(fd);
}

void setup_cgroup(pid_t child) {
    std::string cg = "/sys/fs/cgroup/mini." + std::to_string(getpid());
    must(mkdir(cg.c_str(), 0755), "mkdir cgroup");
    write_file(cg + "/memory.max", "256M");
    write_file(cg + "/memory.high", "200M");
    write_file(cg + "/cpu.max", "50000 100000");      // 0.5 CPU
    write_file(cg + "/pids.max", "256");
    write_file(cg + "/cgroup.procs", std::to_string(child));
}

int child_main(void* arg) {
    auto* a = static_cast<ChildArgs*>(arg);

    // Die if parent dies.
    must(prctl(PR_SET_PDEATHSIG, SIGKILL), "pdeathsig");

    // Make all mounts private, host won't see ours, we won't see theirs.
    must(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr), "rec-private");

    // Bind-mount rootfs onto itself so it is a mount point (pivot_root requires this).
    must(mount(a->rootfs, a->rootfs, nullptr, MS_BIND | MS_REC, nullptr), "bind rootfs");

    must(chdir(a->rootfs), "chdir rootfs");

    // Mount essential filesystems INSIDE the new root.
    mkdir("proc", 0755); mkdir("sys", 0755); mkdir("dev", 0755);
    must(mount("proc",  "proc", "proc",  0, nullptr),                    "mount proc");
    must(mount("sysfs", "sys",  "sysfs", MS_RDONLY|MS_NODEV|MS_NOEXEC|MS_NOSUID, nullptr), "mount sysfs");
    must(mount("tmpfs", "dev",  "tmpfs", MS_NOSUID, "mode=755,size=64k"),"mount devtmpfs");

    // pivot_root.
    mkdir("oldroot", 0700);
    must(syscall(SYS_pivot_root, ".", "oldroot"), "pivot_root");
    must(chdir("/"), "chdir new /");
    must(umount2("/oldroot", MNT_DETACH), "umount oldroot");
    rmdir("/oldroot");

    // Drop hostname.
    must(sethostname("mini", 4), "sethostname");

    // Exec the target.
    execvp(a->argv[0], a->argv);
    perror("execvp");
    return 127;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: %s <rootfs> <cmd> [args...]\n", argv[0]); return 2; }

    ChildArgs ca{ argv[1], &argv[2] };

    auto* stack = static_cast<char*>(std::malloc(STACK_SIZE));
    int flags = CLONE_NEWNS  | CLONE_NEWUTS | CLONE_NEWIPC |
                CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWCGROUP | SIGCHLD;

    pid_t child = clone(child_main, stack + STACK_SIZE, flags, &ca);
    must(child, "clone");

    setup_cgroup(child);

    int status;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
```

What this 150-line program does that a junior `chroot` does not:

1. **All 6 main namespaces** at once via `clone()`.
2. Mount-propagation isolation (no mount leaks either way).
3. Real `pivot_root`, not `chroot`.
4. Per-process `/proc`, `/sys`, `/dev` inside.
5. cgroup v2 with memory + CPU + pid limits.
6. `PR_SET_PDEATHSIG` so the contained process dies if we crash.

What is **missing** (left as exercises): user-namespace mapping, capability dropping (`prctl(PR_CAPBSET_DROP)` + `capset`), seccomp filter (`seccomp(SECCOMP_SET_MODE_FILTER, ...)`), network setup (a `veth` pair from the host), AppArmor/SELinux profile.

### 5. BPF-Attached cgroups (Modern Sandboxing)

cgroups v2 lets you attach BPF programs at:

- `BPF_CGROUP_INET_INGRESS` / `EGRESS`, packet filter per cgroup.
- `BPF_CGROUP_SOCK_OPS`. TCP state machine hooks.
- `BPF_CGROUP_DEVICE`, replaces v1 devices controller (`mknod` policy).
- `BPF_LSM_CGROUP`. LSM hooks scoped per cgroup (5.16+).

This is how Cilium implements pod-level network policy without iptables, and how systemd implements `IPAddressDeny=` directives.

### 6. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `chroot` | `pivot_root` after `unshare(CLONE_NEWNS)` + `MS_PRIVATE`. |
| Run as root in container | User-ns + uid_map, uid 0 inside maps to non-zero outside. |
| `cgcreate`/`cgexec` (v1) | Write directly to `/sys/fs/cgroup/<path>/{memory.max,cpu.max,...}`. |
| `memory.max` only | `memory.high` + `memory.max` + PSI alerting. |
| Forget `oom.group=1` | Set it, otherwise OOM leaves inconsistent service state. |
| Trust `/proc` inside ns | Re-mount `proc` after `CLONE_NEWPID` and `MS_PRIVATE`. |
| iptables for pod policy | BPF cgroup attach (`tc`/`cilium`/`bpfilter`). |

The kernel doc `Documentation/admin-guide/cgroup-v2.rst` is mandatory reading, print it once.
