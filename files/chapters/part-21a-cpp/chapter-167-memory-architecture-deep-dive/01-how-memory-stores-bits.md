## 01. How Memory Stores Bits: Transistors, SRAM, and DRAM

Before examining performance characteristics, you need to know what is physically happening when a bit is stored. The answer involves two components that appear throughout all of computer hardware: the transistor and the capacitor.

### The Transistor as a Switch

A transistor is a semiconductor device with three terminals: gate, source, and drain. Apply a voltage to the gate and current flows from source to drain. Remove that voltage and current stops. This is a switch, and it is the fundamental binary element of all digital logic.

The specific variant used in modern memory chips is the MOSFET (Metal-Oxide-Semiconductor Field-Effect Transistor). MOSFETs are suited to miniaturization. At the 5nm process node, billions fit on a fingernail-sized die.

A transistor alone does not remember anything. If you remove power, the state is gone. To build memory you need the transistor to either hold its state through feedback, or to control access to a device that stores charge.

### Building Memory from Feedback: The Latch

The simplest memory cell uses feedback. Take an OR gate and connect its output back to one of its inputs. Once that output is driven to 1 by an external input, the feedback keeps it at 1 even after the external input goes away. The circuit is stuck. It is remembering.

An AND gate in the same feedback configuration gets stuck at 0 when its input is pulled low. Combine both gates with an inverter and you get a circuit that can remember either a 1 or a 0 by choosing which input to assert. This is called an SR latch (Set-Reset latch).

To make this useful as a memory cell you add a write-enable input. When write-enable is low, the circuit ignores any changes to the data input. When write-enable goes high, the circuit latches whatever is on the data input. This is how SRAM cells work at the logical level.

### SRAM: Six Transistors Per Bit

Static RAM implements a latch using six transistors arranged as two cross-coupled inverters plus two access transistors. The cross-coupled inverters form a bistable circuit, it rests in one of two stable states and stays there as long as power is applied, with no external refresh needed.

```
         VDD
          |
      ----+----
      |       |
     [T1]   [T2]    <- pull-up transistors (PMOS)
      |       |
      +--Q  Q#+--
      |       |
     [T3]   [T4]    <- pull-down transistors (NMOS)
      |       |
      ---------
         |
        GND

     [T5]         [T6]   <- access transistors
      |               |
    BL              BL#
```

Properties of SRAM:
- 6 transistors per bit (sometimes 4-transistor variants exist for lower-density caches).
- No refresh required. The cross-coupled inverters hold state indefinitely while powered.
- Very fast access. A read or write cycle takes 0.5 to 5 nanoseconds depending on the cache level.
- High power consumption per bit (the inverters are always conducting a small leakage current).
- Large physical area per bit. Six transistors take about 3x more silicon than one transistor and one capacitor.
- Used in: CPU registers, L1/L2/L3 cache.

Because SRAM is expensive and large, you never see it in gigabyte quantities. A typical server CPU has 32MB of L3 SRAM cache. The rest of main memory is DRAM.

### DRAM: One Transistor, One Capacitor

Dynamic RAM trades the complexity of six transistors for a single transistor plus a tiny capacitor. The capacitor stores charge. A full capacitor represents a 1. An empty capacitor represents a 0. The transistor controls access: assert the wordline and the capacitor connects to the bitline, allowing charge to flow in or out.

```
   Wordline
      |
    [T]          <- access transistor (NMOS MOSFET)
      |
    [C]          <- storage capacitor (trench design, ~10-30 fF)
      |
    GND

    |
   Bitline
```

The 1T1C (one transistor, one capacitor) cell is tiny. At DDR5 process nodes, a single cell is tens of nanometers across. A 16GB DIMM contains roughly 136 billion such cells.

#### The Refresh Problem

The capacitor in a DRAM cell is not perfect. The transistor that isolates it is only a few dozen nanometers wide. At that scale, electrons tunnel through the gate oxide and leak away. A fully charged capacitor loses its charge in a few milliseconds.

This means DRAM must be continuously refreshed. The memory controller sends a refresh command that opens each row in turn, lets the sense amplifiers read the weakened charge, and then drives the bitline fully back to 1V or 0V, recharging the capacitors. This refresh cycle repeats every 64 milliseconds for every row in every bank.

The refresh operation is not free. During refresh, affected banks cannot be read or written. On a 32-bank DDR5 die, banks can be refreshed in rotation, reducing the impact, but it still represents real overhead, a few percent of total bandwidth.

This dynamic refreshing is why the technology is called Dynamic RAM. The word dynamic refers to the fact that the memory is not static: it must be actively maintained.

#### Reading from DRAM

Reading a DRAM cell is a destructive operation. Here is what happens:

1. Precharge: all bitlines are driven to 0.5V (VDD/2).
2. Row activate: the wordline voltage is raised, connecting all capacitors in that row to their bitlines.
3. Sense: a charged capacitor (binary 1, 1V) causes the bitline voltage to rise slightly above 0.5V. An empty capacitor (binary 0, 0V) causes it to fall. The perturbation is tiny, microvolts on a line with significant capacitance.
4. Amplify: a sense amplifier at the end of each bitline detects the direction of the perturbation and drives the bitline fully to 1V or 0V. This restores the charge in the cell, making the read non-destructive in practice.
5. Column select: a multiplexer connects the target bitlines to the output I/O drivers, which send the bits to the memory controller.

The critical insight here is that reading disturbs the cell. The sense amplifier re-writes the data back, but the open row must eventually be closed (precharged) before a different row in that bank can be read. This row open/close cycle drives the timing parameters you see on DRAM packaging.

### SRAM vs DRAM Comparison

| Property | SRAM | DRAM |
|---|---|---|
| Transistors per bit | 6 | 1 (+1 capacitor) |
| Refresh required | No | Yes, every 64ms |
| Access latency | 0.5-5 ns | 60-100 ns |
| Capacity (typical) | 32 MB (L3 cache) | 16-128 GB (main memory) |
| Cost per GB | Very high | Low |
| Power per bit | Higher static | Lower static, refresh overhead |
| Use case | CPU cache | Main memory |

### Code Implications

The difference between SRAM cache and DRAM main memory is a 20-70x latency gap. This gap is not an implementation detail you can ignore.

```go
// Cache-friendly: sequential access, data stays in L1/L2
func sumRows(matrix [][]int64, rows, cols int) int64 {
    sum := int64(0)
    for i := 0; i < rows; i++ {
        for j := 0; j < cols; j++ {
            sum += matrix[i][j]  // sequential, cache-hot
        }
    }
    return sum
}

// Cache-hostile: column-major access on a row-major layout
func sumCols(matrix [][]int64, rows, cols int) int64 {
    sum := int64(0)
    for j := 0; j < cols; j++ {
        for i := 0; i < rows; i++ {
            sum += matrix[i][j]  // stride = cols * 8 bytes, cache-cold
        }
    }
    return sum
}
```

On a 1024x1024 matrix of int64, `sumRows` is typically 5-10x faster than `sumCols` on modern hardware. The algorithm is identical. The only difference is memory access order, whether the CPU finds the next value already in L1 cache or must wait for DRAM.

**Watch:** [Static RAM and Dynamic RAM Explained](https://www.youtube.com/watch?v=0rNEtAz3wJQ), recommended for visual learners.

**Watch:** [Capacitors are terrible at remembering data. But for this reason we continue doing it.](https://www.youtube.com/watch?v=7WnbIeMgWYA), recommended for visual learners.

**Watch:** [HOW TRANSISTORS REMEMBER DATA](https://www.youtube.com/watch?v=rM9BjciBLmg), recommended for visual learners.
