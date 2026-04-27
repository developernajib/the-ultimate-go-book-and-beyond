export default `## 4.7 Type System Advanced

Go offers two ways to create a new type name: type definitions and type aliases. They look similar but behave differently. A type definition creates a genuinely new type that the compiler treats as distinct from its underlying type. A type alias creates a second name for an existing type with no distinction at all.

### Type Definitions vs Aliases

**Type definition** creates a new distinct type. Values of the defined type and its underlying type cannot be mixed without an explicit conversion:

\`\`\`go
type MyInt int

var x MyInt = 42
var y int = 42
// x = y  // Error: cannot use y (type int) as type MyInt

x = MyInt(y)  // Explicit conversion required
\`\`\`

**Type alias** creates an alternate name for an existing type. The two names are interchangeable with no conversion needed. Type aliases are primarily useful during large-scale refactoring, where a type needs to move between packages without breaking all callers at once:

\`\`\`go
type MyInt = int

var x MyInt = 42
var y int = 42
x = y  // Works: same type
\`\`\`

### When to Use Type Definitions

Type definitions provide:
- **Documentation**: What the value represents
- **Type safety**: Prevent mixing similar types
- **Method attachment**: Add behavior to basic types

\`\`\`go
// Document intent with distinct types
type UserID int64
type ProductID int64
type OrderID int64

// Can't accidentally mix them
func GetUser(id UserID) (*User, error) { ... }
func GetProduct(id ProductID) (*Product, error) { ... }
func GetOrder(id OrderID) (*Order, error) { ... }

var uid UserID = 123
var pid ProductID = 456

// Compile-time error prevents bugs:
// GetUser(pid)  // Error: cannot use pid (type ProductID) as type UserID
\`\`\`

### How Cloudflare Uses Type Definitions

Cloudflare's edge computing platform uses extensive type definitions:

\`\`\`go
// Type-safe identifiers
type ZoneID string
type AccountID string
type RuleID string

// Can't mix them even though both are strings
func GetZone(zoneID ZoneID) (*Zone, error) { ... }
func GetAccount(accountID AccountID) (*Account, error) { ... }

// Domain-specific types
type TTL uint32        // Time-to-live in seconds
type Priority uint16   // DNS priority

// Duration with custom behavior
type Seconds int64

func (s Seconds) Duration() time.Duration {
    return time.Duration(s) * time.Second
}

func (s Seconds) String() string {
    if s < 60 {
        return fmt.Sprintf("%ds", s)
    }
    return fmt.Sprintf("%dm%ds", s/60, s%60)
}
\`\`\`

### Method Sets

A type's method set determines which interfaces it satisfies. The rules are straightforward: a value type \`T\` can only call methods with value receivers, while a pointer type \`*T\` can call methods with both value and pointer receivers. This distinction matters when you assign a value or pointer to an interface variable, the compiler checks whether the method set covers all interface methods.

\`\`\`go
type Counter struct {
    count int
}

// Value receiver - in Counter's method set
func (c Counter) Value() int {
    return c.count
}

// Pointer receiver - only in *Counter's method set
func (c *Counter) Increment() {
    c.count++
}

// Counter method set:     { Value }
// *Counter method set:    { Value, Increment }
\`\`\`

This affects interface satisfaction:

\`\`\`go
type Incrementer interface {
    Increment()
}

type Valuer interface {
    Value() int
}

var c Counter

// Counter satisfies Valuer
var _ Valuer = c     // OK

// Counter doesn't satisfy Incrementer
// var _ Incrementer = c   // Error: Counter doesn't have Increment

// *Counter satisfies both
var _ Incrementer = &c  // OK
var _ Valuer = &c       // OK
\`\`\`

### Type Assertions

An interface value in Go carries both a concrete type and a concrete value. A type assertion extracts the underlying value as a specific type. The single-value form panics on failure. The two-value form returns a boolean indicating success, which is safer for cases where the type is not guaranteed.

\`\`\`go
var i any = "hello"

// Panicking assertion
s := i.(string)  // OK: s = "hello"
// n := i.(int)  // Panics: interface is string, not int

// Safe assertion with ok
s, ok := i.(string)  // s = "hello", ok = true
n, ok := i.(int)     // n = 0, ok = false

// Common pattern
if s, ok := i.(string); ok {
    fmt.Println("String:", s)
} else {
    fmt.Println("Not a string")
}
\`\`\`

### Type Switches

A type switch tests an interface value against multiple types in a single construct. Each \`case\` branch binds the value to its concrete type, giving you type-safe access without manual assertions. This is cleaner than chaining \`if/else\` type assertions and scales well as you add cases.

\`\`\`go
func describe(v any) string {
    switch x := v.(type) {
    case nil:
        return "nil"
    case int:
        return fmt.Sprintf("int: %d", x)
    case int64:
        return fmt.Sprintf("int64: %d", x)
    case string:
        return fmt.Sprintf("string: %q (len=%d)", x, len(x))
    case []int:
        return fmt.Sprintf("[]int with %d elements", len(x))
    case error:
        return fmt.Sprintf("error: %v", x)
    default:
        return fmt.Sprintf("unknown type: %T", x)
    }
}

// Multiple types in one case
func isNumeric(v any) bool {
    switch v.(type) {
    case int, int8, int16, int32, int64,
         uint, uint8, uint16, uint32, uint64,
         float32, float64:
        return true
    default:
        return false
    }
}
\`\`\`

### Generics (Go 1.18+)

Generics arrived in Go 1.18 and have matured through 1.26. The feature's scope is deliberately narrow: parameterised types and parameterised functions, with type constraints expressed as interfaces. There is no higher-kinded polymorphism, no specialisation, no generic methods beyond what the containing type supports. The primary use cases for a senior engineer:

1. **Generic container types.** \`List[T]\`, \`Set[T]\`, \`Queue[T]\`. The standard library added \`slices\`, \`maps\`, and \`sync/atomic.Pointer[T]\`. Before 1.18 these required reflection or code generation.
2. **Type-safe helper functions.** \`Map\`, \`Filter\`, \`Reduce\` over slices, with type parameters for input and output.
3. **Small abstraction over many similar types.** \`Min[T Ordered]\` replaces the \`MinInt\`, \`MinFloat64\`, \`MinInt64\` helpers that littered pre-1.18 codebases.

The discipline for when *not* to reach for generics:

1. **When an interface is simpler.** \`func Process(r io.Reader)\` is almost always simpler than \`func Process[T Reader](r T)\`. Only reach for type parameters when the interface approach loses something material.
2. **When the code is internal and has one caller.** Generics add compile-time work and binary size for each instantiation. One caller means one instantiation and the abstraction earns nothing.
3. **When the constraint is a single method.** \`type Stringer interface { String() string }\` with non-generic code is clearer than \`func F[T interface{ String() string }](t T)\` plumbing. Use the interface directly.

The single highest-leverage place generics earn their keep in 2026 is the \`slices\` and \`maps\` packages themselves, plus a handful of third-party libraries (\`samber/lo\`, \`elliotchance/pie\`) that add functional-style helpers. Most application code still looks non-generic.

### Interfaces as Behavioural Contracts

Go interfaces are small by design. The \`io.Reader\` interface has one method. \`io.Writer\` has one method. \`error\` has one method. The standard-library discipline of "the bigger the interface, the weaker the abstraction" (Rob Pike's proverb) is the rule a senior reviewer applies when looking at a proposed interface with five or ten methods.

When you need to accept a type with many methods, consider whether the caller really needs all of them. Most of the time, the caller needs one or two and the rest were added because "they might be useful later". The idiomatic response is to define a smaller interface in the consumer package that lists only the methods the consumer uses. The type you pass in can be anything that has those methods.

### Type Parameters Do Not Replace Interfaces

Two common mistakes at the senior review level:

1. **Replacing \`any\` parameters with \`T any\` parameters.** If the function does nothing with the type parameter (no constraint, no generic helpers), the change is cosmetic. Stick with \`any\` unless the constraint buys something.
2. **Using type parameters where a method on a type would do.** \`func F[T Container](c T)\` where \`Container\` has one method is a more verbose way of saying \`func F(c Container)\`. Use the interface.

The decision tree: "does the function need to know the concrete type at compile time?" If yes, type parameters. If no, interface.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in advanced-type-system PRs:

1. **A newly introduced interface with five or more methods.** Ask whether every caller uses every method. Usually the answer is no, and the interface should be split.
2. **Type parameters used where an interface would be simpler.** The test is "does this code branch on the concrete type?". If not, the interface is simpler.
3. **Type aliases used where type definitions are meant.** \`type UserID = int64\` (alias) gives no safety. \`type UserID int64\` (definition) does. A senior reviewer catches the equals sign when the intent is domain safety.

### Migration Lens

Coming from Java, the closest analogue to Go generics is Java generics with type erasure, minus wildcards and minus bounded wildcards. The mental model is "generics in Go are type parameters with explicit constraints, and the constraints are expressed as interfaces". Coming from Rust, Go generics lack associated types, lack trait bounds beyond single-method constraints, and lack zero-cost-abstraction guarantees. The trade is simplicity for expressiveness. Coming from TypeScript, Go generics are simpler and less expressive: no conditional types, no mapped types, no template literal types. Coming from C++ templates, Go generics are far less powerful but also far easier to read and debug, and there is no compile-time explosion of instantiations to worry about.

---
`;
