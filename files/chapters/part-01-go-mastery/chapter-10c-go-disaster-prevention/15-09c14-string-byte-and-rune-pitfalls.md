## 10C.14 String, Byte, and Rune Pitfalls

Go strings are sequences of bytes, not characters. A single character like the Chinese character "世" takes 3 bytes in UTF-8 encoding. This means `len(s)` returns the byte count (not the character count), `s[i]` returns a single byte (not a character), and slicing a string at arbitrary byte positions can split a multi-byte character in half, producing invalid UTF-8. To work correctly with international text, you need to understand the difference between bytes, runes (Go's name for Unicode code points), and the `unicode/utf8` package.

```go
package main

import (
    "fmt"
    "unicode/utf8"
)

func main() {
    s := "Hello, 世界" // mixed ASCII and multi-byte UTF-8

    // TRAP 1: len() counts BYTES, not characters
    fmt.Println(len(s)) // 13, not 9! "世" = 3 bytes, "界" = 3 bytes

    // TRAP 2: Indexing gets BYTES, not characters
    fmt.Println(s[7])         // 228 (first byte of "世"), not "世"
    fmt.Println(string(s[7])) // "ä", wrong: byte 228 read as code point U+00E4

    // CORRECT: use rune for code point operations
    runes := []rune(s)
    fmt.Println(len(runes))       // 9 code points
    fmt.Println(string(runes[7])) // "世", correct

    // CORRECT: Range over string iterates RUNES, not bytes
    for i, r := range s {
        fmt.Printf("index=%d rune=%c bytes=%d\n", i, r, utf8.RuneLen(r))
    }
    // Note: i is the BYTE index, not the character index!

    // TRAP 3: slicing a string slices bytes, and can split a code point
    // s[7:10] is all 3 bytes of "世", so it is valid
    // s[7:9] is only the first 2, so it is not valid UTF-8
    invalid := s[7:9]
    fmt.Println(utf8.ValidString(invalid)) // false

    // TRAP 4: a rune is a code point, which is still not a "character" as a
    // user counts them. Written with escapes below so the difference is
    // visible on the page rather than hidden in identical-looking source.
    e1 := "\u00e9"  // precomposed: one code point
    e2 := "e\u0301" // decomposed: "e" plus a combining acute
    fmt.Println(e1 == e2)                         // false, despite rendering identically
    fmt.Println(len([]rune(e1)), len([]rune(e2))) // 1 2
    // Emoji built from ZWJ sequences push this further, several code points
    // per visible glyph. So len([]rune(s)) is the right answer for code
    // points and the wrong answer for "how many characters does the user
    // see". The latter needs grapheme cluster segmentation, which the
    // standard library does not provide. It is also why user input should be
    // normalized (golang.org/x/text/unicode/norm) before you compare it.

    // TRAP 5: string to []byte conversion is a COPY, which costs in hot paths
    b := []byte(s)  // copy
    s2 := string(b) // another copy
    _ = s2
    // In hot paths, use strings.Builder or write straight to an io.Writer
    // rather than converting back and forth.
}

// Count runes safely
func runeCount(s string) int {
    return utf8.RuneCountInString(s)
}

// Safe substring by rune index (not byte index)
func runeSubstring(s string, start, end int) string {
    runes := []rune(s)
    if start < 0 || end > len(runes) || start > end {
        return ""
    }
    return string(runes[start:end])
}
```

---
