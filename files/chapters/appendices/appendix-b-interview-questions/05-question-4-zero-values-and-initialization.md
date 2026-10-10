## Question 4: Zero Values and Initialization

**Level**: Junior-Mid

**Question**: What are the zero values in Go? Why is this design important?

```go
var (
    i   int
    f   float64
    b   bool
    s   string
    p   *int
    sl  []int
    m   map[string]int
    ch  chan int
    fn  func()
    iface any
)

func main() {
    fmt.Printf("int: %v\n", i)
    fmt.Printf("float64: %v\n", f)
    fmt.Printf("bool: %v\n", b)
    fmt.Printf("string: %q\n", s)
    fmt.Printf("pointer: %v\n", p)
    fmt.Printf("slice: %v (nil: %v)\n", sl, sl == nil)
    fmt.Printf("map: %v (nil: %v)\n", m, m == nil)
    fmt.Printf("chan: %v (nil: %v)\n", ch, ch == nil)
    fmt.Printf("func: %v (nil: %v)\n", fn, fn == nil)
    fmt.Printf("interface: %v (nil: %v)\n", iface, iface == nil)
}
```

**Answer**:

```
int: 0
float64: 0
bool: false
string: ""
pointer: <nil>
slice: [] (nil: true)
map: map[] (nil: true)
chan: <nil> (nil: true)
func: <nil> (nil: true)
interface: <nil> (nil: true)
```

**Zero Values by Category**:

1. **Numeric types**: `0`
 - `int`, `int8`, `int16`, `int32`, `int64`
 - `uint`, `uint8`, `uint16`, `uint32`, `uint64`, `uintptr`
 - `float32`, `float64`
 - `complex64`, `complex128`

2. **Boolean**: `false`

3. **String**: `""` (empty string)

4. **Pointers**: `nil`

5. **Slices**: `nil` (not the same as empty slice!)

6. **Maps**: `nil`

7. **Channels**: `nil`

8. **Functions**: `nil`

9. **Interfaces**: `nil`

10. **Structs**: Each field is set to its zero value

**Why This Matters - Useful Zero Values**:

Go's zero values are designed to be **useful** without initialization:

```go
// Sync primitives work at zero value
var mu sync.Mutex
mu.Lock()  // Works immediately

var wg sync.WaitGroup
wg.Add(1)  // Works immediately

// Bytes buffer works at zero value
var buf bytes.Buffer
buf.WriteString("hello")  // Works immediately

// Strings builder
var sb strings.Builder
sb.WriteString("hello")  // Works immediately
```

**Critical Difference - nil Slice vs Empty Slice**:

```go
var nilSlice []int           // nil slice
emptySlice := []int{}        // empty slice
madeSlice := make([]int, 0)  // empty slice

fmt.Println(nilSlice == nil)   // true
fmt.Println(emptySlice == nil) // false
fmt.Println(madeSlice == nil)  // false

// But they behave the same for most operations:
fmt.Println(len(nilSlice))     // 0
fmt.Println(len(emptySlice))   // 0

// Can append to both:
nilSlice = append(nilSlice, 1)
emptySlice = append(emptySlice, 1)

// JSON marshaling differs:
json.Marshal(nilSlice)   // "null"
json.Marshal(emptySlice) // "[]"
```

**Production Bug Example**:

```go
// BUG: nil map
func countWords(text string) map[string]int {
    var counts map[string]int  // nil map!

    for _, word := range strings.Fields(text) {
        counts[word]++  // PANIC: assignment to entry in nil map
    }
    return counts
}

// FIX 1: Initialize
func countWords(text string) map[string]int {
    counts := make(map[string]int)

    for _, word := range strings.Fields(text) {
        counts[word]++  // Works
    }
    return counts
}

// FIX 2: Check for nil
func countWords(text string) map[string]int {
    var counts map[string]int

    for _, word := range strings.Fields(text) {
        if counts == nil {
            counts = make(map[string]int)
        }
        counts[word]++
    }
    return counts
}
```

**Struct Zero Values**:

```go
type Config struct {
    Port        int
    Host        string
    Timeout     time.Duration
    MaxRetries  int
    EnableCache bool
}

var cfg Config
// All fields are zero:
// Port: 0
// Host: ""
// Timeout: 0
// MaxRetries: 0
// EnableCache: false

// Better: Provide defaults
func NewConfig() Config {
    return Config{
        Port:        8080,
        Host:        "localhost",
        Timeout:     30 * time.Second,
        MaxRetries:  3,
        EnableCache: true,
    }
}
```

**Common Follow-up**: When should you use `make()` vs `new()`?

```go
// new() returns a pointer to zeroed memory
p := new(int)        // *int, points to 0
s := new([]int)      // *[]int, points to nil slice
m := new(map[int]string)  // *map[int]string, points to nil map

// make() initializes and returns the value (not a pointer)
sl := make([]int, 0, 10)    // []int, initialized slice
mp := make(map[int]string)  // map[int]string, initialized map
ch := make(chan int, 5)     // chan int, initialized channel

// Use make() for: slices, maps, channels
// Use new() when you need a pointer to zero value (rare)
// Usually just use composite literals: x := T{}
```

**Companies that asked this**: Amazon, Stripe, Datadog

---
