## Exercises

### Exercise 1: Custom Iterator Collection

**Task**: Implement a sorted set using a red-black tree with full iterator support:
1. `type SortedSet[T cmp.Ordered] struct { ... }`
2. `func (s *SortedSet[T]) All() iter.Seq[T]`: iterate in order
3. `func (s *SortedSet[T]) Range(low, high T) iter.Seq[T]`: iterate items in [low, high]
4. `func (s *SortedSet[T]) Backward() iter.Seq[T]`: iterate in reverse order
5. All iterators must support early termination (consumer break)
6. Tests: verify N items in range query visits exactly the correct items, verify break stops iteration

**Key requirement**: use `iter.Pull` to implement the `Range` iterator using the `All` iterator as the base.

### Exercise 2: PGO Pipeline

**Task**: Set up a complete PGO pipeline for a sample HTTP server:
1. HTTP server with a CPU-intensive endpoint (`POST /hash`: hash body 1000 times with SHA-256)
2. Benchmark: measure requests/second without PGO
3. Profile: use `hey` or `wrk` to generate load, collect profile via `pprof`
4. Build with PGO: `go build -pgo=profile.pgo ./cmd/server`
5. Benchmark again: measure improvement
6. Document: what percentage improvement did PGO provide? Which functions got inlined?

**Expected result**: the hot path should land inside Go's documented 2-14% PGO range. Check `go build -pgo=profile.pgo -gcflags=-m ./...` for inlining decisions.

### Exercise 3: Goroutine Leak Detector

**Task**: Build a test helper using the `goroutineleak` profile (GA in Go 1.27, experimental in Go 1.26 behind `GOEXPERIMENT=goroutineleakprofile`):
1. `type LeakChecker struct { ... }`: records the goroutines already present when the test starts, so pre-existing ones are not attributed to it
2. `func (c *LeakChecker) Check(t *testing.T)`: runs a GC, writes the goroutineleak profile, and fails the test if it reports any goroutine the test created. The profile is reachability-based, so it only lists goroutines that provably can never resume, no timing heuristics involved
3. Write three test cases that demonstrate: (a) no leak with `defer cancel()`, (b) goroutine leak with missing cancel, (c) goroutine leak with unread channel

**Bonus**: make the checker work as a cleanup callback: `t.Cleanup(func() { checker.Check(t) })`

### Exercise 4: json/v2 Migration

**Task**: Migrate an existing REST API client from `encoding/json` to `encoding/json/v2`:
1. Find all breakages in the existing code using the behavioral differences
2. Add `case:ignore` tags where external JSON uses different capitalization
3. Handle unknown fields explicitly with `json.RejectUnknownMembers(true)` in tests rather than silently ignoring
4. Write comparison tests that verify identical output for both v1 and v2 for your existing response types
5. Profile: does v2 decode/encode faster than v1? Run benchmarks and compare.

---
