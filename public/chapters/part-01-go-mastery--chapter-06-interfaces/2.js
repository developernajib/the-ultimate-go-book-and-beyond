export default `## 6.1 Interface Fundamentals

An interface defines a set of methods. Any type that implements those methods satisfies the interface, no explicit declaration required.

### Implicit Satisfaction

Go interfaces are satisfied implicitly: any type that implements all the methods of an interface automatically satisfies it, with no declaration required. This enables loose coupling between packages and retroactive interface satisfaction.

\`\`\`go
type Writer interface {
    Write([]byte) (int, error)
}

// File satisfies Writer without declaring it
type File struct {
    name string
}

func (f *File) Write(data []byte) (int, error) {
    // Write to file...
    return len(data), nil
}

// Buffer also satisfies Writer
type Buffer struct {
    data []byte
}

func (b *Buffer) Write(data []byte) (int, error) {
    b.data = append(b.data, data...)
    return len(data), nil
}

// Both can be used as Writer
func save(w Writer, data []byte) error {
    _, err := w.Write(data)
    return err
}

save(&File{name: "out.txt"}, []byte("hello"))
save(&Buffer{}, []byte("hello"))
\`\`\`

This is **duck typing** with compile-time safety: "If it walks like a duck and quacks like a duck, it is a duck."

### Why Implicit Interfaces Matter

Go's implicit interface satisfaction enables several powerful patterns:

1. **Decoupled packages**: Packages do not need to import each other
2. **Easy testing**: Create mocks without complex frameworks
3. **Third-party extension**: Add interfaces to types you do not own
4. **Gradual abstraction**: Extract interfaces after implementation

\`\`\`go
// You can define an interface that matches stdlib types
type Seeker interface {
    Seek(offset int64, whence int) (int64, error)
}

// os.File already satisfies this - no modification needed!
var s Seeker = &os.File{}
\`\`\`

### Interface Values

An interface value has two components:

1. **Type**: The concrete type of the stored value
2. **Value**: The actual value

\`\`\`go
var w Writer = &File{name: "test.txt"}
// w contains (type: *File, value: pointer to File)

fmt.Printf("Type: %T\\n", w)    // *main.File
fmt.Printf("Value: %v\\n", w)   // &{test.txt}
\`\`\`

### Understanding Interface Internals

Interfaces are represented as two-word structures:

\`\`\`go
// Non-empty interface (has methods)
type iface struct {
    tab  *itab          // Type info + method table
    data unsafe.Pointer // Pointer to actual data
}

// Empty interface (no methods)
type eface struct {
    _type *_type         // Type info only
    data  unsafe.Pointer // Pointer to actual data
}
\`\`\`

This representation has implications:
- Interface values are 16 bytes on 64-bit systems
- Storing a value in an interface may require allocation
- Method dispatch goes through the \`itab\` method table

### Nil Interfaces

An interface is nil only when both type and value are nil:

\`\`\`go
var w Writer  // nil interface (type=nil, value=nil)
fmt.Println(w == nil)  // true

var f *File = nil
w = f  // NOT nil interface (type=*File, value=nil)
fmt.Println(w == nil)  // false!
\`\`\`

This is a common gotcha, see Chapter 5 for details.

### Google's Approach to Nil Interfaces

Google's internal style guide emphasizes explicit nil returns:

\`\`\`go
// BAD: Returns typed nil - causes nil interface gotcha
func getWriter(useTempFile bool) io.Writer {
    var f *os.File // nil
    if useTempFile {
        f, _ = os.CreateTemp("", "temp")
    }
    return f // Returns (*os.File, nil) - NOT nil!
}

// GOOD: Return untyped nil explicitly
func getWriter(useTempFile bool) io.Writer {
    if useTempFile {
        f, err := os.CreateTemp("", "temp")
        if err != nil {
            return nil
        }
        return f
    }
    return nil // Returns (nil, nil) - truly nil
}
\`\`\`

### Interface Comparison

Two interface values are equal if they hold the same concrete type and the underlying values are equal. Comparing interface values whose concrete types are not comparable (maps, slices, functions) causes a runtime panic rather than a compile-time error, so use comparison cautiously with interfaces.

\`\`\`go
var w1 Writer = &Buffer{data: []byte("hello")}
var w2 Writer = &Buffer{data: []byte("hello")}

// Different pointers, different values
fmt.Println(w1 == w2)  // false

// Comparing interfaces with non-comparable types panics
type MapBuffer struct {
    data map[string]string  // Maps aren't comparable
}
func (m *MapBuffer) Write([]byte) (int, error) { return 0, nil }

var m1 Writer = &MapBuffer{}
var m2 Writer = &MapBuffer{}
// fmt.Println(m1 == m2)  // panic: comparing uncomparable type
\`\`\`

### Why Structural Typing Matters

The single sentence that makes Go interfaces click: "a type implements an interface by having the right methods, not by declaring it does". This inverts the dependency direction from Java and C#. In those languages, the implementer imports the interface and declares \`implements\`. In Go, the consumer defines the interface and any type with matching methods satisfies it. The consequences:

1. **You can retrofit interfaces onto types you do not own.** A third-party library's type, with no changes to that library, satisfies your interface if the method signatures match.
2. **The producer and consumer can evolve independently.** A consumer can define a smaller interface than the producer's full method set, and the interface changes with the consumer's needs, not the producer's.
3. **Testing becomes easy.** Any type with the right methods is a valid fake. You do not need a "fake" base class or mocking framework.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in interface-basics PRs:

1. **Interfaces named \`IFoo\`, \`FooInterface\`, or \`Abstract*\`.** Java habits. Go uses the noun form (\`Reader\`, \`Writer\`, \`Closer\`) or verb-er (\`Stringer\`, \`Validator\`). Rename.
2. **A typed-nil return through an interface.** Always a finding. Force explicit \`return nil\` on the success path.
3. **An interface declared next to the implementation, not the consumer.** Move it to the consuming package. This is the "accept interfaces where they are used" rule and it is the most important interface-design discipline in Go.

### Migration Lens

Coming from Java, the absence of \`implements\` feels wrong for the first week. The fix is to stop thinking of interfaces as inheritance and start thinking of them as structural contracts. Coming from Python, the addition of compile-time verification is the biggest shift. Duck typing becomes compile-checked duck typing, which is strictly better.

### Method Sets and Pointer Receivers

An interface-fundamentals section is incomplete without the method-set rule. A value \`T\` has a method set of all methods with receiver \`T\`. A pointer \`*T\` has a method set of all methods with receiver \`T\` *and* \`*T\`. Interface satisfaction follows the method set of the exact type being assigned.

\`\`\`go
type Stringer interface{ String() string }

type Point struct{ X, Y int }

func (p *Point) String() string { return fmt.Sprintf("(%d,%d)", p.X, p.Y) }

var s Stringer
s = &Point{1, 2} // OK: *Point has String()
// s = Point{1, 2} // compile error: Point does not implement Stringer
\`\`\`

The rule that tripped most Java migrants in their first month: if any method in the interface uses a pointer receiver, only the pointer type satisfies the interface. Make this instinctive. In interview settings, "why does this not compile" questions are almost always this rule.

### Type-Set Interfaces (Go 1.18 onwards, relevant through Go 1.26)

Generics introduced a second use of the \`interface\` keyword: type sets, used as constraints.

\`\`\`go
type Ordered interface {
    ~int | ~int64 | ~float64 | ~string
}

func Max[T Ordered](a, b T) T {
    if a > b { return a }
    return b
}
\`\`\`

Type-set interfaces are a compile-time vocabulary. They are not stored in interface values, there is no \`itab\`, and there is no dynamic dispatch. The two uses of \`interface\` (method sets for runtime polymorphism, type sets for compile-time constraints) share syntax but are different mechanisms. Conflating them in design reviews is a common senior-track mistake. Ask: "is this interface used to hold values at runtime, or to constrain a type parameter?" If the latter, the allocation cost discussion does not apply.

### Staff Lens: Interface as Team Contract

At one engineer, an interface is a seam for testing. At ten engineers, it is a seam between packages. At a hundred engineers across three teams, it is a contract that gates deployments. A new method on a shared interface is not "just add a method". It is a migration: every implementer across every repo must implement it before the interface change can merge, or the default-method pattern (not supported in Go) has to be faked through an adapter. The staff-track rule: before adding a method to a shared interface, decide (a) who implements it, (b) in what order, (c) how long the parallel-implementation window is, and (d) whether a new interface is the better answer. "Just add a method" is the most expensive four words in a shared-module PR.

---
`;
