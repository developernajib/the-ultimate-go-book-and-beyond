export default `## 5.11 Common Mistakes and How to Avoid Them

### Mistake 1: Returning Pointers to Loop Variables

In pre-1.22 Go, the loop variable \`i\` is a single memory location reused on every iteration, so every pointer stored in \`result\` ends up pointing to the same address. Go 1.22+ fixes this by giving each iteration its own copy of the loop variable, making the manual \`v := i\` workaround unnecessary on modern toolchains.

\`\`\`go
// WRONG: All pointers point to the same memory
func getPointers() []*int {
    result := make([]*int, 3)
    for i := 0; i < 3; i++ {
        result[i] = &i  // i is reused!
    }
    return result  // All point to same variable (value: 3)
}

// CORRECT: Create new variable each iteration
func getPointers() []*int {
    result := make([]*int, 3)
    for i := 0; i < 3; i++ {
        v := i  // New variable each iteration
        result[i] = &v
    }
    return result
}

// CORRECT (Go 1.22+): Loop variables have per-iteration scope
func getPointers() []*int {
    result := make([]*int, 3)
    for i := 0; i < 3; i++ {
        result[i] = &i  // Works correctly in Go 1.22+
    }
    return result
}
\`\`\`

### Mistake 2: Nil Interface Comparison

An interface value holds two internal words: a type pointer and a data pointer. Assigning a typed nil (\`*MyError\`(nil)) to an \`error\` interface sets the type word to \`*MyError\` while leaving the data word nil, making the interface itself non-nil. Always return untyped \`nil\` directly from functions that return interface types.

\`\`\`go
// WRONG: This doesn't work as expected
type MyError struct{}
func (e *MyError) Error() string { return "error" }

func getError() error {
    var err *MyError = nil
    return err  // Returns non-nil interface!
}

func main() {
    if err := getError(); err != nil {
        // This executes even though err is "nil"!
        fmt.Println("Error:", err)
    }
}

// CORRECT: Return nil explicitly
func getError() error {
    var err *MyError = nil
    if err != nil {
        return err
    }
    return nil  // Return untyped nil
}
\`\`\`

### Mistake 3: Ignoring Escape Analysis

Taking the address of a local variable causes it to escape to the heap, adding GC pressure in hot code paths. Accepting a caller-provided pointer for output or returning a value type for small structs keeps allocations on the stack. Use \`go build -gcflags="-m"\` to inspect escape decisions.

\`\`\`go
// WRONG: Unnecessary heap allocation
func processData(data []byte) *Result {
    result := &Result{}  // Always allocates on heap
    // ... process
    return result
}

// BETTER: Let caller control allocation
func processData(data []byte, result *Result) {
    // Caller provides memory - can be stack allocated
    // ... process
}

// Or return by value for small types
func processData(data []byte) Result {
    result := Result{}  // May stay on stack
    // ... process
    return result
}
\`\`\`

### Mistake 4: Forgetting sync.Pool Returns \`any\`

\`sync.Pool.Get()\` returns \`any\`, and the pool may contain objects put back by other goroutines. Wrapping Get and Put in typed helper functions confines the type assertion to a single place and allows zeroing the buffer before reuse to prevent data leaks between requests.

\`\`\`go
// WRONG: Type assertion can fail
var pool = sync.Pool{
    New: func() any {
        return make([]byte, 1024)
    },
}

func process() {
    // This panics if pool contains wrong type
    buf := pool.Get().([]byte)
    defer pool.Put(buf)
}

// CORRECT: Wrap in type-safe functions
func getBuffer() []byte {
    if v := pool.Get(); v != nil {
        return v.([]byte)
    }
    return make([]byte, 1024)
}

func putBuffer(buf []byte) {
    // Reset buffer before returning
    for i := range buf {
        buf[i] = 0
    }
    pool.Put(buf)
}
\`\`\`

### Mistake 5: Creating Pointers to Slice/Map Elements

When \`append\` exceeds the slice's capacity it allocates a new backing array, silently invalidating any pointers taken from the old array. The original pointer now points to stale memory, producing corrupt writes or undefined behavior. Track elements by index rather than pointer whenever the slice may grow.

\`\`\`go
// WRONG: Pointer becomes invalid after append
func dangerous() {
    s := []int{1, 2, 3}
    ptr := &s[0]  // Points to backing array

    s = append(s, 4, 5, 6, 7)  // May reallocate!

    *ptr = 100  // May modify old memory or crash
}

// CORRECT: Work with indices, not pointers
func safe() {
    s := []int{1, 2, 3}
    index := 0

    s = append(s, 4, 5, 6, 7)

    s[index] = 100  // Always correct
}
\`\`\`

### Mistake 6: Inefficient Struct Layout

The Go compiler inserts alignment padding after each field to satisfy platform alignment requirements for the next field. Ordering fields from largest to smallest type eliminates most padding, reducing struct size and the number of cache lines it occupies. Use \`go vet\` or \`fieldalignment\` to detect suboptimal layouts.

\`\`\`go
// WRONG: 24 bytes due to padding
type Bad struct {
    a bool    // 1 + 7 padding
    b int64   // 8
    c bool    // 1 + 7 padding
}

// CORRECT: 16 bytes with optimal ordering
type Good struct {
    b int64   // 8
    a bool    // 1
    c bool    // 1 + 6 padding
}
\`\`\`

### Wire These Into CI

For a senior engineer maintaining a Go service, every mistake on this list has a tooling answer:

1. **Slice memory leak (small slice holding large array alive).** \`staticcheck\` does not catch this. The discipline is "always copy when returning a sub-slice from a function that holds a larger buffer". Code review is the enforcement mechanism.
2. **Map iteration during write.** \`go vet\` and \`staticcheck\` partially cover. Catch the rest in code review.
3. **Goroutine leaks.** \`goleak\` from \`uber-go/goleak\` runs in tests and catches leaked goroutines at the end of each test. Wire it into the test suite.
4. **Mutex copy.** \`go vet\`'s \`copylocks\` analyser is the canonical check. It is on by default in \`go test\`. Make sure CI runs \`go vet\`.
5. **Race conditions.** \`go test -race\` is the answer. Run it in CI for every PR. The overhead is real but the bugs caught are catastrophic.
6. **Inefficient struct layout.** \`fieldalignment\` from \`golang.org/x/tools\` flags it. Wire into \`golangci-lint\`.

The team's review checklist should reference this list and the tooling that enforces each. The discipline of "every recurring bug has a lint rule" is the difference between a team that catches mistakes once and a team that catches them every time.

---
`;
