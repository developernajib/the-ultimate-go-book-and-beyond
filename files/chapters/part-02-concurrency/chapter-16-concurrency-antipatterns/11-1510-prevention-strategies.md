## 16.10 Prevention Strategies

### Code Review Checklist

Use the following checklist during code reviews of concurrent Go code. Each item corresponds to a specific anti-pattern covered earlier in this chapter.

- [ ] All shared state protected by mutex or atomic
- [ ] Locks acquired in consistent order, by a documented rule
- [ ] **No lock held across a blocking operation** (channel op, I/O, `Cond.Wait`, or any call that might do those)
- [ ] All goroutines have exit conditions
- [ ] **Every fan-out is bounded**, with the bound tied to a real resource
- [ ] Channels are closed by senders only, and only by the single owner
- [ ] **Result channels are buffered** where the receiver may give up (timeout or cancellation)
- [ ] Context cancellation is checked, and `break` inside a `select` is `return` or a labelled break
- [ ] No loop variable capture bugs (check the `go` directive in `go.mod`, not the toolchain)
- [ ] Tests run with `-race`, **and assert invariants** rather than only the absence of race reports

### Static Analysis

Static analysis catches concurrency issues that code review misses, but only specific ones. Knowing exactly what each tool does and does not catch is what keeps you from trusting a green build too far.

**`go vet`** is the one that ships with Go, and its `copylocks` check is genuinely valuable: copying a `sync.Mutex` copies its state, so the copy and the original guard nothing in common. It catches every form of this, including the ones that look innocent:

```
main.go:11:9:  Bad passes lock by value: Counter contains sync.Mutex
main.go:13:20: passByValue passes lock by value: Counter contains sync.Mutex
main.go:18:14: call of passByValue copies lock value: Counter contains sync.Mutex
main.go:19:7:  assignment copies lock value to d: Counter contains sync.Mutex
```

A value receiver on a method of a mutex-guarded struct is the classic one, and it is invisible to review because the method body looks fine. `vet` also runs `loopclosure` (for modules below `go 1.22`) and `lostcancel` (a `WithCancel` whose `cancel` is never called).

**`staticcheck`** goes further, including `SA2001` for an empty critical section, which `go vet` does not report.

Be equally clear about what none of them catch. No static tool in Go finds a lock held across a blocking channel send, an unbounded fan-out, a check-then-act race between two correctly-locked operations, or a `break` that exits a `select` instead of its loop. Every one of those compiles cleanly and passes `vet`. They are review problems, and that is why the checklist above exists alongside the tooling.

```bash
# Race detection
go build -race

# Vet for concurrency issues
go vet ./...

# staticcheck
staticcheck ./...

# golangci-lint
golangci-lint run
```

### Testing Patterns

Stress-testing concurrent code by launching many goroutines performing simultaneous operations makes data races more likely to manifest even without the race detector. Running such tests under `go test -race` combines high contention with race instrumentation, significantly improving the probability of catching subtle timing-dependent bugs that sequential tests cannot expose.

```go
// Stress test that asserts an INVARIANT, not just the absence of a
// race report. This is the part people skip, and it is the part that
// catches the bugs -race structurally cannot see.
func TestConcurrentIncrement(t *testing.T) {
    const goroutines, perGoroutine = 100, 1000

    c := NewCounter()
    var wg sync.WaitGroup
    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < perGoroutine; j++ {
                c.Increment()
            }
        }()
    }
    wg.Wait()

    // The assertion is the test. Without it, a counter that loses
    // updates through a check-then-act bug passes silently, because
    // every access was correctly locked and there is no data race.
    if got, want := c.Value(), int64(goroutines*perGoroutine); got != want {
        t.Errorf("lost updates: got %d, want %d", got, want)
    }
}
```

Run it with `-race -count=10` so that scheduling-dependent failures get several chances to appear. And keep the two failure signals distinct in your head: a race report means unsynchronized access, while a failed assertion means the logic is wrong. A test that can only produce the first is only testing half the problem.

### Design Principles

1. **Share by communicating**: Use channels instead of shared memory
2. **Minimize shared state**: Fewer shared resources = fewer races
3. **Use immutable data**: Immutable data needs no synchronization
4. **Scope locks narrowly**: Hold locks for minimum time
5. **Prefer higher-level primitives**: sync.Map, errgroup, singleflight

### CI Integration

The prevention strategy is only effective if enforced automatically. CI should:

1. Run `go test -race` on every test invocation.
2. Include `goleak.VerifyTestMain` in every package.
3. Run `go vet` (its `copylocks` check catches mutex copying, which review reliably misses) and `staticcheck` for the broader set.
4. Run `golangci-lint` with custom concurrency rules enabled.
5. Set `runtime.SetMutexProfileFraction` and `runtime.SetBlockProfileRate` in every service's `main`, since both profiles are off by default and an empty profile during an incident is worse than none, because it reads as an all-clear.

Without CI enforcement, every prevention strategy relies on human discipline, which degrades over time. With CI enforcement, regressions are caught before merge.

### Staff Lens: Prevention Is a Multi-Layered Investment

Preventing concurrency bugs requires coordinated effort across layers:

1. **Design review.** Anti-patterns caught at design time are free.
2. **Code review.** Anti-patterns caught at PR time are cheap.
3. **CI testing.** Anti-patterns caught at merge time are moderately expensive.
4. **Production monitoring.** Anti-patterns caught in production are expensive.
5. **Incident postmortem.** Anti-patterns caught after an incident are very expensive.

Invest in earlier layers. Each layer catches what earlier layers miss. Skipping layers means the bug costs more when eventually caught.

---
