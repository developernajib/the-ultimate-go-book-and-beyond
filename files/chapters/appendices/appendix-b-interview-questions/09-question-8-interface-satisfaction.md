## Question 8: Interface Satisfaction

**Level**: Mid

**Question**: Will this code compile? Explain interface satisfaction and method sets.

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}

type File struct {
    name string
}

func (f *File) Read(p []byte) (n int, err error) {
    // Implementation
    return len(p), nil
}

func process(r Reader) {
    // Use reader
}

func main() {
    f := File{name: "test.txt"}
    process(f)   // Will this compile?

    fp := &File{name: "test.txt"}
    process(fp)  // What about this?
}
```

**Answer**:

```go
process(f)   // ✗ Compile error!
process(fp)  // ✓ Compiles
```

Error: `File does not implement Reader (Read method has pointer receiver)`

**Explanation**:

**Method Sets Rule**:
- Type `T` method set: methods with receiver `T`
- Type `*T` method set: methods with receiver `T` **AND** receiver `*T`

```go
// Method set of File:
//   (nothing)

// Method set of *File:
//   Read(p []byte) (int, error)
```

**Why This Rule Exists**:

When you call a method with a pointer receiver on a value, Go needs to take the address:

```go
f := File{name: "test.txt"}
f.Read(buf)  // Go rewrites as: (&f).Read(buf)
```

This works fine for method calls. But for interfaces, Go can't automatically take the address because:
1. The value might not be addressable (e.g., return value)
2. Taking the address changes semantics

```go
// This wouldn't work:
func getFile() File {
    return File{name: "test.txt"}
}

var r Reader = getFile()  // Can't take address of return value!
```

**The Fix**:

```go
// Option 1: Use pointer
f1 := &File{name: "test.txt"}
process(f1) // Works

// Option 2: Take address explicitly
f2 := File{name: "test.txt"}
process(&f2) // Works

// Option 3: Change to value receiver on type File
// func (f File) Read(p []byte) (n int, err error) {
//     return len(p), nil
// }
// f3 := File{name: "test.txt"}
// process(f3) // Now works!
```

**When to Use Pointer vs Value Receivers**:

```go
// Use POINTER receiver when:
// 1. Method modifies the receiver
type Counter struct {
    count int
}

func (c *Counter) Increment() {
    c.count++  // Modifies receiver
}

// 2. Receiver is large (expensive to copy)
type LargeStruct struct {
    data [1000000]int
}

func (ls *LargeStruct) Process() {
    // Don't copy 4MB on every call!
}

// 3. Consistency (if any method needs pointer, use pointer for all)
type Mixed struct {
    value int
}

func (m *Mixed) Set(v int) {
    m.value = v  // Needs pointer
}

// Use pointer for all methods for consistency:
func (m *Mixed) Get() int {
    return m.value
}

// Use VALUE receiver when:
// 1. Receiver is small and won't change
type Point struct {
    X, Y int
}

func (p Point) Distance() float64 {
    return math.Sqrt(float64(p.X*p.X + p.Y*p.Y))
}

// 2. Receiver is immutable by design
type Percentage int

func (p Percentage) String() string {
    return fmt.Sprintf("%d%%", int(p))
}

// 3. Need to implement interface on value type
type Token string

func (t Token) Validate() error {
    if len(t) == 0 {
        return errors.New("empty token")
    }
    return nil
}

// Want to use Token, not *Token with interfaces
```

**Method Set Reference Table**:

| Variable Type | Method Calls Available | Interface Satisfaction |
|---------------|----------------------|----------------------|
| `T` | Receiver `T` | Receiver `T` only |
| `*T` | Receiver `T` and `*T` | Receiver `T` and `*T` |

```go
type T struct{}

func (t T) ValueMethod()    {}
func (t *T) PointerMethod() {}

type IValue interface {
    ValueMethod()
}

type IPointer interface {
    PointerMethod()
}

func demo() {
    // Calling methods:
    var v T
    v.ValueMethod()   // ✓ Direct call
    v.PointerMethod() // ✓ Go rewrites as (&v).PointerMethod()

    var p *T
    p.ValueMethod()   // ✓ Go rewrites as (*p).ValueMethod()
    p.PointerMethod() // ✓ Direct call

    // Interface satisfaction:
    var _ IValue = v   // ✓ Works
    // var _ IPointer = v // ✗ Compile error: T does not implement IPointer (PointerMethod has pointer receiver)
    var _ IValue = p   // ✓ Works
    var _ IPointer = p // ✓ Works
}
```

**Real Production Example** (from Kubernetes):

```go
// Many Kubernetes objects implement this interface:
type Object interface {
    GetNamespace() string
    SetNamespace(string)
}

// These methods have pointer receivers:
type Pod struct {
    Namespace string
}

func (p *Pod) GetNamespace() string {
    return p.Namespace
}

func (p *Pod) SetNamespace(ns string) {
    p.Namespace = ns
}

// Usage:
func process(obj Object) {
    _ = obj
}

func main() {
    // Must use pointer:
    pod := &Pod{} // Not Pod{}
    process(pod)
}
```

**Common Interview Follow-up**: What about embedded types?

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

// Embedded interface
type ReadWriter interface {
    Reader  // Embeds Read method
    Writer  // Embeds Write method
}

// To satisfy ReadWriter, must implement both:
type File struct{}

func (f *File) Read(p []byte) (int, error)  { return 0, nil }
func (f *File) Write(p []byte) (int, error) { return 0, nil }

var rw ReadWriter = &File{}  // Satisfies ReadWriter
```

**Companies that asked this**: Google, Cloudflare, Uber, Datadog

---
