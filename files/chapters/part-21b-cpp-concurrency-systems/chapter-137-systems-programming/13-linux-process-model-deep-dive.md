## Linux Process Model Deep Dive

> **Senior @ FAANG**: At L5+, you are expected to know exactly what `fork()` does to page tables, why `vfork()` is a footgun, and what `clone(2)` flag combinations produce containers vs threads vs pid-1 isolation. "Just spawn a subprocess" is not an answer when the SRE asks why your service stalls 200ms on every request.

### 1. The `task_struct`. One Per Schedulable Entity

Inside the kernel (`include/linux/sched.h`), every thread/process is a `task_struct`. The fact that Linux has **no separate "thread" kernel object** is foundational: a process is just a `task_struct` whose `tgid` (thread-group id) equals its `pid`. Threads share a `tgid` but have distinct `pid`s.

Key fields you must understand:

| Field | Meaning |
|-------|---------|
| `pid` | Per-task identifier (what `gettid()` returns). |
| `tgid` | Thread-group leader pid (what `getpid()` returns). |
| `mm` | Pointer to `mm_struct` (address space). NULL for kernel threads. |
| `files` | `files_struct`, open fd table. |
| `fs` | `fs_struct`, root, cwd, umask. |
| `signal`, `sighand` | Signal disposition. Shared per thread-group. |
| `nsproxy` | Pointer to namespace set (mount, pid, net, …). |
| `cred` | Credentials (uid/gid/caps). RCU-protected. |
| `sched_class` | Pointer to scheduler (CFS, RT, deadline, idle). |

When you call `clone()`, each `CLONE_*` flag controls whether a field is **shared** (pointer copy) or **duplicated**.

### 2. `fork`, `vfork`, `clone`. One Syscall, Three Faces

`fork()` and `vfork()` are libc wrappers around `clone()` (or the older `clone3(2)`, syscall 435 on x86_64). The differences:

```
fork()   = clone(SIGCHLD,                          stack=NULL)
vfork()  = clone(CLONE_VM | CLONE_VFORK | SIGCHLD, stack=NULL)
pthread  = clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|
                 CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|
                 CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID, stack=...)
```

#### 2.1 Copy-on-Write Fork

`fork()` does **not** copy the address space. The kernel:

1. Allocates a new `task_struct`, `mm_struct`, and pgd.
2. Walks the parent's page tables and **clones the PTEs**, marking both copies read-only and incrementing the page's `_refcount`.
3. Returns. First write triggers a write-protect fault, the kernel allocates a fresh page and copies it (`do_wp_page` → `wp_page_copy`).

Performance implications:

- A 32 GB heap forks in a few ms (just PTEs), but the **first write** to any page costs a minor page fault (~1-3 µs). Redis's BGSAVE famously hits 100 ms+ stalls on huge instances because the parent keeps writing during the fork.
- `MADV_DONTFORK` on regions you do not need post-fork avoids cloning their PTEs. Saves time and memory in subprocess launchers.
- Anonymous transparent hugepages (2 MB) are **split** on COW, doubling the cost of the first write to each subpage.

#### 2.2 `vfork()`. Don't

`vfork()` shares the parent's `mm` and **suspends the parent** until the child calls `execve()` or `_exit()`. Touching any non-stack memory in the child corrupts the parent. The only legitimate use is `posix_spawn`-style fast subprocess launch on systems without `clone(CLONE_VM|CLONE_VFORK)`. Modern code should use `posix_spawn(3)` (which uses `vfork` semantics under the hood) or `clone3()` directly.

#### 2.3 `clone3()` and Namespace Flags

`clone3(2)` (kernel 5.3+) takes a `struct clone_args` and exposes flags `fork()` cannot:

| Flag | Effect |
|------|--------|
| `CLONE_NEWNS` | New mount namespace. |
| `CLONE_NEWPID` | Child becomes pid 1 in a new pid namespace. |
| `CLONE_NEWNET` | New network namespace (no interfaces except `lo` down). |
| `CLONE_NEWUTS` | Independent hostname/domainname. |
| `CLONE_NEWIPC` | New SysV IPC + POSIX message queues. |
| `CLONE_NEWUSER` | New user namespace (uid/gid mapping). |
| `CLONE_NEWCGROUP` | New cgroup namespace (cgroup root remap). |
| `CLONE_NEWTIME` | New time namespace (boottime/monotonic offsets). 5.6+. |
| `CLONE_INTO_CGROUP` | Place child directly into a target cgroup fd. |
| `CLONE_PIDFD` | Return a pidfd in `args.pidfd` for race-free signaling. |

This is the foundation of containers. See Process Isolation: Namespaces and cgroups v2 for the full minimal-container build.

### 3. `prctl(2)`. Per-Process Knobs You Should Use

```cpp
#include <sys/prctl.h>

// Name shows in /proc/[pid]/comm and `top -H`. Up to 15 chars.
prctl(PR_SET_NAME, "rpc-worker-3");

// Disable core dumps for this process. Also clears CAP_*-derived ptrace.
prctl(PR_SET_DUMPABLE, 0);

// Make any child inherit SIGTERM if parent dies, critical for subprocess hygiene.
prctl(PR_SET_PDEATHSIG, SIGTERM);

// Lock down further privilege escalation via setuid binaries.
prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);

// Disable memory write to the executable mapping (W^X enforcement).
prctl(PR_SET_MDWE, PR_MDWE_REFUSE_EXEC_GAIN, 0, 0, 0); // 6.3+
```

`PR_SET_PDEATHSIG` is the single most under-used `prctl` in production. Without it, a crashing parent leaves zombie subprocesses re-parented to pid 1 (or to the nearest `prctl(PR_SET_CHILD_SUBREAPER)` ancestor, kernel 3.4+). Combine with a subreaper for reliable process trees.

### 4. `execve(2)`. What Actually Happens

`execve` does not create a process, it replaces the current process image. Order of operations:

1. Resolve interpreter (`#!`) and ELF loader (`PT_INTERP` typically `/lib64/ld-linux-x86-64.so.2`).
2. Tear down the current `mm` (free all VMAs).
3. Build the new `mm`: load segments, map `[stack]`, `[heap]`, `[vdso]`, `[vvar]`, push argv/envp/auxv.
4. Reset signal handlers to default (signal masks survive, close-on-exec fds close).
5. Atomically swap credentials if setuid/setgid.
6. Jump to the dynamic loader entry point.

Key consequences:

- File descriptors **without** `O_CLOEXEC` leak into the child. Always pass `O_CLOEXEC` (or `SOCK_CLOEXEC`, `MSG_CMSG_CLOEXEC`). Inherit via explicit dup or `CLOEXEC`-clearing, never accidentally.
- Threads other than the caller are **destroyed** (their stacks unmapped), a `pthread_atfork` does not run on `execve`. Always `exec` from a single-threaded process if you need cleanup hooks.
- Memory mappings with `MAP_ANONYMOUS|MAP_SHARED` are gone post-exec. Use `memfd_create()` + `MFD_ALLOW_SEALING` to pass anonymous file-backed memory.

### 5. `/proc/self`. The Process Mirror

Files you must know cold:

| Path | What's there |
|------|-------------|
| `/proc/self/maps` | Every VMA, with permissions + backing file. |
| `/proc/self/smaps` | `maps` + per-VMA RSS, PSS, swap, THP usage. |
| `/proc/self/status` | Vm* fields, threads, signal masks, capabilities (`CapInh/Prm/Eff/Bnd/Amb`), `Seccomp`. |
| `/proc/self/io` | Bytes read/written, syscalls. Track per-thread under `/proc/self/task/[tid]/io`. |
| `/proc/self/limits` | Effective `RLIMIT_*` values. |
| `/proc/self/cgroup` | Resolved cgroup path under v2 hierarchy. |
| `/proc/self/mountinfo` | Mount namespace contents, `mount(8)` reads this. |
| `/proc/self/exe` | Symlink to the on-disk binary (works even if unlinked). |
| `/proc/self/fd/N` | Symlink per open fd, readlink for path. |
| `/proc/self/oom_score`, `oom_score_adj` | OOM killer ranking. Set to `-1000` to make a process unkillable. |
| `/proc/self/coredump_filter` | Bitmask of which VMAs land in core dumps. |
| `/proc/self/timerslack_ns` | Per-process timer rounding (battery vs latency). |

**Senior @ FAANG**: Knowing `smaps_rollup` (kernel 4.14+) gives a single-shot RSS/PSS in O(1) reads instead of O(VMAs). For monitoring services with thousands of mappings, this is the difference between 50 µs and 5 ms per scrape.

### 6. A Production-Grade C++ Subprocess Class

Most C++ codebases reinvent `popen`. Here is a SOLID, race-free design that actual FAANG infra uses:

```cpp
// subprocess.hpp, interface
#pragma once
#include <filesystem>
#include <span>
#include <string>
#include <vector>
#include <chrono>
#include <expected>
#include <sys/types.h>

namespace sysx {

struct SubprocessOptions {
    std::filesystem::path                cwd;
    std::vector<std::pair<std::string,std::string>> env_overrides;
    bool                                 clear_env       = false;
    bool                                 new_session     = true;   // setsid
    bool                                 new_pidns       = false;  // CLONE_NEWPID
    bool                                 new_netns       = false;  // CLONE_NEWNET
    int                                  parent_death_sig = SIGTERM;
    std::optional<int>                   nice;
    std::optional<int>                   oom_score_adj;
    std::vector<int>                     fd_inherit;               // explicit allowlist
    std::optional<std::filesystem::path> stdin_file;
    std::optional<std::filesystem::path> stdout_file;
    std::optional<std::filesystem::path> stderr_file;
};

class Subprocess {
public:
    struct ExitStatus { int code; int signal; bool dumped; };

    static std::expected<Subprocess, std::error_code>
    spawn(std::span<const std::string> argv, SubprocessOptions opts = {});

    pid_t pid() const noexcept { return pid_; }
    int   pidfd() const noexcept { return pidfd_; }   // for poll(2) / pidfd_send_signal(2)

    std::expected<ExitStatus, std::error_code> wait();
    std::expected<ExitStatus, std::error_code> wait_for(std::chrono::milliseconds);
    std::error_code                            terminate(int sig = SIGTERM);

    Subprocess(const Subprocess&) = delete;
    Subprocess& operator=(const Subprocess&) = delete;
    Subprocess(Subprocess&&) noexcept;
    ~Subprocess();

private:
    Subprocess(pid_t p, int fd) : pid_(p), pidfd_(fd) {}
    pid_t pid_   = -1;
    int   pidfd_ = -1;
};

} // namespace sysx
```

Implementation highlights (the parts juniors get wrong):

```cpp
// 1. Use posix_spawn or clone3, never fork+exec from a multithreaded program.
//    fork() in a multithreaded process is async-signal-restricted in the child:
//    you may call ONLY async-signal-safe functions until execve(). Allocators,
//    locale, std::string copies, even iostream are all forbidden.

// 2. Race-free signaling: pidfd_open(pid, 0) right after clone3(), but better,
//    pass CLONE_PIDFD in clone_args and avoid the pid-reuse window entirely.

// 3. Set PR_SET_PDEATHSIG IN THE CHILD AFTER fork BUT BEFORE exec. Then re-check
//    that the parent is still alive (read /proc/self/stat ppid), racing parent
//    death between fork and prctl is real on busy systems.

// 4. Close-from: close all fds not in the inherit allowlist. Use close_range(2)
//    (kernel 5.9+). O(1) instead of looping /proc/self/fd.
//    syscall(SYS_close_range, 3, ~0U, CLOSE_RANGE_CLOEXEC);

// 5. Wait via pidfd: poll({.fd=pidfd_, .events=POLLIN}, 1, timeout_ms) - //    Then waitid(P_PIDFD, pidfd_, &si, WEXITED), never blocks, no SIGCHLD races.
```

`close_range(low, high, CLOSE_RANGE_CLOEXEC)` (5.11+) marks a range CLOEXEC without closing, the cleanest sandbox primitive in modern Linux.

### 7. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `system("cmd ...")` | `posix_spawn` with explicit env, fd allowlist, pidfd. |
| `fork()` then `exec()` from multi-threaded server | `posix_spawn` or pre-forked launcher process. |
| Walk `/proc/self/fd` to close fds | `close_range(3, ~0U, 0)` (or `CLOSE_RANGE_CLOEXEC`). |
| `kill(pid, SIGTERM)` | `pidfd_send_signal(pidfd, SIGTERM, NULL, 0)`, pid-reuse-safe. |
| Hardcode `/proc/PID/...` | `openat(procfd, "status", ...)` once, reuse fd. |
| Trust `getpid()` cache | Know it is invalidated correctly only since glibc 2.25. |

The process model is the substrate everything else in this chapter sits on. If you cannot answer "what does `clone(CLONE_VM|CLONE_FILES)` produce?" without thinking, you cannot reason about containers, sandboxes, or async runtimes.
