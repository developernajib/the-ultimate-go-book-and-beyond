## Linux Time and Clocks

> **Senior @ FAANG**: "Get the time" has at least seven meanings on Linux, and choosing the wrong one corrupts logs, breaks timeouts, and crashes distributed protocols on leap second days. HFT engineers measure clocks in nanoseconds, database engineers fight over leap-smearing strategies, everyone gets monotonic vs realtime wrong at least once.

### 1. The Clock Zoo

| Clock | Source | Monotonic | Suspends pause it? | Use for |
|-------|--------|-----------|--------------------|---------|
| `CLOCK_REALTIME` | wall clock, settable | NO, can jump (NTP, `settimeofday`, leap second) | yes | Timestamps users see, log records. **Never** for timeouts. |
| `CLOCK_REALTIME_COARSE` | jiffy-resolution realtime | NO | yes | Low-cost timestamps where ms is enough. |
| `CLOCK_MONOTONIC` | monotonic since boot, NTP-adjusted rate | YES | yes | Timeouts, durations, rate calc. |
| `CLOCK_MONOTONIC_COARSE` | jiffy-resolution monotonic | YES | yes | Hot-path timeouts. |
| `CLOCK_MONOTONIC_RAW` | raw monotonic, no NTP slewing | YES | yes | Counters where you want hardware truth, not slewed time. |
| `CLOCK_BOOTTIME` | monotonic + suspended time | YES | NO | Wake-from-suspend deadlines (timer_create, timerfd). |
| `CLOCK_TAI` | International Atomic Time, no leap seconds | YES | yes | Distributed systems robust to leap seconds. |
| `CLOCK_PROCESS_CPUTIME_ID` | CPU time in process | YES | n/a | Self-profiling. |
| `CLOCK_THREAD_CPUTIME_ID` | CPU time in thread | YES | n/a | Per-thread profiling. |

The single most-common bug: using `CLOCK_REALTIME` for a timeout. NTP steps the clock backward by 200 ms, your "5 second timeout" now expires in 5.2 s, or never, if it stepped forward.

```cpp
// WRONG
auto deadline = std::chrono::system_clock::now() + 5s;   // CLOCK_REALTIME

// RIGHT
auto deadline = std::chrono::steady_clock::now() + 5s;   // CLOCK_MONOTONIC
```

`std::chrono::steady_clock` maps to `CLOCK_MONOTONIC` on Linux. `std::chrono::system_clock` maps to `CLOCK_REALTIME`. Use the former for everything internal.

### 2. `clock_gettime` and the vDSO

```cpp
struct timespec ts;
clock_gettime(CLOCK_MONOTONIC, &ts);
uint64_t ns = uint64_t(ts.tv_sec) * 1'000'000'000ULL + ts.tv_nsec;
```

On x86_64, `clock_gettime` for `CLOCK_REALTIME`, `CLOCK_MONOTONIC`, `CLOCK_BOOTTIME`, `CLOCK_TAI`, and the `_COARSE` variants is implemented in the **vDSO**, not a real syscall. It reads a kernel-shared page and computes time using `rdtscp` (with kernel-supplied scale/offset). Cost: **~15 ns** vs ~150 ns for a real syscall.

Verify on your system:

```bash
$ ldd /bin/true
linux-vdso.so.1 (0x00007ffc...)

$ ls /proc/self/maps | grep vdso
7ffc...  r-xp  [vdso]
```

For absolute fastest path, use `__rdtsc()` directly **only if** the system has invariant TSC and you have calibrated the frequency yourself:

```cpp
unsigned aux;
uint64_t cycles = __rdtscp(&aux);  // also returns CPU id, fence-like
```

Caveats:

- `rdtsc` without `lfence`/`rdtscp` is reorderable.
- TSC frequency varies by CPU generation, calibrate via `clock_gettime(CLOCK_MONOTONIC_RAW)` over a known interval.
- VM guests may emulate `rdtsc` (slow), check `cpuid` constant_tsc, nonstop_tsc.

### 3. NTP, Slew, and Leap Seconds

NTP keeps `CLOCK_REALTIME` aligned with UTC. Two adjustment modes:

- **Slew**: `adjtime`/`adjtimex` adjusts the clock's *frequency* so it converges to the right time gradually. Continuity preserved.
- **Step**: large offset (>128 ms by default) → instantaneous jump. Discontinuity. **This is what breaks naive timeout code.**

Leap seconds: UTC inserts (or, in theory, removes) a second every few years. Three handling strategies in production:

1. **Kernel insertion** (default): at 23:59:60 UTC the kernel repeats 23:59:59 for one second, then advances. `clock_gettime` returns the repeated second. Code that uses time as an ordering key breaks.
2. **Smearing**: NTP server lies, slewing the clock over a window (typically ±12 h of the leap) so the discontinuity is invisible. Google, AWS, Meta, and Cloudflare all smear. **`leap_smear` is what your servers should run.**
3. **TAI clock**: `CLOCK_TAI` does not have leap seconds. UTC ↔ TAI offset is stored in the kernel via `adjtimex`. Distributed systems that need leap-immune ordering use TAI internally and convert to UTC only for display.

The 2012 and 2015 leap seconds famously crashed Reddit, Foursquare, LinkedIn, Java applications, and various MySQL builds because of `futex`/JVM clock assumptions. Pick smearing **or** TAI, never default insertion in production.

### 4. PTP and PHC. Sub-Microsecond Time

For HFT, market data feeds, telecom, anything that needs microsecond-accurate clocks across machines: **PTP (IEEE 1588)** distributes time from a grandmaster (typically GPS-disciplined) over the LAN with hardware timestamping in the NIC.

The **PTP Hardware Clock (PHC)** is a clock on the NIC. `linuxptp` (`ptp4l` + `phc2sys`) synchronizes the PHC to the grandmaster, then synchronizes the system clock to the PHC.

```bash
ptp4l -i eth0 -m -s            # slave to grandmaster
phc2sys -s eth0 -O 0 -m         # sync system clock to PHC
```

Verify accuracy:

```bash
$ pmc -u -b 0 'GET TIME_STATUS_NP'
master_offset 35 ns
```

A well-tuned PTP setup achieves sub-microsecond offset across a rack. The system clock you read with `clock_gettime(CLOCK_REALTIME)` is now accurate to ~100 ns of the grandmaster.

NIC hardware timestamping (`SO_TIMESTAMPING`) gives you the exact NIC ingress/egress time per packet, the foundation of HFT order-receipt latency measurement.

### 5. Tickless Kernel and Timer Slack

Linux runs in **tickless** mode (`NO_HZ_IDLE` always, `NO_HZ_FULL` opt-in). On `NO_HZ_FULL=2-31` boot param, CPUs 2-31 run with no scheduler tick when one task is runnable, eliminating ~1 µs of jitter per ms.

For HFT and audio:

```bash
isolcpus=2-31 nohz_full=2-31 rcu_nocbs=2-31
```

isolcpus removes CPUs from the scheduler's load-balancer, nohz_full disables the tick when idle or single-task, rcu_nocbs offloads RCU callbacks to other CPUs. Together they give you cores that run **only** what you pin to them (see Userspace Scheduling and CPU Affinity).

Per-process **timer slack** rounds up timer deadlines to amortize wakeups (battery-friendly):

```cpp
prctl(PR_SET_TIMERSLACK, 1);  // 1 ns → minimum slack
```

Default is 50 µs for non-root, some kernels use 50 ms for power-managed devices. Set to 1 for latency-critical processes.

### 6. `timerfd` and `timer_create`

For fd-driven event loops, `timerfd_create` produces an fd that becomes readable when the timer expires.

```cpp
int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
struct itimerspec it{};
it.it_value.tv_nsec    = 1'000'000;   // first expiry in 1ms
it.it_interval.tv_nsec = 1'000'000;   // periodic 1 kHz
timerfd_settime(tfd, 0, &it, nullptr);
epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev);

// On expiry:
uint64_t expirations;
read(tfd, &expirations, sizeof expirations);  // count of missed expiries
```

`TFD_TIMER_ABSTIME` interprets `it_value` as absolute. `TFD_TIMER_CANCEL_ON_SET` (with `CLOCK_REALTIME`) makes the fd return `ECANCELED` if the realtime clock steps, the only way to detect time discontinuities cleanly.

`timer_create(2)` is the older POSIX API delivering by signal or thread, prefer `timerfd` for new code.

For sub-microsecond precision, the system runs `hrtimer`s in the kernel, the practical floor is the local APIC timer resolution + scheduler wake, typically 1-5 µs on commodity x86.

### 7. Time-Sync Correctness in Distributed Systems

Three rules:

**(1) Never use wall time as a logical clock.** Lamport timestamps, Hybrid Logical Clocks (HLC), or CockroachDB-style hybrid clocks are correct under clock jumps. Wall time is not.

**(2) For "happens-before" across machines, you need bounded clock skew.** TrueTime (Spanner) guarantees clocks within ε, the algorithm waits ε after a transaction commit to ensure linearizability. Without TrueTime hardware (atomic + GPS), use HLC and accept the ε is unbounded → no external consistency.

**(3) If you must use wall time, use TAI.** `clock_gettime(CLOCK_TAI, ...)` survives leap seconds. UTC does not. CockroachDB, FoundationDB, and TigerBeetle all internally use TAI or smeared time.

A practical pattern, clock-bounded leases:

```cpp
auto lease_until = clock_tai_now() + lease_duration + max_skew;
// publish lease_until to peers
// peer accepts only if its clock_tai_now() < lease_until - max_skew
```

`max_skew` comes from your PTP/NTP monitoring, not a guess.

### 8. Measuring Latency Right

```cpp
// Two timestamps, same monotonic clock, careful about reordering.
auto t0 = std::chrono::steady_clock::now();
do_work();
auto t1 = std::chrono::steady_clock::now();
auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
```

For sub-µs work, use `__rdtsc()` with `_mm_lfence()` or `__rdtscp()`:

```cpp
auto rdtsc_fenced = []{
    _mm_lfence();
    uint64_t t = __rdtsc();
    _mm_lfence();
    return t;
};
auto cy0 = rdtsc_fenced();
do_work();
auto cy1 = rdtsc_fenced();
double ns = (cy1 - cy0) / tsc_ghz;  // tsc_ghz calibrated at startup
```

Pitfalls:

- TSC scaling on modern CPUs is invariant **across frequency**, so this is robust to turbo. Verify `lscpu | grep -i constant_tsc`.
- VM guests with `kvm-clock` may emulate TSC, calibrate inside the VM.
- Cross-core TSC is synchronized on Intel and AMD with `nonstop_tsc`, otherwise migrate threads with `sched_setaffinity`.

### 9. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `time(NULL)` for everything | `clock_gettime(CLOCK_MONOTONIC)` for durations, `CLOCK_REALTIME` only for user-visible timestamps. |
| `std::chrono::system_clock` for timeouts | `std::chrono::steady_clock`. |
| `sleep(5)` | `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, NULL)`. |
| Trust kernel leap-second insertion | Smear via NTP server, or use `CLOCK_TAI` internally. |
| Wall time as ordering | HLC or vector clocks. |
| `gettimeofday()` in hot path | vDSO `clock_gettime` (or `__rdtscp` after calibration). |
| Default timer slack | `prctl(PR_SET_TIMERSLACK, 1)` for latency-critical procs. |
| Run on default kernel cmdline | `isolcpus`, `nohz_full`, `rcu_nocbs` for HFT cores. |

Time is the substrate of correctness in distributed systems. Treat it as physics, not a function call.
