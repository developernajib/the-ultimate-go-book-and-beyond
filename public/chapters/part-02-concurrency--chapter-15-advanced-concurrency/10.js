export default `## 15.9 Memory Ordering and Barriers

Go's memory model defines which writes to shared variables are visible to reads in other goroutines. Without this model, reasoning about concurrent code correctness is impossible, the compiler and CPU both reorder operations in ways that break naive assumptions about execution order.

### Happens-Before Relationships

Go's memory model guarantees that a write to a variable is visible to a read only when the write _happens-before_ the read according to the formal partial order. Without an explicit synchronization point, a channel send/receive, mutex lock/unlock, or \`sync/atomic\` operation, the compiler and CPU are free to reorder operations, making concurrent reads of unsynchronized shared variables produce unpredictable results.

\`\`\`go
var a, b int

// Goroutine 1
a = 1
b = 2

// Goroutine 2
if b == 2 {
    // a might be 0 or 1 - no guarantee!
}
\`\`\`

Use synchronization to establish happens-before:

\`\`\`go
var a int
var done = make(chan bool)

// Goroutine 1
a = 1
done <- true  // Send happens-before receive

// Goroutine 2
<-done
fmt.Println(a)  // Guaranteed to see 1
\`\`\`

### Atomic Operations and Ordering

Go's \`sync/atomic\` operations carry sequentially consistent semantics by default: a \`Store\` acts as a release barrier, and a \`Load\` acts as an acquire barrier. This means all memory writes that happen before \`ready.Store(true)\` are guaranteed to be visible to any goroutine that observes \`ready.Load()\` returning \`true\`, allowing the \`data\` array to be published to readers without an explicit mutex or channel synchronization.

\`\`\`go
var data [100]int
var ready atomic.Bool

// Writer
for i := range data {
    data[i] = i
}
ready.Store(true)  // Release semantics

// Reader
for !ready.Load() {  // Acquire semantics
    runtime.Gosched()
}
// All data[i] writes are visible here
\`\`\`

### sync/atomic Memory Order

All operations in the \`sync/atomic\` package provide sequentially consistent ordering. This means that the order of atomic operations observed by any goroutine is consistent with a single global total order. In practice, this is the strongest guarantee available and matches the behavior most programmers intuitively expect, unlike C++ or Rust, Go does not expose relaxed or acquire-release ordering modes. The following example shows two atomic stores that are guaranteed to be visible in order to any goroutine reading them.

\`\`\`go
var x, y atomic.Int64

// Goroutine 1
x.Store(1)
y.Store(1)  // Sequentially consistent

// Goroutine 2
if y.Load() == 1 {
    // x.Load() will see 1
}
\`\`\`

### Staff Lens: Memory Ordering Is a Specialist Skill

Reasoning about memory ordering is one of the hardest skills in concurrent programming. Even seasoned C++ developers get it wrong. Go's decision to provide only sequentially consistent atomics trades some peak performance for correctness-friendly semantics, and this is almost always the right tradeoff.

The staff-level discipline: do not let memory-ordering reasoning enter the team's code review unless absolutely necessary. If a PR requires this level of analysis, either the design should change (eliminate the shared state, use a higher-level primitive), or a specialist should review. Most teams have one or two members with the background for this. Route memory-ordering code to them.

### Principal Lens: Go's Simpler Memory Model Is a Feature

Principal engineers evaluating Go as a language for new work should note that Go's memory model is simpler than C++'s or Rust's. For most teams, this is a net win: fewer correctness traps, easier review. The cost is some lost peak performance (Go cannot express "relaxed" atomics that are faster on weakly-ordered architectures). For 99% of Go services, this cost is invisible. The simpler memory model pays back its cost through years of fewer memory-ordering bugs.

---
`;
