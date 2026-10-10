## 03. Computer Evolution and Moore's Law

### The ENIAC to Your Laptop: 80 Years of Change

The ENIAC, built in 1945, was the first general-purpose programmable electronic computer. It used 17,000 vacuum tubes, weighed 27 tons, occupied a full room, and could perform about 5,000 additions per second. It had no stored programs. Operators loaded new programs by manually rewiring patch panels.

By comparison, the Apple M1 chip contains 16 billion transistors, fits in a package smaller than a postage stamp, and executes roughly 3 trillion operations per second. That is a 600-million-fold increase in computation per second, and an even larger improvement in computation per watt and computation per dollar.

Understanding how that improvement happened, and why it is slowing down, tells you a great deal about where the industry is heading and what constraints your software runs under today.

---

### Eight Ages of Computer Evolution

The history of computing did not advance uniformly. Each era had a specific technological breakthrough driving the improvement:

**Age 1: Transistorization (1945-1962).** Replace unreliable vacuum tubes with solid-state transistors. Early transistors (germanium point-contact) were fragile. The breakthrough was reliable silicon planar transistors and, in 1963, the CMOS circuit using complementary N and P type MOSFETs.

**Age 2: Packaging Transistors (1964-1977).** Move from discrete transistors to Integrated Circuits (ICs). Small-Scale Integration (2-10 transistors), Medium-Scale Integration (10-500), Large-Scale Integration (500-20,000). The Intel 4004 (1971) was the first CPU on a chip: 2,300 transistors. The MOS 6502 (1975) at \$25 powered the Apple II, Atari, and NES.

**Age 3: The Frequency Race (1975-2000).** Once you have working ICs, the next lever is clock speed. Improvements in lithography and pipeline design pushed CPUs from 1MHz to 1GHz. The Intel 8086 (1978, 5MHz) to Pentium III (1999, 1GHz) era. The fetch-decode-execute pipeline ran faster and faster.

**Age 4: Multicore CPUs (2000-2011).** Clock speed hit a wall (explained below). The industry pivoted to putting multiple cores on one die.

**Age 5-6: FinFETs and GPUs (2011-2020).** The FinFET transistor broke through the planar scaling wall. GPUs grew from graphics accelerators to general-purpose parallel processors.

**Age 7-8: AI Chips and Beyond (2020-present).** Tensor Processing Units, custom AI ASICs, and the beginning of post-silicon approaches.

---

### Moore's Law: What It Actually Said

In 1965, Gordon Moore (co-founder of Intel) observed that the number of transistors on a chip had doubled every year since the IC was invented, and predicted this would continue. He later revised this to every two years. This became known as Moore's Law.

Moore's Law is an empirical observation, not a physical law. There is no theorem that says transistors must shrink on a predictable schedule. What Moore actually described was an economic and engineering observation: the industry was investing enough in process improvements that doubling roughly every two years was economically rational.

The observation was accurate from the 1960s through roughly 2015. During that time, the number of transistors on a chip did approximately double every 18-24 months. This gave programmers a free performance lunch: the same code ran twice as fast every two years with no changes.

That free lunch is largely over.

---

### Dennard Scaling: Why Clock Speeds Stopped

Through the 1980s and 1990s, transistor shrinkage came with a bonus: Dennard Scaling. As transistors shrank, they required less voltage, switched faster, and used less power. Shrink by a factor of 2 in linear dimensions, and you got 4x more transistors in the same area, each running at higher frequency with the same power budget. Performance scaled with transistor count and clock frequency simultaneously.

Dennard Scaling broke down around 2004-2005. The problem: as gate oxide thickness approached just a few atomic layers, quantum tunneling caused leakage current regardless of gate voltage. The transistor could not be fully turned off. Even at rest, current leaked through. Power dissipation became dominated by this static leakage, not just dynamic switching.

The result: you could not keep raising clock speed without the chip overheating. Intel's Pentium 4 "Netburst" architecture was designed for 10GHz+ operation. It shipped at 3.8GHz and throttled heavily. The architecture was abandoned. The industry shifted to the Core architecture with more modest clocks and more efficient pipelines.

Today, most desktop CPUs run at 3.5-5.5GHz, roughly where they were in 2004, with headroom gained through better boost algorithms and better cooling, not fundamental voltage reduction.

---

### The Multicore Pivot

If you cannot make one core faster, put more cores on the die. This was the strategy from roughly 2005 onward. Intel's Core 2 Duo (2006) put two cores on one die. By 2023, consumer desktop chips have 8-24 cores, server chips have 64-128 cores.

The catch: adding cores does not automatically make a single sequential program faster. Amdahl's Law: if 95% of your program is parallelizable and 5% is sequential, adding infinite cores gives you at most a 20x speedup. The sequential 5% becomes the bottleneck.

This is why Go's goroutine model and the `runtime.GOMAXPROCS` setting matter. Go can schedule goroutines across all available cores. But if your application has a hot sequential path (a single mutex protecting shared state, a single-threaded logger, a serialized database connection pool), more cores do not help that path.

---

### What Comes After Silicon

Several approaches are being deployed now or in the next few years:

**3D Stacking.** Instead of shrinking transistors further in two dimensions, stack multiple die vertically with high-density interconnects. AMD's V-Cache products stack SRAM directly on top of CPU cores, dramatically increasing cache capacity. Intel's Foveros packaging does similar things. The latency between stacked layers is lower than between separate chips on a board.

**CXL (Compute Express Link).** A new interconnect standard built on PCIe that allows CPUs, GPUs, memory expanders, and other accelerators to share a coherent memory space with lower latency than traditional NUMA. CXL enables memory pooling and disaggregation in data centers, which will affect how Go programs reason about memory locality in cloud environments.

**Photonics.** Using light instead of electrons for on-chip interconnects to reduce latency and power in communication between cores or between chiplets. Silicon photonics is being used now in data center networking and is beginning to appear in chip-to-chip communication. On-chip optical interconnects remain a research area.

**Neuromorphic and Quantum.** Neuromorphic chips model neural computation and are useful for specific AI workloads with very low power. Quantum computers use qubits instead of classical bits and are useful for certain mathematical problems (optimization, cryptography). Neither is a general replacement for classical CPUs in the near term.

---

### The Practical Takeaway for Go Programmers

Moore's Law in its original form is over. You will not get free performance by waiting two years and doing nothing. Performance gains now come from:

1. Using more cores (goroutines, `GOMAXPROCS`, parallel algorithms).
2. Using specialized hardware (GPU offload via CGo or gRPC to a GPU service, SIMD instructions exposed through assembly or compiler autovectorization).
3. Fitting more work into cache (data layout, struct packing, reducing pointer indirection).
4. Reducing synchronization overhead (lock-free data structures, sharding, per-CPU data).

The programs that run well on modern hardware are the ones whose authors understood that the hardware is wide, cache-sensitive, and thermally constrained.

**Watch:** [The Incredible Evolution of Computers](https://www.youtube.com/watch?v=aa6YISbAJEA)
