## 10C.27 Substring Memory Leaks

A Go string is a two-word header: a pointer to bytes and a length. Slicing one does not copy the bytes, it produces a new header pointing into the same array with a smaller length. That is what makes substring slicing free, and it is exactly what makes it dangerous: the new header **shares the same backing array**, so a 10-byte substring keeps an entire 10MB allocation reachable and uncollectable.

### The Disaster

Go substrings share the backing array of the original string. A 32-byte `token[:32]` slice holds a reference to the entire 10MB string, preventing the GC from reclaiming it. In a service that processes many files, these pinned strings accumulate silently until the process runs out of memory.

```go
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

    // Convert to string. This copies, so we now hold 10MB twice, briefly.
    content := string(data)

    // Extract a small token (the first 32 BYTES, not characters)
    token := content[:32] // BUG: token points into the 10MB backing array

    // After this function returns:
    //  - content goes out of scope, but is NOT collected
    //  - token is 32 bytes of useful data anchoring all 10MB
    // Nothing here looks like a leak. The variable is small, the scope is
    // tight, and the GC is working correctly. It simply cannot free an
    // array that a live pointer still points into.
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
    fmt.Printf("Memory in use: %d MB\n", m.Alloc/1024/1024)
    // Expected: ~0.03 MB (1000 * 32 bytes)
    // Actual:   ~10,000 MB (1000 * 10 MB), every file still resident
}
```

### Why It's Dangerous

- The substring looks tiny, but it anchors the entire original string in memory
- The GC cannot reclaim the original string because the substring's pointer references it
- This causes silent memory growth over time, a slow memory leak
- Particularly dangerous when reading large files, HTTP response bodies, or log lines and keeping small extracts

### The Fix: Copy the Substring

To break the reference to the original backing array, create an independent copy of the substring. Go 1.20 added `strings.Clone` for exactly this purpose. For older Go versions, the `string([]byte(s))` idiom forces a copy. The best approach is to avoid creating the large string at all and work directly with the byte slice.

```go
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

    // Round-tripping through []byte forces a copy, detaching the result
    return string([]byte(token)), nil
}

// BEST: never build the large string at all, and slice the bytes instead
func extractTokenOptimal(filePath string) (string, error) {
    data, err := os.ReadFile(filePath)
    if err != nil {
        return "", err
    }

    // Guard the short-file case: content[:32] on a 10-byte file panics.
    if len(data) < 32 {
        return string(data), nil
    }

    // Converting []byte to string ALWAYS copies, because strings are
    // immutable and the byte slice is not. That is normally a cost. Here it
    // is the whole point: the result owns 32 fresh bytes and holds no
    // reference to data, so the 10MB is collectable on return.
    return string(data[:32]), nil
}

func main() {
    // All three approaches produce the same result,
    // but only the fixed versions release the large backing memory.
    _, _ = extractTokenFixed("large_file.txt")
    _, _ = extractTokenLegacy("large_file.txt")
    _, _ = extractTokenOptimal("large_file.txt")
}
```

**The Rule:** the sharing only matters when the substring outlives the original. A substring you compare and discard inside one function is free, and cloning it there is pure waste. Reach for `strings.Clone()` (Go 1.20+) at the boundary where a small extract from a large string gets stored somewhere long-lived: a struct field, a cache, a package-level map, a channel to another goroutine. That is the moment the 32 bytes start holding the 10MB hostage.

---
