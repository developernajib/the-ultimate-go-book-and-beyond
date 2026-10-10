## 4. strings and bytes Packages

### Common String Operations

The `strings` package provides functions for searching, splitting, trimming, and transforming strings. Since Go strings are immutable byte slices, these functions return new strings rather than modifying in place. For separator-based splitting where you want exactly two parts, prefer `strings.Cut` (Go 1.18+) over `Split`, and `strings.CutLast` (Go 1.27+) when the split point is the last occurrence, such as extracting a file extension or the final path segment. Both have `bytes` equivalents.

```go
package main

import (
    "fmt"
    "strings"
    "unicode"
)

func stringOperations() {
    s := "  Hello, World!  "

    // Trimming
    fmt.Println(strings.TrimSpace(s))           // "Hello, World!"
    fmt.Println(strings.Trim(s, " !"))          // "Hello, World"
    fmt.Println(strings.TrimPrefix(s, "  He"))  // "llo, World!  "
    fmt.Println(strings.TrimSuffix(s, "!  "))   // "  Hello, World"

    // Searching
    fmt.Println(strings.Contains(s, "World"))    // true
    fmt.Println(strings.HasPrefix(s, "  He"))    // true
    fmt.Println(strings.HasSuffix(s, "!  "))     // true
    fmt.Println(strings.Index(s, "World"))       // 9
    fmt.Println(strings.LastIndex(s, "l"))       // 12
    fmt.Println(strings.Count(s, "l"))           // 3

    // Splitting and joining
    parts := strings.Split("a,b,c,d", ",")
    fmt.Println(parts) // [a b c d]

    joined := strings.Join(parts, "-")
    fmt.Println(joined) // "a-b-c-d"

    fields := strings.Fields("  one  two   three  ")
    fmt.Println(fields) // [one two three]

    // Replacement
    fmt.Println(strings.Replace("ooo", "o", "a", 2)) // "aao"
    fmt.Println(strings.ReplaceAll("ooo", "o", "a")) // "aaa"

    // Case conversion
    fmt.Println(strings.ToLower("HELLO"))      // "hello"
    fmt.Println(strings.ToUpper("hello"))      // "HELLO"
    // strings.Title is deprecated since Go 1.18 - use golang.org/x/text/cases instead
    // fmt.Println(strings.Title("hello world"))  // "Hello World"

    // Comparison
    fmt.Println(strings.EqualFold("Hello", "HELLO")) // true (case-insensitive)
    fmt.Println(strings.Compare("a", "b"))           // -1
}
```

### strings.Builder for Efficient String Construction

```go
package main

import (
    "fmt"
    "strings"
)

// INEFFICIENT: Don't do this
func inefficientConcat(items []string) string {
    result := ""
    for _, item := range items {
        result += item // Creates new string each iteration
    }
    return result
}

// EFFICIENT: Use strings.Builder
func efficientConcat(items []string) string {
    var sb strings.Builder

    // Pre-allocate if you know the size
    totalLen := 0
    for _, item := range items {
        totalLen += len(item)
    }
    sb.Grow(totalLen)

    for _, item := range items {
        sb.WriteString(item)
    }
    return sb.String()
}

func builderExample() {
    var sb strings.Builder

    // Various write methods
    sb.WriteString("Hello")
    sb.WriteRune(',')
    sb.WriteByte(' ')
    sb.WriteString("World!")

    fmt.Println(sb.String()) // "Hello, World!"
    fmt.Println(sb.Len())    // 13

    sb.Reset() // Clear the builder
}

// Building HTML/JSON efficiently
func buildHTML(title string, items []string) string {
    var sb strings.Builder
    sb.WriteString("<html><head><title>")
    sb.WriteString(title)
    sb.WriteString("</title></head><body><ul>")

    for _, item := range items {
        sb.WriteString("<li>")
        sb.WriteString(item)
        sb.WriteString("</li>")
    }

    sb.WriteString("</ul></body></html>")
    return sb.String()
}
```

### strings.Replacer

```go
package main

import (
    "fmt"
    "strings"
)

func replacerExample() {
    // Efficient multiple replacements
    replacer := strings.NewReplacer(
        "&", "&amp;",
        "<", "&lt;",
        ">", "&gt;",
        `"`, "&quot;",
        "'", "&#39;",
    )

    input := `<div class="content">Hello & goodbye</div>`
    escaped := replacer.Replace(input)
    fmt.Println(escaped)
    // &lt;div class=&quot;content&quot;&gt;Hello &amp; goodbye&lt;/div&gt;
}

// Using Replacer for template-style substitution
func simpleTemplate(template string, vars map[string]string) string {
    pairs := make([]string, 0, len(vars)*2)
    for k, v := range vars {
        pairs = append(pairs, "{{"+k+"}}", v)
    }

    replacer := strings.NewReplacer(pairs...)
    return replacer.Replace(template)
}

func templateExample() {
    template := "Hello {{name}}, you have {{count}} messages."
    vars := map[string]string{
        "name":  "Alice",
        "count": "5",
    }

    result := simpleTemplate(template, vars)
    fmt.Println(result) // "Hello Alice, you have 5 messages."
}
```

### bytes Package

```go
package main

import (
    "bytes"
    "fmt"
)

func bytesOperations() {
    // bytes package mirrors strings package for []byte
    b := []byte("  Hello, World!  ")

    // Similar operations as strings
    fmt.Println(string(bytes.TrimSpace(b)))
    fmt.Println(bytes.Contains(b, []byte("World")))
    fmt.Println(bytes.Count(b, []byte("l")))

    // Split and join
    parts := bytes.Split([]byte("a,b,c"), []byte(","))
    joined := bytes.Join(parts, []byte("-"))
    fmt.Println(string(joined))
}

func bytesBufferExample() {
    var buf bytes.Buffer

    // Write operations
    buf.WriteString("Hello")
    buf.WriteByte(',')
    buf.WriteRune(' ')
    buf.Write([]byte("World!"))

    // Read operations
    fmt.Println(buf.String())
    fmt.Println(buf.Len())

    // Read bytes
    firstByte, _ := buf.ReadByte()
    fmt.Printf("First byte: %c\n", firstByte)

    // Read string until delimiter
    line, _ := buf.ReadString('!')
    fmt.Println("Line:", line)

    buf.Reset()
}

// Using Buffer as an io.ReadWriter
func bufferAsReadWriter() {
    var buf bytes.Buffer

    // Implements io.Writer
    fmt.Fprintf(&buf, "Number: %d\n", 42)

    // Implements io.Reader
    data := make([]byte, 10)
    n, _ := buf.Read(data)
    fmt.Printf("Read %d bytes: %s\n", n, data[:n])
}
```

### String/Byte Conversion and Unicode

```go
package main

import (
    "fmt"
    "unicode/utf8"
)

func unicodeHandling() {
    s := "Hello, 世界"

    // Length in bytes vs runes
    fmt.Println("Bytes:", len(s))                    // 13
    fmt.Println("Runes:", utf8.RuneCountInString(s)) // 9

    // Iterate by bytes (wrong for multi-byte characters)
    for i := 0; i < len(s); i++ {
        fmt.Printf("%c ", s[i])
    }
    fmt.Println()

    // Iterate by runes (correct for Unicode)
    for i, r := range s {
        fmt.Printf("Position %d: %c\n", i, r)
    }

    // Manual rune iteration
    for i := 0; i < len(s); {
        r, size := utf8.DecodeRuneInString(s[i:])
        fmt.Printf("%c (size: %d)\n", r, size)
        i += size
    }
}

func stringByteConversion() {
    s := "Hello"

    // String to []byte (makes a copy)
    b := []byte(s)
    b[0] = 'J'
    fmt.Println(s) // "Hello" - unchanged
    fmt.Println(string(b)) // "Jello"

    // Unsafe zero-copy conversion (advanced)
    // import "unsafe"
    // b := unsafe.Slice(unsafe.StringData(s), len(s))
    // NEVER modify the result!
}
```

---
