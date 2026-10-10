## 11. CPU Pinning and Affinity

Pinning a thread to a specific core (or set of cores) takes the kernel scheduler out of the picture. The thread runs where you say, on the cache it owns, with the TLB it built. For HFT, database engines, and any service with a tight tail-latency SLO, pinning is mandatory.

### sched_setaffinity

The Linux primitive:

```cpp
#include <sched.h>
#include <pthread.h>

void pin_to_cpu(int cpu) {
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(cpu, &set);
    pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
}

void pin_to_node(int node) {
    cpu_set_t set;
    CPU_ZERO(&set);
    struct bitmask* mask = numa_allocate_cpumask();
    numa_node_to_cpus(node, mask);
    for (size_t c = 0; c < mask->size; ++c) {
        if (numa_bitmask_isbitset(mask, c)) CPU_SET(c, &set);
    }
    pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
    numa_free_cpumask(mask);
}
```

`sched_setaffinity` sets the affinity for a process (or thread, with `pthread_setaffinity_np`). The mask restricts which CPUs the kernel may schedule the thread on. With a single bit set, the thread is pinned.

After pinning, set memory policy too. Pinning the thread without binding memory still allows allocations to land elsewhere if first-touch happens before pinning takes effect (rare but possible with multi-threaded init).

### taskset

For external pinning:

```bash
# Run ./prog with affinity to CPUs 0 and 2:
taskset -c 0,2 ./prog

# Pin an existing PID:
taskset -pc 0,2 12345

# Verify:
taskset -p 12345
```

`taskset` is convenient for one-off testing. For production, set affinity programmatically inside the application, because external tooling cannot pin individual threads within a process.

### isolcpus and nohz_full

For latency-critical workloads, you do not want the kernel scheduler to ever touch certain CPUs:

```
# Kernel boot parameters (in /etc/default/grub on Ubuntu, then update-grub):
GRUB_CMDLINE_LINUX="isolcpus=2-7,10-15 nohz_full=2-7,10-15 rcu_nocbs=2-7,10-15"
```

- `isolcpus=N-M`: the kernel scheduler does not migrate any task onto these CPUs unless explicitly affined there. CPUs are isolated from default load balancing.
- `nohz_full=N-M`: disables the periodic timer tick on these CPUs as long as exactly one task is running. Removes the largest source of jitter.
- `rcu_nocbs=N-M`: moves RCU callback processing off these CPUs.

After boot, your application explicitly pins threads to the isolated CPUs. The kernel schedules nothing else there. The result: a CPU dedicated to your code with sub-microsecond jitter.

### Production HFT Pinning Script (Sketch)

```bash
#!/bin/bash
# A typical pre-launch pinning script for an HFT process:

NIC_NODE=$(cat /sys/class/net/eth0/device/numa_node)
echo "NIC on NUMA node $NIC_NODE"

# Pin RX/TX IRQs to cores 0-1 of NIC's node:
# (lookup IRQ from /proc/interrupts, write affinity to /proc/irq/N/smp_affinity)

# Disable services on isolated CPUs:
systemctl stop irqbalance
systemctl stop tuned

# Move all kernel threads off isolated cores:
for pid in $(ps -eL -o pid,tid,psr,comm | awk '$NF ~ /^k/ {print $2}'); do
    taskset -p -c 0-1 $pid 2>/dev/null
done

# Set CPU governor to performance:
for c in $(seq 0 $(nproc)); do
    echo performance > /sys/devices/system/cpu/cpu$c/cpufreq/scaling_governor
done

# Disable C-states beyond C1 on isolated cores:
# (writes to /dev/cpu_dma_latency, or per-core PM-QoS)

# Drop caches and compact memory:
echo 3 > /proc/sys/vm/drop_caches
echo 1 > /proc/sys/vm/compact_memory

# Launch:
chrt -f 80 ./trader --pin-feed=2 --pin-strategy=4 --pin-order=6
```

`chrt -f 80` runs the process with SCHED_FIFO real-time priority 80. Combined with isolcpus and nohz_full, the process sees no preemption.

### Verifying Pinning

```cpp
#include <sched.h>
#include <cstdio>

void check_pinning() {
    cpu_set_t set;
    CPU_ZERO(&set);
    sched_getaffinity(0, sizeof(set), &set);
    int n = 0, last = -1;
    for (int c = 0; c < CPU_SETSIZE; ++c) {
        if (CPU_ISSET(c, &set)) { ++n; last = c; }
    }
    int current = sched_getcpu();
    std::printf("affinity_size=%d running_on=%d\n", n, current);
}
```

In tests, assert that `n == 1` and `current` matches the expected CPU. Catching pinning regressions in CI saves debugging time.

```bash
# At runtime, inspect a process's threads and where they run:
ps -eLo pid,tid,psr,comm | grep your_process
# The PSR column is the current CPU.
```

### libfabric and HPC Affinity

For HPC workloads using MPI or libfabric, the framework usually handles pinning. Open MPI's `mpirun` accepts `--bind-to core` and `--map-by socket` to control placement. Slurm has similar `--cpu-bind` options. For C++ code that interfaces with these, querying the framework's view of pinning rather than re-pinning is the right move:

```cpp
// In Open MPI environment, the framework sets affinity before main().
// Just query and use it:
int my_cpu = sched_getcpu();
int my_node = numa_node_of_cpu(my_cpu);
```

### MPI Rank Pinning

A common pattern for an MPI application on a 2-socket 96-core box: 96 ranks total, one per physical core, pinned. Memory allocations follow first-touch on the rank's node.

```bash
mpirun --bind-to core --map-by socket -np 96 ./solver
```

`--map-by socket` round-robins ranks across sockets, which is what you want when the algorithm has even per-rank work. For algorithms with cross-rank communication, `--map-by node` keeps neighboring ranks on the same node so MPI shared-memory transports stay local.

### Hyperthreading Considerations

When you pin to a "core" using a CPU index, you are actually pinning to a hardware thread (SMT sibling). On Intel and AMD with SMT enabled, two CPU indices share a physical core (and L1, L2 caches).

For latency-critical workloads, prefer pinning only one of the two siblings and leaving the other idle (or using `isolcpus` to keep it out of scheduling). For throughput workloads, pin both and accept the contention on shared caches.

```bash
# Find sibling pairs:
for c in $(seq 0 $(nproc)); do
    echo "cpu$c thread_siblings: $(cat /sys/devices/system/cpu/cpu$c/topology/thread_siblings_list)"
done
```

### Junior to FAANG

A junior calls `sched_setaffinity` and ships. A FAANG engineer pins, configures `isolcpus`, sets the CPU governor, disables C-states, pins IRQs, and verifies all of it in CI before considering the work done.

### Senior at FAANG

Staff engineers treat the kernel boot config as part of the deployment artifact. Application code is not sufficient. The host must be prepared (`isolcpus`, `nohz_full`, governor, IRQ affinity), the application must respect that preparation, and monitoring must alert when any of it drifts.

---
