## Arrays and Slices

Arrays in Go have a fixed size that is part of their type, so `[5]int` and `[10]int` are different types. Slices are much more commonly used because they are dynamically sized views into an underlying array. A slice has three components: a pointer to the data, a length, and a capacity. Be careful when assigning one slice to another, because both will share the same backing array, use `copy` when you need an independent duplicate.

```go
// Arrays (fixed size)
var arr [5]int
arr := [5]int{1, 2, 3, 4, 5}
arr := [...]int{1, 2, 3, 4, 5}  // Compiler counts
arr := [5]int{0: 10, 4: 20}     // Sparse initialization

// Array length
len(arr)  // 5

// Slices (dynamic)
var s []int                  // nil slice
s := []int{}                 // Empty slice (not nil)
s := []int{1, 2, 3, 4, 5}
s := make([]int, 5)          // len=5, cap=5, zero-filled
s := make([]int, 5, 10)      // len=5, cap=10

// Slice operations
len(s)                       // Length
cap(s)                       // Capacity
s[i]                         // Access element
s[low:high]                  // Slice [low, high)
s[low:]                      // From low to end
s[:high]                     // From start to high
s[:]                         // Full slice
s[low:high:max]              // Full slice expression, cap = max-low

// Append
s = append(s, 6)             // Add one element
s = append(s, 7, 8, 9)       // Add multiple elements
s = append(s, other...)      // Append another slice

// Copy
dst := make([]int, len(src))
copy(dst, src)               // Returns number of elements copied

// Delete element at index i
s = append(s[:i], s[i+1:]...)

// Insert element at index i
s = append(s[:i], append([]int{value}, s[i:]...)...)

// Filter (keep even numbers)
filtered := s[:0]  // Reuse backing array
for _, v := range s {
    if v%2 == 0 {
        filtered = append(filtered, v)
    }
}

// Multi-dimensional slices
matrix := make([][]int, 3)
for i := range matrix {
    matrix[i] = make([]int, 4)
}

// Slice internals
type SliceHeader struct {
    Data uintptr  // Pointer to underlying array
    Len  int      // Length
    Cap  int      // Capacity
}

// Common gotchas
s1 := []int{1, 2, 3}
s2 := s1         // Shares backing array!
s2[0] = 999      // s1[0] is now 999

// Copy to avoid sharing
s2 := make([]int, len(s1))
copy(s2, s1)

// Nil vs empty slice
var s1 []int     // nil, len=0, cap=0
s2 := []int{}    // not nil, len=0, cap=0
s3 := []int(nil) // nil, len=0, cap=0

// Check for empty
if len(s) == 0 { }  // Correct
// Not: if s == nil { }  // Only checks nil, not empty
```

---
