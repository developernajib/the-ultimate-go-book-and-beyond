export default `## 10C.27 Substring Memory Leaks

Go strings are immutable byte slices internally. When you take a substring using slice syntax, the resulting substring **shares the same backing array** as the original string. This means a tiny 10-byte substring can hold an entire 10MB string in memory, preventing garbage collection.

### The Disaster

Go substrings share the backing array of the original string. A 32-byte \`token[:32]\` slice holds a reference to the entire 10MB string, preventing the GC from reclaiming it. In a service that processes many files, these pinned strings accumulate silently until the process runs out of memory.

\`\`\`go
package main

import (
    "fmt"
    "os"
    "runtime"
)

// WRONG: extracting a small token from a large string leaks the entire string
func extractToken(filePath string) (string, error) {
    data, err := os.ReadFile(filePath) // reads entire 10MB file
    if err != nil {
        return "", err
    }

    // Convert to string - the string now owns 10MB of memory
    content := string(data)

    // Extract a small token (first 32 chars)
    token := content[:32] // BUG: token shares the 10MB backing array!

    // After this function returns:
    // - content goes out of scope - but is NOT garbage collected
    // - token (32 bytes of useful data) keeps the entire 10MB alive
    return token, nil
}

func main() {
    // Imagine calling this for 1000 files: 10GB of memory for 32KB of useful data!
    tokens := make([]string, 0, 1000)
    for range 1000 {
        token, _ := extractToken("large_file.txt")
        tokens = append(tokens, token) // each token retains a 10MB backing array
    }

    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    fmt.Printf("Memory in use: %d MB\\n", m.Alloc/1024/1024)
    // Expected: ~0.03 MB (1000 * 32 bytes)
    // Actual:   ~10,000 MB (1000 * 10 MB) - the entire files are in memory!
}
\`\`\`

### Why It's Dangerous

- The substring looks tiny, but it anchors the entire original string in memory
- The GC cannot reclaim the original string because the substring's pointer references it
- This causes silent memory growth over time, a slow memory leak
- Particularly dangerous when reading large files, HTTP response bodies, or log lines and keeping small extracts

### The Fix: Copy the Substring

To break the reference to the original backing array, create an independent copy of the substring. Go 1.20 added \`strings.Clone\` for exactly this purpose. For older Go versions, the \`string([]byte(s))\` idiom forces a copy. The best approach is to avoid creating the large string at all and work directly with the byte slice.

\`\`\`go
package main

import (
    "os"
    "strings"
)

// CORRECT (Go 1.20+): Use strings.Clone to create an independent copy
func extractTokenFixed(filePath string) (string, error) {
    data, err := os.ReadFile(filePath)
    if err != nil {
        return "", err
    }

    content := string(data)
    token := content[:32]

    // strings.Clone creates a new string with its own backing array
    // The original 10MB string can now be garbage collected
    return strings.Clone(token), nil
}

// CORRECT (pre-Go 1.20): Use the string([]byte()) copy trick
func extractTokenLegacy(filePath string) (string, error) {
    data, err := os.ReadFile(filePath)
    if err != nil {
        return "", err
    }

    content := string(data)
    token := content[:32]

    // Convert to []byte and back to string - forces a copy
    return string([]byte(token)), nil
}

// BEST: Avoid creating the large string entirely - work with bytes
func extractTokenOptimal(filePath string) (string, error) {
    data, err := os.ReadFile(filePath)
    if err != nil {
        return "", err
    }

    // Work directly with the byte slice - never allocate the full string
    if len(data) < 32 {
        return string(data), nil
    }

    // string(data[:32]) creates a fresh string from the byte slice subset
    // The original data []byte can be GC'd after this function returns
    return string(data[:32]), nil
}

func main() {
    // All three approaches produce the same result,
    // but only the fixed versions release the large backing memory.
    _, _ = extractTokenFixed("large_file.txt")
    _, _ = extractTokenLegacy("large_file.txt")
    _, _ = extractTokenOptimal("large_file.txt")
}
\`\`\`

**The Rule:** Whenever you extract a small substring from a large string and store it long-term, use \`strings.Clone()\` (Go 1.20+) or \`string([]byte(s))\` to detach it from the original backing array.

---
`;
