## 20. Future Trends

NUMA is not going away. It is mutating. The two-socket box was simple. The chiplet-based, CXL-attached, GPU-coherent box of 2026 is not. The trends below are visible now and will dominate hardware-aware C++ for the next five years.

### Chiplet Integration

AMD pioneered chiplets at scale. EPYC has 8 to 16 CCDs plus an IO die, all connected via Infinity Fabric. Intel followed with tiled designs in Sapphire Rapids and Granite Rapids. The era of monolithic dies for high-end server parts is over.

Implications:

- Even a single socket has internal NUMA-like behavior. Cross-CCD on EPYC is closer to cross-socket on a monolithic part than to same-die.
- BIOS settings (NPS=1/2/4 on AMD, sub-NUMA clustering on Intel) let you expose the chiplets as separate NUMA nodes. The right setting is workload-dependent.
- The number of "NUMA nodes" your code might see on a single socket can be 4 or 8. Hardcoding "two nodes" is wrong.

### Larger Coherence Domains

Apple Silicon Ultra parts (M1 Ultra, M2 Ultra, presumed M3/M4 Ultra) connect two dies with UltraFusion at ~2.5 TB/s. The result is a single large coherent system from the programmer's view, but with measurable cross-die latency. NVIDIA Grace and Grace Hopper similarly use NVLink-C2C for chip-to-chip coherence at hundreds of GB/s.

Implication: the line between "single socket" and "multi-socket" blurs. Within one package you can have multiple coherence regions, each with its own DRAM controllers.

### CXL 3.0 Fabric Memory

CXL 3.0 (PCIe 6.0 physical layer, mature in 2025-2026 hardware) introduces switched fabrics. Multiple hosts can share a coherent memory pool through a CXL switch. Memory pooling at the rack level becomes practical: a rack-scale machine with 100 TB of shared DRAM, dynamically allocated to hosts on demand.

For C++ allocator design, this means new tiers in the hierarchy:

- Local DRAM (50-100 ns)
- Local CXL DRAM (150-300 ns)
- Pooled fabric DRAM (300-600 ns, depends on switch and topology)
- (Far future) Disaggregated memory across racks

The allocator must classify allocations into the right tier. Static placement may not be enough, dynamic promotion/demotion based on access frequency is the direction.

### GPU-CPU Unified Memory

Grace Hopper (NVIDIA): Grace ARM CPU and Hopper H100 GPU share a 900 GB/s NVLink-C2C, with a unified memory address space. Allocations made on the CPU are accessible from the GPU and vice versa, with the runtime handling page migration.

MI300A (AMD): Zen 4 CPU cores and CDNA 3 GPU compute units in one package, sharing HBM3 memory. Even tighter integration.

For C++ in 2026:

- `cudaMallocManaged` and ROCm's HIP equivalent become the dominant allocation API for hybrid CPU/GPU workloads.
- The "where does this memory live" question becomes "where is it being accessed from", and the runtime answers in real time.
- Latency tiers expand: L1 cache, L2 cache, GPU L2, GPU SM-shared, HBM, host DRAM, CXL.

### Heterogeneous Compute

A single server in 2026 may have:

- 96 to 192 CPU cores across 2 sockets (Zen 5, Granite Rapids).
- 1 to 8 GPUs (H100, B200, MI300X), each with 80 to 192 GB HBM.
- A smartNIC with its own ARM cores and 16 to 64 GB DRAM.
- A DPU (Bluefield-3, Pensando) for offload.
- 1 to 4 TB of CXL DRAM.

C++ code that interacts with this stack needs to treat memory placement as a first-class concern, not an afterthought. The std::pmr ecosystem is the right vocabulary, the implementations need to evolve to handle 5+ tiers.

### Is NUMA Going Away?

Counterintuitively, no. The opposite. The number of distinct memory regions per machine is increasing, not decreasing. The "uniform memory" model never came back, instead, the granularity of non-uniformity got finer:

- 2010: 2-socket NUMA. 2 nodes.
- 2018: 8-socket NUMA. 8 nodes.
- 2024: 2-socket NUMA with sub-NUMA. 8 to 16 nodes.
- 2026: 2-socket + CXL + GPU + smartNIC. 20+ memory regions.

Code written assuming "memory is just memory" performs progressively worse with each generation. Code written with explicit topology awareness adapts.

### Programming Models on the Horizon

- **C++26 std::execution**: structured concurrency with execution context awareness. NUMA-aware schedulers can plug in.
- **C++26 std::pmr extensions**: tier-aware memory resources are being discussed.
- **Sender/receiver model**: explicit work placement on specific schedulers, including per-NUMA schedulers.
- **Heterogeneous SYCL / oneAPI**: cross-CPU/GPU/accelerator C++ with placement semantics.
- **Mojo and other new languages**: explicit memory hierarchy in the type system.

The trend in language design is toward making placement explicit rather than hiding it. C++ has always exposed it. The new languages are catching up to where C++ has been.

### What to Bet On

A C++ engineer building infrastructure that needs to last to 2030 should:

1. Treat memory placement as part of the data structure design, not as a deployment concern.
2. Use `std::pmr` for everything that allocates more than a few KB. Inject the resource at the boundary.
3. Build an internal topology library that abstracts numactl/hwloc/CUDA/ROCm/CXL APIs into a single map.
4. Avoid global mutable state. Per-node, per-shard, per-tier from the start.
5. Treat AutoNUMA, automatic tiering, and runtime placement as advisory. Provide explicit overrides.
6. Benchmark on the actual hardware target, including chiplet variants and sub-NUMA modes.

Code that follows these principles tends to age well. Code that does not tends to require a rewrite at the next hardware generation.

### Junior to FAANG

A junior plans for "the hardware we have today". A FAANG engineer plans for the hardware that will arrive while the code is in production, two to five years out.

### Senior at FAANG

Staff engineers participate in standardization, both internal and external. The std::pmr extensions, the CXL software interfaces, and the placement semantics in std::execution are being shaped now by engineers from Google, Meta, NVIDIA, Intel, and AMD. The gap between "user of the standard" and "shaper of the standard" is what defines staff-level impact.

---
