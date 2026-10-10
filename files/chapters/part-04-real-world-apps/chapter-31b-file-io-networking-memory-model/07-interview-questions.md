## Interview Questions

### Q1: Explain how `os.File` reads translate into kernel syscalls on Linux, and why `bufio.Reader` matters for throughput.
**What FAANG expects**: The candidate maps user-space code to `read(2)` syscalls, understands context-switch cost, and quantifies buffering wins.
**Answer**: Every direct `file.Read(p)` issues a `read` syscall, which crosses the user-kernel boundary, copies bytes from the page cache into the user buffer, and returns. Syscalls cost roughly a microsecond each on modern CPUs because of mode switching, stack changes, and cache pollution. When a program reads one byte at a time from a file, the syscall overhead dominates and throughput collapses. Wrapping the file in `bufio.NewReaderSize` with a buffer of 64 KiB or larger amortises the syscall cost. The reader issues one `read` per buffer fill, then serves small `ReadByte` or `ReadString` calls from memory. On Go 1.27 the default buffer is 4096 bytes, which suits small files but is undersized for log ingest or CSV pipelines. Tune the size to match your working set, and pair it with `io.Copy` when possible so the runtime can use `sendfile`, `splice`, or `copy_file_range` on Linux to skip user space entirely.
**Follow-ups**:
- How does `sendfile(2)` differ from a read plus write loop, and when does Go use it?
- What happens if you call `Sync` after every `Write`, and how do you recover durability without that cost?

### Q2: Walk me through the Go memory model guarantee for a channel send, and why an unsynchronized flag read can see stale data.
**What FAANG expects**: The candidate cites the happens-before rule for channels, explains compiler and CPU reordering, and recommends `sync/atomic` or channels over ad-hoc flags.
**Answer**: The Go memory model states that a send on a channel happens-before the corresponding receive completes, which means all writes performed by the sender before the send are visible to the receiver after the receive. Without such an edge, the compiler is free to reorder writes, and the CPU is free to keep values in store buffers or registers. A naive `done bool` flag polled by a second goroutine violates this rule, so the reader may observe the old value forever, or observe a torn word on platforms without atomic word-sized loads. The fix is to use `atomic.Bool`, a channel close, or a mutex, which all introduce documented happens-before edges. Run `go test -race` to catch these in CI. The race detector instruments every memory access and reports unsynchronized conflicts with full stack traces.
**Follow-ups**:
- Why is `sync.Once` safe for lazy initialization even across NUMA sockets?
- How does `atomic.Pointer[T]` help with lock-free config reloads?

### Q3: You are building a TCP server that must handle 200k concurrent connections. What net-package settings and kernel tunables do you touch?
**What FAANG expects**: The candidate discusses `SO_REUSEPORT`, keepalive, `netpoll`, ulimit, ephemeral ports, and graceful shutdown.
**Answer**: Start by raising `ulimit -n` and the systemd `LimitNOFILE` to at least 262144 so the process can open that many sockets. Bind with `net.ListenConfig` and set `Control` to enable `SO_REUSEPORT`, which lets multiple accept goroutines load-balance at the kernel level and removes the single-accept-mutex bottleneck. Enable `net.KeepAliveConfig` with a 30-second idle and 9-second probe so the runtime detects dead peers without waiting for the default two-hour TCP timeout. Tune `net.ipv4.tcp_tw_reuse`, `somaxconn`, and `tcp_max_syn_backlog` on the host. Inside Go, rely on the netpoll runtime, which parks goroutines on epoll and wakes them without a thread per connection. For graceful shutdown, close the listener, then drain active conns with a `context.WithTimeout` deadline, and call `SetReadDeadline` to unblock stuck reads.
**Follow-ups**:
- How does Go's netpoll differ from a thread-per-connection model like classic Java IO?
- When would you drop to `golang.org/x/sys/unix` for `SO_ATTACH_REUSEPORT_EBPF`?

### Q4: Describe three advanced `sync.WaitGroup` patterns beyond the basic fan-out, and explain what changed in Go 1.25.
**What FAANG expects**: The candidate covers bounded concurrency, dynamic Add safety, composition with errgroup, and the new `WaitGroup.Go` ergonomic method.
**Answer**: Go 1.25 added `WaitGroup.Go(func())`, which folds `Add(1) + go + defer Done()` into one call. It eliminates the three most common WaitGroup bugs, missing `Done`, mismatched `Add` counts, and calling `Add` inside the goroutine (which races with `Wait`). Reach for `wg.Go` by default. Beyond that, combine `WaitGroup` with a semaphore channel to bound concurrency. Acquire a token at the top of each spawned function, release on return, and the channel capacity becomes the worker cap. Second, prefer `golang.org/x/sync/errgroup` when any goroutine can fail, it wraps a `WaitGroup`, cancels a shared context on the first error, and returns that error from `Wait`. Pair `errgroup` with `SetLimit(n)` for bounded pipelines without a separate semaphore. Third, for hierarchical work, nest inner `WaitGroup`s inside outer ones, each level waits for its own children before reporting done upward.
**Follow-ups**:
- What breaks if you call `wg.Add(1)` inside a spawned goroutine?
- How does `errgroup.WithContext` help avoid goroutine leaks on early return?

### Q5: A service occasionally reads garbage bytes from a memory-mapped file. Diagnose the class of bug and the fix.
**What FAANG expects**: The candidate identifies tearing, alignment, or race on the mmap region and prescribes atomics, fences, or file locks.
**Answer**: Memory-mapped files expose shared memory to the kernel and other processes, so the Go memory model does not cover concurrent external writers. If another process writes to the same region while your goroutine reads, you can observe partial updates because the page cache is updated at cache-line granularity, and the CPU may reorder loads. The fix depends on the ownership model. For single-writer multi-reader, use a versioned header with an `atomic.Uint64` sequence number, bump it before and after each write, and have readers retry when the sequence is odd or changes mid-read. For multi-writer, use `flock(2)` or POSIX record locks to serialize writers. If you only need crash consistency, call `msync(MS_SYNC)` after writes. In pure Go code, prefer `sync/atomic` with aligned fields, since 64-bit atomics require 8-byte alignment on 32-bit platforms or they will panic.
**Follow-ups**:
- Why is `unsafe.Pointer` arithmetic dangerous inside an mmap slice?
- How does `madvise(MADV_RANDOM)` change the kernel readahead strategy?

### Q6: Since Go 1.19 formalized atomics in the memory model, when should you use `sync/atomic` instead of a `sync.Mutex`?
**What FAANG expects**: The candidate explains the sequential-consistency guarantee, knows the typed `atomic.Int64`/`atomic.Pointer[T]` API, and articulates when atomics are faster and when a mutex is clearer.
**Answer**: Go 1.19 clarified that all `sync/atomic` operations appear in some single sequentially consistent order, so if a `Load` observes a value from a `Store`, every write happens-before the `Store` is visible to the observing goroutine. This makes atomics a legitimate building block for lock-free patterns, not just counters. Use the typed API, `atomic.Int64`, `atomic.Bool`, `atomic.Pointer[T]`, which guarantee 8-byte alignment on 32-bit platforms and can't be accidentally read without `Load`. Good fits are single-word counters, flags, and pointer swaps for lock-free configuration reloads, `liveConfig.Store(newCfg)` replaces the running configuration without readers ever blocking. Reach for a mutex when you need to update multiple fields atomically together, when holding a lock across I/O, or when the critical section is complex enough that a compare-and-swap loop would obscure intent. A good heuristic, if the invariant spans more than one variable, use a mutex.
**Follow-ups**:
- Why does Go use sequential consistency for atomics instead of C++'s acquire/release?
- How does `atomic.Pointer[T].CompareAndSwap` compose with a copy-on-write update pattern?
- What's the failure mode if you mix `atomic.StoreInt64` with a plain `=` assignment on the same variable?

### Q7: Walk through what `net.Dialer.DialContext` does under contention, and which timeouts belong on the dialer vs the `http.Client`.
**What FAANG expects**: The candidate separates connection-establishment timeouts from response and idle timeouts, understands Happy Eyeballs, and knows how context cancellation propagates through dial.
**Answer**: `DialContext` resolves the hostname, selects an address family (Happy Eyeballs races IPv6 and IPv4 with a `FallbackDelay`), opens a socket, and performs the TCP three-way handshake, all interruptible by `ctx.Done()`. Once the handshake completes, the returned `net.Conn` is detached from the context, expiring the context afterward has no effect on reads or writes. That is why production HTTP clients layer timeouts: `Dialer.Timeout` (10s) bounds connection establishment, `Dialer.KeepAlive` (30s) enables TCP keepalive probing to detect dead peers, `Transport.TLSHandshakeTimeout` (10s) bounds the TLS handshake, `Transport.ResponseHeaderTimeout` (20s) bounds time-to-first-byte, `Transport.IdleConnTimeout` (90s) caps pool lifetime, and `Client.Timeout` (60s) is the outer end-to-end budget. For per-request deadlines, always use `http.NewRequestWithContext` with a `context.WithTimeout`, which the transport honors at every stage. Never rely on `Client.Timeout` alone, it is a safety net, not a per-phase bound.
**Follow-ups**:
- What's the difference between `KeepAlive` on the dialer and HTTP keep-alive at the protocol level?
- How does `Transport.MaxConnsPerHost` interact with `MaxIdleConnsPerHost` under burst load?
- When should you set `Dialer.FallbackDelay` to -1, and what do you lose?

### Junior to FAANG: Warm-Up Questions Before the Loop

The questions above target L5 and above. Before the panel, rehearse the L3/L4 warm-ups that interviewers use to calibrate. You should be able to answer each in under two minutes.

**JQ1: What does `defer file.Close()` guarantee, and what does it not guarantee?**
It guarantees that `Close` is called when the enclosing function returns, regardless of return path. It does not guarantee the error from `Close` is checked. For write-side files the `Close` error matters because it may surface a late write failure. Pattern: `defer func() { if cerr := f.Close(); err == nil { err = cerr } }()`.

**JQ2: Why does this leak goroutines?**
```go
for _, url := range urls {
    go fetch(url)
}
```
No tracking of completion, no error collection, no concurrency bound. Under burst load this spawns unlimited goroutines, exhausts the HTTP client's connection pool, or OOMs the process. Fix with `errgroup.Group` and `SetLimit`.

**JQ3: What is the output?**
```go
ch := make(chan int)
go func() { ch <- 1 }()
close(ch)
fmt.Println(<-ch)
```
Data race on the channel itself. `close` concurrent with send is undefined and may panic. Correct: send first, close from the sender's side only, never close on the receiver's side.

**JQ4: Name the three things `sync.Mutex.Unlock` does.**
Releases the mutex (makes it acquirable by the next `Lock` caller), establishes a happens-before edge from code inside the critical section to any subsequent `Lock` on the same mutex, and wakes one waiter via the runtime semaphore. Panics if called on an unlocked mutex.

**JQ5: Why does `go test -race` not catch every race?**
The detector is a dynamic analysis. It only sees races that actually execute during the test. Rare races under specific scheduling or load conditions can be missed. Coverage is a function of test coverage, `-cpu` variation, and `-count` repetition. At Google the CI runs `-race -count=10 -cpu=1,4,16` for concurrency-heavy packages.

### Senior at FAANG: Staff-Level Deep-Dive Questions

**SQ1: Design a write-ahead log with a fsync budget of 2000 ops per second on NVMe. How do you deliver 200k client commits per second?**
The answer is group commit. Every client commit enters a queue protected by a mutex. A dedicated fsync goroutine wakes every 500us (or when queue depth hits 100), takes the queue, does one `write` of the batch followed by one `fsync`, then acknowledges every waiting client. Throughput is bounded by fsync latency (500us on NVMe) times batch size (100) = 200k ops/sec. The trade-off is per-request latency: each client waits up to 500us for the next batch window. Secondary concerns: torn writes on power loss (use checksums and sequence numbers), log rotation (never fsync across file boundaries without ordering), and concurrent reads via `pread`.

**SQ2: Your service's p99 latency spiked from 10ms to 200ms. `strace -c` shows increased `futex` calls. What is your diagnosis tree?**
Increased futex calls mean increased contention on mutexes or runtime semaphores. Diagnosis path: (1) `go tool pprof -block` to find blocked goroutines, (2) `go tool pprof -mutex` to find contended mutexes, (3) check if a hot path was recently wrapped in a mutex, (4) check GC pressure and whether `runtime.semacquire` for GC assists is dominating. Common causes: a global map guarded by a mutex under concurrent read+write (switch to `sync.Map` or `atomic.Pointer[map[K]V]` with copy-on-write), an undersized `sync.Pool` forcing allocations, a `sync.RWMutex` starving writers.

**SQ3: How does Go's netpoller handle the thundering herd problem for 100k connections waking simultaneously from a single broadcast?**
The netpoller returns a batch of ready `pollDesc`s from `epoll_wait`. For each, it extracts the parked goroutine and places it on the local P's runqueue via `injectglist`. If one P's runqueue overflows, the runtime steals work to other Ps. There is no single lock contended by all 100k goroutines. The real bottleneck at that scale is the subsequent application work: if all 100k goroutines try to grab the same mutex after waking, you get a real thundering herd. Solutions: shard the state by connection, use per-connection worker goroutines with their own queues, or use `sync.Pool` to reduce allocation contention.

**SQ4: Explain why Peterson's mutual exclusion algorithm does not work with plain variables in Go, and show the atomic version.**
With plain reads and writes, both the compiler and CPU can reorder the flag-set and turn-set operations, which breaks Peterson's invariant (that one thread sees the other's flag before entering the critical section). The atomic version uses `atomic.Int32` for `flag[0]`, `flag[1]`, and `turn`, with `Store` and `Load`. Because Go's memory model provides sequential consistency across atomic operations, the reordering is prevented. For production code, of course, use `sync.Mutex`. Peterson's is a teaching exercise.

**SQ5: You discover a race in production via a canary fleet report. The stack trace points at a map read and a map write on different goroutines. The code has been in production for three years. Why now?**
Timing changed. Possible causes: GOMAXPROCS changed (cgroup CPU allocation), goroutine scheduler bias changed between Go releases, workload skew changed so the two goroutines now run more concurrently, or a new caller path invokes both code paths in the same request. The fix is the same regardless (add synchronization), but the root cause investigation matters for confidence that you found the whole bug and not just one symptom.

**SQ6: Compare BBRv3 and CUBIC for a service that does cross-region replication over a 100ms RTT link with 1% packet loss.**
CUBIC treats loss as congestion and backs off aggressively, reducing throughput to roughly `MSS/(RTT*sqrt(loss))` which at 1500 bytes, 100ms, and 1% loss is about 1.5 Mbps. BBR models bandwidth and RTT directly and does not react to loss unless it also indicates queue buildup. On the same link BBR often delivers 50-100 Mbps. BBRv3 adds better fairness with CUBIC flows and a PROBE_UP state for more responsive bandwidth discovery. For intra-datacenter (sub-millisecond RTT, near-zero loss), the difference is small. For WAN replication, BBRv3 is typically 10-50x CUBIC.

**SQ7: Walk me through how you would verify that a new leader-election implementation is correct.**
Four layers. (1) Write a TLA+ spec of the protocol, including failure modes (process crash, network partition, message reordering). Model-check with TLC up to a bounded configuration. (2) Write the Go implementation as a translation of the spec. (3) Unit-test the Go implementation with Porcupine against a sequential model to catch local concurrency bugs. (4) Run Jepsen-style fault injection against a multi-node deployment, logging all operations, and check histories with Elle for linearizability violations. Any one layer catches different bug classes. TLA+ catches design bugs. Porcupine catches local concurrency bugs. Jepsen catches real-world timing and failure-interaction bugs.
