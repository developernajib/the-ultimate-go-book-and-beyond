export default `## 5.2 When to Use Pointers

Knowing when to use pointers, and when not to, separates idiomatic Go from code that compiles but performs poorly or communicates intent unclearly. The following use cases cover the main reasons you would reach for a pointer.

### 1. Modifying the Original Value

Go passes all arguments by value, meaning each function call receives a copy. To modify the caller's variable, you must pass a pointer to it:

\`\`\`go
func double(x int) {
    x = x * 2  // Modifies copy only
}

func doublePtr(x *int) {
    *x = *x * 2  // Modifies original
}

value := 10
double(value)
fmt.Println(value)  // 10 (unchanged)

doublePtr(&value)
fmt.Println(value)  // 20 (modified)
\`\`\`

### 2. Large Struct Efficiency

Passing a struct by value copies every byte of it onto the callee's stack frame. For small structs this is negligible, but for structs with large arrays or many fields, the copy cost adds up on hot paths:

\`\`\`go
type LargeStruct struct {
    Data [10000]byte
}

// Copies 10KB every call
func processValue(ls LargeStruct) {
    // ...
}

// Copies 8 bytes (pointer size)
func processPtr(ls *LargeStruct) {
    // ...
}
\`\`\`

**Rule of thumb**: Use pointers for structs larger than ~64-128 bytes. Benchmark if unsure.

### Uber's Threshold Guidelines

Uber's Go Style Guide recommends this decision matrix:

\`\`\`go
// Size thresholds (64-bit systems)
//
// < 64 bytes:   Value semantics (copy is cheap)
// 64-256 bytes: Measure with benchmarks
// > 256 bytes:  Pointer semantics (avoid copying)

// Small struct - use value
type Point struct {
    X, Y float64  // 16 bytes
}

func Distance(p1, p2 Point) float64 {  // Value is fine
    dx := p2.X - p1.X
    dy := p2.Y - p1.Y
    return math.Sqrt(dx*dx + dy*dy)
}

// Large struct - use pointer
type UserProfile struct {
    ID          int64
    Name        string
    Email       string
    Preferences map[string]string
    History     []Action
    // ... many more fields
}

func (u *UserProfile) Update(changes ProfileChanges) error {
    // Pointer avoids copying potentially kilobytes
    u.Name = changes.Name
    // ...
    return nil
}
\`\`\`

### 3. Indicating Optional Values

Go's zero values (0 for int, "" for string, false for bool) make it impossible to distinguish "not set" from "set to zero" using value types alone. A pointer adds a third state: nil means absent, and any non-nil value means explicitly provided:

\`\`\`go
type User struct {
    Name     string
    Age      int
    Nickname *string  // Optional, can be nil
}

func (u User) DisplayName() string {
    if u.Nickname != nil {
        return *u.Nickname
    }
    return u.Name
}
\`\`\`

### Netflix's Optional Pattern

This pattern is common in REST APIs that support partial updates (PATCH semantics). Netflix's Go SDK uses pointer fields in request structs to distinguish "field was omitted from the request" (nil) from "field was explicitly set to its zero value" (non-nil pointer to zero):

\`\`\`go
// Netflix-style optional fields for partial updates
type UpdateRequest struct {
    Name        *string  \`json:"name,omitempty"\`
    Email       *string  \`json:"email,omitempty"\`
    Age         *int     \`json:"age,omitempty"\`
    IsActive    *bool    \`json:"is_active,omitempty"\`
}

func (s *Service) UpdateUser(ctx context.Context, userID string, req UpdateRequest) error {
    user, err := s.repo.Get(ctx, userID)
    if err != nil {
        return err
    }

    // Only update fields that were explicitly set
    if req.Name != nil {
        user.Name = *req.Name
    }
    if req.Email != nil {
        user.Email = *req.Email
    }
    if req.Age != nil {
        user.Age = *req.Age
    }
    if req.IsActive != nil {
        user.IsActive = *req.IsActive
    }

    return s.repo.Save(ctx, user)
}

// Helper functions for creating optional values
func StringPtr(s string) *string { return &s }
func IntPtr(i int) *int { return &i }
func BoolPtr(b bool) *bool { return &b }

// Usage
req := UpdateRequest{
    Name: StringPtr("Alice"),
    // Age not set - won't be updated
}
\`\`\`

### 5. Sharing Data Between Goroutines

Goroutines that need to read or write the same value must share a pointer to it. Passing by value would give each goroutine its own independent copy, defeating the purpose. Shared mutable state requires synchronization with a mutex or atomic operations:

\`\`\`go
type Counter struct {
    mu    sync.Mutex
    value int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

counter := &Counter{}
for i := 0; i < 100; i++ {
    go counter.Increment()  // All goroutines share same Counter
}
\`\`\`

### 5. Interface Satisfaction

A type with pointer receiver methods only satisfies an interface when used as a pointer. The value type does not have access to pointer receiver methods, so attempting to assign a value to an interface variable will produce a compile error:

\`\`\`go
type Modifier interface {
    Modify()
}

type Data struct {
    value int
}

func (d *Data) Modify() {  // Pointer receiver
    d.value++
}

var m Modifier = &Data{value: 10}  // Must use pointer
// var m Modifier = Data{value: 10}  // Error: Data doesn't implement Modifier
\`\`\`

### When NOT to Use Pointers

- **Small structs**: Copying is often faster than indirection
- **Immutable data**: If you do not need to modify it
- **Map and slice values**: They are already reference types internally
- **When value semantics are clearer**: Explicit copying prevents side effects

\`\`\`go
// Don't use pointers for these
type Point struct {
    X, Y int  // 16 bytes - copy is fine
}

func distance(p1, p2 Point) float64 {
    // Value semantics are clearer here
}
\`\`\`

### Google's Guidelines on Pointer vs Value

Google's internal Go style guide emphasizes:

\`\`\`go
// PREFER value semantics for:
// 1. Immutable data
// 2. Small types (< 64 bytes)
// 3. Types that should be compared by value

type Color struct {
    R, G, B uint8
}

func (c Color) Hex() string {
    return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
}

// Colors are immutable - value semantics make sense
red := Color{255, 0, 0}
blue := Color{0, 0, 255}

// PREFER pointer semantics for:
// 1. Mutable data
// 2. Large types
// 3. Types that should maintain identity

type Connection struct {
    mu      sync.Mutex
    socket  net.Conn
    buffer  []byte
    closed  bool
}

func (c *Connection) Write(data []byte) error {
    c.mu.Lock()
    defer c.mu.Unlock()
    // Connection identity matters - use pointers
}
\`\`\`

### The Consistency Rule

Receiver-type consistency is not a style preference, it is an interface-satisfaction rule enforced by the compiler. A type \`T\` with a mix of value and pointer receivers satisfies an interface from \`*T\` but not from \`T\`. This shows up as inscrutable "does not implement" compile errors in generic code, serialisation libraries, and dependency-injection containers that inspect method sets reflectively. The senior-track discipline: pick one receiver type per type and stay with it. Default to pointer for any non-trivial type, and reserve value receivers for small immutable value types (\`Point\`, \`Time\`, \`Currency\`).

### The Optional-Field Cost

The "use \`*T\` to mean optional" pattern is common and correct, but it has costs you should weigh:

1. **Heap allocations.** Each \`*string\`, \`*int\`, \`*bool\` in an optional field is a heap allocation when the value is set. For a request struct with ten optional fields, that is ten allocations per request in the hot path.
2. **Null-check noise.** Every read of an optional field needs a nil check or a helper. The code becomes verbose.
3. **JSON serialisation discipline.** The \`omitempty\` tag interacts with pointers in specific ways. A nil pointer omits. A pointer to a zero value serialises the zero value. Engineers from languages with \`Optional\` types reflexively reach for \`omitempty\` and get surprised by the behaviour.

The alternatives worth considering:

- **Sentinel values.** \`-1\` for "no age set" is ugly but cheaper. Fine for internal APIs where you control both sides.
- **Separate "set" bitmasks.** A bit per field that tracks which fields are set. Cheaper than pointers, harder to serialise.
- **Generics with \`Option[T]\` types.** Some teams have built these, with mixed success. The boxing and ergonomics are worse than \`*T\` in most cases.

For most services, \`*T\` is the right answer. For hot paths that allocate per-request, measure the impact before committing.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in pointer-usage PRs:

1. **Mixed receivers on one type.** Always a finding. Pick pointer or value, apply consistently.
2. **\`*T\` fields on a hot-path struct.** Benchmark the impact. If the allocation rate is high, consider sentinel values or separate "set" tracking.
3. **\`*T\` parameters where the function does not mutate.** If the caller's type is \`T\`, they will have to take a pointer. Consider making the parameter \`T\` instead, unless the type is large enough that copying is measurable.

### Migration Lens

Coming from Java, the value-vs-pointer distinction does not have a direct analogue. Java's "everything is a reference except primitives" model is the opposite of Go's. The mental shift is that in Go, passing a struct is like Java's \`Object.clone()\` by default. Coming from Python, the closest analogue is the difference between passing a list (mutable reference) and passing a tuple (immutable value). Go makes the distinction explicit at the call site. Coming from C++, Go pointers are closer to references than to pointers: no arithmetic, no ownership transfer, but shared mutation. Coming from Rust, the lack of ownership and borrowing rules is the biggest shift. You can freely pass a \`*T\` to multiple goroutines and mutate through it without the compiler stopping you, which is both liberating and dangerous.

---
`;
