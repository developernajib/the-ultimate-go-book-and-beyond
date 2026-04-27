export default `## 10C.14 String, Byte, and Rune Pitfalls

Go strings are sequences of bytes, not characters. A single character like the Chinese character "世" takes 3 bytes in UTF-8 encoding. This means \`len(s)\` returns the byte count (not the character count), \`s[i]\` returns a single byte (not a character), and slicing a string at arbitrary byte positions can split a multi-byte character in half, producing invalid UTF-8. To work correctly with international text, you need to understand the difference between bytes, runes (Go's name for Unicode code points), and the \`unicode/utf8\` package.

\`\`\`go
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
    fmt.Println(s[7])        // 228 (first byte of "世"), not "世"
    fmt.Println(string(s[7])) // "ä" - wrong! treating a byte as a rune

    // CORRECT: Use rune for character operations
    runes := []rune(s)
    fmt.Println(len(runes))  // 9 - correct character count
    fmt.Println(string(runes[7])) // "世" - correct

    // CORRECT: Range over string iterates RUNES, not bytes
    for i, r := range s {
        fmt.Printf("index=%d rune=%c bytes=%d\\n", i, r, utf8.RuneLen(r))
    }
    // Note: i is the BYTE index, not the character index!

    // TRAP 3: Slicing strings splits bytes, may create invalid UTF-8
    // s[7:10] is the 3 bytes of "世" - valid
    // s[7:9] is only 2 bytes - INVALID UTF-8 sequence!
    invalid := s[7:9]
    fmt.Println(utf8.ValidString(invalid)) // false

    // TRAP 4: String to []byte conversion is a COPY (expensive in hot paths)
    b := []byte(s) // copy
    s2 := string(b) // another copy
    _ = s2
    // In hot paths, use io.Writer or strings.Builder instead of repeated conversions
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
\`\`\`

---
`;
