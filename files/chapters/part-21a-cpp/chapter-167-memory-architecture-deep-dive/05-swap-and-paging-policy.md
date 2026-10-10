## 05. Swap and Paging Policy

Swap is what happens when the OS runs out of physical memory. Pages that have not been accessed recently are written to disk, freeing physical frames for other uses. When those pages are needed again, they are read back from disk, a major page fault.

Understanding swap policy is essential for any server-side Go or C++ programmer. Memory pressure events cause latency spikes. The OOM killer can terminate your process without warning.

### Swap: Partition vs Swapfile

**Swap partition**: a dedicated disk partition formatted for swap use. Slightly faster to access than a file because the OS can address it directly without going through the filesystem layer. Traditional choice on Linux.

**Swapfile**: a regular file used as swap. Since Linux 4.0, swapfiles on XFS and ext4 are as fast as swap partitions (they use direct extent mapping, bypassing the page cache). On NVMe SSDs, the difference is negligible.

Enable a swapfile:

```bash
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
# Add to /etc/fstab for persistence:
# /swapfile none swap sw 0 0
```

Disable swap entirely (useful on machines with abundant RAM where any swap use indicates a configuration problem):

```bash
swapoff -a
# Remove swap entries from /etc/fstab
```

### Linux Swappiness

The `vm.swappiness` kernel parameter controls how aggressively the kernel evicts anonymous memory versus file-backed pages. Range: 0-200 (kernel 5.8+), previously 0-100.

- `swappiness=0`: avoid swapping anonymous pages unless absolutely necessary. Prefer dropping file cache instead.
- `swappiness=60`: default. Balanced behavior.
- `swappiness=100`: treat anonymous pages and file cache equally for eviction.
- `swappiness=200`: (kernel 5.8+) aggressively move anonymous pages to swap to keep RAM available for file cache.

For latency-sensitive server processes that should never be swapped:

```bash
echo 10 > /proc/sys/vm/swappiness
# Or persistently:
echo 'vm.swappiness=10' >> /etc/sysctl.conf
```

For a database server with a large buffer pool that you never want swapped:

```bash
# Lock the process's memory with mlockall
```

```go
//go:build linux

package main

import (
    "syscall"
)

// LockAllMemory prevents the process's pages from being swapped out.
// Requires CAP_IPC_LOCK privilege (or root).
func LockAllMemory() error {
    const MCL_CURRENT = 1
    const MCL_FUTURE  = 2
    return syscall.Mlockall(MCL_CURRENT | MCL_FUTURE)
}
```

### kswapd: The Background Reclaim Daemon

`kswapd` is a kernel thread that reclaims memory in the background, before the system reaches the critical low-watermark. It runs periodically and reclaims pages based on the LRU (Least Recently Used) policy, with separate active and inactive LRU lists.

When free memory falls below `vm.min_free_kbytes`, the kernel performs direct reclaim in the context of the allocating process. This is synchronous and causes allocation latency spikes. The goal of tuning swappiness and `min_free_kbytes` is to keep kswapd running proactively rather than hitting direct reclaim.

```bash
## Show current watermarks:
cat /proc/zoneinfo | grep -E 'min|low|high'

## Increase min_free_kbytes to trigger kswapd earlier:
echo 524288 > /proc/sys/vm/min_free_kbytes  # 512MB
```

## The OOM Killer

When the system cannot reclaim enough memory, the Out-Of-Memory killer selects a process to terminate. The selection algorithm assigns each process an OOM score based on memory usage, process age, and privilege level. The process with the highest score is killed.

View a process's OOM score:

```bash
cat /proc/$(pgrep myserver)/oom_score
```

Adjust OOM score adjustment (range -1000 to +1000):

```bash
## Make this process less likely to be killed:
echo -500 > /proc/$(pgrep myserver)/oom_score_adj

## Make it immune (only root):
echo -1000 > /proc/$(pgrep myserver)/oom_score_adj
```

In Go, you can set the OOM score adjustment at startup:

```go
//go:build linux

package main

import (
    "fmt"
    "os"
)

// SetOOMScoreAdj sets the OOM score adjustment for the current process.
// Negative values reduce kill priority. -1000 is immune (requires root).
func SetOOMScoreAdj(adj int) error {
    if adj < -1000 || adj > 1000 {
        return fmt.Errorf("oom_score_adj out of range: %d", adj)
    }
    path := fmt.Sprintf("/proc/%d/oom_score_adj", os.Getpid())
    return os.WriteFile(path, []byte(fmt.Sprintf("%d\n", adj)), 0644)
}
```

## zswap and zram

**zswap**: a compressed cache for swap pages in RAM. When a page would be written to the swap device, zswap compresses it and stores it in a pool of RAM first. On access, if the page is in the zswap pool it is decompressed in RAM without a disk read. Reduces swap I/O significantly.

```bash
echo 1 > /sys/module/zswap/parameters/enabled
echo 20 > /sys/module/zswap/parameters/max_pool_percent
echo lz4 > /sys/module/zswap/parameters/compressor
```

**zram**: creates a compressed block device entirely in RAM, used as a swap target. No disk I/O at all. Useful on memory-constrained systems (embedded, containers) where you want swap behavior without the latency of a disk.

```bash
modprobe zram
echo lz4 > /sys/block/zram0/comp_algorithm
echo 4G > /sys/block/zram0/disksize
mkswap /dev/zram0
swapon -p 100 /dev/zram0  # higher priority than disk swap
```

## PSI: Pressure Stall Information

PSI (introduced in Linux 4.20) measures memory (and CPU/IO) pressure as the percentage of time tasks spent stalled waiting for the resource. This gives a precise signal for when memory is insufficient, rather than relying on indirect metrics like swap usage.

```bash
cat /proc/pressure/memory
## some avg10=0.00 avg60=0.23 avg300=0.11 total=2349871
## full avg10=0.00 avg60=0.00 avg300=0.01 total=123456
```

- `some`: some tasks stalled, others could make progress.
- `full`: all runnable tasks stalled waiting for memory (complete stall).
- `avg10/avg60/avg300`: exponential moving average over 10s, 60s, 300s.
- `total`: cumulative microseconds of stall time since boot.

For application-level monitoring in Go:

```go
package mempress

import (
    "bufio"
    "fmt"
    "os"
    "strconv"
    "strings"
)

// MemoryPressure holds PSI memory pressure metrics.
type MemoryPressure struct {
    SomeAvg10  float64
    SomeAvg60  float64
    SomeAvg300 float64
    FullAvg10  float64
    FullAvg60  float64
    FullAvg300 float64
}

// Read reads current memory pressure from /proc/pressure/memory.
func Read() (MemoryPressure, error) {
    f, err := os.Open("/proc/pressure/memory")
    if err != nil {
        return MemoryPressure{}, err
    }
    defer f.Close()

    var mp MemoryPressure
    sc := bufio.NewScanner(f)
    for sc.Scan() {
        line := sc.Text()
        parts := strings.Fields(line)
        if len(parts) < 4 {
            continue
        }
        parseVal := func(s string) float64 {
            kv := strings.SplitN(s, "=", 2)
            if len(kv) != 2 {
                return 0
            }
            v, _ := strconv.ParseFloat(kv[1], 64)
            return v
        }
        switch parts[0] {
        case "some":
            mp.SomeAvg10 = parseVal(parts[1])
            mp.SomeAvg60 = parseVal(parts[2])
            mp.SomeAvg300 = parseVal(parts[3])
        case "full":
            mp.FullAvg10 = parseVal(parts[1])
            mp.FullAvg60 = parseVal(parts[2])
            mp.FullAvg300 = parseVal(parts[3])
        }
    }
    return mp, sc.Err()
}

// IsCritical returns true if memory pressure is high enough to take action.
func IsCritical(mp MemoryPressure) bool {
    return mp.SomeAvg10 > 20.0 || mp.FullAvg10 > 5.0
}

func main() {
    mp, err := Read()
    if err != nil {
        fmt.Fprintf(os.Stderr, "cannot read PSI: %v\n", err)
        return
    }
    fmt.Printf("memory pressure some avg10=%.2f avg60=%.2f\n",
        mp.SomeAvg10, mp.SomeAvg60)
    if IsCritical(mp) {
        fmt.Println("WARNING: memory pressure is critical")
    }
}
```

## cgroup Memory Limits

In containerized environments (Docker, Kubernetes), processes run inside cgroups that enforce memory limits. Exceeding the cgroup memory limit triggers the cgroup OOM killer, which is separate from the system OOM killer.

```bash
## View cgroup memory limit for current process:
cat /sys/fs/cgroup/memory/memory.limit_in_bytes  # cgroup v1
cat /sys/fs/cgroup/memory.max                     # cgroup v2

## View current usage:
cat /sys/fs/cgroup/memory/memory.usage_in_bytes   # cgroup v1
cat /sys/fs/cgroup/memory.current                 # cgroup v2
```

In Kubernetes, a Go server should monitor its own cgroup limit and expose a health signal before it gets OOM-killed. Use PSI combined with cgroup memory usage to detect impending memory exhaustion.
