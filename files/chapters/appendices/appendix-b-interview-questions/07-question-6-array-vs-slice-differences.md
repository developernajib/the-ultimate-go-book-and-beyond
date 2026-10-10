## Question 6: Array vs Slice Differences

**Level**: Junior-Mid

**Question**: What's the difference between arrays and slices? What does this code output?

```go
func main() {
    arr := [3]int{1, 2, 3}
    sl := []int{1, 2, 3}

    modifyArray(arr)
    modifySlice(sl)

    fmt.Println("Array:", arr)
    fmt.Println("Slice:", sl)
}

func modifyArray(a [3]int) {
    a[0] = 100
}

func modifySlice(s []int) {
    s[0] = 100
}
```

**Answer**:

```
Array: [1 2 3]
Slice: [100 2 3]
```

**Explanation**:

**Arrays**:
- Fixed size, part of the type
- Passed by value (entire array is copied)
- Size must be a constant expression
- Rarely used directly in Go

```go
var a [3]int             // Array of 3 ints
var b [5]int             // Different type than a!
// a = b  // Compile error: cannot use b (type [5]int) as type [3]int
```

**Slices**:
- Dynamic size, descriptor for array segment
- Passed by value, but the descriptor contains a pointer
- Most common collection type in Go

```go
type SliceHeader struct {
    Data uintptr  // Pointer to array
    Len  int      // Length
    Cap  int      // Capacity
}
```

**Comparison Table**:

| Feature | Array | Slice |
|---------|-------|-------|
| Size | Fixed | Dynamic |
| Type includes size | Yes (`[3]int` ≠ `[5]int`) | No (`[]int`) |
| Pass to function | Copy entire array | Copy slice header (24 bytes) |
| Can grow | No | Yes (via append) |
| Can be nil | No | Yes |
| Memory allocation | Stack (usually) | Heap (usually) |
| Performance | Faster (cache locality) | Flexible |

**Memory Layout**:

```go
// Array:
arr := [4]int{1, 2, 3, 4}
// Memory: [1][2][3][4]
//          ^ arr directly contains the data

// Slice:
sl := []int{1, 2, 3, 4}
// Slice header (24 bytes on 64-bit):
//   ptr: → [1][2][3][4] (underlying array)
//   len: 4
//   cap: 4
```

**When Arrays Copy Matters**:

```go
// Large array copy (expensive!)
func processBigArray(data [1000000]int) {
    // 4MB copied on every call!
    data[0] = 100
}

// Better: Use slice or pointer
func processBigSlice(data []int) {
    // Only 24 bytes copied
    data[0] = 100
}

func processBigArrayPtr(data *[1000000]int) {
    // Only 8 bytes (pointer) copied
    data[0] = 100
}
```

**Array to Slice Conversion**:

```go
arr := [5]int{1, 2, 3, 4, 5}

// Create slice from array
sl1 := arr[:]       // Slice of entire array
sl2 := arr[1:4]     // Slice of arr[1], arr[2], arr[3]

// Modifying slice modifies array
sl1[0] = 100
fmt.Println(arr)    // [100 2 3 4 5]
```

**When to Use Arrays**:

```go
// 1. Fixed-size collections (rare)
type MD5Hash [16]byte
type IPv4Addr [4]byte

// 2. When you need value semantics
type Point3D [3]float64

func translate(p Point3D, dx, dy, dz float64) Point3D {
    return Point3D{p[0] + dx, p[1] + dy, p[2] + dz}
    // Returns copy, original unchanged
}

// 3. Stack allocation for performance
func sumValues() int {
    var vals [100]int  // Stack allocated
    for i := range vals {
        vals[i] = i
    }
    return sum(vals[:])
}
```

**Common Interview Follow-up**: How do you create a slice of arrays?

```go
// Slice of arrays (useful for fixed-size records)
type Record [5]string  // Fixed 5 fields

records := []Record{
    {"John", "Doe", "Engineer", "Google", "2020"},
    {"Jane", "Smith", "Manager", "Meta", "2019"},
}

// Each element is a [5]string array
fmt.Println(records[0][2])  // "Engineer"
```

**Companies that asked this**: Amazon, Cloudflare, Stripe

---
