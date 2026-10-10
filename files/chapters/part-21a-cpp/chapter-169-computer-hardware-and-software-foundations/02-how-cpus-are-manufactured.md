## 02. How CPUs Are Manufactured

### From Sand to Silicon

Silicon is the second most abundant element in Earth's crust. It is also a semiconductor: at room temperature it barely conducts electricity, but with controlled impurities (dopants) added, it becomes the foundation for every transistor on every chip.

The manufacturing process begins with extremely pure silicon (99.9999999% pure, sometimes called "nine nines") extracted from silicon dioxide (sand), refined, and grown into large cylindrical ingots. A single crystal ingot is sliced into thin circular wafers, typically 300mm (about 12 inches) in diameter. Each wafer is polished to atomic-level flatness.

A single 300mm wafer is the raw material for hundreds of identical chips, called dies. The manufacturing process prints billions of transistors onto the wafer simultaneously using a technique called photolithography.

---

### Photolithography: Printing at Nanoscale

Photolithography works like a stencil and light. The wafer is coated with a light-sensitive chemical called photoresist. A mask (a patterned plate of quartz) is positioned above the wafer. Light shines through the mask, exposing the photoresist in specific patterns.

The exposed (or unexposed, depending on resist type) photoresist is then chemically removed. What remains is a pattern on the wafer surface. Etching then removes material from the unprotected areas, or doping implants impurities into specific regions to create N-type or P-type semiconductor zones.

This cycle repeats dozens of times per chip, building up layers:
1. Deposit material
2. Apply photoresist
3. Expose through mask
4. Develop (remove exposed resist)
5. Etch or implant
6. Strip remaining resist
7. Repeat for next layer

---

### EUV: The Light That Makes 7nm and Below Possible

For decades, photolithography used deep-ultraviolet (DUV) light at 193nm wavelength. As transistors shrank below 10nm, the wavelength of the light became a fundamental limitation. You cannot reliably print features smaller than roughly half the wavelength of your light source.

The industry's answer was Extreme Ultraviolet (EUV) lithography, operating at 13.5nm wavelength. The machines that produce EUV light, built by a Dutch company called ASML, cost roughly \$150-200 million each and weigh about 180 tons. They generate EUV light by firing a high-power laser at tiny tin droplets 50,000 times per second, producing plasma that emits EUV radiation.

EUV enables printing features at 7nm, 5nm, 3nm, and smaller process nodes. Without it, the current generation of chips that power your laptop, phone, and cloud servers would not be possible.

---

### What "3nm" Actually Means

The process node name (7nm, 5nm, 3nm, 2nm) is a marketing designation, not a literal physical measurement. A "3nm" transistor gate is not 3 nanometers wide.

The naming convention originated when it roughly corresponded to physical dimensions. That correspondence broke down around 10nm. Today, Samsung's "3nm" GAA process and TSMC's "3nm" FinFET process are quite different architecturally, but both use the 3nm label to indicate competitive density and performance.

What the number does usefully communicate:

- **Higher transistor density.** Smaller node = more transistors per square millimeter. TSMC's N3 delivers roughly 1.7x the density of N5.
- **Lower power at same performance.** Smaller transistors switch faster and at lower voltage.
- **Better performance at same power.** More transistors fit in the same thermal budget.

A rough guide to real numbers: Apple's M1 chip (5nm) has 16 billion transistors in a die area of about 120 mm². Apple's M3 (3nm) fits 25 billion transistors in approximately the same area.

---

### Doping: Creating P-Type and N-Type Regions

A pure silicon crystal does not conduct well. To create useful semiconductor behavior, dopant atoms are implanted into specific regions:

**N-type doping** (e.g., phosphorus, arsenic): adds extra electrons, making those regions electron-rich. Electrons are the charge carriers.

**P-type doping** (e.g., boron): creates "holes" (missing electrons) that act as positive charge carriers.

A FinFET transistor is built by creating precisely shaped N-type and P-type regions in the silicon fin, separated by the gate oxide. The manufacturing process controls doping profiles down to single atomic layers using ion implantation and diffusion steps.

---

### The Die, the Package, and the Board

After all photolithography and metallization steps are complete, the wafer goes through electrical testing. Each die is probed and tested. Failing dies are marked and discarded.

The wafer is then diced into individual chips. Each good die is packaged, which involves:

1. **Bonding** the die to an interposer or substrate (a tiny circuit board with thousands of connection pads).
2. **Wire bonding or flip-chip bonding** to connect the die's contact points to the package.
3. **Encapsulation** in epoxy or attaching a heat spreader (the metal lid you see on a CPU).

The finished package plugs into a socket on a motherboard via a Land Grid Array (LGA) or Ball Grid Array (BGA) of contacts, typically 1,000-4,000 pins for a high-end CPU.

---

### Yield: Why Chips Are Expensive

Not every die on a wafer is functional. Defects from dust, chemical impurities, or process variation kill some fraction of dies. The ratio of good dies to total dies is called yield.

Yield depends on die size and defect density:

```
Yield ≈ e^(-Defect_density × Die_area)
```

A larger die has more area for a defect to land on. This is why high-end desktop CPUs (large dies) are expensive and why chiplet designs (splitting one large die into multiple smaller dies) became attractive. TSMC and AMD's chiplet approach keeps individual dies small enough to achieve good yield while combining them into larger effective chips using advanced packaging.

---

### Practical Implications for Software Engineers

**Why frequency matters:** Smaller transistors switch faster and at lower voltage, allowing higher clock speeds without proportional power increase.

**Why power density is a wall:** As transistor density increases, heat per unit area increases. A modern CPU die dissipates roughly 100W in a thumbnail-sized area, about 100x more than a stove burner per unit area. Thermal throttling is a software-visible consequence of manufacturing physics.

**Why chiplets are the direction:** At 3nm and below, a large monolithic die has low yield and high cost. AMD's EPYC processors, Apple's M-series chips with their unified memory architecture, and Intel's Meteor Lake all use chiplets (or tiles) stitched together with high-bandwidth interconnects. As a systems programmer, this matters because inter-chiplet latency is higher than intra-die latency, which affects NUMA-like behavior even within a single chip package.

**Watch:** [The Engineering that Runs the Digital World: How do CPUs Work?](https://www.youtube.com/watch?v=16zrEPOsIcI)
