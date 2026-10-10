## Busy-Polling and CPU Isolation

Sub-microsecond latency does not happen because of fast code. It happens because nothing else is running on the same core. A modern Linux server is a tangle of kernel work: timer ticks, scheduler load balancing, RCU callbacks, kworker threads, IRQ handlers, ksoftirqd, kswapd, watchdogs. Any one of those firing on the core that runs your hot loop adds tens of microseconds of jitter. The discipline of CPU isolation removes them, one at a time.

This chapter is the practitioner's checklist. By the end you should be able to take a stock Ubuntu install and produce a host where a single C++ thread on a chosen core sees less than 200 nanoseconds of jitter over a 24-hour period.

### isolcpus, nohz_full, rcu_nocbs

Three kernel command-line parameters do most of the work:

- **`isolcpus=2-7,10-15`.** Removes those CPUs from the scheduler's general-purpose pool. Tasks only run there if explicitly pinned. The kernel will not balance load onto them.
- **`nohz_full=2-7,10-15`.** Disables the periodic timer tick (HZ, typically 1000Hz) on those CPUs while exactly one task is running there. Saves 250 ns of jitter per 1ms.
- **`rcu_nocbs=2-7,10-15`.** Moves RCU callback processing off those CPUs. Otherwise, every grace period dispatches a kthread on every core to process callbacks, on an isolated core that is exactly the work you do not want.

Edit `/etc/default/grub`:

```
GRUB_CMDLINE_LINUX="isolcpus=2-7,10-15 nohz_full=2-7,10-15 rcu_nocbs=2-7,10-15 \
                   intel_idle.max_cstate=0 processor.max_cstate=1 idle=poll \
                   intel_pstate=disable mce=ignore_ce audit=0 \
                   tsc=reliable clocksource=tsc nosoftlockup transparent_hugepage=never"
```

Then `sudo update-grub && sudo reboot`. Verify after boot:

```bash
cat /sys/devices/system/cpu/isolated
cat /sys/devices/system/cpu/nohz_full
cat /sys/devices/system/cpu/cpu2/cpuidle/state*/disable
```

### C-states and P-states

Modern x86 CPUs have aggressive idle states (C-states) that turn off cores after a few microseconds of idle. Re-entering takes 5-50 microseconds. For a busy-poll core this is fine because it never idles, but for cores serving the rest of the system the C-state transition cost shows up as jitter on the busy-poll core via shared LLC and memory controller resources.

```
intel_idle.max_cstate=0           # disable Intel-specific idle driver
processor.max_cstate=1            # allow only C0 and C1 (no C3, C6)
idle=poll                         # idle = busy loop
```

For P-states (frequency scaling), pin to the highest frequency:

```bash
sudo cpupower frequency-set -g performance
sudo cpupower frequency-set -d 4.5GHz   # depends on your part
```

`intel_pstate=disable` falls back to acpi_cpufreq, which is more predictable but slower to respond. Most HFT tunings use `intel_pstate` set to performance, not disabled, because the core needs to stay at boost when active. Test both on your hardware.

### cpuset cgroups: Confining the Rest of the System

`isolcpus` keeps the scheduler off the isolated cores, but only for normal tasks. Containers, systemd services, and kernel threads can still land there if not constrained. Use cpusets to confine them.

```bash
sudo mkdir -p /sys/fs/cgroup/system.slice/cpuset.cpus
echo "0-1,8-9" | sudo tee /sys/fs/cgroup/system.slice/cpuset.cpus
echo "0-1,8-9" | sudo tee /sys/fs/cgroup/user.slice/cpuset.cpus
echo "0-1,8-9" | sudo tee /sys/fs/cgroup/init.scope/cpuset.cpus
```

Or in systemd-friendly form, edit `/etc/systemd/system.conf`:

```
CPUAffinity=0 1 8 9
```

Confirm:

```bash
ps -eo pid,psr,cmd | head -50
```

If you see anything other than your bypass app on cores 2-7 or 10-15, track it down.

### IRQ Affinity

The kernel will route hardware interrupts to whichever CPU is in the IRQ affinity mask, default 0xff (all). Move them off the isolated cores explicitly.

```bash
# Move all IRQs to cores 0,1
for i in /proc/irq/*/smp_affinity_list; do
  echo "0-1" | sudo tee "$i" >/dev/null 2>&1 || true
done
sudo systemctl restart irqbalance   # then disable irqbalance entirely:
sudo systemctl disable --now irqbalance
```

NIC IRQs need extra attention if you are not bypassing them: some NICs assign one IRQ per RX queue, and if you have 16 queues with default affinity you can have 16 IRQs all firing on core 0 under load. If you are bypassing (DPDK, ef_vi, AF_XDP zero-copy), those IRQs are largely silent because the application polls. But not always silent: link-status interrupts and error interrupts still fire.

### Hyperthread Peer Halting

Each physical core hosts two SMT/HT threads. When both run, they share L1 and L2 cache and execution units. For a busy-poll core where you want predictable latency, the HT peer is a noise source. Two options:

1. **Disable SMT in BIOS.** Cleanest. Half the logical CPUs but no contention.
2. **Halt the peer.** Boot SMT on, then `echo 0 > /sys/devices/system/cpu/cpu3/online` for each peer. The hardware thread is offlined, the physical core runs only its other thread.

```bash
# Take CPU 3, 5, 7, 9, 11, 13, 15 offline (peers of 2, 4, 6, ...)
for c in 3 5 7 11 13 15; do
  echo 0 | sudo tee /sys/devices/system/cpu/cpu$c/online
done
```

Verify with `lscpu --extended`. Cores 2, 4, 6, etc. are now solo on their physical cores.

For HFT, full SMT-disable in BIOS is preferred because half-disabled SMT can still leak via shared structures (front-end fetch, branch predictor). For other workloads where some background threads need to run, the halt approach is fine.

### Why Busy-Poll Is The Only Way

The cost of a wakeup. Take a thread blocked on a futex (epoll, condvar, sem):

```
wake side: futex_wake syscall      ~250 ns
            schedule add to runqueue ~100 ns
target:    IPI to target CPU        ~500 ns (cross-core)
            interrupt + IRQ exit    ~200 ns
            schedule pick up        ~300 ns
            cache reload of working set ~500-2000 ns (cold)
total                                ~2-4 microseconds
```

A spinning thread reads memory in a loop:

```
load                                  3-5 ns (L1 hit)
branch                                1 ns
total                                  ~5 ns
```

Three orders of magnitude. There is no scheduler trick that closes that gap. The only way to react to an event in <500 ns is to have a CPU already running and looking at the place the event will appear.

The cost: that CPU is permanently at 100%. Watt-for-watt, that is fine on a 1U server with budget for 16 cores running hot. It is unacceptable on a smartphone, fine on a CDN edge, mandatory on an HFT box.

### Polling Discipline

Naive `while (true) { try_pop(); }` is bad in a couple of ways:

- It hammers the LLC if the data being polled is in another core's L1.
- On x86, repeated load-only loops trip the front-end and reduce IPC for the HT peer (if any).

The right way:

```cpp
while (true) {
    if (try_pop(&msg)) {
        process(msg);
        continue;
    }
    _mm_pause();   // PAUSE instruction, ~30 cycles
}
```

`_mm_pause()` (the PAUSE instruction) hints to the CPU that this is a spin loop, gives the HT peer execution slots, reduces memory ordering speculation cost, and on Skylake-and-later improves spin latency. It is the spin-wait idiom in every well-tuned ring buffer reader.

For longer waits (consumer that may be idle for milliseconds), use a hybrid:

```cpp
int spins = 0;
while (true) {
    if (try_pop(&msg)) { process(msg); spins = 0; continue; }
    if (++spins < 10000) { _mm_pause(); continue; }
    sched_yield();   // give the OS a chance, reset spins after wakeup
    spins = 0;
}
```

### Pinning a Thread

```cpp
#include <pthread.h>
#include <sched.h>

void pin_to(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    if (pthread_setaffinity_np(pthread_self(), sizeof(set), &set) != 0) {
        perror("pthread_setaffinity_np");
        std::abort();
    }
}
```

Confirm it took effect with `taskset -p $TID`. Pin before starting the work, pinning after a thread has been running causes a migration that flushes caches.

### SCHED_FIFO Real-Time Priority

For the very hottest threads, set real-time priority so the kernel never preempts:

```cpp
sched_param sp{ .sched_priority = 50 };
if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) != 0) {
    perror("pthread_setschedparam");
}
```

Caveat: SCHED_FIFO can starve everything else if your code spins forever. Combined with `isolcpus`, this is fine because the rest of the system runs on different cores. Without isolation, you can lock up the box.

`sysctl -w kernel.sched_rt_runtime_us=-1` disables the RT throttle, which by default caps RT tasks at 95% of CPU. For a busy-poll core, set this to -1 explicitly.

### Verifying Jitter

The standard test: run a tight loop reading TSC (RDTSCP), record max delta over 10 minutes:

```cpp
#include <x86intrin.h>
#include <cstdio>
#include <cstdint>

int main() {
    pin_to(2);
    uint64_t prev = __rdtsc();
    uint64_t max_delta = 0;
    for (uint64_t i = 0; i < 10ull*1000*1000*1000; i++) {
        uint64_t now = __rdtsc();
        uint64_t d = now - prev;
        if (d > max_delta) max_delta = d;
        prev = now;
    }
    printf("max delta = %lu cycles (~%.1f ns)\n",
        max_delta, double(max_delta) / 4.5);
    return 0;
}
```

On a properly-isolated core: max delta ~200-500 cycles (50-100 ns), with the 100 ns being the cost of an LLC miss caused by some occasional cache eviction.

On a non-isolated core: max delta in the millions of cycles, because the timer tick or a kworker fired.

> Junior engineer pitfall: setting `taskset 0x4 ./app` and assuming the core is "dedicated."
> Senior FAANG move: building the kernel command line with isolcpus + nohz_full + rcu_nocbs, halting HT peers, restricting IRQs and systemd cpusets, validating with a TSC jitter test that produces a clean 24-hour log, before any latency-sensitive workload is deployed.
