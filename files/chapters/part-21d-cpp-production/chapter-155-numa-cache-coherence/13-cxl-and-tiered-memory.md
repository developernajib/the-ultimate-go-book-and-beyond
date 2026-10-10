## 13. CXL and Tiered Memory

CXL (Compute Express Link) is the most disruptive change to server memory in two decades. It runs on PCIe physical layer (CXL 1.1 and 2.0 on PCIe 5.0, CXL 3.0 on PCIe 6.0) and adds three protocols: CXL.io (PCIe-equivalent), CXL.cache (host coherent access to device memory), and CXL.mem (memory expansion). The combination lets you attach DRAM to the CPU through PCIe slots, and lets accelerators participate in the coherence protocol.

### What CXL Looks Like to the OS

A CXL.mem device appears as a NUMA node with no CPUs. `numactl --hardware` shows it as a memory-only node, distance 30 to 40 from local CPUs. Linux kernels 5.18+ have basic CXL support. Kernels 6.x have improvements for CXL hotplug, RAS, and tiering.

```
available: 3 nodes (0-2)
node 0 cpus: 0 1 2 ...
node 0 size: 256 GB
node 1 cpus: 96 97 98 ...
node 1 size: 256 GB
node 2 cpus:                    <-- no CPUs
node 2 size: 1024 GB             <-- 1 TB CXL memory
node distances:
node   0   1   2
  0:  10  21  30
  1:  21  10  30
  2:  30  30  10
```

### Latency and Bandwidth Profile

| Memory Tier | Typical Latency | Typical Bandwidth |
|---|---|---|
| Local DRAM | 80-100 ns | 200-400 GB/s per socket |
| Remote socket DRAM | 130-200 ns | 60-120 GB/s cross-socket |
| CXL DRAM (CXL 2.0) | 170-300 ns | 32 GB/s per x16 link |
| CXL.mem fabric (CXL 3.0) | 250-400 ns | 64 GB/s per x16 link, switched |
| Persistent memory (legacy Optane DCPMM) | 200-400 ns | 8-40 GB/s |

CXL DRAM is roughly between local-socket DRAM and remote-socket DRAM in latency, with bandwidth limited by the PCIe link. Per-link bandwidth on PCIe 5.0 x16 is 64 GB/s nominal, around 50 GB/s practical.

### Tiered Memory Hierarchy

A modern server may have:

1. Local DRAM (hot tier)
2. Remote socket DRAM (warm tier, accessed cross-socket)
3. CXL.mem (cold tier, large capacity)
4. (Future) Pooled CXL fabric memory shared across hosts

Linux's transparent tiering (kernel 6.1+, with `kmemtier` or `memtierd` user-space daemon) promotes hot pages from cold tiers to fast tiers and demotes cold pages downward. The mechanism reuses the AutoNUMA scanning infrastructure, repurposed for tier selection.

```bash
# Check available tiers:
ls /sys/devices/virtual/memory_tiering/

# memtierd userspace daemon (development tool from Intel):
memtierd --config /etc/memtierd.yaml
```

For a service that does not need automatic tiering, you allocate explicitly per tier:

```cpp
// Hot data on local DRAM:
void* hot = numa_alloc_onnode(hot_size, local_node);

// Cold data on CXL node:
void* cold = numa_alloc_onnode(cold_size, cxl_node);
```

### CXL.cache vs CXL.mem

- **CXL.mem**: the host treats device memory as just another NUMA node. The device does not participate in the host's coherence, the host controls coherence on its side.
- **CXL.cache**: an accelerator (FPGA, smartNIC, GPU) becomes a peer in the host's coherence domain. The accelerator can cache host memory coherently, and the host can cache accelerator memory.

CXL.cache is the more transformative protocol. It enables coherent host-accelerator interactions without explicit DMA, similar to how CPU caches interact today. Production CXL.cache devices are starting to appear (some smartNICs, FPGA boards). Coherent GPU memory remains mostly NVLink-based today (Grace Hopper, MI300A), with CXL adoption forthcoming.

### C++ Allocator Design for Tiered Memory

A tier-aware allocator exposes hints:

```cpp
enum class MemoryTier { Hot, Warm, Cold };

class TieredAllocator {
public:
    void* alloc(size_t bytes, MemoryTier tier) {
        int node = node_for_tier(tier);
        return numa_alloc_onnode(bytes, node);
    }
    void free(void* p, size_t bytes) {
        numa_free(p, bytes);
    }
    // Promote/demote hooks for explicit migration:
    void promote(void* p, size_t bytes) {
        migrate_pages_to(p, bytes, hot_node_);
    }
    void demote(void* p, size_t bytes) {
        migrate_pages_to(p, bytes, cold_node_);
    }
private:
    int hot_node_, warm_node_, cold_node_;
    int node_for_tier(MemoryTier t) const { /* ... */ }
};
```

For a buffer pool, place hot pages on local DRAM, less frequently accessed pages on CXL. Track access frequency in a clock-style counter and migrate periodically.

### A Persistent Memory Note

Intel Optane DCPMM (DC Persistent Memory) was the previous attempt at tiered memory. Optane was discontinued in 2022. The PMDK (Persistent Memory Development Kit) and `libpmem` API were the C++ ecosystem around it. Most of that code is now deprecated for new work.

The lesson from Optane: applications that explicitly distinguished between hot DRAM and cold persistent memory beat applications that used a transparent tiering daemon. Explicit placement won. CXL is likely to follow the same pattern: explicit hot/warm/cold allocation in the application beats automatic tiering for performance-critical paths.

### When CXL Is Worth It

- Memory-bound workloads where capacity is the bottleneck. ML inference with very large models, in-memory analytics over multi-terabyte datasets.
- Workloads that can tolerate 200 ns memory latency on a fraction of accesses. A vector search engine that hits CXL on 10 percent of queries can absorb the latency in the 90 percent that hit local.

### When CXL Is Not Worth It

- Latency-critical OLTP. The 200 ns floor is too high.
- HFT. Out of the question.
- Memory-bandwidth-bound workloads at saturation. CXL adds capacity but adds bandwidth more slowly per dollar than adding DRAM channels.

### Grace Hopper, MI300A, and Unified CPU-GPU Memory

NVIDIA's Grace Hopper Superchip (Grace CPU + Hopper GPU on the same package, 900 GB/s NVLink-C2C) and AMD's MI300A (Zen 4 CPUs + CDNA3 GPUs in one package) blur the CPU-GPU memory boundary. From a C++ perspective, these systems present a unified address space where both CPU and GPU can access the same allocations. NUMA-style awareness still applies: data should be placed near the device that accesses it most.

NVIDIA's `cudaMallocManaged` and `__nv_bfloat16` interactions with this unified memory follow rules similar to traditional NUMA: first-touch by the accessing device, with hints to prefer placement.

### Junior to FAANG

A junior treats all memory as equally fast. A FAANG engineer queries the topology, identifies CXL nodes, and picks a placement strategy that respects bandwidth and latency tiers.

### Senior at FAANG

Staff engineers design the data structures with tiering as an axis. A buffer pool that supports promotion/demotion natively can absorb a CXL deployment without code changes. A buffer pool that hardcodes "all memory is the same" requires a rewrite. The bet on which tier to optimize for is a multi-year capacity-planning decision, not a tactical optimization.

---
