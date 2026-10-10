## 31B.1 File I/O Internals

### os.File internally

Every `os.File` is a thin wrapper around an operating system file descriptor, an `int` on Unix, a `HANDLE` on Windows. When you call `Read` or `Write`, Go translates it into the corresponding syscall. The `Fd()` method exposes the raw descriptor for cases where you need to pass it to lower-level syscall functions. `Stat()` retrieves metadata without reading content, and `Seek()` repositions the read/write cursor for random access.

```go
package main

import (
    "fmt"
    "io"
    "os"
)

// os.File is a thin wrapper around a file descriptor (int on Unix, HANDLE on Windows)
// Every read/write operation ultimately calls:
//   Unix:    syscall.Read(fd, buf) / syscall.Write(fd, buf)
//   Windows: syscall.ReadFile(handle, buf) / syscall.WriteFile(handle, buf)

func fileInternals() {
    f, err := os.Open("example.txt")
    if err != nil {
        if os.IsNotExist(err) {
            fmt.Println("file not found")
            return
        }
        fmt.Println("unexpected error:", err)
        return
    }
    defer f.Close()

    // Get file descriptor (for low-level operations or syscall package)
    fd := f.Fd() // uintptr on Unix
    fmt.Println("fd:", fd)

    // File info without reading content
    info, _ := f.Stat()
    fmt.Printf("name=%s size=%d mode=%s modtime=%s\n",
        info.Name(), info.Size(), info.Mode(), info.ModTime())

    // Seek: position the read cursor
    // io.SeekStart=0, io.SeekCurrent=1, io.SeekEnd=2
    offset, _ := f.Seek(100, io.SeekStart)  // move to byte 100
    fmt.Println("seeked to:", offset)

    offset2, _ := f.Seek(-50, io.SeekEnd)   // 50 bytes from end
    fmt.Println("seeked to:", offset2)

    offset3, _ := f.Seek(0, io.SeekCurrent) // current position (no movement)
    fmt.Println("current position:", offset3)
}
```

### os.Open vs os.Create vs os.OpenFile

Go provides three functions for opening files. `os.Open` opens read-only. `os.Create` creates a new file or truncates an existing one for writing. `os.OpenFile` gives full control over flags and permission bits, which you need for append-mode logging, exclusive creation, or read-write access without truncation.

```go
package main

import (
    "fmt"
    "os"
)

func fileOpenModes() {
    // os.Open: read-only, equivalent to OpenFile(name, O_RDONLY, 0)
    f1, err := os.Open("data.txt")
    _ = f1; _ = err

    // os.Create: create/truncate for write-only
    // Equivalent to OpenFile(name, O_RDWR|O_CREATE|O_TRUNC, 0666)
    f2, err := os.Create("output.txt")
    _ = f2; _ = err

    // os.OpenFile: full control over flags and permissions
    f3, err := os.OpenFile("log.txt",
        os.O_APPEND|os.O_CREATE|os.O_WRONLY, // flags
        0644, // permission bits (ignored if file exists)
    )
    if err != nil {
        fmt.Println("error:", err)
        return
    }
    defer f3.Close()
    fmt.Fprintln(f3, "appended log line")

    // Common flag combinations:
    // Read-only:           O_RDONLY
    // Write-only create:   O_WRONLY | O_CREATE | O_TRUNC
    // Append:              O_APPEND | O_CREATE | O_WRONLY
    // Read-write no trunc: O_RDWR | O_CREATE
    // Exclusive create:    O_RDWR | O_CREATE | O_EXCL (fails if exists)
}
```

### The Page Cache, O_DIRECT, and io_uring

Beneath every `os.File.Read` on Linux sits the kernel page cache. When your program reads a file, the kernel first checks whether the 4 KiB page is already cached in RAM, if so, it just copies it into your buffer, if not, it schedules a disk read, parks the process, and fills the page on completion. This is why the second read of the same file is typically 1000x faster than the first. You can hint to the kernel about access patterns with `posix_fadvise(2)`, `POSIX_FADV_SEQUENTIAL` doubles the readahead window for log processing, `POSIX_FADV_DONTNEED` drops pages from the cache after a one-shot scan so they don't evict hot pages, and `POSIX_FADV_RANDOM` disables readahead for database-like workloads. In Go, call these through `golang.org/x/sys/unix.Fadvise`.

For databases, backup tools, and other workloads that manage their own caching, opening a file with `O_DIRECT` bypasses the page cache entirely, reads and writes go straight to the block device. This requires page-aligned buffers (use `unix.Mmap` or manual alignment) and a multiple-of-block-size I/O size, but it removes the double-buffering between page cache and your user buffer.

Linux's `io_uring` is the modern high-throughput I/O interface, it lets a single syscall submit and reap hundreds of I/O operations. The Go standard library does not yet use `io_uring` internally (the netpoller still uses `epoll`), but third-party bindings such as `github.com/iceber/iouring-go` and `github.com/godzie44/go-uring` expose it for extreme-throughput storage code. For 99% of Go services, the standard `os` + `bufio` + `io.Copy` path is already optimal because the runtime uses `sendfile`, `splice`, and `copy_file_range` through `io.ReaderFrom` / `io.WriterTo` fast paths.

### bufio: Buffered I/O Internals

Without buffering, every `Read` or `Write` call triggers a syscall, expensive because it crosses the user/kernel boundary. The `bufio` package wraps any `io.Reader` or `io.Writer` with an in-memory buffer, batching small operations into larger chunks. `bufio.Scanner` provides a higher-level line-oriented API with configurable token splitting. On the write side, remember that `bufio.Writer` holds data in memory until you call `Flush()`, skipping the flush means losing the last partial buffer.

```go
package main

import (
    "bufio"
    "fmt"
    "io"
    "os"
    "strings"
)

// Without buffering: each Read/Write = one syscall (expensive!)
// With buffering: accumulate in userspace, one syscall per 4KB (or on flush)

func bufferedReading() {
    f, _ := os.Open("largefile.txt")
    defer f.Close()

    // bufio.NewReader wraps any io.Reader with a 4096-byte buffer
    // Reads from the underlying file in chunks, serves from buffer
    reader := bufio.NewReaderSize(f, 65536) // 64KB buffer for large files

    // ReadString reads until delimeter (inclusive)
    for {
        line, err := reader.ReadString('\n')
        if len(line) > 0 {
            fmt.Print(line) // process line
        }
        if err == io.EOF {
            break
        }
        if err != nil {
            fmt.Println("error:", err)
            break
        }
    }
}

func bufferedScanner() {
    // bufio.Scanner: higher-level than ReadString, but limited to 64KB lines by default
    f, _ := os.Open("data.txt")
    defer f.Close()

    scanner := bufio.NewScanner(f)

    // Increase buffer for long lines
    buf := make([]byte, 1024*1024) // 1MB buffer
    scanner.Buffer(buf, len(buf))

    // Custom split function (default is ScanLines)
    // scanner.Split(bufio.ScanWords)
    // scanner.Split(bufio.ScanBytes)
    // scanner.Split(bufio.ScanRunes)

    for scanner.Scan() {
        line := scanner.Text() // string (copies bytes)
        // or: scanner.Bytes() - []byte (no copy, valid until next Scan call)
        fmt.Println(line)
    }

    if err := scanner.Err(); err != nil {
        fmt.Println("scan error:", err)
    }
}

func bufferedWriting() {
    f, _ := os.Create("output.txt")
    defer f.Close()

    // bufio.Writer buffers writes - call Flush() to ensure data is written
    writer := bufio.NewWriterSize(f, 65536)
    defer writer.Flush() // CRITICAL: always flush a bufio.Writer!

    for i := range 1000 {
        fmt.Fprintf(writer, "line %d\n", i) // writes to buffer, not file
    }
    // Without defer Flush(): last partial buffer NOT written to file!
}

// Performance tip: ReadFrom/WriteTo for zero-copy I/O
func copyFile(src, dst string) error {
    in, err := os.Open(src)
    if err != nil {
        return err
    }
    defer in.Close()

    out, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer out.Close()

    // io.Copy uses WriteTo/ReadFrom if available (sendfile on Linux)
    _, err = io.Copy(out, in) // may use sendfile() - zero copies in kernel
    return err
}

// ReadAll: reads entire content into memory (use for small files only!)
func readSmallFile(path string) (string, error) {
    data, err := os.ReadFile(path) // equivalent to open + ReadAll + close
    return string(data), err
}

// WriteAll: write entire content atomically
func writeSmallFile(path string, data []byte) error {
    // Write to temp file then rename - atomic from filesystem perspective
    tmp := path + ".tmp"
    if err := os.WriteFile(tmp, data, 0644); err != nil {
        return err
    }
    return os.Rename(tmp, path) // atomic on most filesystems
}

// Peek: look ahead without consuming (bufio.Reader only)
func detectFileType(r *bufio.Reader) string {
    header, _ := r.Peek(4) // peek at first 4 bytes
    if len(header) >= 4 {
        if strings.HasPrefix(string(header), "\x89PNG") {
            return "PNG"
        }
        if string(header[:2]) == "\xFF\xD8" {
            return "JPEG"
        }
        if string(header[:4]) == "PK\x03\x04" {
            return "ZIP"
        }
    }
    return "unknown"
}
```

### io.Reader/Writer Composition

The `io.Reader` and `io.Writer` interfaces are Go's universal I/O abstraction. Because they are single-method interfaces, any reader can wrap any other reader, you build pipelines by stacking layers. A counting reader tracks bytes flowing through. A hashing reader computes a checksum as data passes. `io.Pipe` creates a synchronous in-memory pipe between a writer goroutine and a reader. `io.TeeReader` duplicates a stream to two destinations. `io.LimitReader` caps how many bytes can be read, which is useful for defending against oversized uploads.

```go
package main

import (
    "compress/gzip"
    "crypto/sha256"
    "encoding/hex"
    "io"
    "os"
    "strings"
)

// io.Reader and io.Writer are Go's universal I/O interfaces
// They compose - any Reader can wrap any other Reader

// Counting bytes as they pass through
type CountingReader struct {
    r    io.Reader
    read int64
}

func (c *CountingReader) Read(p []byte) (n int, err error) {
    n, err = c.r.Read(p)
    c.read += int64(n)
    return
}

// Hash-computing reader (reads and computes SHA256 simultaneously)
type HashReader struct {
    r    io.Reader
    hash io.Writer // sha256.New() implements io.Writer
}

func (h *HashReader) Read(p []byte) (n int, err error) {
    n, err = h.r.Read(p)
    if n > 0 {
        h.hash.Write(p[:n]) // feed bytes to hasher as they flow through
    }
    return
}

// Pipeline: read file → count bytes → compute hash → decompress gzip
func processFile(path string) (sum string, size int64, err error) {
    f, err := os.Open(path)
    if err != nil {
        return "", 0, err
    }
    defer f.Close()

    hasher := sha256.New()
    counter := &CountingReader{r: f}
    hashReader := &HashReader{r: counter, hash: hasher}

    // gzip.NewReader takes any io.Reader
    gz, err := gzip.NewReader(hashReader)
    if err != nil {
        return "", 0, err
    }
    defer gz.Close()

    // io.Discard: read and discard (triggers the pipeline)
    if _, err := io.Copy(io.Discard, gz); err != nil {
        return "", 0, err
    }

    return hex.EncodeToString(hasher.Sum(nil)), counter.read, nil
}

// io.Pipe: synchronous in-memory pipe between writer and reader
func pipeExample() {
    pr, pw := io.Pipe()

    // Writer goroutine
    go func() {
        defer pw.Close()
        // Write compressed data into the pipe
        gz := gzip.NewWriter(pw)
        io.WriteString(gz, "hello, compressed world!")
        gz.Close()
    }()

    // Reader: decompress from the pipe
    gz, _ := gzip.NewReader(pr)
    data, _ := io.ReadAll(gz)
    fmt.Println(string(data)) // hello, compressed world!
}

// TeeReader: read and simultaneously write to two destinations
func teeExample(src io.Reader) {
    var buf strings.Builder
    tee := io.TeeReader(src, &buf) // anything read from tee is also written to buf

    io.Copy(io.Discard, tee) // drain: reads src, writes copy to buf
    fmt.Println("read:", buf.String())
}

// LimitReader: limit how much can be read (security: prevent reading huge files)
func limitedRead(r io.Reader, maxBytes int64) ([]byte, error) {
    limited := io.LimitReader(r, maxBytes+1) // +1 to detect truncation
    data, err := io.ReadAll(limited)
    if err != nil {
        return nil, err
    }
    if int64(len(data)) > maxBytes {
        return nil, fmt.Errorf("data exceeds %d bytes", maxBytes)
    }
    return data, nil
}
```

### Memory-Mapped Files

Memory mapping maps a file's contents directly into the process's virtual address space. Instead of explicit `Read` calls, the OS pages data in from disk on demand when your code accesses the mapped byte slice. This is particularly effective for random access patterns on large files, since the OS kernel manages caching, prefetching, and eviction. On Linux, `syscall.Mmap` wraps the `mmap(2)` syscall. You must call `Munmap` when finished to release the mapping.

```go
package main

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// Memory mapping: maps file content directly into process address space
// OS pages in data on demand from disk - no explicit Read() calls needed
// Best for: random access to large files, multiple processes sharing data

func mmapExample(path string) ([]byte, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    info, err := f.Stat()
    if err != nil {
        return nil, err
    }
    size := int(info.Size())
    if size == 0 {
        return nil, nil
    }

    // syscall.Mmap maps the file into memory
    data, err := syscall.Mmap(
        int(f.Fd()),
        0,                          // offset
        size,                       // length
        syscall.PROT_READ,          // read-only
        syscall.MAP_SHARED,         // changes visible to other processes (MAP_PRIVATE for copy-on-write)
    )
    if err != nil {
        return nil, fmt.Errorf("mmap: %w", err)
    }

    // data is a []byte backed by the file - any read triggers page fault = disk read
    // The OS handles caching, prefetching, and eviction automatically
    return data, nil
}

func mmapUnmap(data []byte) error {
    return syscall.Munmap(data) // unmap when done - MUST be called!
}

// Write to mmap'd file (requires PROT_READ|PROT_WRITE and MAP_SHARED)
func mmapWriteExample(path string) error {
    f, err := os.OpenFile(path, os.O_RDWR, 0644)
    if err != nil {
        return err
    }
    defer f.Close()

    info, _ := f.Stat()
    data, err := syscall.Mmap(int(f.Fd()), 0, int(info.Size()),
        syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
    if err != nil {
        return err
    }
    defer syscall.Munmap(data)

    // Write directly to memory - changes are flushed to file by OS
    copy(data[0:5], "hello")

    // Force immediate flush (optional - OS will flush eventually)
    _, _, errno := syscall.Syscall(syscall.SYS_MSYNC,
        uintptr(unsafe.Pointer(&data[0])),
        uintptr(len(data)),
        syscall.MS_SYNC)
    if errno != 0 {
        return fmt.Errorf("msync: %w", errno)
    }
    return nil
}
```

### io/fs: Virtual Filesystem Interface

The `fs.FS` interface (added in Go 1.16) defines a single method, `Open(name string) (fs.File, error)`, that any type can implement. This means you can write code that works identically against `embed.FS` (compiled-in assets), `os.DirFS` (a real directory), `fstest.MapFS` (in-memory test data), or a custom implementation backed by S3, ZIP archives, or anything else. The `fs.WalkDir`, `fs.ReadFile`, `fs.Glob`, and `fs.Sub` functions all operate on this interface.

```go
package main

import (
    "embed"
    "fmt"
    "io/fs"
    "os"
    "testing"
    "testing/fstest"
)

//go:embed testdata
var testFS embed.FS

// fs.FS is an interface - any type that implements Open(name) can be a filesystem
// This enables writing code that works with embed.FS, os.DirFS, zip archives, etc.

func processFS(fsys fs.FS) error {
    // Walk all files in the FS
    return fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        if d.IsDir() {
            return nil
        }
        data, err := fs.ReadFile(fsys, path)
        if err != nil {
            return err
        }
        fmt.Printf("%s: %d bytes\n", path, len(data))
        return nil
    })
}

func main() {
    // Use with embedded files
    processFS(testFS)

    // Use with real filesystem directory
    processFS(os.DirFS("."))

    // Sub: restrict to a subdirectory
    sub, _ := fs.Sub(testFS, "testdata/configs")
    processFS(sub)

    // Glob: find matching files
    matches, _ := fs.Glob(testFS, "testdata/**/*.json")
    fmt.Println(matches)
}

// Testing fs.FS implementations with fstest.MapFS
func TestMyFS(t *testing.T) {
    fsys := fstest.MapFS{
        "config.yaml":     {Data: []byte("host: localhost\nport: 8080")},
        "templates/index.html": {Data: []byte("<html>Hello</html>")},
        "static/style.css":    {Data: []byte("body { margin: 0; }")},
    }

    // Test your code with in-memory filesystem - no real files needed!
    if err := processFS(fsys); err != nil {
        t.Fatal(err)
    }
}
```

### Junior to FAANG: From `os.Open` to Syscall Tracing

When you call `os.ReadFile("config.json")`, the Go runtime performs a chain of operations: `open(2)` to get a file descriptor, `fstat(2)` to learn the size, then a loop of `read(2)` calls into a grown buffer, then `close(2)`. As a junior engineer you can verify this with `strace -e openat,read,close ./myprogram` on Linux or `dtruss -t read ./myprogram` on macOS. Running these commands against your own programs is the fastest way to stop treating IO as a black box.

A worked example. Suppose you wrote this code and it feels slow on a 2 GB log file:

```go
f, _ := os.Open("big.log")
defer f.Close()
scanner := bufio.NewScanner(f)
for scanner.Scan() {
    process(scanner.Bytes())
}
```

The default `bufio.Scanner` buffer is 64 KB, which throws `bufio.ErrTooLong` on long lines. Fix with `scanner.Buffer(make([]byte, 1<<20), 16<<20)`. The next speedup is to skip line splitting entirely and use `io.Copy` with a 1 MB buffer if you are just forwarding bytes. The conceptual jump is that `bufio.Scanner` allocates per-token slices and pays CPU for the split, while `io.Copy` issues one `read` and one `write` per chunk.

First-job context: you will be handed a service that writes log events to disk and someone will ask "why is our p99 disk latency 200ms?" The answer is usually that `os.File.Write` does not buffer, so each log line is a syscall, and each syscall competes with every other thread for the filesystem lock. Wrapping the file in `bufio.NewWriterSize(f, 64<<10)` and flushing every 100ms is the classic fix. Interviewers at L3/L4 phone screens ask exactly this question, often framed as "design a log writer that survives crashes without losing more than 100ms of data."

Three prerequisite skills before the senior material lands:

1. Read `man 2 read`, `man 2 write`, `man 2 open` on Linux. Go's stdlib is a direct mirror.
2. Know that `syscall` is deprecated and `golang.org/x/sys/unix` is the modern path.
3. Understand that `os.File.Write` returns after the data is handed to the kernel, not after it hits disk. `f.Sync()` calls `fsync(2)` to flush the page cache.

### Senior at FAANG: Syscall Layer, Zero-Copy, and io_uring in Go 1.27

At staff level, file IO is a kernel interaction with latency characteristics that depend on the syscall chosen, the filesystem type, the page cache state, and the storage medium. Go's stdlib picks safe defaults. Performance critical services override those defaults.

**Positional reads and `preadv2`.** `read(2)` mutates the file offset, so concurrent readers on one fd need a lock. `pread(2)` takes the offset as an argument, enabling lock-free parallel reads of the same fd. Go exposes this via `(*os.File).ReadAt`, which on Linux calls `pread64`. At scale this matters: a columnar database scanning a 1 TB Parquet file launches dozens of goroutines, each doing `ReadAt` into disjoint ranges. Using `Read`+`Seek` instead would serialize them behind a mutex.

`preadv2` adds scatter-gather plus flags. The most useful flag is `RWF_NOWAIT`, which returns `EAGAIN` if the page is not cached instead of blocking on disk. A latency-sensitive cache can attempt `RWF_NOWAIT`, fall back to an async prefetch on miss, and return a cached-only response to the client in under a millisecond. Go 1.27 does not expose `RWF_NOWAIT` directly in `os` but you can reach it via `unix.Preadv2(fd, iovs, offset, unix.RWF_NOWAIT)`.

**Scatter-gather with `readv`/`writev`.** If you are writing a proxy that reassembles fragmented protocol frames, `writev(2)` sends multiple buffers in one syscall. Go's `net.Buffers` type uses `writev` internally for `TCPConn`. On disk, `(*os.File).Write` does not batch. To scatter-gather into a file, call `unix.Writev(int(f.Fd()), iovecs)` directly. This reduces syscall count from N to 1 for N header+body pairs and is the right move for write-heavy journals.

**Zero-copy: `sendfile` and `splice`.** `sendfile(2)` copies between two fds inside the kernel, avoiding the user-space bounce buffer. Go's `net/http.ServeContent` path uses `sendfile` on Linux when the source is `*os.File` and the destination is a `*net.TCPConn`. You get it for free if you `io.Copy(conn, file)` and both types satisfy the runtime's `readFrom`/`writeTo` interfaces. Verify with `strace -e sendfile` in staging. If you see `read`+`write` instead, something in your middleware wrapped the `ResponseWriter` in a type that hides the `io.ReaderFrom` interface. This happens routinely with gzip and logging middleware. The fix is to unwrap or to implement `io.ReaderFrom` passthrough on the wrapper.

`splice(2)` moves bytes between two pipe ends or a pipe and a socket without copying into user space. Go does not call `splice` automatically. For high-throughput TCP-to-TCP proxies, hand-rolling a splice loop via `unix.Splice` can double throughput on Linux 6.x. See the `github.com/pion/transport` codebase for production examples.

**io_uring in Go.** Since Linux 5.1, `io_uring` offers a submission queue and completion queue shared between user space and the kernel, eliminating syscall overhead entirely for submitted operations. Go's runtime does not use `io_uring` in 1.26 or 1.27. There are several libraries worth knowing:

- `github.com/Iceber/iouring-go`: direct ring access, manual submission, good for benchmarking.
- `github.com/godzie44/go-uring`: an `io_uring` library and runtime for Go.
- `github.com/ii64/gouring`: low-level bindings implemented without cgo.

The reason the Go runtime has not adopted `io_uring` is that the netpoller already amortizes epoll overhead well for network IO, and file IO in Go is typically small enough that syscall cost is not the bottleneck. Where `io_uring` wins: services doing millions of small file reads per second, like object storage gateways. Meta has published on adopting `io_uring` across storage-heavy backends with meaningful CPU savings (io_uring originated there), though that work is in C. A representative modern case is an ML inference fleet loading model weights, where the bandwidth of many concurrent pread calls into NVMe exceeds what the Go runtime can schedule through blocking syscalls.

**O_DIRECT and the page cache.** `O_DIRECT` bypasses the kernel page cache. You almost never want it. The exceptions: databases with their own buffer pool (PostgreSQL, MySQL/InnoDB, CockroachDB, TiKV), and sequential reads of data that will not be reused. If you use `O_DIRECT`, you must align buffers to the block size (typically 4 KB). Go does not provide aligned allocation. The idiom is `buf := make([]byte, size+4096); aligned := buf[4096-int(uintptr(unsafe.Pointer(&buf[0])))%4096:]`.

**fsync and crash safety.** `fsync(2)` is the only primitive that survives a crash. `os.File.Sync` calls it. On ext4 with default mount options, `fsync` flushes the journal and the data blocks. On XFS, it flushes the log. On btrfs, it is more expensive. Latency ranges from 50us on NVMe to 10ms on spinning disks. A write-ahead log for a consensus protocol (Raft, Paxos) must `fsync` before acknowledging the client, which caps throughput at roughly `1/fsync_latency` transactions per second per log. The standard trick is group commit: batch N pending writes, issue one `fsync`, and reply to all N clients. etcd, CockroachDB, and YugabyteDB all do this.

**File locking.** Go has no stdlib file locking. Use `github.com/rogpeppe/go-internal/lockedfile` or `golang.org/x/sys/unix.Flock`. `flock(2)` is advisory. `fcntl(F_SETLK)` is also advisory but per-byte-range. Neither survives NFS reliably. If you need cluster-wide file locks, use a real coordination service.

**Staff-level review checklist for file IO code:**

1. Does every `os.Open` have a matching `Close`, including on error paths?
2. Is `Write` wrapped in a buffer, or justified as direct by latency requirements?
3. Are concurrent reads of one file using `ReadAt`, not `Read`+`Seek`?
4. Is `fsync` called where durability matters, and batched where it is a bottleneck?
5. Is the syscall count per request traceable via `strace -c`?
6. Does the code survive a full disk (`ENOSPC`) and an EIO on read?
7. Is there a metric for p99 `read`/`write` latency separate from application latency?

---
