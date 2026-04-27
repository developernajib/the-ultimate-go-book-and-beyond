export default `## 2.5 Structs and Methods

### Defining Structs

A struct groups related data together. If you're coming from Python, think of it as a class without inheritance. From Java, think of a simple POJO. From JavaScript, think of an object with a fixed shape.

\`\`\`go
type User struct {
    Name  string
    Email string
    Age   int
}

func main() {
    // Create a struct
    alice := User{
        Name:  "Alice",
        Email: "alice@example.com",
        Age:   30,
    }
    
    // Access fields with dot notation
    fmt.Println(alice.Name)   // Alice
    fmt.Println(alice.Age)    // 30
    
    // Modify fields
    alice.Age = 31
}
\`\`\`

You can also create structs without naming every field (positional), but **don't do this**: it breaks when someone adds a new field to the struct:

\`\`\`go
// Fragile: don't do this
bob := User{"Bob", "bob@example.com", 25}

// Always use named fields
bob := User{
    Name:  "Bob",
    Email: "bob@example.com",
    Age:   25,
}
\`\`\`

### Methods

Methods are functions attached to a type. They're defined with a **receiver** between the \`func\` keyword and the function name:

\`\`\`go
type Rectangle struct {
    Width  float64
    Height float64
}

// Value receiver: gets a COPY of the struct
func (r Rectangle) Area() float64 {
    return r.Width * r.Height
}

// Pointer receiver: gets a REFERENCE to the struct (can modify it)
func (r *Rectangle) Scale(factor float64) {
    r.Width *= factor
    r.Height *= factor
}

func main() {
    rect := Rectangle{Width: 10, Height: 5}
    
    fmt.Println(rect.Area())  // 50
    
    rect.Scale(2)
    fmt.Println(rect.Area())  // 200 (width=20, height=10)
}
\`\`\`

**When to use pointer vs value receivers:**
- Use a **pointer receiver** (\`*Rectangle\`) when the method needs to modify the struct
- Use a **value receiver** (\`Rectangle\`) when the method only reads data
- If any method on a type uses a pointer receiver, **all methods on that type should use pointer receivers** for consistency

### Struct Embedding (Composition)

Go doesn't have inheritance. Instead, it uses **composition**: embedding one struct inside another:

\`\`\`go
type Address struct {
    Street string
    City   string
    State  string
}

type Employee struct {
    Name    string
    Address // Embedded: Employee "has an" Address
    Salary  float64
}

func main() {
    emp := Employee{
        Name:   "Alice",
        Address: Address{
            Street: "123 Main St",
            City:   "Portland",
            State:  "OR",
        },
        Salary: 95000,
    }
    
    // Access embedded fields directly
    fmt.Println(emp.City)    // Portland (promoted from Address)
    fmt.Println(emp.Street)  // 123 Main St
}
\`\`\`

This is a fundamental Go pattern. You'll see it throughout the standard library and in every Go codebase. Chapter 10 covers composition in depth, including how promoted methods and multiple embedding interact.

### Constructor Pattern

Go doesn't have constructors. The convention is to write a \`New\` function:

\`\`\`go
func NewUser(name, email string, age int) *User {
    return &User{
        Name:  name,
        Email: email,
        Age:   age,
    }
}

user := NewUser("Alice", "alice@example.com", 30)
\`\`\`

Returning a pointer (\`*User\`) is conventional when the struct is meant to be modified or is expensive to copy.

### Receiver-Type Consistency Is a Real Rule, Not a Style Preference

The "if any method uses a pointer receiver, all methods should" rule is not arbitrary. It is enforced by how interface satisfaction works in Go. A \`*Rectangle\` can call methods defined on both \`Rectangle\` and \`*Rectangle\`, but a \`Rectangle\` value can only call methods defined on \`Rectangle\`. This means a type with mixed receivers will satisfy the same interface from one variable and fail to satisfy it from another, and the failure produces compile errors that read as inscrutable to anyone who has not seen the rule before:

\`\`\`go
type Stringer interface { String() string }

type T struct { v int }
func (t T) String() string { return fmt.Sprintf("%d", t.v) }
func (t *T) Reset()        { t.v = 0 }

var _ Stringer = T{}   // ok
var _ Stringer = &T{}  // ok
\`\`\`

Now flip one method:

\`\`\`go
func (t *T) String() string { return fmt.Sprintf("%d", t.v) }
var _ Stringer = T{}   // compile error: T does not implement Stringer
var _ Stringer = &T{}  // ok
\`\`\`

When the methods are mixed (some on \`T\`, some on \`*T\`), the rule "value methods are in \`*T\`'s method set, pointer methods are not in \`T\`'s method set" makes the type satisfy interfaces in one form and not the other. This breaks generic code, dependency injection, and serialisation libraries that use reflection over method sets. The fix is to pick one receiver type per type and stay with it. The default choice for any non-trivial type is pointer receivers, because (1) value receivers force a copy on every call which can be expensive for large structs, (2) value receivers prevent state mutation, and (3) consistency is easier to maintain than to retrofit. The exception is small immutable value types (\`Point\`, \`Time\`, \`Currency\`) where the copy is cheap and the immutability is a feature.

### Embedding Is Not Inheritance

Engineers from Java, C#, or Python routinely misread struct embedding as a form of inheritance. It is not. Embedding promotes the embedded type's fields and methods into the outer type's namespace, but it does not establish an "is-a" relationship and it does not enable polymorphic dispatch through the parent. There is no \`super\` to call. There is no virtual method table. An \`Employee\` with an embedded \`Address\` is not assignable to an \`Address\`-typed variable, even though \`emp.City\` works. The promoted methods are syntactic sugar for \`emp.Address.City\`. The mental model is "Employee has an Address that it exposes through its own surface", not "Employee is an Address".

This matters in code review because engineers who treat embedding as inheritance will write code that looks correct and behaves wrong. A common mistake is embedding a type to "extend" it and then expecting overrides. Defining \`func (e Employee) String() string\` does not override \`Address.String\`. It shadows it for the \`Employee\` type while leaving \`emp.Address.String()\` reachable independently. Method resolution in Go is by name on the outer type first, then through promotions, with no virtual dispatch through the embedded type.

When you actually want polymorphism, you reach for interfaces, not embedding. Embedding is for "this type composes those types' fields and methods into its own surface". Interfaces are for "this type satisfies a behavioural contract". The two work together (a struct can embed a type and satisfy interfaces independently) but they solve different problems.

### Comparable Structs and Map Keys

Two structs of the same type are comparable with \`==\` if all of their fields are comparable. This is unlike most languages where \`==\` on objects defaults to reference identity. Go compares structs field by field. A struct with a slice or a map field is not comparable, because slices and maps are not comparable, and using such a struct as a map key is a compile error.

\`\`\`go
type Point struct { X, Y int }       // comparable, can be a map key
type Path  struct { Points []Point } // not comparable, cannot be a map key
\`\`\`

This is the right time to internalise that map keys must be comparable, struct equality is value equality, and the easiest way to break both is to add a slice field to a struct that was previously serving as a map key.

### Tags and the Reflection Bridge

Struct fields can carry tags, which are string metadata read at runtime through reflection. Tags are how \`encoding/json\`, \`encoding/xml\`, the database drivers, and most validation libraries know how to map a struct to and from external formats:

\`\`\`go
type User struct {
    Name  string \`json:"name" validate:"required,min=1"\`
    Email string \`json:"email" validate:"required,email"\`
    Age   int    \`json:"age,omitempty"\`
}
\`\`\`

The tag is a single backtick-quoted string with a conventional \`key:"value"\` format separated by spaces. The \`json:"name"\` part tells \`encoding/json\` to marshal \`Name\` as \`"name"\` in the output. The \`omitempty\` tells it to skip the field when the value is the zero value. The \`validate\` tag is consumed by \`go-playground/validator/v10\`, the de-facto validation library. Tags are stringly typed and not type-checked by the compiler, so a typo in \`json:"naem"\` produces no warning. Tools like \`staticcheck\`'s \`ST1003\` and the dedicated \`tagliatelle\` linter help. Wire one in early.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer scans for in struct-heavy code:

1. **Mixed receiver types on the same type.** This is the single most common code-review finding on junior-authored Go PRs and the single most common cause of "why does this not satisfy this interface" puzzles. Either pick value or pick pointer for the type and apply it to every method. If the type ever needs to mutate state or hold a \`sync.Mutex\`, pointer is the only option, because copying a \`sync.Mutex\` is undefined behaviour and \`go vet\` will catch it.
2. **Constructors that return pointers without explanation.** \`func NewUser(...) *User\` is the standard idiom and almost always correct. The case where it deserves comment is when the constructor returns a value (\`func NewPoint(x, y int) Point\`) because the type is intentionally a value type. The senior-track expectation is that the choice between value and pointer is deliberate and the same across the package, not a per-function coin flip.
3. **Public structs with public mutable fields.** \`type User struct { Email string }\` exposes \`User.Email\` for direct mutation by any caller. For a domain type with invariants (an email must be validated, a state machine must transition through legal states) this is usually wrong. Make the field unexported and provide an accessor or a setter that enforces the invariant. Go's lack of getters and setters by default is a virtue for plain data types and a vice for domain types. Use the right shape for the job.

### Migration Lens

Coming from Java, the absence of constructors and inheritance is the biggest mental shift. The replacements are \`New...\` functions and embedding, respectively, and the result is code that is easier to test (no class hierarchies to mock) and easier to reason about (no virtual dispatch surprises). Coming from Python, the lack of \`__init__\`, \`@property\`, and \`@classmethod\` is similar. The Go equivalents are \`New...\`, accessor methods, and package-level functions, in that order. Coming from C++ or Rust, embedding is the closest analogue to private inheritance plus delegation, and Go's choice to make it a single mechanism rather than three is one of the reasons Go code is faster to onboard onto. Coming from JavaScript, the closest analogue to embedding is \`Object.assign(target, source)\`, with the difference that Go does it at compile time and gives you static type checking on the result.
`;
