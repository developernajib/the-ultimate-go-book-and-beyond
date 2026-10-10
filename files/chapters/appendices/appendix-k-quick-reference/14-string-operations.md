## String Operations

Strings in Go are immutable sequences of bytes, typically holding UTF-8 encoded text. The `strings` package provides functions for searching, splitting, joining, trimming, and transforming strings. For efficient string building in loops, use `strings.Builder` instead of repeated concatenation with `+`, which creates a new string on every operation. When you need to work with individual characters (especially non-ASCII), convert to `[]rune` first, since indexing a string gives you bytes, not characters.

```go
import "strings"

// Length
len(s)                    // Byte length
utf8.RuneCountInString(s) // Character count

// Concatenation
s := "hello" + " " + "world"
s := fmt.Sprintf("%s %s", "hello", "world")

// Builder (efficient concatenation)
var b strings.Builder
b.WriteString("hello")
b.WriteString(" ")
b.WriteString("world")
s := b.String()

// Contains
strings.Contains("hello", "ell")      // true
strings.ContainsAny("hello", "aeiou") // true
strings.ContainsRune("hello", 'e')    // true

// Prefix/suffix
strings.HasPrefix("hello", "hel")     // true
strings.HasSuffix("hello", "llo")     // true

// Index
strings.Index("hello", "ll")          // 2
strings.LastIndex("hello", "l")       // 3
strings.IndexRune("hello", 'e')       // 1

// Count
strings.Count("cheese", "e")          // 3

// Cut (Go 1.18+) and CutLast (Go 1.27)
before, after, found := strings.Cut("user@example.com", "@")
// "user", "example.com", true
before, after, found = strings.CutLast("a.b.c", ".")
// "a.b", "c", true (cuts on the LAST occurrence)

// Split
parts := strings.Split("a,b,c", ",")  // []string{"a", "b", "c"}
parts := strings.SplitN("a,b,c", ",", 2) // []string{"a", "b,c"}
fields := strings.Fields("  a  b  c  ")  // []string{"a", "b", "c"}

// Join
s := strings.Join([]string{"a", "b", "c"}, ",") // "a,b,c"

// Replace
s := strings.Replace("hello", "l", "L", 1)   // "heLlo"
s := strings.ReplaceAll("hello", "l", "L")   // "heLLo"

// Trim
s := strings.TrimSpace("  hello  ")          // "hello"
s := strings.Trim("!!hello!!", "!")          // "hello"
s := strings.TrimLeft("!!hello!!", "!")      // "hello!!"
s := strings.TrimRight("!!hello!!", "!")     // "!!hello"
s := strings.TrimPrefix("hello", "hel")      // "lo"
s := strings.TrimSuffix("hello", "lo")       // "hel"

// Case
s := strings.ToUpper("hello")                // "HELLO"
s := strings.ToLower("HELLO")                // "hello"
s := strings.Title("hello world")            // "Hello World" (deprecated)
s := cases.Title(language.English).String("hello world") // Go 1.18+

// Compare
result := strings.Compare("a", "b")          // -1 (a < b)
equal := strings.EqualFold("hello", "HELLO") // true (case-insensitive)

// Repeat
s := strings.Repeat("ha", 3)                 // "hahaha"

// Map
s := strings.Map(func(r rune) rune {
    if r >= 'a' && r <= 'z' {
        return r - 32 // To upper
    }
    return r
}, "hello")  // "HELLO"

// Conversion
// String to []byte
b := []byte(s)

// []byte to string
s := string(b)

// String to []rune
r := []rune(s)

// []rune to string
s := string(r)

// String to int
i, err := strconv.Atoi("42")
i64, err := strconv.ParseInt("42", 10, 64)

// Int to string
s := strconv.Itoa(42)
s := strconv.FormatInt(int64(42), 10)

// String to float
f, err := strconv.ParseFloat("3.14", 64)

// Float to string
s := strconv.FormatFloat(3.14, 'f', 2, 64)

// String to bool
b, err := strconv.ParseBool("true")

// Bool to string
s := strconv.FormatBool(true)

// Quote/unquote
s := strconv.Quote("hello\nworld")      // "\"hello\\nworld\""
s, err := strconv.Unquote(`"hello\nworld"`) // "hello\nworld"

// Regular expressions
import "regexp"

matched, _ := regexp.MatchString(`\d+`, "hello123")
re := regexp.MustCompile(`\d+`)
re.MatchString("hello123")
matches := re.FindAllString("a1b2c3", -1) // []string{"1", "2", "3"}
replaced := re.ReplaceAllString("a1b2c3", "X") // "aXbXcX"

// String formatting
s := fmt.Sprintf("%s is %d years old", "Alice", 30)
```

---
