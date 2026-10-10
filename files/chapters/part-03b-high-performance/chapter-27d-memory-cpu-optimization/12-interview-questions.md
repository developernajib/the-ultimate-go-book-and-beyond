## Interview Questions

These questions test whether a candidate understands hardware-level performance behavior and can apply that understanding to Go code. They appear frequently in interviews for infrastructure, database, and high-performance systems roles.

**What FAANG expects:** Candidates should reason from first principles about cycles, cache lines, and memory bandwidth. Name-dropping `sync.Pool` or `pprof` is table stakes. What separates senior from staff is the ability to predict which fix applies before measuring, then confirm with counters. Answers that hand-wave about "performance" without numbers fail at L5 and above.

---

**Q: What is false sharing and how do you detect and fix it?**

A: False sharing occurs when two goroutines on different CPU cores write to different variables that happen to share the same cache line. A write by one core invalidates the line on every other core, forcing them to refetch. The variables are logically independent, but the cache coherence protocol serializes them. Detect with `perf stat -e cache-misses` or, more precisely, `perf c2c` on Linux, which reports HITM events per cache line. The signature is high CPU utilization with stagnant throughput as you add cores. Fix by padding hot per-core state to a full cache line using `golang.org/x/sys/cpu.CacheLinePad`, which is sized per target architecture at compile time (64 bytes on x86-64, 128 on arm64), so the padding always matches the platform you build for.

Follow-ups:
- Why prefer `cpu.CacheLinePad` over a hard-coded 64? (On an arm64 build it expands to 128 bytes, matching Apple Silicon's line width, so it never under-pads.)
- Show the code for a padded sharded counter. (atomic.Uint64 fields separated by `cpu.CacheLinePad`.)
- When is false sharing a red herring? (When contention is on the logical variable itself, not the line. Look at HITM vs HIT ratio.)

---

**Q: When would you use memory-mapped I/O instead of regular file reads?**

A: `mmap` wins when (1) the file is accessed multiple times so the OS page cache avoids re-reads, (2) access is random so buffered reads would waste bandwidth, (3) you want zero-copy because data never crosses the user/kernel boundary, or (4) multiple processes share the same backing file. Avoid `mmap` when (1) the file is larger than available RAM and page faults under memory pressure become unpredictable, (2) the backing filesystem is a network mount where a page fault can block for seconds, or (3) you need to handle truncation signals, since accessing a truncated region raises SIGBUS rather than returning an error.

Follow-ups:
- What does `MADV_SEQUENTIAL` actually change? (Kernel prefetch aggressiveness and LRU eviction priority.)
- Why is `mmap` dangerous for write workloads? (Dirty pages, `msync` cost, torn writes on crash.)
- Show how Prometheus uses `mmap` for its TSDB index. (Sorted index, binary search directly over the mapped region, no deserialization.)

---

**Q: How does the Go compiler decide to inline a function, and how can you verify it?**

A: The compiler assigns each function a cost based on AST node count and inlines any function whose cost fits the budget (80 as of Go 1.21 and newer). Functions that call `recover`, use `go`, or call non-inlineable functions are rejected. Mid-stack inlining since 1.12 allows a function that calls other inlineables to be inlined itself. Verify with `go build -gcflags='-m=2' ./... 2>&1 | grep 'can inline'`. Block inlining with `//go:noinline`. There is no `//go:inline` directive. You keep functions small and let the compiler decide.

Follow-ups:
- Why does inlining unlock escape analysis? (The allocation can be proven to not escape once the boundary dissolves.)
- What is the relationship between PGO and inlining in Go 1.21+? (PGO raises the budget for hot call sites detected in the profile.)
- How does PGO change inlining decisions on the cold path? (It does not. PGO only boosts hot sites, cold sites keep the default budget.)

---

**Q: Explain the difference between SoA and AoS layouts and when to use each.**

A: Array of Structs (`[]Particle`) keeps all fields of one particle in adjacent memory, which is ideal when most operations touch many fields of a single object. Struct of Arrays stores each field in its own slice (`X, Y, Z []float32`), which is ideal when the hot loop touches one field across many objects. SoA wins for SIMD (adjacent float64s fill AVX registers), for projections in columnar databases, and for physics loops that update position from velocity. AoS wins for OLTP-style code that processes entire records. The decision is driven by the access pattern of the hot loop, not by some abstract preference.

Follow-ups:
- How did CockroachDB use SoA to improve vectorized execution? (Converted row format to columnar batches of 1024. L1 hit rate 82 to 97 percent. 4x bandwidth reduction for projections.)
- "Does SoA let the Go compiler auto-vectorize the loop?" (No, and this is a trap worth catching. The gc compiler does not auto-vectorize at all. SoA wins in Go because contiguous same-type elements mean every byte on a fetched cache line is a byte you wanted, and no gather is required. It would match SIMD lane layout *if* you hand-wrote the assembly or used the experimental `simd/archsimd`, but the compiler will not do it for you.)
- What is the cost of SoA? (More complex index bookkeeping. Cache misses when updating many fields of one object.)

---

**Q: What does PGO actually do, and what gains should I expect?**

A: Profile-guided optimization feeds a representative production CPU profile into the compiler. It uses the hot call distribution to raise the inlining budget for hot sites and to devirtualize interface calls whose concrete type is dominant in the profile. Honest numbers: 2 to 7 percent on general workloads, 10 to 15 percent on call-heavy or allocation-heavy hot paths. Uber reported 4 percent across their top services at fleet scale. Datadog reported up to 14 percent on agents. Marketing numbers above 15 percent are cherry-picked. Budget 5 percent when planning.

Follow-ups:
- Where does PGO's biggest win usually come from? (Devirtualization unlocking inlining.)
- Why does a profile taken under synthetic load often disappoint? (Call distribution differs from real traffic. The hot set in the profile is not the hot set in production.)
- How often should you re-collect profiles? (On meaningful code or traffic shifts. profiles older than a few weeks start to mislead.)

---

**Q: What is the difference between `alloc_objects` and `inuse_objects` in a heap profile?**

A: `alloc_objects` counts every allocation since the process started at a given call site. It tells you where GC pressure originates. `inuse_objects` counts allocations that survived the most recent garbage collection. It tells you what is currently retained, which is the correct lens for diagnosing leaks or RSS growth. A hot handler can dominate `alloc_objects` without appearing in `inuse_objects`, which is normal for ephemeral work. A growing `inuse_objects` at a site that allocates rarely is a classic leak signature. Run both views.

Follow-ups:
- What does `GOMEMLIMIT` do to these numbers? (Raises `alloc_*` because GC runs more often. stabilizes `inuse_*` near the limit.)
- How does sampling affect accuracy? (Controlled by `runtime.MemProfileRate`. The default samples roughly every 512 KB of allocation.)
- How do you capture an allocation profile from a running server? (`curl http://host:6060/debug/pprof/heap`, then `go tool pprof -alloc_objects`.)

---

**Q: Walk me through diagnosing a Go service where p99 latency spikes under sustained load but median is fine.**

A: The pattern points to tail behavior, not mean work cost. Candidates to investigate in order: (1) GC pauses, check `GODEBUG=gctrace=1` for pause spikes. (2) thermal throttling, read `/sys/class/thermal/thermal_zone*/temp` and correlate with the latency timeline. (3) lock contention, run a mutex profile. (4) false sharing on per-core state that emerges only under high concurrency. (5) allocator contention from unpooled per-request allocations. Start with a CPU and heap profile captured during a spike, not a synthetic run. If GC pauses are the cause, check `GOMEMLIMIT` settings and consider raising `GOGC` with a memory limit.

Follow-ups:
- Why does thermal throttling look like a software bug? (Frequency drops 30 to 50 percent mid-request. User-space sees longer cycles with no code change.)
- What Prometheus metrics would you add to catch this class of issue? (Per-CPU frequency gauge, thermal zone temp, GC pause histogram.)
- How does the Green Tea GC in Go 1.26 change the tuning story? (Lower scan cost for pointer-sparse heaps. reduced pause variance. But still requires `GOMEMLIMIT` discipline.)

---

**Q: How do you tell whether a Go service is CPU-bound or memory-bound?**

A: Run `perf stat -e cycles,instructions,cache-references,cache-misses,L1-dcache-load-misses ./binary` under load and compute IPC (instructions divided by cycles). IPC above 2.0 and low cache miss rate means CPU-bound on real work, the fix is algorithmic or parallelism. IPC below 1.0 with cache miss rate above 1 percent means memory-bound, the fix is data layout, prefetching, or reducing the working set to fit in cache. IPC between 1.0 and 2.0 with high branch misprediction rate means branch-bound, the fix is sorting the input or branch-free rewrites. The three diagnoses require opposite interventions, and confusing them is the most common cause of wasted optimization effort.

Follow-ups:
- What if `perf` is not available (cloud VM with disabled PMU)? (Use `pprof` with `-list` on the hot function, plus goroutine trace. Look for stall patterns and memory-wait indicators. Less precise but workable.)
- A hot loop has IPC 3.5 but you want more. What next? (Likely already saturating execution units. Parallelize across goroutines or reduce work.)
- Your service runs at IPC 0.3 on one host type and IPC 2.1 on another. What changed? (Different L3 cache size, different memory speed, or hyperthread contention on the smaller host.)

---

**Q (Junior-track onramp): You have never used `perf stat`. Where do you start?**

A: I would build my service or benchmark as a standalone binary (`go test -c` for benchmarks, regular `go build` for services), then run:

```
perf stat -e cycles,instructions,cache-misses,branch-misses ./binary
```

I would record the four numbers. Then I would change one variable (add `sync.Pool`, flatten a struct, reorder a loop) and rerun. I would track the delta for ten runs across five different changes. After that, the counters stop being alphabet soup and start being actionable. I would also ask a senior engineer to review my interpretation of one run, because reading counter output has vocabulary that transfers much faster with feedback than alone.

Follow-ups:
- What if your environment blocks PMU access? (`sysctl kernel.perf_event_paranoid=-1` on a dev box, or use `pprof` block/mutex profiles as a proxy signal for memory stalls.)
- How do you include the JIT-warmup effect in a benchmark? (Go has no JIT. First iteration is cold and fair to include, or use `b.Loop()` which handles warmup.)

---

**Q (Staff-track): Your team wants to adopt SIMD via the Go 1.27 experimental package for a numeric hot path. You are the staff engineer. Write the decision memo.**

A: Structure the memo: context (what workload, what is the measured bottleneck), options (stay with scalar Go, use an assembly-backed library like gonum, use the experimental `simd/archsimd` package, hand-write the one hot kernel in Go assembly, cgo to BLAS, rewrite the path in Rust), analysis per option (throughput delta, portability, maintenance cost, team fluency, rollback path), recommendation with explicit criteria, risks and mitigations (API changes before the experiment is promoted, architecture-specific builds, Go version upgrade path, lost debuggability), decision and sign-off.

One framing correction that should appear in the memo itself: there is no "stay with auto-vectorized Go" option, because that option does not exist. The gc compiler does not auto-vectorize, so the baseline is scalar Go and the honest question is whether to leave the scalar loop alone. Do not write "we confirmed auto-vectorization was inadequate by checking for VPADD in `go tool compile -S`", because those instructions were never going to be there and the check proves nothing about your loop.

For the 1.26 experimental package specifically, I would be conservative. The API is outside the Go 1 compatibility promise, so every Go upgrade is a potential porting exercise. Adoption is worth it only for a genuinely hot numeric path where the scalar loop has been profiled and found to be the bottleneck, and where the measured gain justifies the ongoing maintenance. The memo forces the team to write that justification explicitly, which is worth more than the performance itself.

Follow-ups:
- Who signs off on this memo? (Tech lead, SRE who owns the SLO, and the engineer who will maintain the code in year two.)
- What would change your mind? (A stable SIMD API in Go 1.27, a measured 3x+ gain with no available alternative, or a dependency whose upstream version already uses the experimental package.)

