export default `## 10C.6 Slice Append Aliasing, The Silent Data Corruptor

This is one of the most subtle bugs in Go. Two slices sharing the same underlying array can silently corrupt each other.

\`\`\`go
package main

import "fmt"

func main() {
    // Creating two slices from the same backing array
    original := make([]int, 3, 6) // len=3, cap=6
    original[0], original[1], original[2] = 1, 2, 3

    // This creates a slice that SHARES the same backing array as original
    alias := original[:3] // same backing array, same capacity

    // Appending to alias within capacity does NOT allocate new memory
    alias = append(alias, 99)

    // DISASTER: original[3] is now 99, even though we never touched original!
    extended := original[:4] // extend original to see the hidden damage
    fmt.Println(extended) // [1 2 3 99] - corrupted by the append to alias!

    // More dangerous pattern: function modifying a slice parameter
    data := make([]int, 3, 10)
    data[0], data[1], data[2] = 10, 20, 30

    processSlice(data) // Looks like it passes a copy...
    extended2 := data[:5]
    fmt.Println(extended2) // [10 20 30 100 200] - modified by processSlice!
}

// This function appears to work on its own slice but modifies the backing array
func processSlice(s []int) {
    // Appending within capacity - no new allocation, modifies SHARED array
    s = append(s, 100, 200)
    // s is now [10 20 30 100 200] locally, but caller's backing array is modified!
}
\`\`\`

### Why Append Can Corrupt or Not Corrupt

\`append\` reuses the underlying array if capacity permits, meaning two slices sharing the same array can corrupt each other's data. Whether corruption occurs depends on the relative capacities and append order.

\`\`\`go
package main

import "fmt"

func main() {
    // When capacity is exceeded, append ALLOCATES a new array - safe
    s1 := []int{1, 2, 3} // len=3, cap=3 (tight)
    s2 := s1
    s1 = append(s1, 4) // exceeds cap, new allocation - s2 unaffected
    fmt.Println(s1, s2) // [1 2 3 4] [1 2 3] - correct, separate arrays

    // When capacity is NOT exceeded, append reuses the array - dangerous
    s3 := make([]int, 3, 10) // len=3, cap=10 (lots of room)
    s3[0], s3[1], s3[2] = 1, 2, 3
    s4 := s3
    s3 = append(s3, 4) // within cap, REUSES array - s4's backing array modified!
    s4Extended := s4[:4]
    fmt.Println(s3, s4Extended) // [1 2 3 4] [1 2 3 4] - s4 sees s3's append!
}
\`\`\`

### The Fix: Use Full Slice Expression or Copy

Go provides three ways to break the shared backing array relationship. The full slice expression (\`s[low:high:max]\`) caps the capacity so the next append forces a new allocation. Alternatively, \`copy\` or \`slices.Clone\` (Go 1.21+) create an independent copy up front.

\`\`\`go
package main

import "fmt"

func main() {
    original := make([]int, 3, 10)
    original[0], original[1], original[2] = 1, 2, 3

    // FIX 1: Full slice expression limits capacity of the subslice
    // s[low:high:max] - max sets the capacity to max-low
    safe := original[:3:3] // len=3, cap=3 - capacity is limited!
    safe = append(safe, 99) // now MUST allocate new array - original unaffected
    fmt.Println(original[:3]) // [1 2 3] - original safe!

    // FIX 2: Explicit copy - cleanest solution
    safeCopy := make([]int, len(original))
    copy(safeCopy, original)
    safeCopy = append(safeCopy, 99)
    fmt.Println(original[:3]) // [1 2 3] - original safe!

    // FIX 3: Use slices.Clone (Go 1.21+)
    // import "slices"
    // safeClone := slices.Clone(original[:3])
}

// Safe function that won't corrupt caller's backing array
func safeProcessSlice(s []int) []int {
    // Limit capacity so any append must allocate new memory
    limited := s[:len(s):len(s)]
    return append(limited, 100, 200)
}
\`\`\`

---
`;
