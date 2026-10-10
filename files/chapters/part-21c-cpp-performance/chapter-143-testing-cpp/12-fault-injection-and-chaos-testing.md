## Fault Injection and Chaos Testing in C++

Production failures are rarely about the happy path. They are about `ENOMEM` on the 10000th allocation, a partial `write()` in the middle of a header, a DNS query that takes 30 seconds, or a thread that wakes from `sleep` 400 microseconds late. Testing these failure modes by hoping they happen naturally does not work. Senior engineers inject the faults deterministically and verify recovery.

### Injecting Syscall Failures with LD_PRELOAD

The simplest, single most useful technique is to wrap libc functions with a shared library loaded via `LD_PRELOAD`. The wrapper can return failures on the Nth call, on calls from a specific stack, or randomly at a configurable rate.

```cpp
// fault_alloc.cpp - compiled as libfault_alloc.so
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <atomic>
#include <cstdio>

using malloc_fn = void* (*)(size_t);
static malloc_fn real_malloc = nullptr;

static std::atomic<long> call_count{0};
static long fail_after = -1;
static double fail_rate = 0.0;

__attribute__((constructor))
static void init_fault_alloc() {
    real_malloc = reinterpret_cast<malloc_fn>(dlsym(RTLD_NEXT, "malloc"));
    if (const char* s = getenv("FAULT_MALLOC_FAIL_AFTER")) fail_after = atol(s);
    if (const char* s = getenv("FAULT_MALLOC_FAIL_RATE"))  fail_rate  = atof(s);
}

extern "C" void* malloc(size_t size) {
    long n = call_count.fetch_add(1, std::memory_order_relaxed);
    if (fail_after >= 0 && n == fail_after) {
        errno = ENOMEM;
        return nullptr;
    }
    if (fail_rate > 0.0 && (rand() / double(RAND_MAX)) < fail_rate) {
        errno = ENOMEM;
        return nullptr;
    }
    return real_malloc(size);
}
```

Run a test with `FAULT_MALLOC_FAIL_AFTER=500 LD_PRELOAD=./libfault_alloc.so ./test_binary`. The 501st allocation returns null, exercising the out-of-memory branch. Rotate through values to test every site that allocates.

The same pattern works for `open`, `read`, `write`, `accept`, `connect`, `fsync`, and any libc entry point. Netflix's Chaos Monkey ancestor, and Google's "DiRT" (Disaster Recovery Testing) program, both started with techniques of this kind.

### seccomp Filters for Deterministic Kernel-Level Faults

`LD_PRELOAD` cannot intercept direct syscalls. For code paths that use `syscall(SYS_write, ...)` directly, or for kernel-facing tests, seccomp-bpf filters let you inject `ENOSYS` or `EACCES` on specific syscalls.

```cpp
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stddef.h>

void forbid_fsync() {
    sock_filter filter[] = {
        { BPF_LD | BPF_W | BPF_ABS, 0, 0,
          static_cast<unsigned>(offsetof(seccomp_data, nr)) },
        { BPF_JMP | BPF_JEQ | BPF_K, 0, 1, SYS_fsync },
        { BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | EIO },
        { BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW },
    };
    sock_fprog prog{.len = sizeof(filter)/sizeof(filter[0]), .filter = filter};
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}
```

Call `forbid_fsync()` in a test, then run the write-ahead-log module. Every `fsync` returns `EIO`. The test passes if the module handles the error correctly (either by returning an error, by retrying, or by transitioning to read-only mode).

### Scheduler-Driven Concurrency Chaos

Race conditions rarely reproduce on a developer laptop. They reproduce in production where a thread is preempted at an unlucky microsecond. Tools like `CHESS` (Microsoft Research), `rr chaos mode`, and custom `SCHED_FIFO` priority manipulation force the scheduler to explore unusual interleavings.

```cpp
#include <pthread.h>
#include <sched.h>
#include <random>

void chaos_yield_hook() {
    thread_local std::mt19937 rng(pthread_self());
    std::uniform_int_distribution<int> dist(0, 999);
    if (dist(rng) == 0) {
        sched_yield();  // 0.1% chance to yield at this point
    }
}

// Inject chaos_yield_hook() at every atomic op, every lock acquire, and
// every function entry via an instrumentation pass (Clang LibTooling).
```

Or link against `rr record --chaos ./test_binary`, which randomizes scheduling for record-replay debugging. Races that once took weeks to reproduce start showing up in minutes.

### Time Injection

Production code that calls `std::chrono::steady_clock::now()` directly is hard to test against clock skew, leap seconds, and slow monotonic clocks. Inject a `Clock` abstraction and use a fake in tests.

```cpp
class Clock {
public:
    virtual ~Clock() = default;
    virtual std::chrono::steady_clock::time_point now() const = 0;
};

class SystemClock : public Clock {
public:
    std::chrono::steady_clock::time_point now() const override {
        return std::chrono::steady_clock::now();
    }
};

class FakeClock : public Clock {
    std::atomic<std::chrono::steady_clock::duration> offset_{};
public:
    std::chrono::steady_clock::time_point now() const override {
        return std::chrono::steady_clock::time_point{} + offset_.load();
    }
    void advance(std::chrono::milliseconds d) {
        offset_.fetch_add(d);
    }
};
```

Timeouts, retry loops, and circuit breakers all need this indirection. Without it, a "retries up to 3 times over 10 seconds" test either sleeps 10 seconds of real time or tests nothing. With it, the test advances the clock deterministically and verifies the exact sequence of retry attempts.

### Building a Chaos Test Suite

A good chaos suite has three tiers:
1. **Deterministic fault injection** in unit tests (LD_PRELOAD, seccomp, FakeClock). Runs in CI on every PR.
2. **Randomized concurrency torture** (chaos scheduling, model-based tests). Runs nightly.
3. **Production-adjacent chaos** (injecting faults into a canary environment). Runs continuously.

All three catch different classes of bugs. The deterministic tier catches "what if allocation fails here" bugs. The randomized tier catches race conditions. The production tier catches issues that only appear at scale with real dependencies. Skipping any tier leaves a class of bugs unexplored.
