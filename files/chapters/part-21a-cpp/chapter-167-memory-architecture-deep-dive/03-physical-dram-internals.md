## 03. Physical DRAM Internals

Understanding DRAM at the chip level explains why memory access patterns matter in real code. The terms you see on a DIMM packaging label, 32-5600-40-40-40-77 or CL40 tRCD40 tRP40, describe real hardware operations that have concrete latency costs.

### The DIMM

A DIMM (Dual Inline Memory Module) is a printed circuit board with DRAM chips soldered to it. A typical DDR5 DIMM has 8 chips plus an SPD (Serial Presence Detect) chip that holds timing parameters.

Each chip operates as a semi-independent unit. A DDR5 DIMM is divided into two independent subchannels (Channel A and Channel B), each with 4 chips. Each chip reads or writes 8 bits at a time, and the 4 chips in a channel work in parallel, transferring 32 bits per transaction.

### Inside a DRAM Die

A single 2GB DRAM die (as found in a 16GB DIMM with 8 chips) is organized into:
- 8 bank groups of 4 banks each = 32 banks total.
- Each bank: 65,536 rows by 8,192 columns.
- Total cells per die: 65,536 × 8,192 × 32 = ~17.2 billion cells.

The 31-bit address is split:
- 3 bits: bank group selection.
- 2 bits: bank selection.
- 16 bits: row address (selects 1 of 65,536 rows).
- 10 bits: column address (selects 1 of 1,024 groups of 8 columns).

The address is sent in two phases, called RAS (Row Address Strobe) and CAS (Column Address Strobe). This two-phase approach is why row hits are fast: once a row is open, subsequent column accesses skip the row-open latency.

### Timing Parameters

DRAM timing is specified as a set of cycle counts at a given clock frequency. Higher clock frequency means shorter absolute time per cycle, but the cycle counts represent minimum waits imposed by the physics of the cell.

| Parameter | Meaning | Typical DDR5 value |
|---|---|---|
| CL (CAS Latency) | Cycles from CAS command to first data out | 38-44 |
| tRCD | Cycles to open a row (RAS to CAS delay) | 38-44 |
| tRP | Cycles to precharge (close) a row | 38-44 |
| tRAS | Cycles a row must remain active | 77-88 |
| tRFC | Cycles for a full refresh operation | 295-560 (per bank group) |

At DDR5-5600 (2800 MHz base clock, 5600 MT/s), one clock cycle is approximately 0.36 ns. A CL40 timing means the controller must wait 40 × 0.36 ns ≈ 14.4 ns from issuing the column address to receiving data. Add tRCD for a row miss and tRP for a closed row, and the full penalty for a cold random read is roughly 60-100 ns.

### The Row Buffer

When a row is activated, all 8,192 columns in that bank are connected to the sense amplifiers simultaneously. The sense amplifiers drive all bitlines to 0V or 1V. This is called opening the row. The row stays open in a "row buffer", a set of sense amplifiers that hold the entire row.

Any subsequent access to the same bank and row (same physical row) is a row hit. A row hit skips tRCD and tRP, using only CL. Row hits are roughly 2-4x faster than row misses.

The implication for code is that accessing memory addresses that map to the same DRAM row is efficient. DRAM rows are typically 8KB wide (8,192 columns × 1 byte). Accessing addresses within the same 8KB window in the same bank gives row hits. Jumping between rows in the same bank forces close-precharge-open cycles.

Row conflicts (accessing different rows in the same bank) are the worst case. They require: close current row (tRP) + open new row (tRCD) + column access (CL). This is why hash maps with random key distribution are DRAM-unfriendly, consecutive accesses will likely land in different rows of the same bank.

### Bank Interleaving and Parallelism

32 banks allow the memory controller to overlap operations across banks. While bank 0 is precharging after a row close, the controller can issue an activate to bank 1. This pipelining is called bank interleaving.

The DRAM controller in modern CPUs aggressively reorders memory accesses to maximize bank parallelism and minimize row conflicts. Programs that generate requests to many different banks simultaneously benefit from this.

### DDR4 vs DDR5

| Feature | DDR4 | DDR5 |
|---|---|---|
| Max speed | 3200-5333 MT/s | 4800-8800+ MT/s |
| Bank groups | 4 groups × 4 banks = 16 banks | 8 groups × 4 banks = 32 banks |
| Subchannel width | 64-bit channel per DIMM | Two 32-bit subchannels per DIMM |
| Voltage (VDD) | 1.2 V | 1.1 V |
| On-die ECC | Not standard | Required for all DDR5 |
| Refresh scheme | Per-bank refresh (pBR) | Same-bank refresh (SBR), more granular |
| Burst length | BL8 (8 transfers) | BL16 (16 transfers) |

DDR5's 32-bank design significantly reduces row-miss penalties by allowing more rows to remain open simultaneously. The two-subchannel design also provides more address-decode flexibility and enables better error correction.

### ECC Memory

ECC (Error-Correcting Code) memory adds extra bits to each 64-bit word (typically 8 bits) to detect and correct single-bit errors and detect double-bit errors. On DDR5, a form of on-die ECC is mandatory at the chip level, correcting errors before they reach the controller. Server-grade ECC DIMMs add an additional SECDED (Single Error Correct, Double Error Detect) layer at the DIMM level.

From a programmer's perspective, ECC adds a small latency (a few nanoseconds) and reduces effective capacity by ~12.5%, but eliminates a class of silent data corruption bugs that can corrupt in-memory data structures in long-running server processes.

### Rank Interleaving

A rank is a set of DRAM chips that share command/address lines and collectively present a 64-bit (or 72-bit with ECC) data width. A DIMM with two ranks doubles effective bandwidth by allowing the controller to pipeline requests between ranks, hiding refresh and precharge latency.

Dual-rank DIMMs outperform single-rank DIMMs in bandwidth-constrained workloads even when total capacity is the same.

### Code Example: Observing Row Hit Patterns

```cpp
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <cstdio>

// Typical DRAM row size is 8KB.
// Accessing addresses separated by multiples of the row size
// lands in different banks or forces row conflicts.

static const size_t ROW_SIZE = 8 * 1024;   // 8KB DRAM row
static const size_t MEM_SIZE = 256 * 1024 * 1024; // 256MB

int main() {
    uint8_t* mem = (uint8_t*)aligned_alloc(4096, MEM_SIZE);
    memset(mem, 0, MEM_SIZE);

    size_t iters = 1 << 24;
    volatile uint8_t sink = 0;

    // Row-friendly: stride 1 (sequential within row)
    auto t0 = std::chrono::high_resolution_clock::now();
    for (size_t i = 0; i < iters; i++) {
        sink += mem[(i * 64) % MEM_SIZE];
    }
    auto t1 = std::chrono::high_resolution_clock::now();

    // Row-hostile: stride by large prime to force row thrashing
    auto t2 = std::chrono::high_resolution_clock::now();
    size_t idx = 0;
    for (size_t i = 0; i < iters; i++) {
        sink += mem[idx % MEM_SIZE];
        idx += 7 * ROW_SIZE + 64;
    }
    auto t3 = std::chrono::high_resolution_clock::now();

    using ms = std::chrono::duration<double, std::milli>;
    printf("sequential:    %.2f ms\n", ms(t1 - t0).count());
    printf("row-thrashing: %.2f ms\n", ms(t3 - t2).count());

    free(mem);
}
```

The row-thrashing loop will typically run 3-5x slower than the sequential loop on a machine with 16-32 GB of DRAM, even though both loops access the same total number of bytes.

**Watch:** [How does Computer Memory Work](https://youtu.be/7J7X7aZvMXQ?si=CFkYLVO_tEKeVf5O), recommended for visual learners.
