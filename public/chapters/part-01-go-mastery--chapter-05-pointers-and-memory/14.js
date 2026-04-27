export default `## 5.13 Exercises with Solutions

### Exercise 1: Pointer Swap

Write a function \`Swap(a, b *int)\` that swaps two integers using pointers.

**Solution:** Go's multiple assignment (\`*a, *b = *b, *a\`) makes this a one-liner. The nil guard prevents panics when callers pass invalid pointers. The generic version extends the pattern to any type.

\`\`\`go
func Swap(a, b *int) {
    if a == nil || b == nil {
        return
    }
    *a, *b = *b, *a
}

// Generic version
func SwapGeneric[T any](a, b *T) {
    if a == nil || b == nil {
        return
    }
    *a, *b = *b, *a
}

// Test
func TestSwap(t *testing.T) {
    a, b := 1, 2
    Swap(&a, &b)
    if a != 2 || b != 1 {
        t.Errorf("expected a=2, b=1; got a=%d, b=%d", a, b)
    }
}
\`\`\`

### Exercise 2: Escape Analysis Investigation

Write three functions that cause values to escape to the heap and verify with \`go build -gcflags="-m"\`.

**Solution:** Each function below triggers a different escape reason. Run the escape analysis command shown at the bottom and compare the output against the inline comments to confirm your understanding.

\`\`\`go
package main

// 1. Return pointer - escapes
func returnPointer() *int {
    x := 42
    return &x  // x escapes to heap
}

// 2. Store in interface - escapes
func storeInInterface() any {
    x := 42
    return x  // x escapes to heap
}

// 3. Capture in closure - escapes
func captureInClosure() func() int {
    x := 42
    return func() int {
        return x  // x escapes to heap
    }
}

// Non-escaping version
func noEscape() int {
    x := 42
    return x  // x stays on stack
}

func main() {
    _ = returnPointer()
    _ = storeInInterface()
    _ = captureInClosure()
    _ = noEscape()
}

// Run: go build -gcflags="-m" main.go
// Output shows which variables escape
\`\`\`

### Exercise 3: Nil-Safe Linked List

Write a linked list with a \`Length()\` method that handles nil receivers correctly.

**Solution:** Every method starts with a nil check on the receiver, allowing operations on an empty (nil) list without panicking. The recursive approach keeps each method short and takes advantage of Go's nil receiver semantics.

\`\`\`go
package main

import "fmt"

type Node struct {
    Value int
    Next  *Node
}

// Length returns the number of nodes (nil-safe)
func (n *Node) Length() int {
    if n == nil {
        return 0
    }
    return 1 + n.Next.Length()
}

// Sum returns the sum of all values (nil-safe)
func (n *Node) Sum() int {
    if n == nil {
        return 0
    }
    return n.Value + n.Next.Sum()
}

// Append adds a value at the end (returns new head if needed)
func (n *Node) Append(value int) *Node {
    newNode := &Node{Value: value}
    if n == nil {
        return newNode
    }

    current := n
    for current.Next != nil {
        current = current.Next
    }
    current.Next = newNode
    return n
}

// Contains checks if value exists (nil-safe)
func (n *Node) Contains(value int) bool {
    if n == nil {
        return false
    }
    if n.Value == value {
        return true
    }
    return n.Next.Contains(value)
}

// ToSlice converts to slice (nil-safe)
func (n *Node) ToSlice() []int {
    if n == nil {
        return []int{}
    }
    return append([]int{n.Value}, n.Next.ToSlice()...)
}

// Test
func main() {
    var list *Node  // nil

    fmt.Println(list.Length())    // 0
    fmt.Println(list.Sum())       // 0
    fmt.Println(list.Contains(5)) // false

    list = list.Append(1)
    list = list.Append(2)
    list = list.Append(3)

    fmt.Println(list.Length())    // 3
    fmt.Println(list.Sum())       // 6
    fmt.Println(list.Contains(2)) // true
    fmt.Println(list.ToSlice())   // [1 2 3]
}
\`\`\`

### Exercise 4: Struct Optimization

Given this struct, reorder fields to minimize size:

\`\`\`go
type Event struct {
    Type      byte
    ID        uint64
    Processed bool
    Timestamp int64
    Priority  int16
    Data      string
}
\`\`\`

**Solution:** The original layout wastes 8 bytes on alignment padding. Sorting fields from largest alignment to smallest packs the small fields at the end with minimal padding. The program below prints both sizes and field offsets so you can verify the improvement.

\`\`\`go
package main

import (
    "fmt"
    "unsafe"
)

// Original: poorly ordered
type EventBad struct {
    Type      byte    // 1 + 7 padding
    ID        uint64  // 8
    Processed bool    // 1 + 1 padding
    Priority  int16   // 2 + 4 padding
    Timestamp int64   // 8
    Data      string  // 16
}
// Total: 48 bytes

// Optimized: ordered by size descending
type EventGood struct {
    ID        uint64  // 8
    Timestamp int64   // 8
    Data      string  // 16
    Priority  int16   // 2
    Type      byte    // 1
    Processed bool    // 1 + 4 padding
}
// Total: 40 bytes (saved 8 bytes = 17%)

func main() {
    fmt.Printf("Bad layout:  %d bytes\\n", unsafe.Sizeof(EventBad{}))
    fmt.Printf("Good layout: %d bytes\\n", unsafe.Sizeof(EventGood{}))
    fmt.Printf("Savings: %d bytes (%.0f%%)\\n",
        unsafe.Sizeof(EventBad{})-unsafe.Sizeof(EventGood{}),
        float64(unsafe.Sizeof(EventBad{})-unsafe.Sizeof(EventGood{}))/float64(unsafe.Sizeof(EventBad{}))*100,
    )

    // Field offsets
    var e EventGood
    fmt.Println("\\nField offsets:")
    fmt.Printf("  ID:        %d\\n", unsafe.Offsetof(e.ID))
    fmt.Printf("  Timestamp: %d\\n", unsafe.Offsetof(e.Timestamp))
    fmt.Printf("  Data:      %d\\n", unsafe.Offsetof(e.Data))
    fmt.Printf("  Priority:  %d\\n", unsafe.Offsetof(e.Priority))
    fmt.Printf("  Type:      %d\\n", unsafe.Offsetof(e.Type))
    fmt.Printf("  Processed: %d\\n", unsafe.Offsetof(e.Processed))
}
\`\`\`

### Exercise 5: Benchmark Value vs Pointer Passing

Write benchmarks comparing passing structs of various sizes by value vs by pointer.

**Solution:** The benchmarks below test four struct sizes (16B, 64B, 1KB, 8KB) passed both by value and by pointer. Run them with \`go test -bench=. -benchmem\` and compare the ns/op column. You should see value passing become significantly slower than pointer passing around the 64-128 byte mark.

\`\`\`go
package main

import (
    "testing"
)

// Various struct sizes
type Small struct {
    a, b int64  // 16 bytes
}

type Medium struct {
    data [8]int64  // 64 bytes
}

type Large struct {
    data [128]int64  // 1024 bytes
}

type Huge struct {
    data [1024]int64  // 8192 bytes
}

// Value versions
func processSmallValue(s Small) int64   { return s.a + s.b }
func processMediumValue(s Medium) int64 { return s.data[0] }
func processLargeValue(s Large) int64   { return s.data[0] }
func processHugeValue(s Huge) int64     { return s.data[0] }

// Pointer versions
func processSmallPtr(s *Small) int64   { return s.a + s.b }
func processMediumPtr(s *Medium) int64 { return s.data[0] }
func processLargePtr(s *Large) int64   { return s.data[0] }
func processHugePtr(s *Huge) int64     { return s.data[0] }

// Benchmarks
func BenchmarkSmallValue(b *testing.B) {
    s := Small{a: 1, b: 2}
    for b.Loop() {
        _ = processSmallValue(s)
    }
}

func BenchmarkSmallPtr(b *testing.B) {
    s := &Small{a: 1, b: 2}
    for b.Loop() {
        _ = processSmallPtr(s)
    }
}

func BenchmarkMediumValue(b *testing.B) {
    s := Medium{}
    for b.Loop() {
        _ = processMediumValue(s)
    }
}

func BenchmarkMediumPtr(b *testing.B) {
    s := &Medium{}
    for b.Loop() {
        _ = processMediumPtr(s)
    }
}

func BenchmarkLargeValue(b *testing.B) {
    s := Large{}
    for b.Loop() {
        _ = processLargeValue(s)
    }
}

func BenchmarkLargePtr(b *testing.B) {
    s := &Large{}
    for b.Loop() {
        _ = processLargePtr(s)
    }
}

func BenchmarkHugeValue(b *testing.B) {
    s := Huge{}
    for b.Loop() {
        _ = processHugeValue(s)
    }
}

func BenchmarkHugePtr(b *testing.B) {
    s := &Huge{}
    for b.Loop() {
        _ = processHugePtr(s)
    }
}

// Expected results (example):
// BenchmarkSmallValue-8    1000000000    0.25 ns/op    <- Value faster
// BenchmarkSmallPtr-8      1000000000    0.30 ns/op
// BenchmarkMediumValue-8   200000000     6.5 ns/op     <- Similar
// BenchmarkMediumPtr-8     500000000     3.0 ns/op
// BenchmarkLargeValue-8    5000000       350 ns/op     <- Pointer faster
// BenchmarkLargePtr-8      500000000     3.0 ns/op
// BenchmarkHugeValue-8     500000        2500 ns/op    <- Pointer much faster
// BenchmarkHugePtr-8       500000000     3.0 ns/op

// Conclusion: Pointer becomes faster around 64-128 bytes
\`\`\`

### Mid-Level FAANG-Entry Track

These exercises test the operational mental model an interviewer probes for memory-aware Go.

5. **Profile a leaky service.** Take any small Go service you have (or build a deliberately-leaky one with an unbounded slice). Capture a heap profile, identify the leak with \`pprof\`, fix it, and capture before-and-after profiles. Write up the diagnosis in a 200-word incident-report-style note. The deliverable is the writeup plus the diff.

6. **Reduce allocations in a hot path.** Write a JSON-encoder helper that takes a struct and returns the JSON bytes. Benchmark it with \`-benchmem\`. Then optimise: pre-allocate the buffer, replace \`json.Marshal\` with \`json.Encoder.Encode\` to a pooled buffer, measure again. The deliverable is the benchmark numbers showing the reduction.

7. **Implement a \`sync.Pool\`-backed buffer pool with size tiering.** Define tiers at 256B, 1KB, 4KB, 16KB, 64KB, 256KB, 1MB. \`Get(size int)\` returns a buffer of at least \`size\` from the smallest tier that fits. \`Put(buf []byte)\` returns to the appropriate tier. Drop buffers larger than 1MB. Self-check: a \`Put\` followed by a \`Get\` of the same size returns the same backing array.

### Senior at FAANG Track

8. **Quarterly memory review.** Pick a service your team owns. Run a heap profile, an allocation profile, and a goroutine profile. Identify the top three optimisation opportunities. Write a 500-word memo for the team that prioritises them by ROI (engineering cost vs operational benefit). The memo is the deliverable. The interesting part is which opportunities you choose not to pursue and why.

9. **\`fieldalignment\` audit on hot-path types.** For every struct in your service that is allocated more than 1000 times per second (use pprof allocation profile to identify), run \`fieldalignment\` and apply the suggestion. Measure RSS and allocation rate before and after. Document the savings.

10. **Migrate a hand-rolled cache to \`weak.Pointer[T]\`.** Find a cache in your service that uses explicit eviction (LRU, TTL). Evaluate whether it would be better served by weak references. If yes, migrate. If no, document why. The deliverable is the analysis, not necessarily the code change.

11. **Continuous profiling rollout.** If your team does not run continuous profiling (Pyroscope, Parca, or a hosted equivalent), evaluate the rollout cost and the diagnostic value. Write a 1-page proposal. Include the cost (engineering time, infrastructure, retention), the benefit (faster incident diagnosis, regression detection), and the recommendation.

12. **Green Tea GC migration audit.** Verify your services are running Go 1.26 (or document the upgrade plan). Measure GC CPU before and after the upgrade. Document the savings. The deliverable is the measurement plus the recommendation for which services to upgrade in which order.

---
`;
