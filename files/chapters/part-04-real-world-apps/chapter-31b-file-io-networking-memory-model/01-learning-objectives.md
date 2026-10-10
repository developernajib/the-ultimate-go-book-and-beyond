## Learning Objectives

1. **Write efficient file I/O code** using the right buffering strategy for each workload
2. **Use io.Reader/Writer composition** to build reusable, testable I/O pipelines
3. **Understand TCP connection management** in Go and tune it for your use case
4. **Read the Go Memory Model** and apply its happens-before rules to write correct concurrent code
5. **Know what sync.WaitGroup, sync.Once, and atomic operations guarantee** about memory visibility
6. **Use memory-mapped files** for high-performance random access to large files

### Junior to FAANG: Entry-Level Objectives

Before attacking the staff material, confirm you can do the following unaided:

1. Open a file, copy it to another file using `io.Copy`, and close both without leaking a descriptor if an error fires mid-copy.
2. Accept TCP connections in a loop, spawn a goroutine per connection, and shut the listener down cleanly on SIGTERM.
3. Explain why `for i := range 10 { go func() { fmt.Println(i) }() }` prints unpredictable values in Go 1.21 and earlier but is fixed in Go 1.22+.
4. Recognize a data race by reading `go run -race` output and point at the offending read and write addresses.
5. Use `sync.WaitGroup.Add` before spawning the goroutine, never inside it, and explain the race if you do it the wrong way.

Interviewers at the new-grad and L3 tier ask these five things in some form. If any feel shaky, the Senior objectives below will not land.

### Senior at FAANG: Staff-Level Objectives

At the staff and principal tier, the objectives expand to cover the kernel boundary, formal reasoning, and fleet-wide operational concerns:

1. **Syscall-level IO reasoning.** Choose between `read`/`pread`/`preadv2` with `RWF_NOWAIT`, explain when `io_uring` beats epoll for your workload, and justify `sendfile`/`splice` for proxy services. Know when `O_DIRECT` bypasses the page cache and when it is the wrong answer (almost always, except for databases with their own buffer pool).
2. **Netpoller internals.** Describe how `runtime.netpoll` parks goroutines on `gopark`, how `netpollready` requeues them on the runq, and why blocking syscalls use a separate M via `entersyscall`/`exitsyscall`. Explain the interaction with `GOMAXPROCS` and cgroup CPU limits on Kubernetes.
3. **Memory model proofs.** Given a racy program, produce a happens-before proof or a counterexample execution. Reason about `sync.Once.Do` as a release/acquire pair. Know that `atomic.Load` in Go provides sequential consistency per the 1.19 memory model update, not just acquire semantics.
4. **Production race hunting.** Run the race detector in canary fleets with sampled traffic, know the 8x memory and 2-20x CPU overhead, and triage `runtime.raceread`/`runtime.racewrite` reports against git blame. Compare against ThreadSanitizer traces from C++ sibling services.
5. **Congestion and tuning at scale.** Choose BBRv3 over CUBIC for cross-region replication. Tune `TCP_NODELAY`, `TCP_QUICKACK`, `SO_REUSEPORT`, and `SO_INCOMING_CPU` for a 10M RPS fleet. Understand when TLS session resumption saves handshake cost and when 0-RTT opens replay attacks.
6. **Formal and empirical verification.** Write a TLA+ spec for a leader-election protocol, check linearizability with Porcupine or Elle, and run Jepsen-style fault injection against a Go service that claims strong consistency.

By the end of this chapter you should be able to lead a design review for a network service where the failure budget is single-digit seconds per quarter.

---
