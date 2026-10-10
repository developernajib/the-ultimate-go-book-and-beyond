## 11. Microchip Manufacturing

### From Design to Silicon

A CPU starts as a logical design: engineers specify the ISA, design the microarchitecture, and use hardware description languages (VHDL, Verilog, SystemVerilog) to describe the circuit at the register-transfer level. Synthesis tools convert this to a netlist, a description of transistors and their connections. Place-and-route tools arrange the transistors on a chip layout.

The output is a set of photomasks: stencils that define patterns for each layer of the chip.

---

### Photolithography

The core of chip manufacturing is photolithography. A silicon wafer is coated with photoresist, a light-sensitive material. A mask is placed above the wafer and light is shone through it. Where the light hits, the photoresist hardens or softens (depending on type). The unexposed photoresist is washed away, leaving a pattern.

The exposed silicon is then etched, doped, or covered with metal. The process repeats for each layer of the chip. A modern CPU has dozens of layers.

The minimum feature size (the smallest pattern that can be printed) is limited by the wavelength of the light. Shorter wavelengths produce sharper patterns and smaller features.

---

### EUV Lithography

Extreme Ultraviolet (EUV) lithography uses light at 13.5 nanometer wavelength, produced by blasting tin droplets with a laser to create plasma. This is far shorter than the 193nm light used in earlier generations.

EUV allows feature sizes below 10nm, enabling billions of transistors on a chip the size of a thumbnail. ASML (a Dutch company) is currently the only manufacturer of EUV lithography machines. Each machine costs over \$150 million and takes a year to build.

The practical implications:

- TSMC and Samsung use EUV for their leading-edge nodes (5nm, 3nm, 2nm)
- Intel also uses EUV for its most recent process nodes
- Access to EUV machines is a chokepoint in semiconductor manufacturing capacity
- Export restrictions on EUV machines to specific countries directly limit their ability to produce advanced chips

---

### Transistor Density and Moore's Law

Gordon Moore observed in 1965 that the number of transistors on a chip doubled roughly every two years. This was not a law of physics, it was an observation about the economics and engineering pace of the semiconductor industry.

Moore's Law held remarkably well through the 2000s. It has been slowing since 2015 as physical limits of lithography and transistor design become harder to overcome.

Modern figures:
- Apple M3 (3nm TSMC): ~25 billion transistors
- NVIDIA H100 (4nm TSMC): ~80 billion transistors
- Intel Core Ultra (Intel 4 node): ~30-60 billion transistors depending on die

As transistor density increases, individual transistors become smaller but do not run faster. Clock speeds plateaued around 2004 at 3-5 GHz. Heat dissipation became the limiting factor, more power into a smaller area produces more heat than cooling systems can remove. This is why CPU performance improvements since 2004 have come from more cores, wider execution units, and deeper caches, not higher clock speeds.

---

### What This Means for Software

The physical constraints of chip manufacturing directly shape the software problems this chapter discusses:

- **Memory hierarchy:** Cache sizes are expensive in die area. You get kilobytes of L1 cache, megabytes of L2/L3, and gigabytes of RAM. Cache misses are slow because physically reaching DRAM requires going off-chip.

- **Core count vs clock speed:** Adding cores is easier than raising clock speed. Parallel software extracts the performance that single-threaded software cannot reach.

- **Power management:** CPUs throttle clock speed to stay within thermal limits. A CPU running at full load may run slower than its rated frequency if the cooler is insufficient. Performance-sensitive code that runs long may run at lower effective frequency than benchmarks suggest.

- **ARM's power advantage:** Smaller, simpler cores at lower voltages consume less power per instruction. This is why battery-powered devices use ARM. As cloud providers pay enormous electricity bills, ARM's power efficiency is driving migration in data centers too.

---

**Watch:** [How Microchips Are Made. CPU Manufacturing Steps](https://www.youtube.com/watch?v=d9SWNLZvA8g)

---

| [◀ Chapter 167: How Computer Memory Works Under the Hood](../chapter-167-memory-architecture-deep-dive/00-introduction.md) | [Chapter 168: CPU and OS Concurrency Foundations](00-introduction.md) | [Chapter 169: Computer Hardware and Software Foundations](../chapter-169-computer-hardware-and-software-foundations/00-introduction.md) ▶ |

