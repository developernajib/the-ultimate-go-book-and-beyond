export default `## 10.1 Composition Over Inheritance

Go has no inheritance. Instead, it uses composition through embedding and interfaces, a deliberate design choice that leads to more flexible and maintainable code.

### Why No Inheritance?

Rob Pike and the Go team made explicit decisions against inheritance:

1. **Fragile base class problem**: Changes to parent classes break child classes
2. **Deep hierarchies**: Complex inheritance trees are hard to understand
3. **Diamond problem**: Multiple inheritance creates ambiguity
4. **Tight coupling**: Inheritance creates strong dependencies

Go's answer: composition and interfaces.

### Struct Embedding

Embedding promotes fields and methods to the outer type:

\`\`\`go
type Writer struct {
    buffer []byte
}

func (w *Writer) Write(data []byte) (int, error) {
    w.buffer = append(w.buffer, data...)
    return len(data), nil
}

func (w *Writer) Flush() error {
    // Write buffer to destination
    return nil
}

func (w *Writer) Reset() {
    w.buffer = w.buffer[:0]
}

type BufferedWriter struct {
    Writer     // Embedded, not inherited
    bufferSize int
    flushCount int
}

// BufferedWriter now has Write(), Flush(), and Reset() automatically
func main() {
    bw := &BufferedWriter{bufferSize: 1024}
    bw.Write([]byte("hello"))  // Calls embedded Writer.Write
    bw.Flush()                  // Calls embedded Writer.Flush

    // Can still access inner type explicitly
    bw.Writer.Reset()
}
\`\`\`

### How Embedding Works

When you embed a type, Go does several things:

\`\`\`go
type Inner struct {
    Value int
}

func (i Inner) Method() string {
    return "inner"
}

type Outer struct {
    Inner  // Embedding
    Name string
}

// Go generates these implicit methods and field access:
// func (o Outer) Method() string { return o.Inner.Method() }
// o.Value is shorthand for o.Inner.Value

func main() {
    o := Outer{
        Inner: Inner{Value: 42},
        Name:  "test",
    }

    fmt.Println(o.Value)      // 42 (promoted field)
    fmt.Println(o.Method())   // "inner" (promoted method)
    fmt.Println(o.Inner.Value) // 42 (explicit access)
}
\`\`\`

### Embedding vs Composition

Embedding promotes fields and methods from the embedded type to the embedding struct. Explicit field composition requires qualifying each access but makes the delegation visible and avoids unexpected method promotion.

\`\`\`go
// Embedding: fields and methods are promoted
// Use when you want the outer type to "be" the inner type
type Server struct {
    http.Server  // Promoted: s.ListenAndServe() works
}

// Composition: explicit delegation required
// Use when you want to hide or control the inner type's API
type Server struct {
    httpServer *http.Server  // Not promoted: s.httpServer.ListenAndServe()
}

func (s *Server) Start() error {
    return s.httpServer.ListenAndServe()  // Explicit delegation
}

func (s *Server) Stop(ctx context.Context) error {
    return s.httpServer.Shutdown(ctx)
}
\`\`\`

**When to use embedding:**
- You want the outer type to satisfy an interface the inner type satisfies
- The inner type's API is appropriate for the outer type
- You're extending functionality without hiding it

**When to use composition:**
- You want to hide the inner type's API
- You need to transform or intercept method calls
- The inner type's API doesn't make sense for the outer type

### Multiple Embedding

A single struct can embed multiple types, gaining all their promoted methods. This is how you compose behaviors from independent pieces without inheriting from a shared base:

\`\`\`go
type Reader struct{}
func (r *Reader) Read(p []byte) (int, error) { return 0, nil }

type Writer struct{}
func (w *Writer) Write(p []byte) (int, error) { return len(p), nil }

type ReadWriter struct {
    *Reader
    *Writer
}

// ReadWriter now has both Read() and Write()
var rw ReadWriter
var _ io.ReadWriter = &rw  // Satisfies io.ReadWriter
\`\`\`

### Handling Method Conflicts

When two embedded types share a method name, Go cannot resolve which one to promote. The compiler reports an "ambiguous selector" error if you call the conflicting method directly. You must either qualify the call with the embedded type's name or define the method on the outer type to resolve the ambiguity:

\`\`\`go
type A struct{}
func (A) Method() string { return "A" }

type B struct{}
func (B) Method() string { return "B" }

type Combined struct {
    A
    B
}

func main() {
    c := Combined{}

    // c.Method() - compile error: ambiguous selector

    // Must be explicit:
    fmt.Println(c.A.Method())  // "A"
    fmt.Println(c.B.Method())  // "B"
}

// Can resolve by defining Method on Combined
func (c Combined) Method() string {
    return c.A.Method() + c.B.Method()  // Or any other logic
}
\`\`\`

### Shadowing Embedded Methods

The outer type can define its own version of a promoted method. The outer method takes precedence in normal calls, but the embedded type's original method remains accessible through explicit field access:

\`\`\`go
type Base struct{}

func (b Base) String() string {
    return "base"
}

type Derived struct {
    Base
    name string
}

// This shadows Base.String()
func (d Derived) String() string {
    return fmt.Sprintf("derived(%s)", d.name)
}

func main() {
    d := Derived{name: "test"}
    fmt.Println(d.String())       // "derived(test)"
    fmt.Println(d.Base.String())  // "base"
}
\`\`\`

### Interface Embedding

Interfaces in Go compose the same way structs do. You define small, single-method interfaces and combine them into larger contracts. This keeps each interface focused and lets consumers depend on only the behavior they actually need.

\`\`\`go
// Small, focused interfaces
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

type Closer interface {
    Close() error
}

// Composed interfaces
type ReadWriter interface {
    Reader
    Writer
}

type ReadCloser interface {
    Reader
    Closer
}

type WriteCloser interface {
    Writer
    Closer
}

type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}
\`\`\`

This is the **interface segregation principle**: depend on minimal interfaces.

### Standard Library Interface Composition

The standard library itself follows this pattern. The \`io\` package defines \`Reader\`, \`Writer\`, and \`Closer\` as single-method interfaces, then composes them into \`ReadWriter\`, \`ReadCloser\`, and others. Other packages do the same with their own domain-specific contracts:

\`\`\`go
// From io package
type ReadWriter interface {
    Reader
    Writer
}

// From http package - http.ResponseWriter embeds multiple interfaces
type ResponseWriter interface {
    Header() Header
    Write([]byte) (int, error)
    WriteHeader(statusCode int)
}

// From sort package
type Interface interface {
    Len() int
    Less(i, j int) bool
    Swap(i, j int)
}
\`\`\`

### Flagging Inheritance-Shaped Embedding

When an engineer uses struct embedding as a substitute for inheritance, the code often has these tells:

1. **"Base" types with no independent callers.** A \`BaseEntity\` that is only ever embedded, never used on its own, is a Java parent class in disguise.
2. **Embedded fields named as type hierarchies.** \`BaseModel\`, \`AbstractRepository\`, \`BaseHandler\`. These names signal the wrong mental model.
3. **Embedding-as-override expectations.** Engineers expecting the outer type's method to replace the inner's by virtual dispatch. Go does not work that way.

The fix is to inline the embedded type's fields into the outer type when there are no other callers, or to promote the embedded type to a first-class reusable component with genuine independent purpose.

### The Static-Dispatch Reality Check

A point worth driving home for engineers crossing from OO languages: Go embedding is syntactic sugar for explicit delegation, resolved at compile time. There is no vtable, no virtual dispatch, no "the subclass's override wins when the base class calls a virtual method". If \`Inner.DoWork()\` internally calls \`Inner.Helper()\`, embedding \`Inner\` in \`Outer\` and shadowing \`Helper\` on \`Outer\` does nothing. \`DoWork\` still calls \`Inner.Helper\`. This is the single most common surprise for Java or C++ developers learning Go. Teach it explicitly. In Go, the way to let a subcomponent call a customisable piece is to pass that piece in as a function value or an interface, not to expect virtual dispatch.

\`\`\`go
type Inner struct {
    hook func() string
}

func (i Inner) DoWork() string { return i.hook() }

type Outer struct {
    Inner
}

func NewOuter() Outer {
    o := Outer{}
    o.Inner.hook = func() string { return "outer customisation" }
    return o
}
\`\`\`

This is the idiomatic answer. Explicit composition beats implicit virtual dispatch because the extension point is visible at the type signature.

### Staff Lens: The Embedding Budget

A codebase where every struct embeds two or three other structs looks reusable. It is not. It is a codebase where every change to a widely-embedded type propagates to every consumer, and where method promotion surprises show up in reviews for years. At staff level, set an embedding budget for the team. A reasonable default: embed at most one type per struct, and only when the outer type genuinely "is-a" extended version of the inner with the full embedded API surface making sense on the outer. Everything else is explicit composition with named fields and explicit delegation. This rule gets some pushback because it feels restrictive, but it is exactly the rule that prevents the codebase from accreting inheritance-shaped embedding over years.

### Principal Lens: The Library-vs-Framework Question

Embedding, generic middleware chains, and composition-heavy patterns can easily push a Go codebase from "library of small components" to "framework that dictates structure". The distinction matters. A library is code the application calls. A framework is code that calls the application. Go is at its best as a library language. When a team writes a "base service" that every microservice embeds, with lifecycle hooks, initialisation callbacks, and promoted middleware registration, that team has built a framework. The framework typically seemed like a good idea for the first six months, then became the thing the next staff engineer has to untangle. Principal-level instinct: push composition patterns toward the library end of the spectrum. Keep the extension points explicit, keep the call direction from application to component, and resist the gravitational pull toward "one true service skeleton". The codebase that survives is the one with many small reusable components, not the one with one big shared framework.

---
`;
