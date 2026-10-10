## 18. Real-World NUMA Tuning Case Studies

Theory is the foundation. The cases below are simplified composites of real production tuning episodes. Each one moves from a symptom (latency spike, throughput plateau, regression after upgrade) to a hardware-level diagnosis to a fix.

### Case 1: Query Engine, Dual Socket vs Quad Socket

A column-store analytics engine performed at 1.2 million rows/sec/core on a dual-socket Skylake-SP. When migrated to a quad-socket platform of the same generation, expected throughput was 4 sockets / 2 sockets * baseline = 2x. Actual throughput was 1.4x.

Diagnosis:

- `numactl --hardware` showed 4 nodes with distance matrix [10, 21, 31, 31] for any node.
- Most allocations went to node 0 (the bootstrap node).
- `perf stat` showed 60 percent of LLC misses going to remote DRAM, with substantial traffic on UPI links between nodes 0 and 2/3.
- The query scheduler did not consider node distance when assigning fragments to threads.

Fix:

1. Parallelize columnar segment loading: each segment is loaded by a thread pinned to its target node.
2. Schedule query fragments to threads on the node where the segment lives.
3. For cross-node aggregation steps, batch the cross-node transfer into one large copy rather than many small RPCs.

Outcome: throughput moved to 1.85x dual-socket. The remaining gap was inherent to the workload (some queries spanned all data and required cross-node movement).

Lesson: scaling from 2 to 4 sockets is not free. The algorithm must be aware of the topology, or the extra hardware is wasted.

### Case 2: ClickHouse NUMA Settings

ClickHouse on dual-socket EPYC 9654 (NPS=1) showed inconsistent latency for analytic queries. Some queries hit p99 of 200 ms, others 400 ms, on the same data and same query.

Diagnosis: ClickHouse's query thread pool created threads on whichever socket the dispatcher ran on. Half the queries had their worker threads on the wrong socket relative to the data.

Fix: configure `numa_balancing=0`, set NPS=4 in BIOS to expose the chiplets as separate NUMA nodes (doubling locality opportunity), and tune ClickHouse with:

```xml
<numa>
    <interleaving>0</interleaving>
    <pin_threads_to_numa_node>1</pin_threads_to_numa_node>
</numa>
```

Some ClickHouse versions also benefit from `MPOL_INTERLEAVE` for the merge tree storage:

```bash
numactl --interleave=all clickhouse-server
```

This is appropriate for analytics workloads that scan large fractions of data and benefit from aggregate bandwidth.

Outcome: p99 dropped to 220 ms across the board. Lower variance.

Lesson: a single global config is rarely right. NPS=4 with explicit pinning beat NPS=1 with `interleave=all` for this workload, because the queries had locality the storage engine could exploit.

### Case 3: Database Connection Pool NUMA Pinning

A multi-tenant database service running on a 4-socket box used a single connection pool shared across all sockets. Connection thread affinity was random. Per-connection state (parsing buffers, plan caches) lived wherever the connection was first created.

Symptom: p99 latency was 3x p50.

Diagnosis: `perf c2c` showed cross-socket HITM hot lines in the plan cache. The plan cache was a single shared structure, threads on socket A reading entries written by threads on socket B caused the line to bounce.

Fix:

1. Per-socket plan caches with eventual consistency. A miss on the local cache falls back to a global cache (rare path).
2. Connection assignment routes to a worker on the socket of the listening port (different ports for different sockets).
3. Connection state (allocators, buffers) allocated on the worker's node.

Outcome: p99/p50 ratio moved from 3 to 1.4. Total throughput up 25 percent.

Lesson: connection-level state needs to follow the connection. A global structure invites cross-socket traffic.

### Case 4: Cloudflare-Style Network IRQ Affinity

A CDN edge server running NGINX on dual-socket showed asymmetric load: socket 0 was at 90 percent CPU, socket 1 at 30 percent. Throughput was much lower than expected.

Diagnosis: the NIC was on socket 0's PCIe slot. All RX queue interrupts fired on socket 0 cores. NGINX worker processes on socket 1 received connections only after socket 0 workers were full.

Fix: a hybrid approach used by Cloudflare and others:

1. Pin NIC RX queues across all CPUs of socket 0 (the NIC's home node).
2. Run only socket 0 workers for connections handled directly. Socket 1 hosts other services.

Or, on dual-NIC systems:

1. Two NICs, one on each socket's PCIe.
2. RX queues of NIC 0 pinned to socket 0, same for NIC 1 / socket 1.
3. NGINX workers per socket bind to the local NIC's listening sockets.

Outcome: total throughput doubled. Both sockets used.

Cloudflare published a blog on this exact pattern (pinning IRQs to specific cores, then aligning userspace workers).

Lesson: on multi-socket network workloads, follow the NIC topology. The NIC's NUMA node is not a suggestion.

### Case 5: Aerospike Configuration

Aerospike (a memory-resident key-value store) ships with explicit NUMA tuning options. A typical 4-socket production config:

```
service {
    paxos-single-replica-limit 1
    proto-fd-max 15000
    auto-pin numa
}
namespace test {
    replication-factor 2
    storage-engine memory {
        data-size 256G
    }
    index-type shmem
}
```

The `auto-pin numa` setting causes Aerospike to detect the topology, partition data across nodes, and pin threads accordingly. With this setting, Aerospike on a 4-socket machine performs roughly linearly better than the same workload on a 1-socket machine.

Without `auto-pin`, scaling falls off past 2 sockets due to cross-socket index access.

Lesson: production systems built for high throughput often expose NUMA settings in their config. Read the config docs first, do not assume defaults are right for your hardware.

### Case 6: Linux Kernel Network Stack and NUMA

Even the kernel network stack has NUMA settings. By default, the kernel allocates skb (socket buffer) memory on the node where the packet is received (RX queue's node). If the application thread reads from a different node, every packet is remote.

```bash
# RPS (Receive Packet Steering): distributes packets to specific cores
echo "1f" > /sys/class/net/eth0/queues/rx-0/rps_cpus

# RFS (Receive Flow Steering): steers based on flow hashing
echo 32768 > /proc/sys/net/core/rps_sock_flow_entries
echo 4096 > /sys/class/net/eth0/queues/rx-0/rps_flow_cnt

# Set IRQ affinity to NIC's NUMA node:
NUMA_CPUS=$(cat /sys/class/net/eth0/device/local_cpulist)
for irq in $(grep eth0 /proc/interrupts | awk '{print $1}' | sed 's/://'); do
    echo $NUMA_CPUS > /proc/irq/$irq/smp_affinity_list
done
```

Modern NICs (Mellanox/NVIDIA ConnectX-5+, Intel E810) have many RX queues. Configure them to spread across the NIC's NUMA cores, and pin application workers to consume from queues on their own NUMA node.

### A Pattern: The NUMA Tuning Checklist

For any latency-critical service on multi-socket hardware:

1. Confirm NUMA topology with `numactl --hardware` and `lstopo`.
2. Identify NIC, NVMe, and accelerator NUMA placement.
3. Disable AutoNUMA balancing.
4. Set hugepages (2M or 1G) per node, with reservations.
5. Configure THP to `madvise` or `never`.
6. Pin worker threads with `sched_setaffinity` after thread creation.
7. Allocate per-thread state with `numa_alloc_onnode`.
8. Pin IRQs to the NIC's local cores.
9. Use `chrt -f` for real-time priority on critical threads.
10. Set CPU governor to `performance`, disable deep C-states on critical cores.
11. Configure malloc to retain memory (avoid TLB shootdowns).
12. Validate placement with `/proc/PID/numa_maps`.
13. Monitor remote DRAM ratio in production.

This is the production checklist. Skipping any item leaves performance on the table.

### Junior to FAANG

A junior reads the config docs and turns on every "NUMA" setting they find. A FAANG engineer measures, identifies the specific bottleneck (compute, memory, IRQ, allocation), and applies the targeted fix.

### Senior at FAANG

Staff engineers convert these cases into runbooks and dashboards. Every production service has a "is this NUMA-correctly deployed" check that runs at startup and alerts in monitoring. The runbook is the institutional memory, without it, every team relearns the same lessons.

---
