## 01. How Transistors Work: From Switch to CPU

### The Transistor Is an Electronic Switch

A transistor is not a mechanical relay. Nothing moves. It is a semiconductor device that controls whether current can flow between two points based on a voltage signal at a third point. The specific variant used in every modern CPU and GPU is the MOSFET, Metal-Oxide-Semiconductor Field-Effect Transistor.

The three terminals of a MOSFET are called the **gate**, the **source**, and the **drain**. The channel connects source to drain. The gate voltage controls whether that channel conducts.

```
        Gate (G)
          |
     [dielectric]
Source ---[channel]--- Drain
  (S)                  (D)
```

When you apply voltage to the gate, an electric field forms across the dielectric (a thin insulating layer). That field either attracts or repels charge carriers in the channel, turning it on or off. No mechanical contact. No moving parts. Just voltage controlling conductivity.

---

### N-Type and P-Type: Two Complementary Behaviors

Modern CPUs use two types of MOSFETs that behave in opposite ways:

**N-type (NMOS):**
- Gate = 1V (high): channel conducts, current flows. Switch is ON.
- Gate = 0V (low): channel does not conduct. Switch is OFF.

**P-type (PMOS):**
- Gate = 0V (low): channel conducts. Switch is ON.
- Gate = 1V (high): channel does not conduct. Switch is OFF.

P-type is the complement of N-type. Connect them together with a shared gate input, and they always operate in opposite states. One is always ON, the other always OFF. This is the foundation of CMOS: Complementary Metal-Oxide-Semiconductor.

CMOS is power-efficient because, in the steady state, one transistor in each pair blocks current. No direct path from the power rail to ground exists during stable logic levels. Current only flows briefly during the transition between states.

---

### Two Transistors Make an Inverter

Connect one N-type and one P-type transistor with a shared gate, a power rail (1V) above, and a ground rail (0V) below:

```
      VDD (1V)
        |
    [P-type]
        |--- Output
    [N-type]
        |
      GND (0V)
```

When input (gate) = 1:
- N-type turns ON, connecting output to GND. Output = 0.
- P-type turns OFF.

When input (gate) = 0:
- P-type turns ON, connecting output to VDD. Output = 1.
- N-type turns OFF.

This is an inverter, also called a NOT gate. Input 1 becomes output 0 and vice versa. Two transistors, one useful logical operation.

---

### Four Transistors Make a NAND Gate

A NAND gate is NOT(A AND B). It outputs 0 only when both inputs are 1. Otherwise it outputs 1.

```
        VDD
       /    \
   [P-A]  [P-B]   <- P-types in parallel
       \    /
        |
       Out
        |
     [N-A]         <- N-types in series
        |
     [N-B]
        |
       GND
```

The two P-types are in parallel: if either input is 0, one P-type conducts, pulling output to VDD (output = 1). The two N-types are in series: both must conduct simultaneously for output to reach GND (output = 0), which only happens when both inputs are 1.

Truth table:

| A | B | Output |
|---|---|--------|
| 0 | 0 | 1 |
| 0 | 1 | 1 |
| 1 | 0 | 1 |
| 1 | 1 | 0 |

The NAND gate is functionally complete: any logic function can be built from NAND gates alone. In practice, CPUs use a library of standard cells (inverters, NAND, NOR, AND, OR, XOR) for efficiency. But knowing NAND is universal helps you see why the NAND gate gets so much attention in computer science courses.

---

### Standard Cells: The Lego Bricks of CPU Design

A standard cell is a physical implementation of a logic gate that has been designed, verified, and characterized for a particular manufacturing process. Engineers who design CPUs do not draw individual transistors by hand. They work at the level of standard cells from a pre-verified library.

**Scale of composition:**

| Level | Components | Example |
|-------|-----------|---------|
| Transistor | 1 | NFET or PFET |
| Standard cell | 2-10 transistors | Inverter (2), NAND (4), XOR (10) |
| Macrocell | ~100-6,000 cells | 32-bit adder (~160 cells), 32-bit multiplier (~6,100 cells) |
| Functional unit | Many macrocells | ALU, cache controller |
| Core | Many functional units | One CPU core |
| Die | Multiple cores + shared cache + I/O | Apple M1 chip |

The 32-bit multiplier with 6,100 standard cells takes roughly 150-200 picoseconds to produce a result. Each individual cell transition takes a few picoseconds. Billions of these operations happen every second.

---

### Modern Transistors: FinFETs

The planar MOSFET from the 1960s eventually hit a scaling wall. As transistors shrank below about 25nm, the gate could no longer reliably control the channel. Current leaked through even when the gate said "off."

The solution was the FinFET, introduced commercially around 2011 (Intel, 22nm process). Instead of a flat channel, the semiconductor is shaped into a thin vertical fin. The gate wraps around three sides of the fin, giving it much better electrostatic control.

```
         Gate
      _____|_____
     |     |     |
     |   [fin]   |   <- gate wraps 3 sides
     |___________|
         fin (the channel runs through this)
```

Today's transistors at "3nm" and below (the names are marketing, not literal measurements) use variations of the Gate-All-Around (GAA) structure where the gate surrounds the channel on all four sides, providing even tighter control as dimensions shrink further.

---

### The Interconnect Labyrinth

Transistors alone do nothing useful without wiring. A modern CPU die has around 15-17 layers of metal wiring above the transistors. These metal layers are connected by vertical vias. The total length of wiring in a modern high-end chip runs to tens of kilometers, compressed into a die roughly the size of a thumbnail.

The wiring layers closer to the transistors (M1, M2) are thin and dense, used for local connections within standard cells. Higher layers are thicker and used for power distribution and long-distance signals across the die.

The physical complexity of this interconnect is one reason why a chip design can have 16 billion transistors but still take 3-5 years to design, verify, and manufacture.

---

### The Key Takeaway for Software Engineers

When your Go program performs a 64-bit integer addition, that operation flows through an ALU built from thousands of standard cells, each implemented with 2-10 transistors, completing in one or two clock cycles. A 3GHz clock cycle is about 333 picoseconds. The ALU finishes in roughly that time because the designers carefully timed the propagation delays through the transistor chain.

When you write code that causes branch mispredictions, you are disrupting the pipeline that keeps those transistors fed with useful work. When you access unaligned memory, you may cause two separate cache line loads where one would suffice. The transistors are fast. It is the system around them that you need to optimize for.

**Watch:** [How do Transistors Build into a CPU?](https://www.youtube.com/watch?v=_Pqfjer8-O4)
