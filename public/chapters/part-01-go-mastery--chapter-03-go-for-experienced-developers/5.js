export default `## 3.4 Variables and Constants

Go's variable and constant system has a few key differences from other languages. Variables are always initialized (there is no "uninitialized memory" in safe Go code), and the language provides two distinct declaration styles for different situations. Constants, meanwhile, support an \`iota\` generator that replaces the enum types found in other languages.

### Short Declaration vs var

Go offers two ways to declare variables. The short declaration operator \`:=\` infers the type from the right-hand side and is the preferred form inside functions:

\`\`\`go
name := "Alice"  // type inferred
count := 42      // type inferred
\`\`\`

Use \`var\` when:
- Declaring without initialization (zero value wanted)
- Declaring at package level
- Specifying a type different from the literal

\`\`\`go
var name string              // Zero value: ""
var count int64 = 42         // Explicit type (42 is int by default)
var err error                // Interface zero value: nil
\`\`\`

### The Blank Identifier

The blank identifier \`_\` acts as a write-only variable that discards a value. It appears frequently in Go because the compiler refuses to compile code with unused variables:

\`\`\`go
// Ignore the index in range
for _, value := range slice {
    fmt.Println(value)
}

// Ignore one of multiple return values
value, _ := someFunc()  // Ignoring error - usually bad!

// Force interface compliance at compile time
var _ io.Reader = (*MyType)(nil)

// Import for side effects
import _ "github.com/lib/pq"
\`\`\`

### Iota for Enumerations

Go lacks a dedicated enum keyword. Instead, \`iota\` generates sequential constant values within a \`const\` block, resetting to 0 at each new block:

\`\`\`go
const (
    Sunday = iota  // 0
    Monday         // 1
    Tuesday        // 2
    Wednesday      // 3
    Thursday       // 4
    Friday         // 5
    Saturday       // 6
)
\`\`\`

\`iota\` becomes powerful when combined with expressions. You can skip values, create bitmasks, or compute sizes:

\`\`\`go
// Skip zero value (useful for "unknown" state)
const (
    _ = iota  // Skip 0
    One       // 1
    Two       // 2
)

// Bit flags
const (
    FlagRead  = 1 << iota  // 1
    FlagWrite              // 2
    FlagExec               // 4
)

// With expressions
const (
    _  = iota              // Skip 0
    KB = 1 << (10 * iota)  // 1 << 10 = 1024
    MB                     // 1 << 20 = 1048576
    GB                     // 1 << 30 = 1073741824
    TB                     // 1 << 40
)
\`\`\`

### Real-World Iota: HTTP Status Codes

Real-world uses of \`iota\` go beyond simple sequences. HTTP status code groups, permission bitmasks, and state machines benefit from \`iota\`-based constant blocks that express intent clearly.

\`\`\`go
// Status categories (like net/http does internally)
const (
    statusInformational = iota + 1  // 1
    statusSuccess                   // 2
    statusRedirect                  // 3
    statusClientError               // 4
    statusServerError               // 5
)

func statusCategory(code int) int {
    return code / 100
}
\`\`\`

### Typed vs Untyped Constants

Go distinguishes between typed and untyped constants. Untyped constants have no fixed type until they are used in a context that requires one, which gives them more flexibility in expressions:

\`\`\`go
const x = 1.0  // untyped - can be used as int or float

const y int = 1  // typed - must be int
\`\`\`

Untyped constants are stored with arbitrary precision, far beyond what any runtime type can hold. The compiler evaluates constant expressions at compile time and only checks for overflow when the result is assigned to a variable:

\`\`\`go
const huge = 1e1000  // Valid - untyped, precise
// var f float64 = huge  // Error - too large for float64

// But can use in expressions
const smaller = huge / 1e999  // = 10, still precise
var f float64 = smaller       // OK - fits in float64
\`\`\`

### Why Untyped Constants Matter

For an experienced developer, the untyped-constants distinction looks like a curiosity until you hit the case where it matters. The arbitrary-precision evaluation lets you write expressions like \`const Pi = 3.14159265358979323846264338327950288\` and have the compiler use the most precise value supported by whatever destination type you assign it to. The same constant works as a \`float32\`, a \`float64\`, or a \`big.Float\` without the precision-loss surprises that happen when constants in C or Java are silently truncated to the destination type at the literal site. The senior-track lesson is to leave numeric literal constants untyped unless you have a specific reason to fix the type, because doing so preserves the precision and the flexibility for future callers.

### Iota Patterns Worth Memorising

Beyond bit flags and KB/MB/GB sizes, three iota patterns are worth knowing because they recur in real codebases:

\`\`\`go
// String-backed enums: define the iota constants and a String() method
type Status int

const (
    StatusUnknown Status = iota
    StatusActive
    StatusSuspended
    StatusDeleted
)

func (s Status) String() string {
    switch s {
    case StatusActive:
        return "active"
    case StatusSuspended:
        return "suspended"
    case StatusDeleted:
        return "deleted"
    default:
        return "unknown"
    }
}

// Generated stringers: use stringer to generate the String() method
//go:generate stringer -type=Status
\`\`\`

The \`stringer\` tool from the \`golang.org/x/tools/cmd/stringer\` package reads the iota declarations and generates a \`String()\` method automatically. Wire it into \`go generate\` and the iota constants become self-documenting at log time without manual switch maintenance.

\`\`\`go
// Versioned enum: reserve the zero value for "unknown" so future additions
// at the end of the list do not change existing values
type APIVersion int

const (
    APIUnknown APIVersion = iota
    APIv1
    APIv2
    APIv3
)
\`\`\`

Reserving the zero value for "unknown" or "unset" is a discipline worth applying to every iota-based enum, because it means the zero value of the surrounding struct is "I have not set this yet", which is almost always the right semantic. The contrast is the careless pattern of \`const ( APIv1 = iota; APIv2; APIv3 )\` where the zero value of \`APIVersion\` happens to mean "v1", which silently turns "I forgot to set this" into "I meant v1".

\`\`\`go
// Carry-forward expression: the iota expression at one line can be
// repeated implicitly on subsequent lines
type Priority int

const (
    PriorityLow    Priority = 1 << iota  // 1
    PriorityMedium                       // 2
    PriorityHigh                         // 4
    PriorityCritical                     // 8
)
\`\`\`

The expression \`1 << iota\` repeats on each subsequent line with the new \`iota\` value. This is how the bit-flag pattern works without writing the shift on every line. Misunderstanding this rule is the source of "why is my second flag 1 instead of 2?" bug reports.

### The Variable-Shadowing Trap

The most expensive variable-related bug in Go is shadowing of \`err\` in nested scopes. The pattern that bites every team at least once:

\`\`\`go
func load(id string) error {
    data, err := fetch(id)
    if err != nil {
        return err
    }
    if cond {
        data, err := transform(data)  // both new in this scope
        if err != nil {
            return err
        }
        _ = data
    }
    return err  // outer err, never updated by the inner block
}
\`\`\`

Inside the \`if\`, \`data, err := transform(data)\` declares new \`data\` and new \`err\` because both names appear on the left and the block is a new scope. The outer \`err\` is never updated. The function returns whatever the outer \`err\` was at the time of the first check, which is usually \`nil\`, hiding the failure. The fix is \`data, err = transform(data)\` (assign instead of declare) once \`data\` and \`err\` already exist. The detection is \`go vet -shadow\` or the equivalent \`golangci-lint\` configuration. The discipline is to keep functions small enough that the shadowing is visually obvious.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in variables-and-constants PRs:

1. **Typed constants where untyped would do.** \`const MaxRetries int = 3\` is rarely necessary. Drop the type. The compiler will pick the right one when the constant is used.
2. **Magic numbers and stringly-typed status codes.** A literal \`200\` or \`"active"\` in a function body is unnamed state. Promote to a typed constant or a named iota value, and the type system starts catching mistakes the original literal hid.
3. **Iota blocks where the zero value happens to mean a real state.** Reserve the zero value for "unknown" or "unset", as above. The cost is an extra constant. The benefit is that uninitialised values are detectable.

### Migration Lens

Coming from Java's \`enum\`, Go's iota plus typed-constant pattern is the closest analogue. The cost is that you write the \`String()\` method by hand or generate it. The benefit is that the constants are int-backed at runtime, so they serialise cheaply, and the type system enforces them at compile time. Coming from Python's \`Enum\` class, the same applies, with the additional shift that there is no \`for member in MyEnum\` iteration built in (you write a \`func All() []Status\` helper). Coming from TypeScript's union types, the pattern is similar but Go's enums are nominal types (\`Status\` and \`Priority\` are different types even if both are \`int\`), which is usually what you want.

---
`;
