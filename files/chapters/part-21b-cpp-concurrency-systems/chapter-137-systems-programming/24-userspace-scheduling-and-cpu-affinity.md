## Userspace Scheduling and CPU Affinity

> **Senior @ FAANG**: The kernel's CFS is excellent for general workloads and wrong for tail-latency-sensitive ones. Knowing how to pin threads, isolate cores, configure RT scheduling, and read futex internals is the price of admission for HFT, databases, real-time audio, video, and packet-forwarding code.

### 1. Scheduling Classes

Linux has five scheduling classes, ordered by priority (highest first):

| Class | Use | Pre-emption | Notes |
|-------|-----|-------------|-------|
| `STOP` | kstopmachine, hot-plug | always wins | kernel-only |
| `DEADLINE` (`SCHED_DEADLINE`) | soft real-time guarantees | EDF + CBS | Userspace-accessible, needs `runtime/deadline/period` |
| `RT` (`SCHED_FIFO`, `SCHED_RR`) | real-time | priority-based, `FIFO` runs until it yields, `RR` time-slices among same prio | RT throttling 95% by default |
| `FAIR` (`SCHED_NORMAL` aka `SCHED_OTHER`, `SCHED_BATCH`, `SCHED_IDLE`) | default CFS | weighted fairness | Vast majority of threads |
| `IDLE` (`SCHED_IDLE`) | only when nothing else runnable | n/a | Lowest possible priority |

Set via `sched_setscheduler(2)` / `pthread_setschedparam(3)`:

```cpp
struct sched_param p{};
p.sched_priority = 80;        // 1..99 for RT; 0 for normal
pthread_setschedparam(pthread_self(), SCHED_FIFO, &p);
```

**Caveats:**

- RT priorities above 50 contend with kernel threads. Pick 1-49 for application RT, leave 50+ for kernel.
- A `SCHED_FIFO` thread that loops without I/O **starves the kernel** including the scheduler watchdog → soft lockup → reboot. Always have a yield point or budget.
- Default RT throttling: `/proc/sys/kernel/sched_rt_runtime_us=950000` of every `sched_rt_period_us=1000000`. RT can use 95%, leaving 5% for normal tasks. Disable with `-1` only if you understand the consequences.

### 2. `SCHED_DEADLINE`. Real Real-Time

```cpp
struct sched_attr a{};
a.size           = sizeof a;
a.sched_policy   = SCHED_DEADLINE;
a.sched_runtime  =   500'000;  // 500 µs of CPU per period
a.sched_period   = 10'000'000;  // 10 ms period
a.sched_deadline = 10'000'000;  // deadline = period
syscall(SYS_sched_setattr, 0, &a, 0);
```

Kernel guarantees: at most `runtime` CPU per `period`, completed by `deadline`. Admission control rejects oversubscription. The right model for periodic real-time work (audio callbacks, control loops). Cannot be inherited by children.

### 3. CPU Affinity

```cpp
cpu_set_t set;
CPU_ZERO(&set);
CPU_SET(4, &set); CPU_SET(5, &set);
sched_setaffinity(0, sizeof set, &set);    // current thread
pthread_setaffinity_np(tid, sizeof set, &set);
```

For a worker pool, pin each thread to one core:

```cpp
for (int i = 0; i < n; ++i) {
    workers[i] = std::thread([i]{
        cpu_set_t s; CPU_ZERO(&s); CPU_SET(2 + i, &s);
        pthread_setaffinity_np(pthread_self(), sizeof s, &s);
        worker_loop();
    });
}
```

Verify: `taskset -pc <pid>` or `/proc/<pid>/status` field `Cpus_allowed_list`.

#### 3.1 SMT siblings

`cat /sys/devices/system/cpu/cpu4/topology/thread_siblings_list` → `4,36`. Two logical CPUs share L1/L2 and pipeline resources. For latency, **disable SMT** (`nosmt` boot param) or pin only one sibling. For throughput, use both.

#### 3.2 NUMA-aware affinity

`numactl --cpunodebind=0 --membind=0` is the lazy way. Programmatic:

```cpp
struct bitmask* cpus = numa_allocate_cpumask();
numa_node_to_cpus(0, cpus);
// build cpu_set_t from cpus, then sched_setaffinity.
```

Pin worker threads to the NUMA node where their data lives, saves QPI/UPI/Infinity Fabric traffic.

### 4. Boot-Time Isolation

For HFT and packet processing, dedicate CPUs at boot:

```
isolcpus=2-31 nohz_full=2-31 rcu_nocbs=2-31 \
irqaffinity=0,1 mitigations=off audit=0 \
intel_idle.max_cstate=1 idle=poll \
processor.max_cstate=1 nosoftlockup
```

What each does:

| Param | Effect |
|-------|--------|
| `isolcpus=2-31` | Remove from CFS load-balancing. Threads land here only via affinity. |
| `nohz_full=2-31` | No scheduler tick when single runnable task, saves ~1 µs/ms of jitter. |
| `rcu_nocbs=2-31` | Offload RCU callbacks to non-isolated CPUs. |
| `irqaffinity=0,1` | All IRQs default to CPU 0-1, isolated cores untouched. |
| `intel_idle.max_cstate=1` / `idle=poll` | Don't enter deep C-states, stay ready. Burns power, eliminates wake-up latency. |
| `mitigations=off` | Disable Spectre/Meltdown mitigations. **Only on dedicated trusted hardware.** |

Validate: `dmesg | grep isolcpus`, `cat /sys/devices/system/cpu/isolated`.

For dynamic isolation without reboot, **cgroup v2 cpuset**:

```bash
mkdir /sys/fs/cgroup/hot
echo "+cpuset" > /sys/fs/cgroup/cgroup.subtree_control
echo "2-31" > /sys/fs/cgroup/hot/cpuset.cpus
echo "root"  > /sys/fs/cgroup/hot/cpuset.cpus.partition   # exclusive
```

`cpuset.cpus.partition=root` evicts all other tasks from those CPUs at runtime.

### 5. IRQ Affinity

Default `irqbalance` distributes IRQs heuristically. For latency, kill it and pin manually:

```bash
systemctl stop irqbalance
echo 0 > /proc/sys/kernel/numa_balancing

for irq in $(grep nvme /proc/interrupts | awk '{print $1}' | tr -d :); do
    echo 1 > /proc/irq/$irq/smp_affinity_list   # all NVMe IRQs to CPU 1
done
```

For multi-queue NICs with N queues and pinned cores 2..2+N-1, map each rx-K to the K-th core. Combined with RPS/XPS/`SO_REUSEPORT` per-queue accept loops, you get NIC-to-app contiguous CPU residence.

### 6. Futex Internals

A **futex** (fast userspace mutex) is a 32-bit (or 64-bit since 5.16) integer in shared memory. Userspace does atomic compare-and-swap, only on contention does it call into the kernel via `futex(2)`:

```cpp
// Lock acquire (uncontended fast path):
uint32_t expect = 0;
while (!__atomic_compare_exchange_n(&lock, &expect, 1, false, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
    syscall(SYS_futex, &lock, FUTEX_WAIT, 1, nullptr, nullptr, 0);
    expect = 0;
}
// Lock release:
__atomic_store_n(&lock, 0, __ATOMIC_RELEASE);
syscall(SYS_futex, &lock, FUTEX_WAKE, 1, nullptr, nullptr, 0);
```

`pthread_mutex_t`, `std::mutex`, condition variables, semaphores, all built on this. Kernel maintains per-futex hash buckets of waiters, `FUTEX_WAIT` parks the calling thread there.

Futex operations:

| Op | Effect |
|----|--------|
| `FUTEX_WAIT` | Sleep if `*addr == val`. |
| `FUTEX_WAKE` | Wake N waiters. |
| `FUTEX_REQUEUE` / `FUTEX_CMP_REQUEUE` | Move waiters from one futex to another (used by condvars to avoid thundering herd). |
| `FUTEX_WAKE_OP` | Atomic op + conditional wake (used by some pthread implementations). |
| `FUTEX_LOCK_PI` / `FUTEX_UNLOCK_PI` | Priority-inheritance variant for RT. |
| `FUTEX_WAIT_BITSET` | Wait with a 32-bit mask, only wakes matching bits. |

The new `futex2` API (kernel 5.16+) supports 64-bit and other future-proofings, libc support is rolling out.

**Performance note:** an uncontended `pthread_mutex_lock`/`unlock` on x86 is ~20 ns (CAS only, no syscall). A contended one with `futex_wait` is ~1 µs minimum (syscall + scheduler work). The math: design for low contention, not for fast locks.

### 7. Priority Inheritance (PI Mutexes)

Classical priority inversion: low-prio holds a lock, mid-prio runs and starves low-prio, high-prio blocks on the lock. Mars Pathfinder famously hit this.

PI mutexes (`pthread_mutexattr_setprotocol(&a, PTHREAD_PRIO_INHERIT)`) make the lock holder temporarily inherit the highest priority of any waiter. In RT systems this is mandatory, without it, an `SCHED_FIFO` thread can deadlock.

`SCHED_DEADLINE` does **not** support PI as of mainline, design around shared locks if you use deadline scheduling.

### 8. Pinning a HFT Process Correctly. Worked Example

Hardware: 32-core, 2 NUMA nodes, NIC on node 0, NVMe on node 0.

Boot:
```
isolcpus=2-31 nohz_full=2-31 rcu_nocbs=2-31 \
irqaffinity=0,1 idle=poll intel_idle.max_cstate=1
```

Process layout:

| Thread | Pinned to | Why |
|--------|-----------|-----|
| Main / config | CPU 0 | Housekeeping, no isolated CPU needed |
| Stats / log shipper | CPU 1 | Off the hot path |
| Market-data RX | CPU 2 (NUMA0) | Same node as NIC. SCHED_FIFO 80 |
| Strategy core | CPU 3 (NUMA0) | NUMA0 for cache-line proximity to RX. SCHED_FIFO 80 |
| Order TX | CPU 4 (NUMA0) | Same NUMA, dedicated |
| WAL writer | CPU 5 (NUMA0) | Drives NVMe via io_uring |
| Backtest worker pool | CPU 6-15 (NUMA0), 16-31 (NUMA1) | SCHED_NORMAL, NUMA-balanced |

NIC IRQs: `/proc/irq/<rxN>/smp_affinity_list = 2`. NVMe completion: `= 5`. Application RX thread on CPU 2 reads frames produced by IRQ on CPU 2, no cross-CPU cache traffic.

`mlockall(MCL_CURRENT|MCL_FUTURE|MCL_ONFAULT)`, `prctl(PR_SET_TIMERSLACK, 1)`, `prctl(PR_SET_DUMPABLE, 0)`. Hugepages for the order book. `numa_alloc_onnode` on node 0 for hot data.

This shape is what every production HFT C++ codebase implements in some form.

### 9. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| Threads scheduled by default CFS | Pinned `SCHED_FIFO` for hot threads on isolated CPUs. |
| `nice -20` for "real-time" | `SCHED_DEADLINE` or `SCHED_FIFO`, with budget enforcement. |
| `pthread_mutex` on hot path | Lock-free queues, mutex only off hot path. |
| Trust `irqbalance` | Disable, pin IRQs explicitly. |
| Default kernel cmdline | `isolcpus`, `nohz_full`, `rcu_nocbs`, `idle=poll` for hot cores. |
| Ignore SMT siblings | Pin to one sibling, or disable SMT for latency. |
| Ignore NUMA | Co-locate thread, IRQ, memory on the same node. |
| Trust `pthread_mutex` PI | Set `PTHREAD_PRIO_INHERIT` for any RT shared lock. |

The kernel will give you what you ask for, and ask for what you tell it. The above checklist turns a "fast" service into a deterministic one.
