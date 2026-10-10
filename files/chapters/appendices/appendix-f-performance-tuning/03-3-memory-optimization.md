## 3. Memory Optimization

Memory optimization reduces allocations and improves cache efficiency.

### 3.1 Allocation Reduction Strategies

**Understanding Allocations**:

```go
package main

import (
    "bytes"
    "fmt"
    "testing"
)

// Bad: Many allocations
func buildStringBad(parts []string) string {
    result := ""
    for _, part := range parts {
        result += part // New allocation every iteration
    }
    return result
}

// Good: Single allocation with strings.Builder
func buildStringGood(parts []string) string {
    var builder bytes.Buffer
    for _, part := range parts {
        builder.WriteString(part)
    }
    return builder.String()
}

// Better: Pre-sized builder
func buildStringBetter(parts []string) string {
    size := 0
    for _, part := range parts {
        size += len(part)
    }

    builder := make([]byte, 0, size)
    for _, part := range parts {
        builder = append(builder, part...)
    }
    return string(builder)
}

func BenchmarkStringBuilding(b *testing.B) {
    parts := []string{"hello", " ", "world", " ", "from", " ", "Go"}

    b.Run("Bad", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = buildStringBad(parts)
        }
    })

    b.Run("Good", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = buildStringGood(parts)
        }
    })

    b.Run("Better", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = buildStringBetter(parts)
        }
    })
}

// Results:
// BenchmarkStringBuilding/Bad-8      1000000    1246 ns/op    896 B/op    6 allocs/op
// BenchmarkStringBuilding/Good-8     5000000     287 ns/op    112 B/op    2 allocs/op
// BenchmarkStringBuilding/Better-8   8000000     156 ns/op     64 B/op    1 allocs/op
```

### 3.2 Stack vs Heap

Variables on the stack are faster (no GC). Variables on the heap require GC.

**Escape Analysis**:

```go
package main

// Stays on stack
func stackAlloc() int {
    x := 42
    return x
}

// Escapes to heap (returned pointer)
func heapAlloc() *int {
    x := 42
    return &x // x escapes
}

// Escapes to heap (too large for stack)
func largeSizedArray() *[1024 * 1024]int {
    var arr [1024 * 1024]int
    return &arr // Too large, goes to heap
}

// Escapes to heap (unknown size at compile time)
func dynamicSize(n int) []int {
    return make([]int, n) // Always heap
}

// Stays on stack (size known, small)
func fixedSmallArray() [10]int {
    var arr [10]int
    return arr // Copied, stays on stack
}

// Check escape analysis:
// go build -gcflags='-m' main.go
//
// Output:
// ./main.go:9:6: &x escapes to heap
// ./main.go:8:2: moved to heap: x
// ./main.go:14:2: &arr escapes to heap
// ./main.go:14:6: moved to heap: arr
```

**Reducing Heap Allocations**:

```go
// Bad: Creates many heap allocations
type Point struct {
    X, Y float64
}

func processPoints(n int) []*Point {
    points := make([]*Point, n)
    for i := 0; i < n; i++ {
        points[i] = &Point{X: float64(i), Y: float64(i * 2)}
    }
    return points
}

// Good: Slice of values, not pointers
func processPointsOptimized(n int) []Point {
    points := make([]Point, n)
    for i := 0; i < n; i++ {
        points[i] = Point{X: float64(i), Y: float64(i * 2)}
    }
    return points
}

// Real-world example: API response
type User struct {
    ID    int64
    Name  string
    Email string
}

// Bad: Each user is a heap allocation
func getUsers(ids []int64) []*User {
    users := make([]*User, len(ids))
    for i, id := range ids {
        users[i] = &User{
            ID:    id,
            Name:  fmt.Sprintf("User %d", id),
            Email: fmt.Sprintf("user%d@example.com", id),
        }
    }
    return users
}

// Good: Values in contiguous memory
func getUsersOptimized(ids []int64) []User {
    users := make([]User, len(ids))
    for i, id := range ids {
        users[i] = User{
            ID:    id,
            Name:  fmt.Sprintf("User %d", id),
            Email: fmt.Sprintf("user%d@example.com", id),
        }
    }
    return users
}

// Use pointers only when needed:
// 1. Large structs (>100 bytes)
// 2. Need to modify
// 3. nil is a valid value
```

### 3.3 Escape Analysis Deep Dive

**Forcing Stack Allocation**:

```go
// Interface causes escape
func withInterface(i any) {
    fmt.Println(i) // i escapes to heap
}

// Concrete type stays on stack
func withConcrete(x int) {
    fmt.Println(x) // x stays on stack
}

// Closure causes escape
func withClosure() func() int {
    x := 42
    return func() int {
        return x // x escapes (captured)
    }
}

// Return value prevents escape
func withReturnValue() int {
    x := 42
    return x // x stays on stack
}

// Check escape analysis:
// go build -gcflags='-m -m' main.go
```

**Escape Analysis Rules**:

1. **Pointer returned from function** → Heap
2. **Variable outlives function scope** → Heap
3. **Size unknown at compile time** → Heap
4. **Too large for stack (>10MB)** → Heap
5. **Stored in any** → Heap
6. **Captured by closure** → Heap

### 3.4 sync.Pool Usage

`sync.Pool` reuses objects to reduce allocations.

**Basic sync.Pool Pattern**:

```go
package main

import (
    "bytes"
    "sync"
)

// Buffer pool for reuse
var bufferPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func processData(data []byte) []byte {
    // Get buffer from pool
    buf := bufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset() // Clear buffer
        bufferPool.Put(buf) // Return to pool
    }()

    // Use buffer
    buf.Write(data)
    buf.WriteString(" processed")

    return buf.Bytes()
}

// Real-world example: HTTP handler
type Server struct {
    requestPool sync.Pool
}

type Request struct {
    ID      string
    Payload []byte
    Result  []byte
}

func NewServer() *Server {
    return &Server{
        requestPool: sync.Pool{
            New: func() any {
                return &Request{
                    Payload: make([]byte, 0, 4096),
                    Result:  make([]byte, 0, 4096),
                }
            },
        },
    }
}

func (s *Server) HandleRequest(id string, data []byte) []byte {
    req := s.requestPool.Get().(*Request)
    defer func() {
        req.ID = ""
        req.Payload = req.Payload[:0]
        req.Result = req.Result[:0]
        s.requestPool.Put(req)
    }()

    req.ID = id
    req.Payload = append(req.Payload, data...)

    // Process request
    req.Result = append(req.Result, "Processed: "...)
    req.Result = append(req.Result, req.Payload...)

    return req.Result
}
```

**sync.Pool Best Practices**:

```go
// Good: Appropriate use cases
// 1. High-allocation hot paths
// 2. Temporary objects
// 3. Known object lifecycle

// Bad: Inappropriate use
// 1. Long-lived objects
// 2. Objects that don't allocate much
// 3. Objects requiring complex cleanup

// Example: JSON encoder pool
var encoderPool = sync.Pool{
    New: func() any {
        return json.NewEncoder(nil)
    },
}

func encodeJSON(w io.Writer, v any) error {
    enc := encoderPool.Get().(*json.Encoder)
    defer encoderPool.Put(enc)

    enc.Reset(w)
    return enc.Encode(v)
}

// Warning: sync.Pool can be cleared at any GC
// Don't rely on items being there
```

### 3.5 Slice Pre-allocation

Always pre-allocate slices when the size is known.

**Slice Pre-allocation Examples**:

```go
package main

import "testing"

// Bad: Grow as needed
func appendGrow(n int) []int {
    var result []int
    for i := 0; i < n; i++ {
        result = append(result, i)
    }
    return result
}

// Good: Pre-allocate with make
func appendPreallocate(n int) []int {
    result := make([]int, 0, n)
    for i := 0; i < n; i++ {
        result = append(result, i)
    }
    return result
}

// Best: Direct index assignment
func directAssign(n int) []int {
    result := make([]int, n)
    for i := 0; i < n; i++ {
        result[i] = i
    }
    return result
}

func BenchmarkSliceAllocation(b *testing.B) {
    b.Run("Grow", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = appendGrow(1000)
        }
    })

    b.Run("Preallocate", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = appendPreallocate(1000)
        }
    })

    b.Run("DirectAssign", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = directAssign(1000)
        }
    })
}

// Results:
// BenchmarkSliceAllocation/Grow-8            50000    34567 ns/op    24576 B/op    11 allocs/op
// BenchmarkSliceAllocation/Preallocate-8    200000     8901 ns/op     8192 B/op     1 allocs/op
// BenchmarkSliceAllocation/DirectAssign-8   200000     7234 ns/op     8192 B/op     1 allocs/op
```

**Real-World Pre-allocation**:

```go
// Processing database results
func queryUsers(db *sql.DB) ([]User, error) {
    rows, err := db.Query("SELECT id, name, email FROM users")
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    // Bad: Unknown size
    // var users []User

    // Good: Estimate capacity
    users := make([]User, 0, 100) // Typical result size

    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
            return nil, err
        }
        users = append(users, u)
    }

    return users, rows.Err()
}

// Processing API responses
func transformItems(items []InputItem) []OutputItem {
    // Pre-allocate with exact size
    results := make([]OutputItem, 0, len(items))

    for _, item := range items {
        if item.Valid {
            results = append(results, transform(item))
        }
    }

    return results
}

// Filtering with known maximum size
func filterActive(users []User) []User {
    active := make([]User, 0, len(users)) // Max size

    for _, u := range users {
        if u.IsActive {
            active = append(active, u)
        }
    }

    return active
}
```

### 3.6 String Optimization

Strings are immutable. Avoid creating new strings unnecessarily.

**String Builder Pattern**:

```go
package main

import (
    "fmt"
    "strings"
    "testing"
)

// Bad: String concatenation
func buildHTMLBad(title, body string) string {
    html := "<html>"
    html += "<head><title>" + title + "</title></head>"
    html += "<body>" + body + "</body>"
    html += "</html>"
    return html
}

// Good: strings.Builder
func buildHTMLGood(title, body string) string {
    var b strings.Builder
    b.Grow(100 + len(title) + len(body)) // Pre-allocate

    b.WriteString("<html>")
    b.WriteString("<head><title>")
    b.WriteString(title)
    b.WriteString("</title></head>")
    b.WriteString("<body>")
    b.WriteString(body)
    b.WriteString("</body>")
    b.WriteString("</html>")

    return b.String()
}

// Best: bytes.Buffer for []byte
func buildHTMLBytes(title, body string) []byte {
    var b bytes.Buffer
    b.Grow(100 + len(title) + len(body))

    b.WriteString("<html>")
    b.WriteString("<head><title>")
    b.WriteString(title)
    b.WriteString("</title></head>")
    b.WriteString("<body>")
    b.WriteString(body)
    b.WriteString("</body>")
    b.WriteString("</html>")

    return b.Bytes()
}

// Avoiding string conversions
func processBytes(data []byte) []byte {
    // Bad: Convert to string and back
    s := string(data)
    s = strings.ToUpper(s)
    return []byte(s)

    // Good: Work with bytes directly
    // return bytes.ToUpper(data)
}

// String interning for repeated values
var stringCache = make(map[string]string)

func intern(s string) string {
    if cached, ok := stringCache[s]; ok {
        return cached
    }
    stringCache[s] = s
    return s
}
```

**Substring and Memory Leaks**:

```go
// Danger: Substring retains original string's memory
func parseHeader(data string) string {
    // data might be 1MB
    colonIdx := strings.Index(data, ":")
    if colonIdx == -1 {
        return ""
    }

    // Bad: header references all of data's memory
    header := data[:colonIdx]

    // Good: Copy to release original memory
    headerCopy := string([]byte(data[:colonIdx]))

    return headerCopy
}

// Real-world example: Log parsing
func extractErrors(logData string) []string {
    lines := strings.Split(logData, "\n")
    errors := make([]string, 0, 10)

    for _, line := range lines {
        if strings.Contains(line, "ERROR") {
            // Bad: Each string references logData's backing array
            // errors = append(errors, line)

            // Good: Copy string to release logData
            errors = append(errors, strings.Clone(line)) // Go 1.20+
        }
    }

    return errors
}
```

---
