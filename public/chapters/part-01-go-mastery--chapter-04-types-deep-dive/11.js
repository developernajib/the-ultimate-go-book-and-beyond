export default `## 100 Go Mistakes: Data Types, Slices, and Maps

This section covers common mistakes from "100 Go Mistakes and How to Avoid Them" related to Go's type system. Each mistake includes the wrong pattern, why it fails, and the corrected version with production examples.

### Mistake #17: Creating Confusion with Octal Literals

Go supports multiple integer literal formats, but octal literals can cause confusion:

\`\`\`go
// WRONG: Looks like decimal but is octal
permissions := 0644  // Actually 420 in decimal!

// Common confusion in file permissions
func createFile(name string) error {
    // Developer thinks 755, but Go interprets 0755 as octal
    return os.WriteFile(name, []byte{}, 0755)  // OK: intentionally octal
}

// PROBLEMATIC: Leading zeros in non-permission contexts
numbers := []int{
    100,
    010,   // This is 8, not 10!
    050,   // This is 40, not 50!
    001,   // This is 1
}

// CORRECT: Use explicit base prefixes (Go 1.13+)
permissions := 0o644  // Explicit octal (clearer)
binary := 0b1010      // Binary literal
hex := 0xFF           // Hexadecimal
decimal := 10         // Decimal (no prefix)

// Use underscores for readability (Go 1.13+)
billion := 1_000_000_000
permissions := 0o755
hex := 0xFF_FF_FF_FF
\`\`\`

**Company Practice (Google)**: Google's Go style guide recommends always using \`0o\` prefix for octal literals to make intent explicit, especially in file permission contexts.

### Mistake #18: Neglecting Integer Overflows

Integer overflow in Go is silent: no panic, no error.

\`\`\`go
// DANGEROUS: Silent overflow
var i int32 = math.MaxInt32  // 2147483647
i++                           // Wraps to -2147483648!

// WRONG: Unchecked arithmetic
func addPrices(a, b int32) int32 {
    return a + b  // Can overflow silently!
}

// CORRECT: Check for overflow before operation
func safeAdd(a, b int32) (int32, error) {
    if a > 0 && b > math.MaxInt32-a {
        return 0, errors.New("integer overflow")
    }
    if a < 0 && b < math.MinInt32-a {
        return 0, errors.New("integer underflow")
    }
    return a + b, nil
}

// CORRECT: Use math/big for arbitrary precision
func safeBigAdd(a, b int64) *big.Int {
    bigA := big.NewInt(a)
    bigB := big.NewInt(b)
    return bigA.Add(bigA, bigB)
}

// UBER PATTERN: Conversion with bounds checking
func intToInt32(i int) (int32, error) {
    if i > math.MaxInt32 || i < math.MinInt32 {
        return 0, fmt.Errorf("value %d out of int32 range", i)
    }
    return int32(i), nil
}
\`\`\`

**Company Practice (Stripe)**: Financial calculations at Stripe always use overflow-checked arithmetic to prevent silent corruption of monetary values.

### Mistake #19: Not Understanding Floating-Point Issues

Floating-point arithmetic has inherent precision limitations:

\`\`\`go
// WRONG: Comparing floats with ==
func isEqual(a, b float64) bool {
    return a == b  // Almost never what you want!
}

// WRONG: Financial calculations with floats
price := 0.1 + 0.2
fmt.Println(price == 0.3)  // false! (0.30000000000000004)

// CORRECT: Compare with epsilon
const epsilon = 1e-9

func floatEquals(a, b float64) bool {
    return math.Abs(a-b) < epsilon
}

// CORRECT: Use integers for money (cents)
type Money int64  // Store cents, not dollars

func (m Money) Dollars() float64 {
    return float64(m) / 100
}

func (m Money) String() string {
    return fmt.Sprintf("\$%d.%02d", m/100, m%100)
}

// CORRECT: Use math/big for exact decimal arithmetic
func preciseCalculation() {
    // Exact decimal using big.Rat
    third := new(big.Rat).SetFrac64(1, 3)
    result := new(big.Rat).Mul(third, big.NewRat(3, 1))
    fmt.Println(result.FloatString(10))  // Exactly 1.0
}

// STRIPE PATTERN: All money as smallest unit
type Amount struct {
    Value    int64  // Always in smallest currency unit
    Currency string // "usd", "eur", etc.
}

func (a Amount) Add(b Amount) (Amount, error) {
    if a.Currency != b.Currency {
        return Amount{}, errors.New("currency mismatch")
    }
    result, err := safeAdd(a.Value, b.Value)
    if err != nil {
        return Amount{}, err
    }
    return Amount{Value: result, Currency: a.Currency}, nil
}
\`\`\`

**Company Practice (Stripe)**: All monetary values at Stripe are stored as integers in the smallest currency unit (cents for USD). Never use \`float64\` for money.

### Mistake #20: Not Understanding Slice Length and Capacity

Confusion between length and capacity leads to subtle bugs:

\`\`\`go
// WRONG: Assuming length equals capacity
s := make([]int, 3, 10)
fmt.Println(len(s), cap(s))  // 3, 10

// WRONG: Accessing beyond length (even within capacity)
s := make([]int, 3, 10)
fmt.Println(s[5])  // PANIC: index out of range!

// Elements exist only up to length, not capacity
s := make([]int, 0, 10)
s[0] = 1  // PANIC: index out of range!

// CORRECT: Use append for zero-length slices
s := make([]int, 0, 10)
s = append(s, 1, 2, 3)  // Now len=3, cap=10

// CORRECT: Initialize with length if filling directly
s := make([]int, 10)  // len=10, cap=10
for i := 0; i < len(s); i++ {
    s[i] = i * 2
}

// UNDERSTANDING: Reslicing within capacity
original := make([]int, 5, 10)
for i := range original {
    original[i] = i
}

// Can expand within capacity
extended := original[:8]  // OK: cap is 10
fmt.Println(len(extended))  // 8

// Cannot exceed capacity
// tooBig := original[:15]  // PANIC!
\`\`\`

### Mistake #21: Inefficient Slice Initialization

Creating slices without proper capacity leads to multiple allocations:

\`\`\`go
// WRONG: Growing slice without pre-allocation
func collectIDs(users []User) []int {
    var ids []int  // nil slice, cap=0
    for _, u := range users {
        ids = append(ids, u.ID)  // Multiple reallocations!
    }
    return ids
}

// With 1000 users, this causes ~10 allocations and copies

// CORRECT: Pre-allocate with known size
func collectIDsEfficient(users []User) []int {
    ids := make([]int, 0, len(users))  // Pre-allocate
    for _, u := range users {
        ids = append(ids, u.ID)  // No reallocation
    }
    return ids
}

// CORRECT: Direct assignment when size is known
func collectIDsDirect(users []User) []int {
    ids := make([]int, len(users))  // Length = size
    for i, u := range users {
        ids[i] = u.ID  // Direct assignment
    }
    return ids
}

// BENCHMARK COMPARISON:
// BenchmarkNoPrealloc-8     50000    25000 ns/op    40960 B/op   10 allocs/op
// BenchmarkPrealloc-8      200000     8000 ns/op    8192 B/op     1 allocs/op

// UBER PATTERN: Always pre-allocate when size is known or estimable
func processRecords(count int) []Result {
    results := make([]Result, 0, count)
    // ... process
    return results
}
\`\`\`

**Company Practice (Uber)**: Uber's Go style guide mandates pre-allocation for any slice where the size is known or can be reasonably estimated.

### Mistake #22: Being Confused About nil vs. Empty Slices

nil and empty slices behave differently in some contexts:

\`\`\`go
// Both nil and empty slices have len=0
var nilSlice []int          // nil slice
emptySlice := []int{}       // empty slice
makeSlice := make([]int, 0) // empty slice

fmt.Println(nilSlice == nil)   // true
fmt.Println(emptySlice == nil) // false
fmt.Println(makeSlice == nil)  // false

fmt.Println(len(nilSlice))     // 0 (all three)
fmt.Println(len(emptySlice))   // 0
fmt.Println(len(makeSlice))    // 0

// JSON encoding differs!
type Response struct {
    Items []string \`json:"items"\`
}

r1 := Response{Items: nil}
r2 := Response{Items: []string{}}

j1, _ := json.Marshal(r1)  // {"items":null}
j2, _ := json.Marshal(r2)  // {"items":[]}

// CORRECT: Choose based on semantic meaning
func getUsers() []User {
    users := queryDB()
    if len(users) == 0 {
        return []User{}  // Return empty, not nil, for consistent JSON
    }
    return users
}

// CORRECT: Use omitempty for optional fields
type Response struct {
    Items []string \`json:"items,omitempty"\`  // Omits if nil or empty
}

// GOOGLE PATTERN: Be explicit about nil vs empty
func NewCache() *Cache {
    return &Cache{
        items: make(map[string]Item),  // Explicit empty map
        keys:  []string{},              // Explicit empty slice
    }
}
\`\`\`

**Company Practice (Google)**: Google recommends being explicit about whether you want nil or empty slices, especially in APIs where JSON serialization matters.

### Mistake #23: Not Properly Checking if a Slice is Empty

Using nil checks instead of length checks:

\`\`\`go
// WRONG: Only checks for nil
func processItems(items []Item) error {
    if items == nil {  // Misses empty slices!
        return errors.New("no items")
    }
    // ...
}

// Empty slice passes the nil check but may not be valid input
processItems([]Item{})  // No error, but no items to process

// CORRECT: Check length
func processItems(items []Item) error {
    if len(items) == 0 {  // Catches both nil and empty
        return errors.New("no items")
    }
    // ...
}

// len() is safe on nil slices
var s []int
fmt.Println(len(s))  // 0, no panic

// CORRECT: Idiomatic emptiness check
func isEmpty(s []int) bool {
    return len(s) == 0  // Works for nil and empty
}
\`\`\`

### Mistake #24: Not Making Slice Copies Correctly

Sharing backing arrays leads to unexpected mutations:

\`\`\`go
// WRONG: Slice assignment shares backing array
original := []int{1, 2, 3, 4, 5}
copy := original  // Both point to same array!
copy[0] = 999
fmt.Println(original[0])  // 999 - original modified!

// WRONG: Slicing shares backing array
original := []int{1, 2, 3, 4, 5}
slice := original[1:3]  // [2, 3]
slice[0] = 999
fmt.Println(original[1])  // 999 - original modified!

// CORRECT: Use copy() function
original := []int{1, 2, 3, 4, 5}
duplicate := make([]int, len(original))
copy(duplicate, original)  // Deep copy
duplicate[0] = 999
fmt.Println(original[0])  // 1 - original unchanged

// CORRECT: Append to nil slice for copy
original := []int{1, 2, 3, 4, 5}
duplicate := append([]int(nil), original...)  // One-liner copy

// CORRECT: Full slice expression prevents accidental modification
original := []int{1, 2, 3, 4, 5}
slice := original[1:3:3]  // Length=2, Capacity=2
slice = append(slice, 999)  // Forces new allocation
fmt.Println(original)  // [1 2 3 4 5] - unchanged

// UBER PATTERN: Return copies from getters
type Cache struct {
    mu    sync.RWMutex
    items []Item
}

func (c *Cache) Items() []Item {
    c.mu.RLock()
    defer c.mu.RUnlock()

    // Return a copy to prevent external modification
    result := make([]Item, len(c.items))
    copy(result, c.items)
    return result
}
\`\`\`

### Mistake #25: Unexpected Side Effects Using Slice Append

Append can modify shared backing arrays:

\`\`\`go
// DANGEROUS: Append within capacity modifies shared array
s := make([]int, 3, 6)  // len=3, cap=6
s[0], s[1], s[2] = 1, 2, 3

s1 := append(s, 4)    // len=4, cap=6
s2 := append(s, 5)    // len=4, cap=6 - overwrites s1[3]!

fmt.Println(s1[3])  // 5, not 4!
fmt.Println(s2[3])  // 5

// WHY: Both appends fit within capacity, share backing array
// s1 appends 4 at index 3
// s2 appends 5 at index 3 (overwrites!)

// CORRECT: Full slice expression to limit capacity
s := make([]int, 3, 6)
s[0], s[1], s[2] = 1, 2, 3

s1 := append(s[:3:3], 4)  // Forces new allocation
s2 := append(s[:3:3], 5)  // Forces new allocation

fmt.Println(s1[3])  // 4 - correct
fmt.Println(s2[3])  // 5 - correct

// CORRECT: Copy first if you need independence
s := []int{1, 2, 3}
s1Copy := append([]int(nil), s...)
s1 := append(s1Copy, 4)

s2Copy := append([]int(nil), s...)
s2 := append(s2Copy, 5)
\`\`\`

### Mistake #26: Slices and Memory Leaks

Holding references to large backing arrays:

\`\`\`go
// WRONG: Small slice holds reference to large array
func getFirstTen(data []byte) []byte {
    return data[:10]  // Still references entire backing array!
}

// If data is 1GB, the returned slice prevents GC of 1GB

// CORRECT: Copy to release reference
func getFirstTen(data []byte) []byte {
    result := make([]byte, 10)
    copy(result, data[:10])
    return result  // Only 10 bytes retained
}

// WRONG: Pointer in slice prevents GC
type BigStruct struct {
    Data [1024 * 1024]byte  // 1MB
}

func filterStructs(items []*BigStruct) []*BigStruct {
    var result []*BigStruct
    for _, item := range items {
        if item != nil {
            result = append(result, item)
        }
    }
    return result  // Holds references to all BigStructs
}

// If you only need a few, copy them
func filterAndCopy(items []*BigStruct) []BigStruct {
    var result []BigStruct
    for _, item := range items {
        if item != nil && shouldKeep(item) {
            result = append(result, *item)  // Copy value
        }
    }
    return result  // No references to original
}

// NETFLIX PATTERN: Explicit cleanup for long-lived slices
type Buffer struct {
    data []byte
}

func (b *Buffer) Compact() {
    if cap(b.data) > len(b.data)*4 {  // More than 4x waste
        newData := make([]byte, len(b.data))
        copy(newData, b.data)
        b.data = newData  // Release old backing array
    }
}
\`\`\`

**Company Practice (Netflix)**: Netflix services that process large data streams implement periodic compaction to prevent memory bloat from over-capacity slices.

### Mistake #27: Inefficient Map Initialization

Maps without size hints cause repeated rehashing:

\`\`\`go
// WRONG: No size hint
func buildIndex(items []Item) map[string]Item {
    index := make(map[string]Item)  // Unknown size
    for _, item := range items {
        index[item.ID] = item  // Multiple rehashes as map grows
    }
    return index
}

// CORRECT: Provide size hint
func buildIndexEfficient(items []Item) map[string]Item {
    index := make(map[string]Item, len(items))  // Size hint
    for _, item := range items {
        index[item.ID] = item  // No rehashing
    }
    return index
}

// BENCHMARK COMPARISON (10000 items):
// BenchmarkNoHint-8     1000    1500000 ns/op    700000 B/op   100 allocs/op
// BenchmarkWithHint-8   3000     500000 ns/op    400000 B/op     2 allocs/op

// UBER PATTERN: Always hint maps with known or estimated size
type Cache struct {
    items map[string]Item
}

func NewCache(expectedSize int) *Cache {
    return &Cache{
        items: make(map[string]Item, expectedSize),
    }
}
\`\`\`

**Company Practice (Uber)**: All maps at Uber must be initialized with size hints when the size is known or can be estimated. This is enforced by linters.

### Mistake #28: Maps and Memory Leaks

Maps never shrink, even when entries are deleted:

\`\`\`go
// PROBLEM: Map memory never decreases
func mapMemoryDemo() {
    m := make(map[int][]byte)

    // Add 1 million entries
    for i := 0; i < 1_000_000; i++ {
        m[i] = make([]byte, 1024)  // 1KB each
    }
    // Memory: ~1GB

    // Delete all entries
    for i := 0; i < 1_000_000; i++ {
        delete(m, i)
    }
    // Memory: Still ~1GB! Map buckets not released

    runtime.GC()  // Doesn't help
}

// CORRECT: Replace map entirely to reclaim memory
func periodicCleanup(m map[int][]byte) map[int][]byte {
    newMap := make(map[int][]byte, len(m))
    for k, v := range m {
        if shouldKeep(k, v) {
            newMap[k] = v
        }
    }
    return newMap  // Old map can be GC'd
}

// CORRECT: Use sync.Map with periodic recreation
type Cache struct {
    mu   sync.RWMutex
    data map[string]Item
}

func (c *Cache) Compact() {
    c.mu.Lock()
    defer c.mu.Unlock()

    newData := make(map[string]Item, len(c.data))
    for k, v := range c.data {
        if !v.IsExpired() {
            newData[k] = v
        }
    }
    c.data = newData
}

// DATADOG PATTERN: Periodic map rotation
type MetricsStore struct {
    current  map[string]int64
    previous map[string]int64
    mu       sync.RWMutex
}

func (s *MetricsStore) Rotate() {
    s.mu.Lock()
    s.previous = s.current
    s.current = make(map[string]int64, len(s.previous))
    s.mu.Unlock()
}
\`\`\`

**Company Practice (Datadog)**: Datadog's agent uses map rotation patterns to prevent unbounded memory growth in long-running metric collection.

### Mistake #29: Comparing Values Incorrectly

Using \`==\` on non-comparable types or missing \`reflect.DeepEqual\` nuances:

\`\`\`go
// COMPILE ERROR: Slices not comparable with ==
s1 := []int{1, 2, 3}
s2 := []int{1, 2, 3}
// fmt.Println(s1 == s2)  // Won't compile!

// COMPILE ERROR: Maps not comparable with ==
m1 := map[string]int{"a": 1}
m2 := map[string]int{"a": 1}
// fmt.Println(m1 == m2)  // Won't compile!

// WRONG: reflect.DeepEqual with different types
var i int = 1
var i64 int64 = 1
fmt.Println(reflect.DeepEqual(i, i64))  // false! Different types

// WRONG: DeepEqual with empty vs nil slices
var nilSlice []int
emptySlice := []int{}
fmt.Println(reflect.DeepEqual(nilSlice, emptySlice))  // false!

// CORRECT: Manual comparison for slices
func sliceEqual(a, b []int) bool {
    if len(a) != len(b) {
        return false
    }
    for i := range a {
        if a[i] != b[i] {
            return false
        }
    }
    return true
}

// CORRECT: Use slices.Equal (Go 1.21+)
import "slices"
fmt.Println(slices.Equal([]int{1, 2}, []int{1, 2}))  // true

// CORRECT: Use maps.Equal (Go 1.21+)
import "maps"
fmt.Println(maps.Equal(m1, m2))  // true

// CORRECT: Custom equality for structs
type User struct {
    ID   int
    Name string
    Tags []string
}

func (u User) Equal(other User) bool {
    return u.ID == other.ID &&
           u.Name == other.Name &&
           slices.Equal(u.Tags, other.Tags)
}

// UBER PATTERN: Define Equals method for complex types
type Config struct {
    Settings map[string]string
    Enabled  []string
}

func (c Config) Equals(other Config) bool {
    return maps.Equal(c.Settings, other.Settings) &&
           slices.Equal(c.Enabled, other.Enabled)
}
\`\`\`

### Quick Reference: Type Mistakes to Avoid

| Mistake | Problem | Solution |
|---------|---------|----------|
| Octal confusion | \`010\` is 8, not 10 | Use \`0o10\` for explicit octal |
| Integer overflow | Silent wrap-around | Check bounds before arithmetic |
| Float comparison | \`0.1 + 0.2 != 0.3\` | Use epsilon or integers for money |
| Slice nil check | Misses empty slices | Use \`len(s) == 0\` |
| Slice copy | Shares backing array | Use \`copy()\` or \`append(nil, s...)\` |
| Append side effects | Modifies shared array | Use full slice expression \`s[:n:n]\` |
| Map no hint | Multiple rehashes | Always provide size hint |
| Map memory leak | Deleted entries waste space | Recreate map periodically |
| Value comparison | Can't use \`==\` on slices | Use \`slices.Equal\` (Go 1.21+) |

### How to Use This List in Code Review

For the senior track, the list above is the skeleton of a team code-review checklist. Three ways to deploy it:

1. **Wire the mechanical checks into CI.** \`errorlint\` catches bare \`err == ErrFoo\` comparisons. \`staticcheck\` catches many of the integer-overflow and slice-aliasing patterns. \`fieldalignment\` catches struct-padding waste. \`gofmt -s\` simplifies redundant code. Wire them all into the pre-merge pipeline so the easy findings happen without human attention.
2. **Train the team on the non-mechanical checks.** Integer overflow in monetary code, float comparisons in scientific code, slice aliasing across function boundaries, map-backing-array retention. These require human judgment and domain knowledge. Walk through each with the team once and add them to the review guide.
3. **Audit the existing codebase.** For an established service, take the list and audit the entire repository. Typed-nil returns, slice aliasing, map iteration order dependency. Document the findings. Prioritise the fixes by blast radius. Not all findings are worth fixing today, but cataloguing them turns "latent bugs" into "known, prioritised work".

The list is not exhaustive. Real teams accumulate their own list of institutional mistakes (patterns that have burned them before), and the team's code-review guide is a living document that captures those. The 100-Go-Mistakes catalogue is a starting point, not a finishing line.

### What FAANG Reviewers Actually Flag

For engineers interviewing for FAANG-tier Go roles, the take-home-assignment and on-site-coding feedback most commonly flags three of the mistakes above:

1. **Slice aliasing.** Returning a slice that aliases an internal buffer, then having the test suite fail when the caller appends to it. A 50% failure rate among otherwise-strong junior candidates.
2. **Map iteration order dependency.** A test that passes locally but fails in CI because iteration order changed. A signal that the candidate has not internalised the randomisation discipline.
3. **Error wrapping without \`%w\`.** The interviewer asks a follow-up like "how would the caller detect a not-found condition?" and the candidate cannot answer because the wrap discarded the sentinel.

Internalising these three is more valuable in an interview than memorising the full list. The interviewer is testing fluency, not trivia.

---
`;
