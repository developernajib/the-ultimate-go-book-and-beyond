## Question 1: Slice Internals and Shared Arrays

**Level**: Mid

**Question**: What is the output of this code? Explain why.

```go
func main() {
    s1 := []int{1, 2, 3, 4, 5}
    s2 := s1[1:3]
    s3 := s1[2:4]

    s2[0] = 10
    s3[1] = 20

    fmt.Println("s1:", s1)
    fmt.Println("s2:", s2)
    fmt.Println("s3:", s3)
}
```

**Answer**:

```
s1: [1 10 3 20 5]
s2: [10 3]
s3: [3 20]
```

**Explanation**:

Slices in Go are descriptors containing three fields:
- A pointer to the underlying array
- Length (number of elements in the slice)
- Capacity (number of elements from the start of the slice to the end of the array)

```go
// s1 layout:
// ptr: 0x... (points to array [1,2,3,4,5])
// len: 5
// cap: 5

// s2 = s1[1:3] layout:
// ptr: 0x...+8 (points to second element of same array)
// len: 2
// cap: 4 (can extend to end of original array)

// s3 = s1[2:4] layout:
// ptr: 0x...+16 (points to third element of same array)
// len: 2
// cap: 3
```

All three slices share the same underlying array. When we modify `s2[0]`, we're modifying the second element of the shared array (index 1). When we modify `s3[1]`, we're modifying the fourth element (index 3).

**Memory Visualization**:

```
Underlying array: [1, 2, 3, 4, 5]
                   ↑  ↑  ↑  ↑  ↑
                   |  |  |  |  |
s1:                ├──┴──┴──┴──┤
s2:                   ├──┴──┐
s3:                      ├──┴──┐
```

**Common Follow-up**: What happens if we append to s2?

```go
s2 = append(s2, 100)
fmt.Println("s1:", s1)  // [1 10 3 100 5] - modified!
fmt.Println("s2:", s2)  // [10 3 100]
```

Since `s2` has capacity 4 (can hold 2 more elements without reallocation), the append modifies the shared array. However, if append causes reallocation:

```go
s2 = append(s2, 100, 200, 300)  // Exceeds capacity
fmt.Println("s1:", s1)  // [1 10 3 20 5] - unchanged
fmt.Println("s2:", s2)  // [10 3 100 200 300] - new array
```

**Production Considerations**:
- Always use full slice expressions when you want to prevent capacity sharing: `s2 := s1[1:3:3]`
- The third index limits the capacity, preventing unintended sharing
- This is critical in production to avoid subtle bugs

**Companies that asked this**: Google, Uber, Stripe

---
