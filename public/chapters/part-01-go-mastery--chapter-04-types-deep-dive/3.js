export default `## 4.2 Strings and Text

Strings in Go are immutable sequences of bytes, typically containing UTF-8 encoded text.

### String Internals

A string is a two-word data structure:

\`\`\`go
// Internal representation (simplified)
type stringStruct struct {
    ptr *byte  // Pointer to byte array
    len int    // Length in bytes
}
\`\`\`

This means:
- \`len(s)\` returns bytes, not characters
- Strings are cheap to pass (just 16 bytes on 64-bit)
- Slicing creates a new header but shares the data

\`\`\`go
s := "Hello, World!"
// sizeof(s) = 16 bytes (pointer + length)
// The actual "Hello, World!" data lives on the heap
\`\`\`

### UTF-8 Encoding

Go strings are UTF-8 by default. UTF-8 is a variable-width encoding:
- ASCII characters: 1 byte
- Most European characters: 2 bytes
- Most Asian characters: 3 bytes
- Emojis: 4 bytes

\`\`\`go
s := "Hello, 世界"
fmt.Println(len(s))         // 13 (bytes, not characters)
fmt.Println(len([]rune(s))) // 9 (runes/characters)

// Breakdown:
// H e l l o ,   世   界
// 1 1 1 1 1 1 1  3   3  = 13 bytes total
\`\`\`

### Runes vs Bytes

Strings in Go are byte sequences, but text operations often need Unicode code points (runes). Iterating with \`range\` over a string yields runes. Indexing yields bytes. Confusing the two causes incorrect text processing.

\`\`\`go
s := "café"
fmt.Println(len(s))  // 5 (é is 2 bytes in UTF-8)

// Iterating by byte
for i := 0; i < len(s); i++ {
    fmt.Printf("%d: %x\\n", i, s[i])
}
// 0: 63 (c), 1: 61 (a), 2: 66 (f), 3: c3, 4: a9 (é as two bytes)

// Iterating by rune
for i, r := range s {
    fmt.Printf("%d: %c (%U)\\n", i, r, r)
}
// 0: c (U+0063)
// 1: a (U+0061)
// 2: f (U+0066)
// 3: é (U+00E9)  <- index jumps from 3 to 5 because é is 2 bytes
\`\`\`

### String Operations

The \`strings\` package provides essential operations:

\`\`\`go
import "strings"

s := "Hello, World!"

// Searching
strings.Contains(s, "World")     // true
strings.HasPrefix(s, "Hello")    // true
strings.HasSuffix(s, "!")        // true
strings.Index(s, "o")            // 4
strings.LastIndex(s, "o")        // 8
strings.Count(s, "l")            // 3

// Transforming
strings.ToUpper(s)               // "HELLO, WORLD!"
strings.ToLower(s)               // "hello, world!"
strings.TrimSpace("  hi  ")      // "hi"
strings.Trim("!!!hi!!!", "!")    // "hi"
strings.Replace(s, "o", "0", -1) // "Hell0, W0rld!"
strings.ReplaceAll(s, "l", "L")  // "HeLLo, WorLd!"

// Splitting and joining
strings.Split("a,b,c", ",")      // []string{"a", "b", "c"}
strings.SplitN("a,b,c", ",", 2)  // []string{"a", "b,c"}
strings.Fields("a b  c")         // []string{"a", "b", "c"}
strings.Join([]string{"a", "b"}, "-") // "a-b"

// Case-insensitive comparison
strings.EqualFold("Go", "go")    // true
\`\`\`

### Efficient String Building

String concatenation creates new strings each time:

\`\`\`go
// Slow: O(n²) for n concatenations
s := ""
for i := 0; i < 10000; i++ {
    s += "x"  // Creates new string each iteration
}
\`\`\`

Use \`strings.Builder\` instead:

\`\`\`go
// Fast: O(n) with amortized allocations
var b strings.Builder
for i := 0; i < 10000; i++ {
    b.WriteString("x")
}
s := b.String()  // One allocation at the end
\`\`\`

Or preallocate:

\`\`\`go
// Fastest: single allocation
var b strings.Builder
b.Grow(10000)  // Preallocate capacity
for i := 0; i < 10000; i++ {
    b.WriteByte('x')
}
s := b.String()
\`\`\`

### How Netflix Builds Log Messages

Netflix processes petabytes of logs daily. Here's their pattern:

\`\`\`go
// Netflix-style efficient log message building
type LogBuilder struct {
    b strings.Builder
}

func NewLogBuilder() *LogBuilder {
    lb := &LogBuilder{}
    lb.b.Grow(256)  // Typical log message size
    return lb
}

func (lb *LogBuilder) Add(key, value string) *LogBuilder {
    if lb.b.Len() > 0 {
        lb.b.WriteByte(' ')
    }
    lb.b.WriteString(key)
    lb.b.WriteByte('=')
    lb.b.WriteString(value)
    return lb
}

func (lb *LogBuilder) AddInt(key string, value int) *LogBuilder {
    if lb.b.Len() > 0 {
        lb.b.WriteByte(' ')
    }
    lb.b.WriteString(key)
    lb.b.WriteByte('=')
    lb.b.WriteString(strconv.Itoa(value))
    return lb
}

func (lb *LogBuilder) String() string {
    return lb.b.String()
}

// Usage
log := NewLogBuilder().
    Add("service", "recommendation").
    Add("request_id", "abc123").
    AddInt("latency_ms", 45).
    String()
// "service=recommendation request_id=abc123 latency_ms=45"
\`\`\`

### String Conversions

Converting between \`string\`, \`[]byte\`, and \`[]rune\` copies the underlying data. For performance-critical paths, \`strings.Builder\` or \`bytes.Buffer\` avoids repeated allocations during string construction.

\`\`\`go
import "strconv"

// Int to string
s := strconv.Itoa(42)              // "42"
s := strconv.FormatInt(42, 16)     // "2a" (hex)
s := strconv.FormatInt(42, 2)      // "101010" (binary)

// String to int
i, err := strconv.Atoi("42")       // 42, nil
i, err := strconv.ParseInt("2a", 16, 64)  // 42, nil
i, err := strconv.ParseInt("101010", 2, 64)  // 42, nil

// Float conversions
f, err := strconv.ParseFloat("3.14", 64)
s := strconv.FormatFloat(3.14, 'f', 2, 64)  // "3.14"
s := strconv.FormatFloat(3.14, 'e', 2, 64)  // "3.14e+00"
s := strconv.FormatFloat(3.14, 'g', -1, 64) // "3.14" (shortest)

// Bool conversions
b, err := strconv.ParseBool("true")  // true, nil
b, err := strconv.ParseBool("1")     // true, nil
s := strconv.FormatBool(true)        // "true"

// Quote strings (escape special characters)
s := strconv.Quote("Hello\\nWorld")  // "\\"Hello\\\\nWorld\\""
s := strconv.QuoteToASCII("Hello, 世界")  // "\\"Hello, \\\\u4e16\\\\u754c\\""
\`\`\`

### []byte vs string

Converting between \`string\` and \`[]byte\` copies data:

\`\`\`go
s := "hello"
b := []byte(s)  // Copies "hello" into new byte slice
s2 := string(b) // Copies byte slice into new string
\`\`\`

For read-only operations, prefer working with strings. For modification, convert to \`[]byte\` once, modify, convert back.

\`\`\`go
// Efficient: work with bytes when modifying
func reverse(s string) string {
    b := []byte(s)
    for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
        b[i], b[j] = b[j], b[i]
    }
    return string(b)  // One conversion back
}
\`\`\`

### String Interning and Memory

Go does not intern strings by default (unlike Java, which interns string literals). Each string allocation is a separate heap object. In hot paths that repeatedly create the same strings, HTTP header keys, log field names, metric labels, this duplication wastes memory. A manual string pool deduplicates by storing one canonical copy of each string and returning it for subsequent lookups.

\`\`\`go
s1 := "hello"
s2 := "hello"
// s1 and s2 may or may not share memory (compiler optimization)

// For high-frequency strings, consider a string pool
type StringPool struct {
    mu    sync.RWMutex
    pool  map[string]string
}

func (p *StringPool) Intern(s string) string {
    p.mu.RLock()
    if interned, ok := p.pool[s]; ok {
        p.mu.RUnlock()
        return interned
    }
    p.mu.RUnlock()

    p.mu.Lock()
    defer p.mu.Unlock()

    // Double-check after acquiring write lock
    if interned, ok := p.pool[s]; ok {
        return interned
    }

    p.pool[s] = s
    return s
}
\`\`\`

#### The \`unique\` Package (Go 1.23+)

Hand-rolled string pools like the one above are now unnecessary in most cases. Go 1.23 added the \`unique\` package, which provides canonical handles for any comparable type and handles concurrency, collection, and memory reclamation correctly. The runtime keeps one canonical copy per value and reclaims it through weak references once no \`unique.Handle\` refers to it any longer.

\`\`\`go
import "unique"

h1 := unique.Make("user-agent")    // unique.Handle[string]
h2 := unique.Make("user-agent")    // same canonical copy under the hood

// Comparison is a pointer-equality check, not a byte compare
if h1 == h2 { /* true, O(1) regardless of string length */ }

// Retrieve the original value when you need it
s := h1.Value()                    // "user-agent"
\`\`\`

Where \`unique.Make\` pays off:

- HTTP header keys, metric labels, and log field names on services handling millions of QPS (Cloudflare and Datadog reported single-digit-percent RSS reductions on services that adopted it).
- Tag sets in time-series databases and tracing backends where the same label appears on millions of points.
- Interned identifiers that flow through caches and queues where equality checks dominate over value reads.

Unlike a hand-rolled pool, the runtime coordinates with the GC, so interned values do not leak after they stop being referenced. Prefer \`unique.Make\` over the manual pattern above unless your workload has specific eviction requirements the \`unique\` package does not address.

### Unicode Normalization

Unicode allows the same visual character to be encoded in multiple ways. The accented letter "e" can be a single code point (U+00E9) or a base "e" followed by a combining accent (U+0301). These byte sequences look identical when rendered but fail a \`==\` comparison. The \`golang.org/x/text/unicode/norm\` package normalizes strings to a canonical form so equivalent representations compare as equal.

\`\`\`go
import "golang.org/x/text/unicode/norm"

s1 := "café"        // 'é' as single code point (U+00E9)
s2 := "cafe\\u0301"  // 'e' + combining accent (U+0065 + U+0301)

fmt.Println(s1 == s2)  // false - different bytes!

// Normalize for comparison
n1 := norm.NFC.String(s1)
n2 := norm.NFC.String(s2)
fmt.Println(n1 == n2)  // true - now identical
\`\`\`

### The \`strings\` Package Additions Worth Knowing

Three additions to the \`strings\` package since Go 1.18 that teams still miss in code review:

1. **\`strings.Cut(s, sep)\` (Go 1.18+).** Splits at the first occurrence of \`sep\`, returning \`before, after, found\`. Replaces the common \`SplitN(s, sep, 2)\` pattern with a form that signals absence explicitly. Use it for \`"key=value"\`-style parsing:

    \`\`\`go
    key, value, ok := strings.Cut("user=alice", "=")
    if !ok { return errors.New("missing =") }
    \`\`\`

2. **\`strings.CutPrefix\` and \`strings.CutSuffix\` (Go 1.20+).** Combine \`HasPrefix\` or \`HasSuffix\` with \`TrimPrefix\` or \`TrimSuffix\` into one call:

    \`\`\`go
    after, ok := strings.CutPrefix(s, "Bearer ")
    if !ok { return errors.New("not a bearer token") }
    \`\`\`

3. **\`strings.Clone(s)\` (Go 1.18+).** Copies the string into freshly allocated memory, which matters when you are holding a substring of a huge string and want to let the original be garbage-collected. This is the fix for the "my service leaks memory because a tiny substring is holding a megabyte buffer alive" bug pattern.

### When to Reach for \`bytes.Buffer\` vs \`strings.Builder\`

The two are twins with different APIs. \`strings.Builder\` produces a string with no extra copy. \`bytes.Buffer\` produces a \`[]byte\` and can also read back as a string (which copies). Use \`strings.Builder\` when the output is a string and you do not need to do byte-level manipulation in the middle. Use \`bytes.Buffer\` when you need to interleave writes and reads, when you are implementing \`io.Writer\` somewhere, or when you need to pass the result as \`[]byte\` to another API. Do not copy a \`strings.Builder\` or pass it by value. The \`noCopy\` check in the type will fail via \`go vet\`.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in string-heavy PRs:

1. **String concatenation in a loop.** \`s += "x"\` in a loop is O(n²). Replace with \`strings.Builder\` or \`bytes.Buffer\`. This is a performance finding that shows up immediately in pprof when the path is hot.
2. **\`[]byte(s)\` and \`string(b)\` in the same function.** The two conversions always copy. Converting back and forth repeatedly is a performance smell. The fix is to pick one representation and stay in it.
3. **Byte indexing into a multilingual string.** \`s[i]\` for a string that may contain non-ASCII content is a bug waiting to happen. Iterate with \`range\` or use \`unicode/utf8.DecodeRuneInString\` to advance correctly. The code-review question is "does this string ever contain non-ASCII characters in production?". If the answer is "yes or we do not know", the byte indexing is wrong.

### Migration Lens

Coming from Python 3, Go's \`string\` is closer to Python's \`bytes\` than to Python's \`str\`. Python 3 \`str\` is a sequence of code points, Go \`string\` is a sequence of bytes that is conventionally UTF-8. The rune-vs-byte distinction in Go is the equivalent of Python's decode-at-the-boundary discipline. Coming from Java, \`string\` is immutable in both languages but Java's is UTF-16-backed while Go's is UTF-8-backed. Indexing a Java \`String\` gives you a \`char\` (often a UTF-16 code unit, sometimes a surrogate half). Indexing a Go \`string\` gives you a byte. The behaviours look similar and are different in ways that bite. Coming from C, Go's \`string\` is a \`(ptr, len)\` pair instead of a null-terminated \`char *\`, so the length is O(1) and you do not end at the first zero byte.

---
`;
