## 17. NUMA Balancing for JVM and Other Runtimes

C++ gives you fine control over thread placement, memory allocation, and prefetch. Other runtimes hide some of this behind a runtime layer. Knowing how the JVM, .NET CLR, and Go runtime handle NUMA matters when your C++ service interoperates with them, or when you are choosing a language for a tier of the system.

### The JVM

Hotspot supports NUMA-aware allocation in some collectors:

- **ParallelGC** (`-XX:+UseParallelGC -XX:+UseNUMA`): the young generation is split into per-NUMA-node regions. Each thread allocates from its node's region, and minor GC respects locality.
- **G1GC** (`-XX:+UseG1GC` from JDK 14, more in JDK 21+): regions are allocated NUMA-aware. Mixed collections respect locality where possible.
- **ZGC** (`-XX:+UseZGC`): NUMA awareness improved through JDK 17 to JDK 21. ZGC pre-touches memory at startup with NUMA awareness if `-XX:+UseNUMA` is set.

Activating it:

```
java -Xmx128g -XX:+UseG1GC -XX:+UseNUMA -XX:+UseLargePages -jar app.jar
```

Limitations: the JVM does not pin threads. Application threads are scheduled by the OS and can migrate. The JVM's NUMA awareness applies to allocation, not execution. For a Java service on a multi-socket box, the operator should pin the JVM process to one socket (with `numactl --cpunodebind=0 --membind=0 java ...`) or accept the migration cost.

The Cassandra-on-JVM vs ScyllaDB-on-C++ comparison is partly about this. Cassandra cannot give you per-core sharding because the JVM cannot reliably keep a thread on a core. ScyllaDB pins explicitly and owns each core.

### .NET CLR

.NET ServerGC (`<gcServer enabled="true"/>` or `COMPlus_gcServer=1`) creates one heap per logical processor and runs GC threads in parallel. Server GC is implicitly NUMA-aware: each heap's memory is allocated from the NUMA node of the corresponding processor.

Catch: .NET does not pin application threads either. The benefit of per-processor heaps is partial without thread pinning.

```
COMPlus_GCNumaAware=1 dotnet run
```

For .NET 6+, NUMA awareness is on by default for Server GC.

### Go Runtime

Go's runtime is not NUMA-aware. `runtime.GOMAXPROCS` controls the number of OS threads (M's), but Go has no first-class NUMA concept. Goroutines move freely between threads, and the scheduler does not consider NUMA distance.

Workarounds for Go:

1. Run multiple Go processes, each pinned to one socket with `numactl`.
2. Use `runtime.LockOSThread` to pin a goroutine to its current OS thread, and pin that thread to a CPU with cgo. Tedious and not idiomatic.
3. Accept the overhead. For most Go services, the I/O bottleneck dominates, and NUMA effects are second-order. For tight CPU-bound work, this is why a Go HFT engine or a Go database engine is rare.

The Go-on-multi-socket question is similar to JVM but with even less runtime support. CockroachDB (Go-based) recommends running one process per socket.

### C++ Comparison

C++ has no runtime layer between the application and the kernel for these decisions. You call `pthread_setaffinity_np`, `numa_alloc_onnode`, `mbind`. The result is exactly what you ask for, with no runtime second-guessing.

This is why the most NUMA-sensitive systems (HFT, ScyllaDB, ClickHouse, ZetaSQL, Folly-based services at Meta) are written in C++ or Rust. The runtime control is the differentiator, not just performance per line.

### When to Pick Which

| Workload | C++ | Rust | Go | Java | .NET |
|---|---|---|---|---|---|
| HFT pinned core | Yes | Yes | No | No | No |
| Database storage engine | Yes | Yes | Maybe | Maybe | Maybe |
| Network proxy on multi-socket | Yes | Yes | Yes (one per socket) | Yes (one per socket) | Yes |
| Batch ML inference | Yes | Yes | Maybe | Yes | Yes |
| HTTP API server (latency-tolerant) | Yes | Yes | Yes | Yes | Yes |

The "Yes" cells reflect runtime support for fine-grained NUMA control. "Maybe" means it is possible with effort but not idiomatic.

### Interop

If a C++ service exposes data to a Java consumer (e.g., via shared memory, gRPC, or a memory-mapped file), the C++ side controls placement. The Java side must accept whatever placement the C++ side chose. This is one reason why hybrid architectures often put the latency-critical, NUMA-aware tier in C++ and the business logic in JVM/CLR.

### A Practical Hybrid

A trading firm with a C++ market data engine and a Java strategy engine:

- C++ engine: pinned to socket 0, owns the NIC, parses market data, writes to a shared-memory ring buffer on socket 0.
- Java engine: process started with `numactl --cpunodebind=1 --membind=1`, reads the ring buffer cross-socket. The cross-socket cost is paid once per message, not per field, because the message is read into a local Java heap object.
- Result: market data path is sub-microsecond on socket 0. Strategy logic runs on socket 1 with predictable Java GC behavior.

This is a real architecture pattern at multiple firms.

### Junior to FAANG

A junior assumes all runtimes handle NUMA. A FAANG engineer knows the runtime semantics, picks the language tier-by-tier, and pins processes externally when the runtime cannot.

### Senior at FAANG

Staff engineers make the language choice with NUMA in mind from the start. The "rewrite from Java to C++" engineering ticket is rarely about C++ being faster per line. It is about the runtime support for placement, pinning, and allocation that Java cannot match. The reverse rewrite (C++ to Java) is rare for this reason.

---
