## Common Mistakes and How to Avoid Them

Most performance regressions in Go services trace back to a small set of recurring patterns. The table below lists the mistakes that appear most often in production code reviews and post-mortems.

Read the Impact column with suspicion, including here. Where a figure was measured for this book it says so and names the machine. Where the honest answer is "it depends on your working set," it says that instead of quoting a number that would look more authoritative than it deserves. A speedup figure with no hardware attached is marketing.

| Mistake | Impact | Fix |
|---------|--------|-----|
| Column-major 2D array access | Nothing at all if the array fits in cache. Measured 2.6× slower once it does not (i7-10510U, 64 MB array vs 8 MB L3, identical timings at 4 MB) | Access data sequentially. Transpose if needed |
| AoS when the loop touches one field | Wastes whatever fraction of each cache line the loop never reads. Bounded by how much of the struct is dead weight | Use SoA for hot, single-field loops |
| Struct with large cold fields inline | Each hot access drags cold bytes through L1 | Hot/cold split with pointer to cold data |
| Per-request JSON target allocation | Measured 17 allocs/840 B → 11 allocs/312 B when the target struct's map and slice are pooled (i7-10510U, see section 5.2) | Pool the target struct with sync.Pool. It will not reach zero |
| Unpadded concurrent counters | False sharing, measured 4× to 11× (median 7.6×) elsewhere in this part | Pad with `cpu.CacheLinePad`, not a hand-rolled 64 |
| fmt.Sprintf in hot paths | 2+ allocs per call | strconv.AppendInt / append pattern |
| `[]byte(s)` / `string(b)` on a read-only path | 1 alloc plus a copy per conversion | `unsafe.String`/`unsafe.Slice` ONLY if the bytes are provably never mutated afterwards |
| Large heap with GOGC=100 | Frequent GC, high write barrier cost | Raise GOGC and set GOMEMLIMIT as the backstop. Do not set GOGC=off (see 5.1) |
| Hand-rolled read/write loop for file serving | Copies payload through user space for nothing | `io.Copy(conn, file)` already uses sendfile on Linux. The mistake is bypassing it, not using it |
| Random index access into large array | Cache miss per access | Sort indices, group by cache line |
| Misaligned struct field order | 40 percent of the struct, measured: `BadOrder` 40 B vs `GoodOrder` 24 B (section 2.1) | Reorder fields largest alignment to smallest, run `fieldalignment` in CI |
| `append` to a nil slice in a known-length loop | Measured 12 allocs/25 KB → 0 allocs/0 B for N=1000 (i7-10510U). The reallocations are the visible cost, the copying is the hidden one | `make([]T, 0, N)` with exact capacity |
| Calling `strings.ToLower` on short ASCII strings in a hot path | Allocates even when already lowercase | Fast-path scan for uppercase bytes, return input unchanged |
| Logging formatted strings in a hot handler at INFO level | Lock contention on log writer, GC pressure from formatting | Structured logging at DEBUG, or sampled logging, never `fmt.Sprintf` in hot path |
| Type assertion without comma-ok on untrusted input | Panics. Note it does NOT block inlining: verified on Go 1.27, `v.(int)` inlines at cost 3 while the comma-ok form costs 9 | Use comma-ok for correctness, not for speed |
| `time.Now()` per request for a value that could be cached | Measured 38 ns/op, 0 allocs (i7-10510U, vDSO). That is a real cost but a small one | Cache via a background ticker updating `atomic.Int64`, and only after proving it matters |
| `regexp.MustCompile` inside a function | Compile cost on every call | Compile once at package init, reuse the `*regexp.Regexp` |
| Benchmark without `b.Loop()` (Go 1.24+) | Dead code elimination. A loop optimized away reports a sub-nanosecond time, which is the tell | Use `for b.Loop() { ... }` and always `b.ReportAllocs()` |
| Claiming a performance win without `benchstat` | Noise mistaken for improvement | Run 10x each, compare with `benchstat`, ship only on p-value < 0.05 |

**On that last row, from this chapter's own verification.** Running the *identical* JSON benchmark twice on this machine produced 24888 ns/op and then 52181 ns/op, a 2× swing from nothing but background load, while `allocs/op` stayed at exactly 17 both times. If a 2× difference can appear between two runs of unchanged code, then a 2× difference between your before and after means nothing on its own. This is why every claim in this chapter that survived review is anchored to an allocation count, an escape decision, or an instruction count, and why the wall-clock figures that could not be reproduced were deleted rather than rounded.

### Junior → FAANG: the symptom-to-command mapping

For each row, memorize the one command that confirms the symptom. Column-major access: `perf stat -e L1-dcache-load-misses` shows the miss rate jump, and confirms whether your array is even large enough for the access order to matter. Unpadded counters: `perf c2c` reports HITM events. `fmt.Sprintf` allocs: `go test -bench . -benchmem` shows the allocs/op delta. User-space copying on the I/O path: `strace -c` shows the `read`/`write` pairs that `sendfile` would collapse. Random access cache miss: `perf stat -e cache-misses` on the hot function. Bounds checks: `go build -gcflags="-d=ssa/check_bce/debug=1"`. Escapes: `go build -gcflags=-m`.

Prefer the last two. They print a decision the compiler made, so they give the same answer on a loaded laptop and a quiet server, whereas every `perf` and wall-clock number above moves with whatever else the machine is doing. Knowing the confirming command per mistake is the operational fluency interviewers probe for when they ask "how would you verify that hypothesis?" A candidate who says "I would run `perf stat` and look at `L1-dcache-load-misses` before and after the change" outperforms a candidate who says "I would just time it."

### Senior @ FAANG: the team-level anti-patterns

Beyond individual mistakes, teams at scale accumulate systemic problems that no single PR can fix. The anti-performance ones to watch for: the team ships optimizations without `benchstat` evidence and celebrates noise-level wins. The team has no CI guard against allocation regression, so every PR can silently add 10 percent. The team's dashboards do not show RSS, GC CPU fraction, or cache miss rate, so regressions go undetected until they become incidents. The team has never run `perf stat` against their own service and cannot identify whether it is CPU-bound or memory-bound. Each of these is a platform-level gap a staff engineer can fix once and benefit from forever. The most impactful practice is higher than any individual optimization. Services whose teams have internalized these habits ship faster and regress less. Services whose teams have not operate with persistent, invisible drag that only shows up as a mysterious "why is this service expensive to run."

---
