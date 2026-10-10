## Low-Level I/O Performance

> **Senior @ FAANG**: A junior asks "should I use `read()` or `pread()`?" A senior asks "what is my queue depth, what is the device's mq queue, am I doing read-ahead, am I polluting the page cache, and is the syscall on the hot path?" The difference between 100k IOPS and 5M IOPS on the same NVMe is entirely in those answers.

### 1. The Three I/O Models

| Model | Calls | When kernel returns | Concurrency |
|-------|-------|---------------------|-------------|
| Synchronous | `read`, `pread`, `write`, `pwrite` | After data in/out of page cache (or device, with `O_SYNC`/`O_DIRECT`) | One syscall = one I/O |
| Async via thread pool | glibc AIO, `std::async` | Userspace POSIX AIO is just a thread pool | One thread per outstanding I/O |
| Kernel-async | `io_uring`, `libaio` (Linux AIO) | Submission returns immediately, completion polled or signaled | Hundreds-millions of I/Os in flight per thread |

Kernel-async is the only model that scales to modern NVMe. A single core driving NVMe via `io_uring` polled mode hits 1M+ IOPS, the same core doing synchronous `pread` peaks around 200k.

### 2. `io_uring` vs Linux AIO (`libaio`)

`libaio` (kernel `io_submit`/`io_getevents`) was the asynchronous block I/O API for ~15 years. Limitations that killed it:

- Blocks on metadata operations (open, fsync, stat).
- Non-`O_DIRECT` falls back to synchronous.
- Not useful for sockets.

`io_uring` (5.1+, mature 5.10+) replaces it everywhere:

| Feature | libaio | io_uring |
|---------|--------|----------|
| File I/O | yes (O_DIRECT only) | yes (any fd) |
| Sockets | no | yes |
| Buffered reads | falls back to sync | true async |
| Completions per syscall | 1 (`io_getevents` batches) | 0 (shared rings) |
| Polled mode | no | `IORING_SETUP_IOPOLL` (NVMe), `IORING_SETUP_SQPOLL` (kernel side) |
| Linked operations | no | yes (`IOSQE_IO_LINK`) |
| Multi-shot accept/recv | no | yes (5.13+) |
| `O_DIRECT` requirement | yes | no |

`io_uring` is covered in Section 4 (`io_uring`: Modern Linux Async I/O). The lesson here: if you are starting a new I/O subsystem in 2026, `io_uring` is the only correct choice. `libaio` exists for legacy.

### 3. Page Cache Control, `posix_fadvise` and `madvise`

Page cache hides device latency, but indiscriminate use evicts hot data. Hints:

```cpp
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL); // increase readahead window
posix_fadvise(fd, 0, 0, POSIX_FADV_RANDOM);     // disable readahead
posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);   // drop pages from cache
posix_fadvise(fd, 0, 0, POSIX_FADV_WILLNEED);   // schedule readahead now
posix_fadvise(fd, 0, 0, POSIX_FADV_NOREUSE);    // hint streaming
```

Production patterns:

- **Streaming a 100 GB log file**: `POSIX_FADV_SEQUENTIAL` before the read, `POSIX_FADV_DONTNEED` per chunk after consumption. Prevents cache eviction of working set.
- **Random index reads**: `POSIX_FADV_RANDOM` on the index file. Disables readahead so each read does exactly one device transfer.
- **Pre-warming at startup**: `POSIX_FADV_WILLNEED` on critical files in parallel, kernel issues readahead, your service starts already-cached.

`/proc/sys/vm/dirty_*` controls writeback timing globally:

```
/proc/sys/vm/dirty_background_ratio   # % memory dirty before background flush
/proc/sys/vm/dirty_ratio              # % at which writes block until flush
/proc/sys/vm/dirty_expire_centisecs   # max age before flush
/proc/sys/vm/dirty_writeback_centisecs # flush thread interval
```

For database workloads, `dirty_ratio=10`, `dirty_background_ratio=5` flatten latency vs the defaults (20/10), fewer giant flushes, more frequent small ones.

`/proc/sys/vm/swappiness=1` (or 0) on database servers, anonymous swap evictions cost more than dropping page cache.

### 4. Readahead Tuning

The kernel issues readahead based on access pattern detection. The window is per-file, capped at `/sys/block/<dev>/queue/read_ahead_kb` (default 128 KB).

For sequential workloads on NVMe, increase to 4-8 MiB:

```bash
echo 4096 > /sys/block/nvme0n1/queue/read_ahead_kb
```

Per-fd override at runtime:

```cpp
readahead(fd, offset, len);   // synchronous: waits to enqueue
```

The `readahead(2)` syscall is fire-and-forget, useful for scanning indexes from a B-tree.

### 5. `O_DIRECT` Best Practices

`O_DIRECT` bypasses the page cache. Constraints:

- Buffer **alignment** at logical block size (typically 4 KiB on modern devices). `posix_memalign(&buf, 4096, len)` or `aligned_alloc`.
- **Length and offset** multiples of block size.
- Use `statx(STATX_DIOALIGN)` (kernel 6.1+) for the exact alignment required.

Patterns that work:

```cpp
int fd = open(path, O_RDWR | O_DIRECT | O_CLOEXEC);
constexpr size_t ALIGN = 4096;
void* buf = nullptr;
posix_memalign(&buf, ALIGN, BUF_SIZE);

// Concurrent O_DIRECT via io_uring with QD=64 saturates a modern NVMe.
struct io_uring ring;
io_uring_queue_init(64, &ring, IORING_SETUP_SQPOLL);
for (int i = 0; i < 64; ++i) {
    auto* sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf + i*ALIGN, ALIGN, off + i*ALIGN);
}
io_uring_submit(&ring);
```

Anti-patterns:

- Single-threaded `pread(O_DIRECT)`: each read waits for the device. Throughput = 1/latency × block size. Use `io_uring` or threads.
- `O_DIRECT` + frequent small reads: each is a device transfer. Coalesce or use buffered I/O.
- Ignoring `EINVAL` from misalignment, your code "works" until someone runs it on a 4Kn device.

### 6. `fallocate` vs `ftruncate` vs Sparse Writes

```cpp
ftruncate(fd, 1ULL << 30);  // sparse file: virtual size 1 GiB, no blocks allocated
fallocate(fd, 0, 0, 1ULL << 30);  // ALLOCATED 1 GiB on disk; no I/O until write

// Hole punch: deallocate range, leave virtual size:
fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, off, len);

// Zero range without I/O if FS supports it (xfs, ext4):
fallocate(fd, FALLOC_FL_ZERO_RANGE, off, len);

// Collapse: remove range and shift the rest down. Log rotation in O(metadata):
fallocate(fd, FALLOC_FL_COLLAPSE_RANGE, off, len);

// Insert: insert a hole, shifting data up:
fallocate(fd, FALLOC_FL_INSERT_RANGE, off, len);
```

WAL pre-allocation is a `fallocate` before any write, guarantees you never `ENOSPC` mid-commit. PostgreSQL, MySQL, etcd all do this.

### 7. `splice`, `tee`, `vmsplice`, `sendfile`. Zero-Copy Pipes

Already covered in Section 5 (Zero-Copy Techniques), but a perf-relevant summary:

- `sendfile(out, in, off, n)`: file → socket without userspace bounce. Single syscall, ~0 copies.
- `splice(in, in_off, out, out_off, n, flags)`: any two endpoints where one is a pipe. Used for fd-to-fd transfers via a pipe broker.
- `vmsplice(pipe, iov, n, flags)`: gift userspace pages to a pipe (no copy). Receiver `splice`s them out.

For network → disk transcoding loops, `splice(socket → pipe)` then `splice(pipe → file)` keeps data entirely in kernel page cache.

### 8. Async DMA with Persistent Memory and DAX

For Optane/NVDIMM with `dax`-mounted FS:

```cpp
int fd = open("/mnt/dax/log", O_RDWR);
void* p = mmap(nullptr, size, PROT_READ|PROT_WRITE, MAP_SHARED_VALIDATE | MAP_SYNC, fd, 0);
// Stores to p are durable after a CLWB + SFENCE, no syscall needed.
*reinterpret_cast<uint64_t*>(p) = value;
_mm_clwb(p);
_mm_sfence();
```

`MAP_SYNC` (Linux 4.15+) guarantees the FS will not need to update metadata before durability, durability is a CPU instruction, not an `fsync`. This collapses commit latency from ~10 µs to ~100 ns. Production users: SAP HANA, RocksDB-PMEM, custom WALs.

### 9. NUMA-Aware I/O

I/O queue interrupts are pinned to specific CPUs. If your application thread runs on a different NUMA node than the IRQ, every completion crosses the interconnect.

Tools:

- `/proc/interrupts` → which CPU handles each MSI-X queue.
- `irqbalance` → daemon that distributes IRQs, **disable it** for HFT and pin manually:
  ```bash
  echo 0 > /proc/sys/kernel/numa_balancing
  # Pin nvme0q1 to CPU 4:
  echo 4 > /proc/irq/<irq>/smp_affinity_list
  ```
- `XPS` (transmit packet steering) and `RPS` (receive) for network: `/sys/class/net/eth0/queues/{tx-N,rx-N}/{xps_cpus,rps_cpus}`.

The rule: I/O thread, the queue's IRQ, and the issuing application thread should all be on the same NUMA node, and ideally on **adjacent** SMT siblings of the same physical core.

### 10. Measuring I/O, `iostat`, `bpftrace`, `blktrace`

```bash
iostat -xmt 1                 # %util, await, r/s, w/s, rMB/s
bpftrace -e 'tracepoint:block:block_rq_complete { @lat = hist((nsecs - args->start_time)/1000); }'
blktrace -d /dev/nvme0n1 -o - | blkparse -i -
```

`iostat`'s `%util` is misleading on multi-queue devices, you can have 100% util at 10% capacity. Use **`avgqu-sz`** (queue depth) instead: depth × IOPS = throughput, depth alone tells you saturation.

`bpftrace` block-layer histograms give p50/p99/p99.9 latency per device, the real SLO metric.

### 11. The "Cold Storage" Pattern

A streaming reader that does not pollute cache:

```cpp
constexpr size_t CHUNK = 1 << 20;  // 1 MiB
posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
char* buf = static_cast<char*>(aligned_alloc(4096, CHUNK));

off_t off = 0;
while (off < size) {
    size_t n = std::min<size_t>(CHUNK, size - off);
    ssize_t r = pread(fd, buf, n, off);
    process(buf, r);
    posix_fadvise(fd, off, r, POSIX_FADV_DONTNEED);  // immediately drop
    off += r;
}
```

This reads at full sequential bandwidth without evicting another tenant's hot pages, the difference between a friendly batch job and one that triggers an SRE page.

### 12. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `read` / `write` everywhere | `io_uring` for any concurrent I/O. |
| `O_DIRECT` for "fast" | `O_DIRECT` only with own cache + alignment + queue depth. |
| Trust default readahead | Tune `read_ahead_kb` per workload, `posix_fadvise` per fd. |
| `truncate` to grow | `fallocate` first, then write. |
| Streaming reads pollute cache | `POSIX_FADV_SEQUENTIAL` + `POSIX_FADV_DONTNEED`. |
| `sendfile` for socket → file | `splice` via pipe broker for arbitrary fd pairs. |
| Default IRQ affinity | Manual pinning, disable `irqbalance` and `numa_balancing` for latency cores. |
| Use `iostat` `%util` | Look at avgqu-sz, await, p99 from BPF. |

Disk and network I/O are where most "performance work" happens. Done correctly with `io_uring` + alignment + cache hints, you do not need a faster machine.
