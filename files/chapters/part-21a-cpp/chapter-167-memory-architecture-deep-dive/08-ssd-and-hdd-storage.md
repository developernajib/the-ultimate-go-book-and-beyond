## 08. SSD and HDD Storage

Persistent storage is the bottom of the memory hierarchy. Data survives power loss here. Understanding how SSDs and HDDs work physically explains their performance characteristics, why random writes are expensive on NAND flash, why HDD random IOPS are bounded by physics, and why NVMe outperforms SATA by orders of magnitude.

### Hard Disk Drives: Mechanical Storage

An HDD consists of one or more circular platters coated with a magnetic material and an actuator arm that moves a read/write head across the platter surface.

Data is stored as magnetic field orientations. The platter spins at 7,200 RPM (consumer) or 10,000-15,000 RPM (enterprise). The head floats nanometers above the surface on a cushion of air.

#### HDD Access Anatomy

Accessing data on an HDD has three components:

1. **Seek time**: moving the actuator arm to the correct track. Average seek time for a 7200 RPM drive: 8-10ms. This is dominated by the mechanical inertia of the actuator arm.

2. **Rotational latency**: waiting for the platter to rotate so the target sector is under the head. Average: half a revolution. At 7200 RPM that is 4.2ms.

3. **Transfer time**: reading or writing the data. Sequential transfer rates reach 100-250 MB/s. This is the only phase where HDDs are competitive.

Total random access latency: 8-12ms average. That is 8,000,000 to 12,000,000 nanoseconds. Compare to DRAM at 60-100 ns: a 100,000x difference.

**Random IOPS limit**: at 10ms per access, a single HDD can sustain approximately 100 random IOPS. This is a hard physical limit imposed by the mechanical components. No software optimization can overcome it.

#### HDD Use Cases

HDDs remain competitive for:
- Sequential large file storage (video files, backups, cold archives).
- High-capacity, low-cost bulk storage where random access is not required.
- Situations where cost per TB is the primary constraint.

For anything involving random access, databases, OS boot, application code. HDDs are obsolete for performance-sensitive deployments.

### Solid-State Drives: NAND Flash

An SSD stores data in NAND flash memory. NAND flash uses floating-gate transistors (traditional) or charge trap flash (CTF, newer) to trap electrons inside an insulating layer. The quantity of trapped electrons determines the stored value.

#### SLC, MLC, TLC, QLC

The number of bits per cell is determined by how many distinct electron charge levels the cell can reliably maintain:

| Type | Bits per cell | Levels | Endurance (P/E cycles) | Relative speed |
|---|---|---|---|---|
| SLC (Single-Level Cell) | 1 bit | 2 | 100,000 | Fastest |
| MLC (Multi-Level Cell) | 2 bits | 4 | 10,000 | Fast |
| TLC (Triple-Level Cell) | 3 bits | 8 | 3,000 | Medium |
| QLC (Quad-Level Cell) | 4 bits | 16 | 1,000 | Slowest |

Higher density (more bits per cell) means cheaper storage per GB but fewer program/erase cycles before cell wear-out. TLC is dominant in consumer SSDs. QLC appears in capacity-optimized drives.

**Charge Trap Flash (CTF)**: replaces the conductive floating gate with a non-conductive charge trap layer (silicon nitride). Electrons are trapped at localized sites, not as a uniform sheet. CTF is more resistant to charge leakage between adjacent cells and enables tighter cell packing. Samsung's VNAND (Vertical NAND) uses CTF.

#### VNAND: Vertical Stacking

Traditional planar NAND arranges cells in a 2D grid. As lithography shrinks cells further, interference between adjacent cells degrades data retention and endurance. VNAND stacks cells vertically, current drives reach 100-200+ layers.

Vertical stacking allows higher density without shrinking cell size. A 1TB VNAND die may have 128 vertical layers, each containing a 2D array of cells. The cells in a vertical string are connected like beads on a wire (the bitline), with each layer having its own control gate (wordline).

#### NAND Flash Organization

NAND flash is organized hierarchically:
- **Cell**: one CTF structure, stores 1-4 bits.
- **String**: a vertical column of 10+ cells connected in series.
- **Page**: a horizontal row of strings sharing a wordline. Minimum unit of read/write. Typically 4KB-16KB.
- **Block**: a group of pages sharing a common erase operation. Typically 256KB-8MB. The minimum unit of erase.

The block structure creates the fundamental write constraint of NAND flash: **you cannot overwrite in place**. To modify data, you must:
1. Read the entire block containing the target page into a RAM buffer.
2. Erase the block (sets all cells to 1).
3. Write the modified data back (programming sets cells to 0).

This read-erase-write cycle is called write amplification when it results in writing more data than originally intended.

#### Flash Translation Layer (FTL)

The FTL is firmware inside the SSD controller that presents a block device interface (sector reads/writes) to the OS while managing NAND flash's page/block structure internally.

The FTL handles:
- **Logical-to-physical mapping**: maps logical block addresses (LBA) that the OS uses to physical NAND page locations.
- **Wear leveling**: spreads writes across all blocks to avoid wearing out frequently written blocks. Without wear leveling, a log file written repeatedly would exhaust a small set of blocks while the rest remain unused.
- **Garbage collection**: reclaims blocks containing only obsolete (overwritten) pages by reading live pages to a new block, erasing the old block, and updating the LBA mapping.
- **Write buffering**: uses a DRAM or SRAM cache on the SSD controller to absorb small random writes and coalesce them into full-page writes.

#### Write Amplification

Write amplification (WA) is the ratio of actual NAND writes to host-requested writes. A WA of 1.0 means every byte written by the OS is written to NAND exactly once. A WA of 5.0 means 5 bytes are written to NAND for every 1 byte the OS writes.

High WA comes from:
- Garbage collection: moving live pages to erase a block.
- Small random writes: each small write may require reading, erasing, and rewriting a full block.
- Low free space: the FTL has fewer clean blocks available, forcing more aggressive GC.

Maintain ~10-20% free space (over-provisioning) on SSDs to keep WA low and sustained write performance high.

#### NVMe vs SATA

| Feature | SATA III | NVMe (PCIe 4.0 x4) |
|---|---|---|
| Protocol | AHCI | NVMe |
| Interface | SATA port | PCIe slot / M.2 |
| Max bandwidth | ~550 MB/s | ~7,000 MB/s |
| Command queues | 1 queue, 32 commands | 65,535 queues, 65,535 commands each |
| Random 4K read IOPS | ~100K | ~1,000,000 |
| Latency (4K read) | 100-400 µs | 20-100 µs |

AHCI (the SATA command set) was designed for spinning disks with a single queue and 32 command slots. NVMe was designed for flash and allows massive command-level parallelism. The queue depth advantage means NVMe SSDs can serve more concurrent requests without queuing delay.

### Programmer Implications

#### Avoid Random Small Writes to SSD

Random 512-byte writes are expensive on NAND: the FTL must read a 4KB-16KB page, modify the relevant bytes, and write the full page. Batch small writes into sequential larger writes or use a write-ahead log pattern.

#### fsync Is Expensive

`fsync` forces all buffered writes to NAND flash and waits until the data is durable. On SSDs, this can take 1-10ms because the FTL must complete all pending GC operations. Avoid calling `fsync` per transaction. Use group commit to amortize the cost.

### Read-ahead Helps Sequential Access

Both SSDs and HDDs benefit from prefetching sequential data. Linux's `readahead` mechanism detects sequential access patterns and prefetches ahead. For large sequential file reads, the OS read-ahead reduces effective latency.

### Go Example: Sequential vs Random I/O

```go
package main

import (
    "fmt"
    "math/rand"
    "os"
    "time"
)

func sequentialRead(path string, size int64) time.Duration {
    f, _ := os.Open(path)
    defer f.Close()
    buf := make([]byte, 4096)
    start := time.Now()
    for offset := int64(0); offset < size; offset += 4096 {
        f.ReadAt(buf, offset)
    }
    return time.Since(start)
}

func randomRead(path string, size int64, accesses int) time.Duration {
    f, _ := os.Open(path)
    defer f.Close()
    buf := make([]byte, 4096)
    pages := size / 4096
    start := time.Now()
    for i := 0; i < accesses; i++ {
        offset := rand.Int63n(pages) * 4096
        f.ReadAt(buf, offset)
    }
    return time.Since(start)
}

func main() {
    const path = "/tmp/testfile"
    const size = 256 * 1024 * 1024 // 256MB

    // Create test file
    f, _ := os.Create(path)
    f.Write(make([]byte, size))
    f.Close()
    defer os.Remove(path)

    seq := sequentialRead(path, size)
    rnd := randomRead(path, size, 4096) // same byte count as sequential

    fmt.Printf("sequential 256MB read: %v\n", seq)
    fmt.Printf("random 4K x 4096 read: %v\n", rnd)
    fmt.Printf("ratio: %.1fx\n", float64(rnd)/float64(seq))
}
```

On NVMe SSD, sequential throughput is ~5-7 GB/s. Random 4K reads will be 1-2 GB/s at high queue depth, but at queue depth 1 (as above), effective throughput drops to ~0.3-0.5 GB/s due to per-operation latency. On HDD, the difference is extreme.

**Watch:** [How do SSDs Work?](https://www.youtube.com/watch?v=5Mh3o886qpg), recommended for visual learners.

**Watch:** [How does Computer Memory Work](https://youtu.be/7J7X7aZvMXQ?si=CFkYLVO_tEKeVf5O), recommended for visual learners.
