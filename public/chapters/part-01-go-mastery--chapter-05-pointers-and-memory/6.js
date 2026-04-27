export default `## 5.5 Understanding Nil

Nil behaves differently depending on the type it belongs to. A nil pointer panics on dereference, a nil slice works with \`append\`, a nil map panics on write, and a nil channel blocks forever. Knowing these distinctions prevents the most common class of runtime errors in Go.

### Nil Pointers

A nil pointer holds no address. Dereferencing one causes a runtime panic, so always check for nil before accessing the pointed-to value. The zero value for all pointer types is nil.

\`\`\`go
var p *int  // nil

// Safe: comparison
if p == nil {
    fmt.Println("nil pointer")
}

// Panic: dereference
// fmt.Println(*p)  // panic: runtime error
\`\`\`

### Nil Slices vs Empty Slices

A nil slice and an empty slice both have zero length and behave identically for most operations, but they differ in JSON encoding and nil comparisons. Choose based on whether absence carries semantic meaning.

\`\`\`go
var nilSlice []int           // nil
emptySlice := []int{}        // not nil, but empty
madeSlice := make([]int, 0)  // not nil, but empty

fmt.Println(nilSlice == nil)    // true
fmt.Println(emptySlice == nil)  // false
fmt.Println(madeSlice == nil)   // false

// But they behave the same for most operations
fmt.Println(len(nilSlice))      // 0
fmt.Println(len(emptySlice))    // 0
fmt.Println(cap(nilSlice))      // 0

nilSlice = append(nilSlice, 1)  // Works!
\`\`\`

**JSON difference:**

\`\`\`go
type Response struct {
    Items []string \`json:"items"\`
}

// nil slice marshals to null
r1 := Response{Items: nil}
// {"items":null}

// empty slice marshals to []
r2 := Response{Items: []string{}}
// {"items":[]}
\`\`\`

### Stripe's API Pattern

Stripe's Go SDK handles nil vs empty explicitly for API consistency:

\`\`\`go
// Stripe pattern: explicit empty vs nil for JSON
type ListResponse struct {
    Data     []Resource \`json:"data"\`
    HasMore  bool       \`json:"has_more"\`
}

func (c *Client) List(ctx context.Context) (*ListResponse, error) {
    resp := &ListResponse{
        Data: []Resource{},  // Never nil - always []
    }

    if err := c.call(ctx, resp); err != nil {
        return nil, err
    }

    return resp, nil
}

// Guarantees:
// - data is always [] or [...items], never null
// - Clients can safely iterate without nil check
\`\`\`

### Nil Maps

A nil map can be read from safely (lookups return the zero value), but writing to a nil map causes a runtime panic. Always initialize maps with \`make\` before inserting values.

\`\`\`go
var m map[string]int  // nil

// Safe: reading returns zero value
v := m["key"]  // v = 0

// Safe: checking length
fmt.Println(len(m))  // 0

// Safe: iteration
for k, v := range m {  // Loop doesn't execute
    fmt.Println(k, v)
}

// Panic: writing
// m["key"] = 1  // panic: assignment to entry in nil map

// Initialize before writing
m = make(map[string]int)
m["key"] = 1  // Works
\`\`\`

### Nil Channels

A nil channel blocks forever on both send and receive. This property is useful in \`select\` statements to disable a case dynamically by setting its channel variable to nil.

\`\`\`go
var ch chan int  // nil

// Blocks forever
// <-ch  // Block on receive
// ch <- 1  // Block on send

// Safe: close panics
// close(ch)  // panic: close of nil channel
\`\`\`

Nil channels are useful in select:

\`\`\`go
func merge(ch1, ch2 <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for ch1 != nil || ch2 != nil {
            select {
            case v, ok := <-ch1:
                if !ok {
                    ch1 = nil  // Disable this case
                    continue
                }
                out <- v
            case v, ok := <-ch2:
                if !ok {
                    ch2 = nil
                    continue
                }
                out <- v
            }
        }
    }()
    return out
}
\`\`\`

### Nil Interfaces

This is the most common nil-related bug in Go. An interface value consists of two words internally: a type descriptor and a data pointer. Even when the data pointer is nil, the interface itself is non-nil if the type descriptor is set.

\`\`\`go
type MyError struct{}
func (e *MyError) Error() string { return "error" }

func getError(fail bool) error {
    var err *MyError = nil
    if fail {
        err = &MyError{}
    }
    return err  // Returns non-nil interface!
}

func main() {
    err := getError(false)
    if err != nil {
        fmt.Println("Got error!")  // This prints!
    }
}
\`\`\`

An interface value has two components: (type, value). It's nil only if both are nil:

\`\`\`go
var err error = nil           // (nil, nil) - nil interface
var err error = (*MyError)(nil)  // (*MyError, nil) - NOT nil!
\`\`\`

**Fix: Return nil explicitly:**

\`\`\`go
func getError(fail bool) error {
    if fail {
        return &MyError{}
    }
    return nil  // Returns nil interface
}
\`\`\`

### Nil Receivers

Go allows method calls on nil pointer receivers without panicking, as long as the method body checks for nil before accessing fields. This property is particularly useful for recursive data structures like trees and linked lists, where nil represents an empty subtree.

\`\`\`go
type Node struct {
    Value int
    Next  *Node
}

func (n *Node) Sum() int {
    if n == nil {
        return 0
    }
    return n.Value + n.Next.Sum()
}

var head *Node = nil
fmt.Println(head.Sum())  // 0 - works!
\`\`\`


### Airbnb's Nil Safety Patterns

Airbnb's Go services use consistent nil handling:

\`\`\`go
// Pattern 1: Always initialize in constructors
type Service struct {
    cache  *Cache
    logger *Logger
    db     *Database
}

func NewService(opts ...Option) *Service {
    s := &Service{
        cache:  NewCache(),        // Never nil
        logger: NewDefaultLogger(), // Never nil
    }
    for _, opt := range opts {
        opt(s)
    }
    if s.db == nil {
        panic("database is required")  // Fail fast
    }
    return s
}

// Pattern 2: Nil-safe accessors
func (s *Service) GetCache() *Cache {
    if s == nil || s.cache == nil {
        return noopCache  // Return safe default
    }
    return s.cache
}

// Pattern 3: Guard clauses at function start
func ProcessOrder(order *Order) error {
    if order == nil {
        return errors.New("order is required")
    }
    if order.Items == nil {
        return errors.New("order items is required")
    }
    // ... safe to use order.Items
}
\`\`\`

### The Typed-Nil-Interface Bug in Production

The typed-nil-interface bug ranks among the top three causes of "this should not be possible" Go production incidents. The shape is always similar: a function declares its return type as \`error\` (or some other interface), assigns to a typed pointer that happens to be nil, returns the typed pointer, and the caller's \`if err != nil\` check passes when it should fail. The variants:

\`\`\`go
// Variant 1: Direct return of typed nil
func F() error {
    var e *MyError
    return e // non-nil interface wrapping nil pointer
}

// Variant 2: Conditional assignment
func F() error {
    var e *MyError
    if shouldFail() { e = &MyError{} }
    return e // non-nil interface even when shouldFail() is false
}

// Variant 3: Helper that returns typed nil
func makeError() *MyError { return nil }
func F() error {
    return makeError() // non-nil interface
}
\`\`\`

The defences:

1. **Lint with \`nilness\` from \`golang.org/x/tools/go/analysis/passes/nilness\`.** Catches some cases.
2. **Test the success path explicitly.** A test that calls \`F()\` in the no-error case and asserts \`err == nil\` will fail and reveal the bug.
3. **The team rule "always return \`nil\` literal on the success path".** Never \`return e\` where \`e\` is a typed pointer. Always \`return nil\` explicitly. The discipline is annoying, the bugs it prevents are catastrophic.

### Nil Method Receivers Are a Feature

The "method on a nil receiver works as long as you check" property is intentional and used in the standard library. \`(*os.File)(nil).Close()\` does the right thing (returns an error rather than panicking). \`(*list.List)(nil).Len()\` returns zero. Use the property when designing types where nil is a meaningful state, especially recursive data structures and option-style accessors.

The pitfall: a \`*T\` method that does not check for nil and then dereferences will panic. The check is your responsibility.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in nil-related PRs:

1. **A function that returns a typed pointer through an \`error\` interface.** Always a finding. Force the explicit \`return nil\` for the success path.
2. **A nil map written to.** Catch the panic potential at the line. Initialise the map at struct construction or in the first method that needs it.
3. **A \`*T\` method that does not nil-check and then dereferences.** Either document that nil receivers are not supported or add the check. Both are valid. Ambiguity is not.

### Migration Lens

Coming from Java, the absence of \`null\` checks at the method-call boundary is the biggest behavioural shift. Java throws NPE on any null dereference. Go panics, but only on dereference, not on the call itself if the receiver is a pointer. Coming from Python, \`None\` is roughly equivalent to nil but Python lets you call methods on \`None\` (which raise AttributeError on attribute access). Go's nil receivers are more permissive in some cases (you can call the method) and stricter in others (you cannot dereference). Coming from Rust, the absence of \`Option<T>\` for nullable pointers is the biggest shift. Go relies on convention and discipline where Rust uses the type system.

---
`;
