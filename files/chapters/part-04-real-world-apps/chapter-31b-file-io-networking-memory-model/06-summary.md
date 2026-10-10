## Summary

### File I/O Best Practices

| Operation | Tool | Notes |
|-----------|------|-------|
| Read whole file | `os.ReadFile` | Only for small files (<100MB) |
| Read line by line | `bufio.Scanner` | Memory-efficient for large files |
| Write with buffering | `bufio.NewWriter` + `Flush()` | Always Flush! |
| Large sequential copy | `io.Copy` | May use sendfile() syscall |
| Random access large file | `syscall.Mmap` | OS handles page caching |
| Binary I/O | `encoding/binary` | Fixed-size types: Read/Write with binary.LittleEndian |
| Virtual filesystem | `io/fs.FS` | Makes code testable with `fstest.MapFS` |

### net Package Best Practices

| Topic | Rule |
|-------|------|
| Deadlines | Always set `conn.SetDeadline()` - connections without deadlines leak |
| Connection pooling | Use `http.Transport.MaxIdleConnsPerHost` for HTTP. Implement manually for raw TCP |
| Keepalive | Enable `net.KeepAliveConfig` for long-lived connections (detects peer crashes) |
| DNS | Use `context` with `net.Resolver` for timeout-safe resolution |
| Unix sockets | Use for same-machine IPC - faster than TCP loopback |
| TCP options | `SetNoDelay(true)` for low-latency, `SetReadBuffer` for throughput |

### Memory Model Quick Reference

The Go memory model defines happens-before relationships, the formal guarantee that a write in one goroutine will be visible to a read in another. Without an explicit happens-before edge (a channel operation, mutex unlock, `sync.Once`, or atomic), the compiler and CPU are free to reorder operations, meaning a read may observe a stale or partially-written value even when the program appears sequentially correct. A data race, any unsynchronized concurrent access where at least one side is a write, is undefined behavior in Go, and the race detector (`go test -race`) is the canonical tool for catching these at test time.

```
Happens-before guarantees:
  Within goroutine:    statement order
  Goroutine start:     writes before "go" are visible in new goroutine
  Goroutine join:      writes in goroutine are visible after wg.Wait()
  Channel send:        write before send is visible after corresponding receive
  Channel close:       writes before close are visible after receive of zero value
  Mutex unlock:        writes inside lock are visible to next lock holder
  sync.Once:           writes in once.Do are visible to all callers after Do()
  atomic.Store/Load:   sequentially consistent within the atomic variable

Data race = no happens-before between a write and a concurrent read = undefined behavior
Always: go test -race ./...
```

### Junior to FAANG: The Working Checklist

Before you close this chapter, confirm you can produce the following artifacts from memory:

1. A 20-line TCP echo server that uses deadlines and does not leak on client disconnect.
2. A 15-line concurrent URL fetcher using `errgroup` with a SetLimit of 16.
3. A snippet demonstrating that `for _, v := range slice { go func() { use(v) }() }` is broken in Go 1.21 and below.
4. The four happens-before edges you use most often: channel send/receive, mutex unlock/lock, WaitGroup Done/Wait, atomic Store/Load.
5. The single line you add to every test file: `defer goleak.VerifyNone(t)` (or the suite-level `TestMain` variant).

If any of these feels uncertain, revisit the earlier sections before sitting in an L3 or L4 interview loop.

### Senior at FAANG: The Staff-Level Mental Model

At staff and principal level this chapter collapses into a small set of invariants that you enforce across every service you design or review.

**IO invariants.** Every syscall is observable. Every blocking IO has a deadline. Every file is opened with a defined failure mode for `ENOSPC`, `EIO`, and `EMFILE`. Every network connection has explicit read and write deadlines, a TLS config with minimum version 1.3, and a congestion control choice (BBR for WAN, CUBIC for intra-datacenter). Every proxy-style data path tries to reach `sendfile` or `splice` before falling back to `io.Copy`. Zero-copy wins are a review-time question, not a profiling-time discovery.

**Memory-model invariants.** Every shared variable falls into one of three categories: immutable after init, protected by a mutex, or accessed exclusively via `sync/atomic`. Double-checked locking is banned. `sync.Once` or `atomic.Pointer` is the only acceptable lazy-init. Every claim of happens-before is documented in a comment naming the synchronizing primitive. Every custom concurrent data structure has a Porcupine test. Every distributed protocol has a TLA+ spec.

**Concurrency invariants.** Every goroutine has a tracked lifetime. Every fanout has a concurrency bound. Every worker recovers from panic. Every test verifies goroutine cleanup. The fleet has a dashboard for goroutine count per instance, with alerts at 10x baseline.

**Observability invariants.** Every service exports metrics for: syscall latency (p50/p99/p999 on `read`/`write`/`fsync`), socket states (`ESTABLISHED`, `TIME_WAIT`, `CLOSE_WAIT`), goroutine count, thread count (M count), GC pause time, heap live bytes, and race-detector canary findings. Tracing spans cover every outbound RPC with propagation of `traceparent`.

**Fleet-level concerns.** `SO_REUSEPORT` for listeners above 10k accepts/sec. TLS session ticket keys shared and rotated every 24h. DNS resolution cached. File descriptor limit raised to 1M and monitored. Net.core.somaxconn and net.ipv4.tcp_max_syn_backlog tuned. Kernel at Linux 6.x LTS for modern `io_uring` and BBRv3 support.

If you can walk a new hire through each of these invariants and justify each one, you are operating at staff level for the subject matter of this chapter.

---

*Next chapter: Chapter 31C - Internationalization and Localization*
