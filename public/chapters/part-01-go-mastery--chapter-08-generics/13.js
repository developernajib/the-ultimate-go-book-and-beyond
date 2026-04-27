export default `## Generics Pitfalls and Production Patterns

Generics shipped in Go 1.18 and have been refined through 1.25. The community has had several years to discover what works and what causes problems in production. This section collects the most frequent pitfalls and the patterns that have proven reliable in large codebases.

### When NOT to Use Generics

The most common mistake with generics is reaching for them when a simpler construct, a plain function, an interface, or a concrete type, already solves the problem. The following examples contrast wrong and right usage.

\`\`\`go
// WRONG: Generics for simple operations
func PrintAnything[T any](v T) {
    fmt.Println(v)  // fmt.Println already accepts any type!
}

// Just use:
func Print(v any) {
    fmt.Println(v)
}

// WRONG: Generics when interface{} works fine
type BadContainer[T any] struct {
    data []T
}

func (c *BadContainer[T]) Add(v T) {
    c.data = append(c.data, v)
}

func (c *BadContainer[T]) Get(i int) T {
    return c.data[i]
}

// If you don't need type safety at compile time:
type SimpleContainer struct {
    data []any
}

// WRONG: One method per type instead of generic
type StringProcessor struct{}
type IntProcessor struct{}
type FloatProcessor struct{}

func (p *StringProcessor) Process(s string) string { return strings.ToUpper(s) }
func (p *IntProcessor) Process(n int) int { return n * 2 }
func (p *FloatProcessor) Process(f float64) float64 { return f * 2 }

// CORRECT: Generic when you need same logic for different types
type Processor[T any] struct {
    transform func(T) T
}

func (p *Processor[T]) Process(v T) T {
    return p.transform(v)
}

// RULE OF THUMB: Use generics when:
// 1. You need type safety with compile-time checking
// 2. The same logic applies to different types
// 3. You're building data structures or algorithms
// 4. Interfaces don't provide enough type safety
\`\`\`

### Type Constraint Gotchas

Each constraint level permits a specific set of operations and excludes others. Mixing up \`any\`, \`comparable\`, and \`cmp.Ordered\` is one of the most common sources of compile errors when writing generic code.

\`\`\`go
// GOTCHA #1: any doesn't let you do much
func process[T any](v T) T {
    // What can you do with T?
    // - Assign it
    // - Pass it to functions accepting any
    // - Return it
    // That's about it!

    // Can't do:
    // v + v        // ERROR: + not defined on T
    // v == v       // ERROR: == not defined on T (for any)
    // v < v        // ERROR: < not defined on T

    return v
}

// GOTCHA #2: comparable allows == but not < >
func findEqual[T comparable](slice []T, target T) int {
    for i, v := range slice {
        if v == target {  // OK
            return i
        }
    }
    return -1
}

func findMin[T comparable](slice []T) T {
    min := slice[0]
    for _, v := range slice {
        // if v < min {  // ERROR: < not defined on T comparable
        //     min = v
        // }
    }
    return min
}

// CORRECT: Use cmp.Ordered for comparison
import "cmp"

func findMin[T cmp.Ordered](slice []T) T {
    min := slice[0]
    for _, v := range slice {
        if v < min {  // OK: cmp.Ordered defines < > <= >=
            min = v
        }
    }
    return min
}

// GOTCHA #3: Type constraints don't support methods
type Stringable interface {
    String() string
}

// This works:
func stringify[T Stringable](v T) string {
    return v.String()
}

// But what if you want both methods AND operators?
type OrderedStringer interface {
    cmp.Ordered
    String() string
}

// No built-in type satisfies this!
// int is Ordered but doesn't have String()
// Custom types with String() aren't Ordered

// SOLUTION: Use two constraints or accept trade-offs
func processWithBoth[T cmp.Ordered](v T) string {
    return fmt.Sprintf("%v", v)  // Use fmt for string conversion
}
\`\`\`

### Type Inference Limitations

Go's type inference works well when function arguments provide enough information to determine all type parameters. It fails in several predictable situations: when the type parameter appears only in the return type, when instantiating generic structs directly, and when a variable's static type is \`any\` instead of its concrete type.

\`\`\`go
// Type inference works for function arguments
func identity[T any](v T) T {
    return v
}

x := identity(42)     // T inferred as int
s := identity("hi")   // T inferred as string

// But NOT for return types or struct fields
func newSlice[T any]() []T {
    return make([]T, 0)
}

// var s = newSlice()      // ERROR: cannot infer T
var s = newSlice[string]()  // Must specify type

// NOT for struct instantiation
type Container[T any] struct {
    value T
}

// c := Container{value: 42}     // ERROR
c := Container[int]{value: 42}   // Must specify type

// WORKAROUND: Factory functions help with inference
func NewContainer[T any](value T) Container[T] {
    return Container[T]{value: value}
}

c := NewContainer(42)  // T inferred from argument

// GOTCHA: Inference doesn't "chain" through variables
func process[T any](v T) T { return v }

var x any = 42
// y := process(x)  // T is any, not int!

// The compiler sees x as any, not the underlying int
\`\`\`

### Generic Performance Considerations

GCShape stenciling means that generic code does not always compile to the same machine code as hand-written type-specific functions. The following patterns illustrate when the difference matters and how to work around it.

\`\`\`go
// Go uses "GCShape stenciling" - not full monomorphization
// Types with same "GC shape" share code

// Same GC shape (all pointers):
// *int, *string, *User, *Order - share implementation

// Different GC shapes:
// int, string, struct{...} - different implementations

// PERFORMANCE IMPLICATION:
// Generic code with pointer types: One implementation
// Generic code with value types: Multiple implementations

// This is usually fine, but in hot paths:
func sumGeneric[T cmp.Ordered](slice []T) T {
    var sum T
    for _, v := range slice {
        sum += v
    }
    return sum
}

// For maximum performance in hot paths, consider specific implementations:
func sumInt(slice []int) int {
    sum := 0
    for _, v := range slice {
        sum += v
    }
    return sum
}

func sumFloat64(slice []float64) float64 {
    sum := 0.0
    for _, v := range slice {
        sum += v
    }
    return sum
}

// BENCHMARK COMPARISON (typical):
// BenchmarkSumGenericInt-8      100000000    12 ns/op
// BenchmarkSumSpecificInt-8     100000000    10 ns/op
//
// The difference is usually small (10-20%), but matters in hot paths

// PATTERN: Generic API, specialized implementation
func Sum[T cmp.Ordered](slice []T) T {
    // Runtime type switch for hot paths
    switch s := any(slice).(type) {
    case []int:
        return any(sumInt(s)).(T)
    case []float64:
        return any(sumFloat64(s)).(T)
    default:
        return sumGeneric(slice)
    }
}
\`\`\`

### Method Constraints and Type Sets

Combining type unions with method requirements creates constraints that are precise but restrictive. The following examples show how \`~\` interacts with method sets, and where constraint definitions become unsatisfiable.

\`\`\`go
// Type sets define which types satisfy a constraint
type Numeric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
    ~float32 | ~float64
}

// The ~ means "underlying type"
type UserID int64

// Without ~: UserID doesn't satisfy "int64" constraint
// With ~:    UserID satisfies "~int64" constraint

// NOTE: You CAN combine type unions with methods in a constraint
type NumberStringer interface {
    ~int | ~float64
    String() string  // Type must satisfy BOTH the union AND have this method
}

// However, no built-in type satisfies both - you need a defined type:
type MyInt int
func (m MyInt) String() string { return fmt.Sprintf("%d", m) }
// MyInt satisfies NumberStringer: underlying type is int AND has String()

// GOTCHA: If no concrete type satisfies the constraint, it's useless
type Impossible interface {
    ~int | ~string
    Len() int  // int doesn't have Len(), string doesn't have Len()
}
// No type can satisfy this - it compiles but is unusable

// PATTERN: Constraint for pointer methods
type Cloner[T any] interface {
    Clone() T
}

// This won't work as expected:
func CloneSlice[T Cloner[T]](slice []T) []T {
    result := make([]T, len(slice))
    for i, v := range slice {
        result[i] = v.Clone()
    }
    return result
}

// Because value types usually have pointer receivers for Clone:
type User struct { Name string }
func (u *User) Clone() *User {  // Pointer receiver!
    return &User{Name: u.Name}
}

// Fix: Use pointer constraint pattern
func CloneSlice[T any, PT interface { *T; Clone() *T }](slice []T) []T {
    result := make([]T, len(slice))
    for i := range slice {
        ptr := PT(&slice[i])
        result[i] = *ptr.Clone()
    }
    return result
}
\`\`\`

### Common Generic Patterns in Production

The following four patterns appear repeatedly in production Go codebases. Each addresses a specific problem, error propagation, optional values, event dispatch, and data access abstraction, that generics solve more cleanly than the pre-1.18 alternatives.

\`\`\`go
// PATTERN 1: Generic result type (like Rust's Result)
type Result[T any] struct {
    value T
    err   error
}

func Ok[T any](value T) Result[T] {
    return Result[T]{value: value}
}

func Err[T any](err error) Result[T] {
    return Result[T]{err: err}
}

func (r Result[T]) Unwrap() (T, error) {
    return r.value, r.err
}

func (r Result[T]) UnwrapOr(defaultValue T) T {
    if r.err != nil {
        return defaultValue
    }
    return r.value
}

// PATTERN 2: Generic optional type
type Optional[T any] struct {
    value   T
    present bool
}

func Some[T any](v T) Optional[T] {
    return Optional[T]{value: v, present: true}
}

func None[T any]() Optional[T] {
    return Optional[T]{}
}

func (o Optional[T]) Get() (T, bool) {
    return o.value, o.present
}

func (o Optional[T]) OrElse(defaultValue T) T {
    if !o.present {
        return defaultValue
    }
    return o.value
}

// PATTERN 3: Type-safe event system
type Event[T any] struct {
    handlers []func(T)
    mu       sync.RWMutex
}

func (e *Event[T]) Subscribe(handler func(T)) func() {
    e.mu.Lock()
    e.handlers = append(e.handlers, handler)
    index := len(e.handlers) - 1
    e.mu.Unlock()

    return func() {
        e.mu.Lock()
        e.handlers = append(e.handlers[:index], e.handlers[index+1:]...)
        e.mu.Unlock()
    }
}

func (e *Event[T]) Publish(data T) {
    e.mu.RLock()
    handlers := make([]func(T), len(e.handlers))
    copy(handlers, e.handlers)
    e.mu.RUnlock()

    for _, h := range handlers {
        h(data)
    }
}

// Usage:
type UserCreated struct {
    UserID string
    Name   string
}

userCreatedEvent := &Event[UserCreated]{}
userCreatedEvent.Subscribe(func(e UserCreated) {
    fmt.Printf("User created: %s\\n", e.Name)
})
userCreatedEvent.Publish(UserCreated{UserID: "123", Name: "Alice"})

// PATTERN 4: Generic repository
type Repository[T any, ID comparable] interface {
    Get(ctx context.Context, id ID) (T, error)
    List(ctx context.Context) ([]T, error)
    Create(ctx context.Context, entity T) error
    Update(ctx context.Context, entity T) error
    Delete(ctx context.Context, id ID) error
}

type BaseRepository[T any, ID comparable] struct {
    db    *sql.DB
    table string
}

// This provides type-safe repository for any entity type
\`\`\`

### Quick Reference: Generics Decision Guide

| Scenario | Use Generics? | Alternative |
|----------|---------------|-------------|
| Type-safe container | Yes | \`interface{}\` loses safety |
| Same algorithm, multiple types | Yes | Code duplication |
| Method accepting any type | No | \`interface{}\` is fine |
| Single concrete type | No | Just use the type |
| Complex constraints needed | Maybe | Consider interfaces |
| Hot path performance-critical | Maybe | Benchmark both |
| Need to compare values | Use \`comparable\` | Custom Equal method |
| Need to order values | Use \`cmp.Ordered\` | Custom Less method |

### Senior-Track Wisdom

The most valuable thing a senior engineer can do with generics is resist adopting them reflexively. The Go 1 codebase survived a decade without generics, which means most patterns work fine without them. The right question is not "could this use generics?" but "would the generic version be measurably better?". If the answer is yes, go. If the answer is no or unclear, stay concrete.

---
`;
