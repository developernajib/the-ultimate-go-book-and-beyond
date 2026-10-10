## Signals: Correctness Beyond `signal(SIGINT, handler)`

> **Senior @ FAANG**: Signals are the most-misunderstood Unix primitive. Half the production C++ code base uses `signal(2)` (BSD, racy), passes non-async-signal-safe functions to handlers, and ignores `pthread_sigmask`. The first time SIGTERM arrives during a `malloc()` lock, the service deadlocks. Get it right once.

### 1. The Async-Signal-Safe Contract

A signal handler can interrupt code at **any** instruction. If the interrupted code held a lock, the handler must not try to acquire it. If the interrupted code was inside `malloc`, the handler must not call `malloc`.

POSIX defines the set of **async-signal-safe** functions in `signal-safety(7)`. The short version of what is safe:

```
abort, _exit, accept, access, alarm, bind, cfgetispeed, chdir, chmod,
chown, clock_gettime, close, connect, dup, dup2, execl/execve/execv,
fchmod, fchown, fcntl, fork, fstat, fsync, getegid, geteuid, getgid,
getpid, getppid, getuid, kill, link, listen, lseek, lstat, mkdir,
mkfifo, open, pause, pipe, poll, posix_trace_event, pselect, raise,
read, readlink, recv, recvfrom, recvmsg, rename, rmdir, select, sem_post,
send, sendmsg, sendto, setgid, setpgid, setsid, setsockopt, setuid,
shutdown, sigaction, sigaddset, sigdelset, sigemptyset, sigfillset,
sigismember, signal, sigpause, sigpending, sigprocmask, sigqueue,
sigset, sigsuspend, sleep, socket, socketpair, stat, symlink, sysconf,
tcdrain, tcflow, tcflush, tcgetattr, tcgetpgrp, tcsendbreak, tcsetattr,
tcsetpgrp, time, timer_getoverrun, timer_gettime, timer_settime, times,
umask, uname, unlink, utime, wait, waitpid, write
```

Notice what is **NOT** there: `printf`, `fprintf`, `malloc`, `free`, `pthread_*`, anything from `<iostream>`, anything from the C++ standard library that allocates, locale functions, `localtime`, exception machinery.

The corollary: **a signal handler should do almost nothing.** Set a `volatile sig_atomic_t` flag, write a byte to a self-pipe, or call `write(2)` to a fd. That's it.

### 2. `sigaction(2)` vs `signal(2)`

`signal(2)` has BSD/SysV semantic differences and on some implementations resets the handler to default after firing. **Never use `signal()` in production code.**

```cpp
struct sigaction sa{};
sa.sa_flags     = SA_SIGINFO | SA_RESTART;
sa.sa_sigaction = &on_signal;        // void(int, siginfo_t*, void*)
sigemptyset(&sa.sa_mask);
sigaddset(&sa.sa_mask, SIGTERM);     // block SIGTERM during handler
sigaction(SIGINT,  &sa, nullptr);
sigaction(SIGTERM, &sa, nullptr);
```

Important `sa_flags`:

| Flag | Meaning |
|------|---------|
| `SA_SIGINFO` | Use the 3-arg `sa_sigaction`, gives `siginfo_t` (sender pid, faulting addr, signal cause). |
| `SA_RESTART` | Restart slow syscalls (`read`, `accept`, ...) instead of returning `EINTR`. |
| `SA_NOCLDSTOP` | Don't deliver SIGCHLD on stopped/continued children. |
| `SA_NOCLDWAIT` | Don't create zombies, auto-reap. |
| `SA_NODEFER` | Don't add this signal to the mask during the handler (re-entrant, risky). |
| `SA_RESETHAND` | Handler resets to default after firing once. |
| `SA_ONSTACK` | Run on the alternate signal stack (`sigaltstack`), required for SIGSEGV from stack overflow. |

`SA_RESTART` is double-edged. It restarts most slow syscalls, **except** select/poll/epoll_wait/recv-with-timeout, which always return EINTR regardless. So you still need EINTR loops on those.

### 3. The `siginfo_t` Goldmine

```cpp
void on_signal(int sig, siginfo_t* si, void* ucontext) {
    // si->si_signo, si->si_code, si->si_pid, si->si_uid
    // For SIGSEGV: si->si_addr (faulting address), si->si_code (SEGV_MAPERR | SEGV_ACCERR)
    // For SIGCHLD: si->si_pid, si->si_status, si->si_code (CLD_EXITED, CLD_KILLED, CLD_DUMPED, ...)
    // For SIGIO:   si->si_fd
    // ucontext is a ucontext_t*, register state at fault. Stack-walk it for backtraces.
}
```

For crash handlers, `siginfo_t` plus libunwind/`backtrace_symbols_fd` gives a usable post-mortem trace **before** the process dies. See Crash Handling and Core Dumps.

### 4. Per-Thread Signal Masks

Signal masks are **per-thread**. `sigprocmask(2)` is officially undefined in multi-threaded programs, use `pthread_sigmask(3)` instead. Signal **handlers** are process-wide.

The standard production pattern for "main thread handles signals, workers don't":

```cpp
sigset_t set;
sigemptyset(&set);
sigaddset(&set, SIGTERM);
sigaddset(&set, SIGINT);
sigaddset(&set, SIGHUP);

// Main thread, BEFORE spawning workers, children inherit the mask.
pthread_sigmask(SIG_BLOCK, &set, nullptr);

// Workers run with these signals blocked, kernel will route them to the
// main thread (or any thread that unblocks them).
spawn_workers();

// Main thread waits synchronously:
int sig;
sigwait(&set, &sig);   // returns the delivered signal
shutdown(sig);
```

This avoids handlers entirely for clean shutdown, no async-signal-safety constraints, no race with destructors. **This is the right shape for any C++ service.**

### 5. `signalfd`. Signals as File Descriptors

```cpp
sigset_t set;
sigemptyset(&set); sigaddset(&set, SIGTERM); sigaddset(&set, SIGCHLD);
pthread_sigmask(SIG_BLOCK, &set, nullptr);   // MUST block first

int sfd = signalfd(-1, &set, SFD_CLOEXEC | SFD_NONBLOCK);

epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev);

// In the event loop:
struct signalfd_siginfo si;
while (read(sfd, &si, sizeof si) == sizeof si) {
    switch (si.ssi_signo) {
        case SIGTERM: graceful_shutdown(); break;
        case SIGCHLD: reap_children();     break;
    }
}
```

`signalfd` integrates signals with `epoll`/`io_uring`, no more "wake up the loop via self-pipe." It is the modern default for any reactor-style C++ server.

Caveats:

- The signal must be **blocked** in every thread, otherwise the kernel may deliver it to a thread that does not read the fd, and the fd will never become readable.
- `signalfd` does **not** consume the signal until you `read()`. Pending signals stack as a queue (real-time signals) or coalesce (standard signals).

### 6. SIGCHLD. Don't Lose Children

When a child exits, the kernel sends SIGCHLD and creates a zombie until you `wait`. Three correct patterns:

**(a) `SA_NOCLDWAIT`**, auto-reap, no notification (you do not care about exit status):

```cpp
sa.sa_handler = SIG_IGN;
sa.sa_flags   = SA_NOCLDWAIT;
sigaction(SIGCHLD, &sa, nullptr);
```

**(b) `signalfd`**, drain SIGCHLD, then `waitpid(-1, &st, WNOHANG)` in a loop until it returns 0 or `ECHILD`. **The loop is mandatory**, multiple children can exit between fd reads, and SIGCHLD coalesces.

**(c) `pidfd`**, the modern way. After `clone3(CLONE_PIDFD)` you have a pidfd. Add to epoll, wait for EPOLLIN, then `waitid(P_PIDFD, fd, &si, WEXITED)`. No SIGCHLD involved.

### 7. Restarting Slow Syscalls

Without `SA_RESTART`, every `read`, `write`, `accept`, etc. on a slow fd returns `-1 EINTR` if a signal fires. Code must loop:

```cpp
ssize_t safe_read(int fd, void* buf, size_t n) {
    for (;;) {
        ssize_t r = ::read(fd, buf, n);
        if (r >= 0) return r;
        if (errno == EINTR) continue;   // signal, try again
        return -1;
    }
}
```

`SA_RESTART` automates this for most syscalls but **never** for: `select`, `pselect`, `poll`, `ppoll`, `epoll_wait`, `epoll_pwait`, `recv*` with `SO_RCVTIMEO`, `send*` with `SO_SNDTIMEO`, `sem_timedwait`, `sigtimedwait`. Always EINTR-loop these.

### 8. Real-Time Signals (`SIGRTMIN`..`SIGRTMAX`)

Standard signals coalesce, if 100 SIGUSR1s arrive while masked, only 1 is delivered. Real-time signals **queue** (up to `RLIMIT_SIGPENDING`) and **carry payload**:

```cpp
union sigval val; val.sival_int = task_id;
sigqueue(target_pid, SIGRTMIN+1, val);
```

In the handler, `siginfo_t::si_value` is the payload. Used by POSIX timers and AIO completion. Modern code prefers `eventfd`/`signalfd`/`io_uring`, but real-time signals remain useful for cross-process work-item delivery without shared memory.

### 9. SIGSEGV from Stack Overflow, `sigaltstack`

If your stack overflows, the handler **cannot run on the same stack**, that's the very stack that just blew up. Install an alternate:

```cpp
static thread_local std::array<std::byte, 64*1024> alt_stack;
stack_t ss { .ss_sp = alt_stack.data(), .ss_flags = 0, .ss_size = alt_stack.size() };
sigaltstack(&ss, nullptr);

struct sigaction sa{};
sa.sa_sigaction = &crash_handler;
sa.sa_flags     = SA_SIGINFO | SA_ONSTACK;
sigaction(SIGSEGV, &sa, nullptr);
```

Per-thread, because each thread has its own stack. Combine with guard pages (mmap a `PROT_NONE` page below the stack) to **detect** overflow vs random memory corruption, `siginfo_t::si_addr` will be in the guard region.

### 10. Signal-Driven I/O (Mostly Historical)

`fcntl(fd, F_SETOWN, getpid())` + `fcntl(fd, F_SETSIG, SIGRTMIN)` + `O_ASYNC` causes the kernel to send a signal when the fd is readable. With SA_SIGINFO, `siginfo_t::si_fd` identifies the fd. Predates `epoll` and is largely superseded by it. Mention exists so you recognize legacy code, do not write new.

### 11. Putting It Together. A Service Skeleton

```cpp
// service_main.cpp, production-shape signal handling
#include <sys/signalfd.h>
#include <sys/epoll.h>
#include <signal.h>
#include <unistd.h>

int main() {
    // 1. Block signals process-wide BEFORE any thread is spawned.
    sigset_t mask; sigemptyset(&mask);
    sigaddset(&mask, SIGTERM);
    sigaddset(&mask, SIGINT);
    sigaddset(&mask, SIGHUP);
    sigaddset(&mask, SIGCHLD);
    sigaddset(&mask, SIGPIPE);   // we want EPIPE returns, not crashes
    pthread_sigmask(SIG_BLOCK, &mask, nullptr);

    // 2. Ignore SIGPIPE entirely, for socket writes use MSG_NOSIGNAL.
    struct sigaction ign{}; ign.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &ign, nullptr);

    // 3. Crash signals go to a backtrace handler on alt stack.
    install_crash_handler(); // SIGSEGV/SIGBUS/SIGABRT with SA_ONSTACK
    // 4. Operational signals come through signalfd into epoll.
    sigset_t opmask; sigemptyset(&opmask);
    sigaddset(&opmask, SIGTERM);
    sigaddset(&opmask, SIGHUP);
    sigaddset(&opmask, SIGCHLD);
    int sfd = signalfd(-1, &opmask, SFD_CLOEXEC | SFD_NONBLOCK);

    int epfd = epoll_create1(EPOLL_CLOEXEC);
    epoll_event ev{ .events = EPOLLIN, .data = { .fd = sfd } };
    epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev);

    run_event_loop(epfd, sfd);
}
```

This skeleton is the difference between "service" and "incident waiting to happen."

### 12. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `signal(SIGINT, h)` | `sigaction` with `SA_SIGINFO`. |
| `printf` in handler | `write(2, msg, len)` only, or set a flag and let main loop print. |
| Per-thread handler logic | Block in workers, handle in main via `sigwait` or `signalfd`. |
| Forget `SIGPIPE` | `SIG_IGN` + `MSG_NOSIGNAL` on every send. |
| Loop `wait()` on SIGCHLD | `pidfd` + epoll, no SIGCHLD at all. |
| Signal handler does shutdown | Handler sets atomic flag, main loop tears down. |
| Trust `EINTR` will not appear | EINTR-loop every slow syscall, even with `SA_RESTART`. |

The discipline summary: **block early, deliver via fd, handle in normal code paths, never call non-async-signal-safe functions from a real handler.**
