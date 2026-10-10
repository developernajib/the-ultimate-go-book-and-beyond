## Interview Questions

These questions mirror patterns from FAANG and top-tier Go interviews. Work through them after reading the chapter.

### Q1: Explain the nil interface trap and how to prevent it in production code.

**What FAANG expects**: Correct two-word interface model, a concrete example, and a defensive coding rule.

**Answer**: An interface value holds two words, a type descriptor and a data pointer. It equals nil only when both are nil. Returning a typed nil pointer as an interface produces a value whose type word is non-nil, so comparisons against untyped nil at the call site fail.

```go
type DBError struct{ Code int }
func (e *DBError) Error() string { return "db" }

func query() error {
    var e *DBError
    return e
}

func main() {
    if err := query(); err != nil {
        // This branch is TAKEN. err holds (*DBError, nil): the type word is
        // set, so the interface is not nil. Printing it calls Error() on a
        // nil receiver, fmt recovers from the resulting panic, and you see
        // "<nil>". A caller reading the log sees an error whose message is
        // the word nil, which is the most confusing outcome available.
        fmt.Println("taken:", err)
    }
}
```

The fix is to never let a typed nil escape as an interface. Return untyped `nil` in the success path, or use an `error` local variable instead of a concrete pointer:

```go
func query() error {
    var err error
    if failed {
        err = &DBError{Code: 500}
    }
    return err
}
```

The same rule applies to any interface, not just `error`.

Be honest about tooling in the interview, because it is a point in your favor. No mainstream linter catches this reliably. `nilerr` and `nilnil` are adjacent (returning nil when err is non-nil, and returning `nil, nil`), but neither detects a typed nil escaping into an interface. `go vet`'s `nilness` pass reasons about nil within a function, not across the return boundary. Uber's `nilaway` goes furthest and is not widely deployed. The practical control is a convention plus review: functions returning `error` declare `var err error`, never `var err *ConcreteType`, and no concrete error pointer is ever named as a return type.

**Follow-ups**:
- How does `errors.Is(err, nil)` behave with a typed nil, and why?
- Why does `reflect.ValueOf(err).IsNil()` succeed where `err == nil` fails?

### Q2: How does Go handle integer overflow, and how do you detect it safely?

**What FAANG expects**: Silent wraparound semantics, `math/bits` helpers, and when to use `math/big`.

**Answer**: Go defines integer overflow as two's-complement wraparound for signed and unsigned integers. There is no panic and no trap. `int32(math.MaxInt32) + 1` produces `math.MinInt32` with no warning. This is fast and predictable, but it is a silent data-corruption risk in financial code, cursor arithmetic, and capacity calculations.

The `math/bits` package provides `Add64`, `Sub64`, `Mul64`, and their 32-bit counterparts. State the limitation, because interviewers probe it: **these are unsigned only**. `Add64` and `Sub64` return a carry or borrow. `Mul64` returns a 128-bit result as `(hi, lo)`, so overflow is `hi != 0` rather than a flag.

```go
sum, carry := bits.Add64(a, b, 0) // a, b are uint64
if carry != 0 {
    return 0, errors.New("overflow")
}
```

There is no signed equivalent in the standard library. Signed overflow checks are written by hand as preconditions, `if b > 0 && a > math.MaxInt64-b`, and the `MinInt64 / -1` case needs its own guard because the division check cannot catch it: the Go spec defines that quotient as `MinInt64` rather than trapping.

For unbounded precision, switch to `math/big.Int`. The cost is real, and it is the right call in ledger and cryptographic code.

Detection strategies include fuzz testing with `testing.F` that targets boundary values, and property-based tests asserting monotonicity of accumulation functions.

**Follow-ups**:
- Why did Go choose silent wraparound instead of panicking on overflow?
- How would you implement a saturating-add helper in pure Go?

### Q3: Describe the slice-aliasing bug in append, and how to guard against it.

**What FAANG expects**: Capacity vs length, shared-backing-array insight, and the three-index slice form.

**Answer**: A slice is a header of pointer, length, and capacity. Reslicing preserves the pointer, so two slices can share a backing array. `append` grows the backing array only when length would exceed capacity. When there is spare capacity, append writes into the shared array, silently mutating the other slice.

```go
s := []int{1, 2, 3, 4, 5}
a := s[:2]
b := append(a, 99)
fmt.Println(s) // [1 2 99 4 5]
```

`a` had capacity 5, so `append(a, 99)` wrote into `s[2]`. Any caller holding `s` sees the mutation.

The three-index slice form caps capacity and prevents the aliasing: `a := s[:2:2]` creates a slice with length 2 and capacity 2, so any append reallocates. Defensive copying is the other option when you hand out slice subranges: `return append([]int(nil), src[i:j]...)` or `slices.Clone` from the standard library.

The bug is especially dangerous in concurrent code because the mutation can race across goroutines even without any explicit shared state beyond the returned slice. Library authors who return internal slice views should document the ownership or always clone.

**Follow-ups**:
- How does `bytes.Split` avoid or expose aliasing?
- What does `slices.Clip` do, and when would you use it?

### Q4: How do you detect and prevent goroutine leaks in long-running services?

**What FAANG expects**: Detection tooling, the blocking-channel root cause, and the context-propagation pattern.

**Answer**: Goroutine leaks happen when a goroutine blocks forever on a channel, mutex, or network call that never completes. Over time, leaks exhaust memory and file descriptors and poison traces with stale work.

Detection has three tiers, and naming all three separates a good answer from a great one.

`runtime.NumGoroutine()` as a gauge metric is the alarm: a healthy service has a bounded goroutine count under steady load, so a rising line means a leak. It tells you nothing about which one. The `pprof` goroutine profile is the next step, grouping goroutines by blocking stack, though it lists every goroutine including the healthy ones, so you are eyeballing the difference.

Go 1.27's `goroutineleak` profile (GA in 1.27, experimental in 1.26), at `/debug/pprof/goroutineleak`, is the tier worth leading with. It applies GC-style reachability analysis to blocked goroutines and reports only those that provably cannot resume, because nothing runnable can still reach the channel or mutex they are parked on. No time thresholds, so a legitimately slow goroutine is never flagged, and no manual diffing.

In tests, `go.uber.org/goleak` asserts that a test or `TestMain` ends with only the expected goroutines.

Prevention centers on three rules. First, every goroutine that reads from or writes to a channel must have a plan for how it exits when the other side is gone, typically a `select` with `<-ctx.Done()`. Second, every long-running goroutine accepts a `context.Context` and returns when it is canceled. Third, callers own the context and cancel it on error paths, timeouts, and shutdown. `errgroup.Group` wraps this pattern and propagates the first error while canceling siblings.

```go
func worker(ctx context.Context, in <-chan Job) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case job, ok := <-in:
            if !ok {
                return nil
            }
            process(job)
        }
    }
}
```

**Follow-ups**:
- How would you find a goroutine leak that only manifests at 1% of requests?
- Why is a bare `time.Sleep` in a goroutine a latent leak?

### Q5: Explain context cancellation propagation and the common misuses.

**What FAANG expects**: Tree semantics, `Done` channel mechanics, and the cancel-function ownership rule.

**Answer**: A `context.Context` forms a tree. `context.WithCancel`, `WithTimeout`, and `WithDeadline` return a child context and a cancel function. Canceling the parent cancels all descendants. The cancellation signal flows through the `Done` channel, which closes on cancel. Reading from a closed channel returns immediately, so `select` can multiplex cancellation with other work.

Common misuses fall into four buckets. Storing a context in a struct is almost always wrong, because a context describes one call's lifetime and a struct outlives the call. Passing `context.Background()` to downstream calls inside a request handler severs the chain, so a canceled request keeps doing work nobody will read. Forgetting to call the returned `cancel` leaks the timer and its goroutine until the parent is canceled, which for a `Background` parent means the process lifetime. And `context.Value` gets used as a general-purpose argument bag: it is for request-scoped data that must cross API boundaries and cannot be a parameter, meaning trace IDs and auth tokens, not the things you did not feel like adding to a signature.

The cancel-function rule is enforced by `go vet`'s `lostcancel` check. The pattern is:

```go
ctx, cancel := context.WithTimeout(parent, 5*time.Second)
defer cancel()
```

Even if the operation completes before the timeout, calling cancel releases resources immediately rather than waiting.

**Follow-ups**:
- Why does `context.WithValue` use interface keys instead of strings?
- What happens to in-flight database queries when the context cancels, and is that driver-dependent?

### Q6: Why does concurrent map access panic, and what are the correct alternatives?

**What FAANG expects**: the detection mechanism and its limits, a cost comparison of `sync.Mutex` vs `sync.Map`, and sharding as the answer at scale.

**Answer**: Go maps are not safe for concurrent use. The map implementation carries a writing flag and checks it on access, so concurrent writes, or a concurrent read and write, will often terminate the process with `fatal error: concurrent map writes` or `concurrent map read and map write`.

The nuance that earns the point: **this is a cheap best-effort backstop, not a race detector.** It is unsynchronized itself, so it can miss, and when it misses you get a silently corrupted hash table rather than a crash. Say so, and add that it is a fatal error rather than a panic, so `recover` cannot catch it and no defers run. The design is deliberate: crash loudly when the flag catches it, because a corrupted map is worse than downtime. But the tool that actually *proves* your code is free of the bug is `-race`, which tracks happens-before rather than hoping to collide.

The alternatives come with different tradeoffs. A plain map guarded by `sync.Mutex` is the simplest correct answer and performs well for balanced read and write workloads. `sync.RWMutex` helps when reads dominate, but the RLock overhead can be higher than a plain Lock under contention, so benchmark before assuming it is better. `sync.Map` is optimized for two specific patterns, append-mostly caches where entries are written once and read many times, and cases where goroutines mostly operate on disjoint keys. It performs worse than a mutex-guarded map for general workloads.

For high-throughput scenarios, a sharded map (an array of `N` locked maps, keyed by `hash(key) % N`) cuts contention roughly with shard count, until the keys turn out to be skewed and one shard takes the load anyway. Hash the whole key, not its first byte. Libraries like `orcaman/concurrent-map` and `puzpuzpuz/xsync` implement this. The choice depends on measured contention, not on reputation.

Worth adding for a Go 1.24+ baseline: `sync.Map` was reimplemented on a hash-trie design, so old benchmark folklore about it is stale. Measure on your own workload.

**Follow-ups**:
- How does `sync.Map`'s hash-trie implementation (Go 1.24+, `internal/sync.HashTrieMap`) work?
- What happens if you read from a map that another goroutine is writing, without a write of your own?

### Q7: What is the defer-in-loop trap, and when does it matter?

**What FAANG expects**: Recognition of deferred execution timing, the file-handle leak example, and the explicit-close fix.

**Answer**: `defer` runs when the enclosing function returns, not when the enclosing block exits. A `defer` inside a loop accumulates deferred calls that fire only at function return. For short loops this is harmless. For long loops that open resources, it is a leak.

```go
func process(paths []string) error {
    for _, p := range paths {
        f, err := os.Open(p)
        if err != nil {
            return err
        }
        defer f.Close() // all closes happen only at function return
        io.Copy(io.Discard, f)
    }
    return nil
}
```

With ten thousand paths, this holds ten thousand open file descriptors until the function returns, often exhausting the process limit. The fix is to scope the work in a helper function so each iteration's `defer` fires at helper return:

```go
for _, p := range paths {
    if err := processOne(p); err != nil {
        return err
    }
}

func processOne(p string) error {
    f, err := os.Open(p)
    if err != nil {
        return err
    }
    defer f.Close()
    _, err = io.Copy(io.Discard, f)
    return err
}
```

Alternatively, call `f.Close()` explicitly at the end of each iteration. The helper-function pattern is preferred, and the reason is worth stating: the explicit close is skipped by any early return, any panic, and any error path someone adds next quarter. The helper's `defer` cannot be skipped by any of them.

Go 1.14 made `defer` far cheaper (open-coded defer), so the performance argument against `defer` in tight loops has mostly disappeared. The leak argument has not.

**Follow-ups**:
- How does open-coded defer work, and when does it not apply?
- What happens to `defer` order when a function has 9 or more defers?

### Q8: Describe the zero-value pitfalls that trip up even experienced Go developers.

**What FAANG expects**: At least three concrete cases across maps, channels, sync types, and time values.

**Answer**: The zero-value-is-useful principle is powerful but uneven. Several types have zero values that look usable but are not, and several operations behave differently on the zero value than on constructed instances.

A nil map supports reads (returning the zero value of the element type) but panics on writes. `var m map[string]int; m["a"]++` panics. The fix is `m := map[string]int{}` or `m := make(map[string]int)`. A nil slice supports `len`, `cap`, `range`, and `append`, so it is a usable zero value, which can make the map bug more surprising by contrast.

A nil channel blocks forever on send and receive, and closing one panics. This is occasionally useful in `select` to disable a case by setting its channel to nil, but it is more often a bug when a constructor forgot to initialize a field. A closed channel is not the same as a nil channel. Receiving from a closed channel returns immediately with the zero value and `ok` false, while sending panics.

A `time.Time` zero value represents January 1, year 1, UTC. `t.IsZero()` is the correct check. `t == time.Time{}` is not a stylistic quibble but a real bug waiting: `==` compares all three fields, including the location pointer and the monotonic reading, so it answers a different question than you asked. The same reason `==` is wrong for comparing any two times. Serializing a zero `time.Time` produces `"0001-01-01T00:00:00Z"`, and note that `omitempty` does NOT omit it, because a struct is never "empty" to v1's encoder. Use `*time.Time` for optional timestamps, or the `omitzero` tag, added to `encoding/json` in Go 1.24 and carried into json/v2, which exists precisely because `omitempty` cannot express "omit the zero value of a struct type".

A zero `sync.Mutex` works, but copying a `sync.Mutex` after first use is a data-corruption bug. `go vet`'s `copylocks` check flags it. Struct assignment or passing the struct by value both copy the mutex. The fix is to always pass pointers to types embedding `sync.Mutex`.

**Follow-ups**:
- Why does reading from a nil map not panic, while writing does?
- How would you make a custom type whose zero value panics on use, and should you?
