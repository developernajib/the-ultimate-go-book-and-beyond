## 31.2 Processing Large Files

### Stream Processing

Stream processing reads input incrementally through a `bufio.Reader` and writes output through a `bufio.Writer`, so memory usage stays proportional to the buffer size rather than the file size. The first function below transforms a file line by line. The second distributes lines across a worker pool through a buffered channel for parallel processing.

> **Senior track**: `bufio.Scanner` is convenient but caps individual tokens at `bufio.MaxScanTokenSize` (64KB by default). A single long JSON log line or an un-newlined 1MB blob will return `bufio.ErrTooLong` mid-stream. For inputs where line length is not bounded, either call `scanner.Buffer(buf, maxSize)` with a sensible ceiling, or drop to `bufio.Reader.ReadString('\n')` / `ReadBytes('\n')` which grow as needed. For pure copy-through pipelines with no per-line work, `io.Copy(dst, src)` is fastest because it avoids the user-space line split entirely and, on Linux, can trigger `copy_file_range` or `sendfile` when both sides are regular files or sockets.

```go
package main

import (
    "bufio"
    "io"
    "os"
    "sync"
)

// Process large file without loading into memory
func processLargeFile(inputPath, outputPath string, transform func(string) string) error {
    input, err := os.Open(inputPath)
    if err != nil {
        return err
    }
    defer input.Close()

    output, err := os.Create(outputPath)
    if err != nil {
        return err
    }
    defer output.Close()

    reader := bufio.NewReader(input)
    writer := bufio.NewWriter(output)
    defer writer.Flush()

    for {
        line, err := reader.ReadString('\n')
        if len(line) > 0 {
            transformed := transform(line)
            if _, writeErr := writer.WriteString(transformed); writeErr != nil {
                return writeErr
            }
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }
    }

    return nil
}

// Parallel line processing
func processLargeFileParallel(path string, workers int, process func(string)) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    lines := make(chan string, workers*10)
    var wg sync.WaitGroup

    // Start workers
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for line := range lines {
                process(line)
            }
        }()
    }

    // Read and distribute lines
    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        lines <- scanner.Text()
    }
    close(lines)

    wg.Wait()
    return scanner.Err()
}
```

### Memory-Mapped Files

Memory-mapped files map a file's contents directly into the process's virtual address space using `syscall.Mmap`. This is most useful for random-access patterns where seeking to arbitrary offsets is frequent, such as database index files or binary search over sorted data. For sequential processing of very large files, streaming reads are usually a better fit because mmap can trigger heavy page faulting when the file exceeds physical RAM.

> **Senior track**: Prefer `golang.org/x/exp/mmap` over raw `syscall.Mmap` for portability. It exposes an `*mmap.ReaderAt` implementing `io.ReaderAt`, handles Windows (`CreateFileMapping`/`MapViewOfFile`) and POSIX behind one API, and owns munmap through its `Close` method. Use mmap only for read-mostly random access over files that comfortably fit in the address space (and ideally in page cache). For files larger than physical RAM, mmap can degrade into synchronous page faults on every miss, which is slower than an explicit `ReadAt` loop with a tuned buffer. Never mmap files on network filesystems (NFS/SMB): pages can be invalidated while mapped and your process will see torn reads or SIGBUS on access.

```go
package main

import (
    "os"
    "syscall"
)

// Memory-map a file for fast random access
func mmapFile(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    info, err := f.Stat()
    if err != nil {
        return nil, err
    }

    size := info.Size()
    if size == 0 {
        return []byte{}, nil
    }

    data, err := syscall.Mmap(
        int(f.Fd()),
        0,
        int(size),
        syscall.PROT_READ,
        syscall.MAP_SHARED,
    )
    if err != nil {
        return nil, err
    }

    return data, nil
}

func unmapFile(data []byte) error {
    return syscall.Munmap(data)
}
```

### Chunked Processing with Progress

A `ProgressReader` wraps any `io.Reader` and calls a callback after every `Read`, reporting how many bytes have been consumed so far against a known total. Because it satisfies `io.Reader` itself, it drops into any existing pipeline, pass it to `io.Copy`, `json.NewDecoder`, or a `gzip.Reader`, without changing the surrounding code.

```go
package main

import (
    "fmt"
    "io"
    "os"
)

type ProgressReader struct {
    reader     io.Reader
    total      int64
    current    int64
    onProgress func(current, total int64)
}

func NewProgressReader(reader io.Reader, total int64, onProgress func(int64, int64)) *ProgressReader {
    return &ProgressReader{
        reader:     reader,
        total:      total,
        onProgress: onProgress,
    }
}

func (pr *ProgressReader) Read(p []byte) (int, error) {
    n, err := pr.reader.Read(p)
    pr.current += int64(n)
    if pr.onProgress != nil {
        pr.onProgress(pr.current, pr.total)
    }
    return n, err
}

func copyWithProgress(src, dst string) error {
    srcFile, err := os.Open(src)
    if err != nil {
        return err
    }
    defer srcFile.Close()

    info, err := srcFile.Stat()
    if err != nil {
        return err
    }

    dstFile, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer dstFile.Close()

    progressReader := NewProgressReader(srcFile, info.Size(), func(current, total int64) {
        percent := float64(current) / float64(total) * 100
        fmt.Printf("\rProgress: %.1f%%", percent)
    })

    _, err = io.Copy(dstFile, progressReader)
    fmt.Println()
    return err
}
```

### Junior to FAANG: streaming pitfalls that interviewers love

The parallel line processor above contains a subtle ordering bug that shows up in every second interview on this topic. Lines enter the channel in file order, but workers process them concurrently, so outputs arrive in arbitrary order. If the downstream consumer assumes order (and most do, for log reconstruction or replay), the pipeline is silently wrong. The fix is either to preserve ordering by attaching a sequence number to every line and reordering on the consumer side, or to shard by key so that all records sharing a key land on the same worker in order. Interviewers will ask "does this preserve ordering" and expect you to say no and then propose a fix.

The second pitfall is the scanner buffer. Replace `bufio.NewScanner(f)` with the following pattern in production, every time.

```go
scanner := bufio.NewScanner(f)
scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
```

This caps at 16 MB, which is enough for any sane log line and small enough that a single rogue input does not OOM the process. Without this, a 65 KB line silently stops the scanner mid file with `bufio.ErrTooLong`.

The third pitfall is forgetting that `io.Copy` is already optimized. On Linux with Go 1.21 and later, `io.Copy` between two `*os.File` values goes through `copy_file_range`, which performs the copy in kernel space with zero user copies and can even offload to filesystem reflinks on XFS and Btrfs. Writing your own loop with a buffer defeats this optimization and halves throughput. For the progress reporting case, accept the throughput cost or call `copy_file_range` directly for the bulk and skip to a buffer only for the last percent of the file to emit progress.

The fourth pitfall is the progress callback firing on every `Read`, which on a 1 GB file can be hundreds of thousands of calls. If the callback writes to stdout, you spend more time on IO for progress than for the file itself. Rate limit the callback to once per 100 ms or once per percent, whichever is larger.

For the interview mental model, when asked "process a 100 GB file", the answer structure is: (1) open with buffered reader sized to 1 MB, (2) parse with a streaming decoder, (3) fan out to workers if work per record justifies it, (4) preserve ordering via sequence numbers if needed, (5) emit progress via rate limited callback, (6) handle context cancellation in the read loop, (7) report partial progress on failure so the job can resume. Walking through this list gets you to a senior answer even if you do not finish the code.

### Senior @ FAANG: petabyte batch ETL and the streaming buffered hybrid model

At petabyte scale, the "stream everything" advice stops being universally correct. The right model is hybrid, and the trade off points are known and quantifiable.

For pure transform (record in, record out, no cross record state), pure streaming with buffered reads is optimal. Memory is O(buffer), throughput is saturated by disk or network bandwidth, and horizontal scaling is trivial. This is the regime for format conversion, redaction, field mapping, and enrichment with a small lookup table.

For aggregation (group by key, top K, distinct count), pure streaming fails because state grows with cardinality. Now you need spill to disk when state exceeds a threshold, plus a merge phase. External sort is the classic algorithm. Netflix's Iceberg compaction jobs and Meta's Presto shuffle use this pattern. The memory ceiling per worker is typically 4 to 8 GB, spill to NVMe with LZ4 compression because CPU is the bottleneck and ratio is secondary. BigQuery's and Snowflake's internal shuffle use roughly the same design with proprietary optimizations.

For join (two or more inputs matched by key), the choice between broadcast join (small side fits in memory, stream large side against it), shuffle hash join (both sides partitioned by hash), and sort merge join (both sides sorted by key) is made at planning time based on cardinality statistics. A senior engineer must be able to read an execution plan, spot a broadcast that should be shuffle, and understand the memory implications of each. Interview prompts like "join a 100 GB fact table with a 10 GB dimension table" are probing this.

The mmap versus read decision at scale has a concrete threshold. Anandtech style benchmarks and Google internal data converge on the same rule. If your working set fits in RAM and access is random, mmap wins by 20 to 40 percent because it eliminates syscall overhead per access. If your working set exceeds RAM or access is sequential at scan rate, buffered read wins by 30 to 50 percent because readahead is tuned for sequential patterns and mmap page faults are synchronous. The crossover point is working set size equal to roughly 60 percent of RAM, leaving headroom for page cache and the process heap.

O_DIRECT is the third regime and is used by almost every production database storage engine. It bypasses the page cache entirely, which means the application owns its buffer pool. The tradeoffs are alignment (buffers must be aligned to 512 bytes on traditional disks, 4096 on modern NVMe, and the filesystem's logical block size on some setups), reduced small random read throughput (no page cache hits), and increased write throughput for large sequential writes (no double copy through page cache). In Go, this requires passing `unix.O_DIRECT` to `os.OpenFile` and allocating aligned buffers via `unix.Mmap` with `MAP_ANONYMOUS` or by over allocating and slicing to the aligned boundary. RocksDB's Go bindings, Badger, and CockroachDB's Pebble all use O_DIRECT on Linux.

S3 and GCS multipart is the object store analog of chunked local IO and has its own design rules. Parts must be 5 MB to 5 GB on S3, 5 MB minimum except for the last part, and exactly 10000 parts maximum. Optimal part size is 16 to 64 MB for typical bandwidth, with 8 to 32 way concurrency per object. The AWS SDK's default `s3manager.Uploader` uses 5 MB parts and 5 way concurrency, which is suboptimal for large uploads. Tune `PartSize` to `min(64 MB, max(5 MB, total/9999))` and `Concurrency` to `min(32, bandwidth_mbps / 400)`. For downloads the same logic applies via `s3manager.Downloader`. Range GETs with 8 MB chunks and 8 way concurrency saturate typical gigabit links and scale well on 10 Gbit.

Resumability matters at this scale because a 4 TB upload failing at 99 percent must not restart from zero. S3 multipart supports `ListParts` for resume. Your uploader must persist the `UploadId` and the `ETag` of every completed part to stable storage before acknowledging progress to the caller. On resume, `ListParts` tells you which parts to skip. Without this, every tail latency spike costs you a full re upload. GCS resumable uploads use a different protocol (session URI plus byte range acknowledgment) and the concept is the same, persist the session URI.

Checksumming end to end means the sender computes CRC32C on the uncompressed record, attaches it to the record, the receiver verifies after decompression, and the storage system verifies on write and read. S3 now supports `ChecksumAlgorithm: CRC32C` in PUT requests and stores it in object metadata, so you can round trip verify without downloading. This is cheap (CRC32C runs at memory bandwidth) and catches silent corruption from cosmic rays, bad RAM, and buggy network hardware. Uncorrectable bit error rates for commodity drives run around 1 per 10^14 bytes, and studies of silent data corruption in large fleets keep finding it at meaningful rates, so at petabyte scale corrupt bytes surface regularly. End to end checksumming is not paranoia, it is table stakes.

Crash consistency for batch pipelines uses write once output semantics. Write to a uniquely named temp path, fsync, then atomic rename to the final path, and the final path is immutable once published. For object stores this maps to upload with a content addressed key (hash of contents) and then publish via a manifest update. The manifest update itself must be atomic, typically via a conditional write on a small metadata object. Iceberg, Delta Lake, and Hudi all implement this pattern with varying levels of transactional guarantee, and at FAANG the choice between them is driven by which engine (Spark, Trino, Flink) you are optimizing for.

---
