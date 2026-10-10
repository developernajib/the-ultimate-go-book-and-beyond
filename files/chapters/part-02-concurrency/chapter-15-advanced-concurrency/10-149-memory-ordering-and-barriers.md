## 15.9 Memory Ordering and Barriers

Go's memory model defines which writes to shared variables are visible to reads in other goroutines. Without this model, reasoning about concurrent code correctness is impossible. The compiler and CPU both reorder operations in ways that break naive assumptions about execution order.

### Happens-Before Relationships

Go's memory model guarantees that a write to a variable is visible to a read only when the write _happens-before_ the read according to the formal partial order. Without an explicit synchronization point, a channel send/receive, mutex lock/unlock, or `sync/atomic` operation, the compiler and CPU are free to reorder operations, making concurrent reads of unsynchronized shared variables produce unpredictable results.

```go
var a, b int

// Goroutine 1
a = 1
b = 2

// Goroutine 2
if b == 2 {
    // a might be 0 or 1. No guarantee either way.
}
```

Be precise about what "no guarantee" means here, because the C and C++ intuition is wrong in an important way. This program has a data race, but a data race in Go is **not** undefined behaviour. Go's memory model deliberately bounds what a racy program may do: a racy read observes *some* value actually written to that location by some goroutine, either the zero value or a value from a real write. It does not license the compiler to assume the race cannot happen, delete the surrounding code, or produce a value nobody ever wrote. There are no nasal demons, and a racy Go program is not permitted to catch fire.

That bound is a real guarantee and it is why Go can promise memory safety even in racy programs. It is emphatically not permission to ship races. "Reads `a` as 0 when the programmer expected 1" is a bug that will cost you a weekend regardless of how well specified it is, and the value you get is unpredictable across builds, architectures, and load. The point is only that you should reason about Go races as *nondeterministic*, not as *anything at all*.

Use synchronization to establish happens-before:

```go
var a int
var done = make(chan bool)

// Goroutine 1
a = 1
done <- true  // Send happens-before receive

// Goroutine 2
<-done
fmt.Println(a)  // Guaranteed to see 1
```

### Atomic Operations and Ordering

Go's `sync/atomic` operations are sequentially consistent, and that is the only mode there is. There is no "by default" about it: Go does not offer relaxed, acquire, release, or acquire-release variants the way C++ and Rust do. `sync/atomic`'s own documentation states the rule directly, that if the effect of atomic operation A is observed by atomic operation B then A "synchronizes before" B, and that all atomic operations in a program behave as though executed in some sequentially consistent order, giving the same semantics as C++'s sequentially consistent atomics and Java's `volatile`.

You will still see Go atomics described as release stores and acquire loads. That description is not false, since sequential consistency implies acquire-release, but it understates the guarantee and imports vocabulary for distinctions Go does not make. Say sequentially consistent, and reason with the stronger property you actually have.

The practical consequence is the one the code below relies on: every write that precedes `ready.Store(true)` in program order is visible to any goroutine that observes `ready.Load()` returning `true`. That is what publishes the `data` array to readers without a mutex or channel.

```go
var data [100]int
var ready atomic.Bool

// Writer
for i := range data {
    data[i] = i
}
ready.Store(true)  // Publishes every write above

// Reader
for !ready.Load() {
    runtime.Gosched()
}
// All data[i] writes are visible here
```

The spin loop is here to isolate the memory-model point, not as a pattern to copy. Burning a core polling an atomic is worse in every respect than receiving from a channel, which parks the goroutine and establishes the same happens-before edge. Reach for the channel.

### sync/atomic Memory Order

All operations in the `sync/atomic` package provide sequentially consistent ordering, meaning the order of atomic operations observed by any goroutine is consistent with a single global total order. This is the strongest guarantee available, and it matches what most programmers intuitively expect. Unlike C++ or Rust, Go does not expose relaxed or acquire-release ordering modes.

The example below depends on that total order, and it is worth tracing rather than accepting. Goroutine 1's two stores keep their program order in the total order. If goroutine 2 observes `y == 1`, then `y.Store(1)` precedes that load in the total order, and therefore `x.Store(1)` does too. So the subsequent `x.Load()` must return 1. On a weakly ordered machine such as arm64 this costs real barrier instructions, which is exactly the peak performance Go trades away for a guarantee you can reason about.

```go
var x, y atomic.Int64

// Goroutine 1
x.Store(1)
y.Store(1)  // Sequentially consistent

// Goroutine 2
if y.Load() == 1 {
    // x.Load() will see 1
}
```

### Staff Lens: Memory Ordering Is a Specialist Skill

Reasoning about memory ordering is one of the hardest skills in concurrent programming. Even seasoned C++ developers get it wrong. Go's decision to provide only sequentially consistent atomics trades some peak performance for correctness-friendly semantics, and this is almost always the right tradeoff.

The staff-level discipline: do not let memory-ordering reasoning enter the team's code review unless absolutely necessary. If a PR requires this level of analysis, either the design should change (eliminate the shared state, use a higher-level primitive), or a specialist should review. Most teams have one or two members with the background for this. Route memory-ordering code to them.

### Principal Lens: Go's Simpler Memory Model Is a Feature

Principal engineers evaluating Go as a language for new work should note that Go's memory model is simpler than C++'s or Rust's. For most teams, this is a net win: fewer correctness traps, easier review. The cost is some lost peak performance (Go cannot express "relaxed" atomics that are faster on weakly-ordered architectures). For 99% of Go services, this cost is invisible. The simpler memory model pays back its cost through years of fewer memory-ordering bugs.

---
