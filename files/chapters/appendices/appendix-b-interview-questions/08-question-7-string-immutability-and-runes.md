## Question 7: String Immutability and Runes

**Level**: Mid

**Question**: What's the output? Explain string indexing and iteration.

```go
func main() {
    s := "Hello, 世界"

    fmt.Println("len:", len(s))
    fmt.Println("s[0]:", s[0])
    fmt.Println("s[7]:", s[7])

    for i := 0; i < len(s); i++ {
        fmt.Printf("%c ", s[i])
    }
    fmt.Println()

    for i, r := range s {
        fmt.Printf("%d:%c ", i, r)
    }
}
```

**Answer**:

```
len: 13
s[0]: 72
s[7]: 228
H e l l o ,   ä ¸ � ç � Œ
0:H 1:e 2:l 3:l 4:o 5:, 6:  7:世 10:界
```

**Explanation**:

Strings in Go are:
- Immutable byte slices
- UTF-8 encoded
- Indexing returns **bytes**, not characters

```go
// String internals
type stringStruct struct {
    str unsafe.Pointer  // Pointer to byte array
    len int             // Length in bytes
}
```

**UTF-8 Encoding**:

```
"Hello, 世界"

H     e     l     l     o     ,     (space)   世              界
0x48  0x65  0x6C  0x6C  0x6F  0x2C  0x20     0xE4 0xB8 0x96  0xE7 0x95 0x8C
0     1     2     3     4     5     6        7    8    9     10   11   12

ASCII chars: 1 byte each
Chinese chars: 3 bytes each
```

**Indexing Returns Bytes**:

```go
s := "Hello, 世界"
fmt.Println(s[0])     // 72 (0x48, 'H')
fmt.Println(s[7])     // 228 (0xE4, first byte of '世')

// To get the character:
fmt.Printf("%c", s[0])  // H
// But s[7] is not a valid UTF-8 character by itself!
```

**Iterating Bytes vs Runes**:

```go
s := "Hello, 世界"

// Byte iteration
for i := 0; i < len(s); i++ {
    fmt.Printf("%c ", s[i])
}
// Output: H e l l o ,   ä ¸ � ç � Œ
// Shows bytes, invalid UTF-8 sequences appear as �

// Rune iteration
for i, r := range s {
    fmt.Printf("%d:%c ", i, r)
}
// Output: 0:H 1:e 2:l 3:l 4:o 5:, 6:  7:世 10:界
// Note: index jumps (7 → 10) because 世 is 3 bytes
```

**Runes**:

```go
// rune is an alias for int32
type rune = int32  // Represents a Unicode code point

// Converting string to rune slice
s := "Hello, 世界"
runes := []rune(s)
fmt.Println("Rune count:", len(runes))  // 9
fmt.Println("Byte count:", len(s))      // 13

// Now indexing works as expected:
fmt.Printf("%c", runes[7])  // 世
fmt.Printf("%c", runes[8])  // 界
```

**Common Production Bugs**:

```go
package main

import "unicode/utf8"

// ✗ BUG: Truncating multi-byte characters
func truncateBuggy(s string, n int) string {
    if len(s) <= n {
        return s
    }
    return s[:n]  // May split UTF-8 sequence!
}

// e.g. fmt.Println(truncateBuggy("Hello, 世界", 8))
// Output: "Hello, �" - Invalid UTF-8!

// ✓ FIX: Use rune slicing
func truncateRune(s string, n int) string {
    runes := []rune(s)
    if len(runes) <= n {
        return s
    }
    return string(runes[:n])
}

// e.g. fmt.Println(truncateRune("Hello, 世界", 8))
// Output: "Hello, 世"

// ✓ BETTER: Use unicode/utf8 package (no slice allocation)
func truncateUTF8(s string, n int) string {
    if utf8.RuneCountInString(s) <= n {
        return s
    }

    count := 0
    for i := range s {
        if count == n {
            return s[:i]
        }
        count++
    }
    return s
}
```

**String Immutability**:

```go
s := "hello"
// s[0] = 'H'  // Compile error: cannot assign to s[0]

// To modify, convert to byte slice:
b := []byte(s)
b[0] = 'H'
s = string(b)
fmt.Println(s)  // "Hello"

// For multiple modifications, use strings.Builder:
var sb strings.Builder
sb.WriteString("hello")
sb.WriteByte('!')
sb.WriteString(" world")
result := sb.String()  // "hello! world"
```

**Performance Implications**:

```go
// ✗ BAD: Repeated string concatenation
func buildString(n int) string {
    s := ""
    for i := 0; i < n; i++ {
        s += "a"  // Allocates new string each time: O(n²)
    }
    return s
}

// ✓ GOOD: Use strings.Builder
func buildString(n int) string {
    var sb strings.Builder
    sb.Grow(n)  // Pre-allocate
    for i := 0; i < n; i++ {
        sb.WriteString("a")  // O(n)
    }
    return sb.String()
}

// Benchmark: For n=10000
// Bad:  ~100ms
// Good: ~0.1ms (1000x faster!)
```

**UTF-8 Functions**:

```go
package main

import (
	"fmt"
	"unicode/utf8"
)

func main() {
	s := "Hello, 世界"

	// Count runes (not bytes)
	count := utf8.RuneCountInString(s) // 9
	_ = count

	// Decode first rune
	r, size := utf8.DecodeRuneInString(s)
	fmt.Printf("%c (size: %d)\n", r, size) // H (size: 1)

	// Decode rune at position 7
	r, size = utf8.DecodeRuneInString(s[7:])
	fmt.Printf("%c (size: %d)\n", r, size) // 世 (size: 3)

	// Validate UTF-8
	fmt.Println(utf8.ValidString(s))                          // true
	fmt.Println(utf8.ValidString(string([]byte{0xFF, 0xFE}))) // false
}
```

**Companies that asked this**: Google, Uber, Stripe, Cloudflare

---
