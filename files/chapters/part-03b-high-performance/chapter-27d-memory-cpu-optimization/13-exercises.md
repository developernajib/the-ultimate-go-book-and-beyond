## Exercises

Each exercise targets a specific optimization technique from this chapter. Measure with `go test -bench=. -benchmem`, and use `perf stat` on Linux for hardware counters where noted.

Three ground rules, because they are what separate an exercise that teaches you something from one that teaches you a comfortable falsehood.

- **Write every benchmark loop as `for b.Loop() { ... }`** (Go 1.24 and later). It keeps the compiler from deleting work whose result you never use.
- **Do the setup outside the timed loop.** Generating input, sorting a slice, or allocating a fixture inside `b.Loop()` measures the setup, not the thing. This is the single most common way these exercises go wrong, and exercise 5 is where it bites.
- **If a result looks too good, it is.** An L1 hit costs roughly a nanosecond, so any benchmark reporting below about 1 ns/op has been optimized into nothing. Treat sub-nanosecond figures as a bug in your benchmark until proven otherwise.

1. **False Sharing Benchmark**: Put two counters in adjacent struct fields and increment them from separate goroutines. Measure. Then separate them with `cpu.CacheLinePad` from `golang.org/x/sys/cpu` (not a hand-written `[64]byte`, which is wrong on arm64) and measure again. Expect a large effect: this one was measured at 4× to 11× elsewhere in this part. It is one of the few micro-optimizations whose win is big enough to see clearly through benchmark noise.

2. **SoA vs AoS**: Implement a particle update (position += velocity × dt) in both AoS and SoA layouts. Benchmark at 1M particles, then again at 1000. Explain why the gap changes. Note the expected mechanism: SoA wins by packing the hot fields densely so each cache line delivers more useful data, and it will not trigger vectorization, because the gc compiler does not auto-vectorize. Confirm that for yourself with `go tool objdump` and look for scalar `ADDSD`/`MULSD` rather than packed `ADDPS`/`MULPD`.

3. **Zero-Copy String Parser**: Write an HTTP header parser that returns `string` values pointing into the input `[]byte` via `unsafe.String`, without copying. Verify 0 allocs/op with `-benchmem`. Then write down the invariant that makes this safe, namely that nobody mutates the input buffer for as long as any returned string is reachable, and add a comment on the function saying so. If you cannot state that invariant, do not ship the optimization.

4. **mmap Index**: Build a sorted int64 index file and binary search it via mmap. Benchmark mmap binary search against reading the file into a Go slice and searching that. Run it twice: once with a cold page cache (`echo 3 | sudo tee /proc/sys/vm/drop_caches`) and once warm. The two answers are different, and knowing which one your production actually looks like is the entire point of the exercise.

5. **Branchless Filter**: Implement `filterPositive` (keep values > 0) branchlessly. Compare against the naive version on random data. **Sort the input before the timer starts, never inside `b.Loop()`.** An earlier draft of this book claimed a branch-prediction win that, when re-run, measured about 200× *slower*, because the sort was inside the timed path and the benchmark was measuring `sort.Ints`. Sorting to help the branch predictor only pays when the data arrives sorted for free. If you have to sort it yourself, you have almost certainly spent more than you saved.

6. **Fast JSON Encoder**: Use the `FastJSONEncoder` from section 4 to encode 1000 `User` structs and compare to `encoding/json.Marshal`. Measure both variants: encoding into the pooled buffer with no copy (0 allocs/op) and copying the result out (1 alloc/op, since the copy is an allocation by definition). Report `allocs/op`, and treat any ratio you compute from `ns/op` on a shared machine as provisional.

7. **Inline Analysis**: Build a hot request handler with `go build -gcflags="-m=2"` and find the functions reported as `cannot inline`, along with the reason. Refactor to enable inlining, then verify the cost the compiler now reports. Also verify a negative result: confirm that a function calling a `//go:noinline` callee is still itself inlinable, which rules out one of the most repeated pieces of Go folklore.

8. **CPU Flame Graph**: Run a Go HTTP server under load, capture a CPU profile, and render it with `go tool pprof -http=:8080`. Identify the top 3 opportunities. For each, state whether the wide frame is doing the work or merely passing through to a child, and check whether any of your top frames are `runtime.gcBgMarkWorker`, which is a symptom of allocation elsewhere and not a thing you can optimize.

### Junior → FAANG: ramped exercises

9. **Memorize the four latency numbers**: Write L1=1 ns, L2=4 ns, L3=15 ns, DRAM=80 ns on a sticky note. Put it on your monitor for a week. After that week, remove it and explain the numbers to a colleague from memory.

10. **Run `perf stat` five ways**: Build your favorite benchmark as a binary. Run `perf stat` with each of: `-e cycles,instructions`, `-e cache-misses,cache-references`, `-e branch-misses,branches`, `-e L1-dcache-load-misses,L1-dcache-loads`, `-e LLC-load-misses,LLC-loads`. Write one paragraph explaining what each pairing tells you.

11. **Remove allocations one at a time**: Take a real HTTP handler. Benchmark it. Remove one allocation. Benchmark again. Record each step, with `benchstat` output. Go until the next removal would require pooling, then stop and write a paragraph on whether pooling is worth the manual-lifetime bug it introduces. The goal is the trajectory and the judgement call at the end of it, not a zero.

12. **Annotate one flame graph**: Capture a CPU profile from a real Go service under load. Open it in `go tool pprof -http=:8080`. Screenshot the flame graph, annotate the top 10 functions with one sentence each explaining what they do. Share with a senior colleague for review.

### Senior @ FAANG: staff-level exercises

13. **Add allocation budgets to CI**: For three services your team owns, add `testing.B` benchmarks that assert `allocs/op <= N` for the hot handlers. Wire them into CI. Document the threshold selection and the escalation path when they fail.

14. **Write an optimization ADR**: Pick a past optimization your team shipped. Write the retroactive ADR: context, options considered, decision, measured effect, rejection criteria, rollback plan. Share with your team and iterate.

15. **Run a cross-architecture benchmark study**: Build your service for amd64 and arm64. Run the same workload on both. Record IPC, cache miss rate, and latency on both. Document which wins on which workload. This is the kind of artifact that informs capacity and procurement decisions.

16. **Mentor a junior through exercise 11**: Sit with a junior engineer for an afternoon while they work through the allocation removal drill. Your job is to ask "what does your profile show?" not to type. This coaching skill is the staff-to-principal differentiator.

---
