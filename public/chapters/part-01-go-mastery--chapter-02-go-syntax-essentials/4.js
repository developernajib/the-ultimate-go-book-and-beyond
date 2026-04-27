export default `## 2.2 Variables and Types

### Declaring Variables

Go gives you three ways to declare variables:

\`\`\`go
// 1. Full declaration with type
var name string = "Alice"
var age int = 30

// 2. Type inference (Go figures out the type from the value)
var city = "New York"  // Go infers string

// 3. Short declaration (most common inside functions)
count := 42            // Go infers int
message := "hello"     // Go infers string
\`\`\`

The \`:=\` short declaration is what you'll use 90% of the time inside functions. You cannot use \`:=\` outside of functions. Use \`var\` for package-level variables.

\`\`\`go
package main

var maxRetries = 3  // Package-level: must use var

func main() {
    attempts := 0   // Function-level: := is fine
    _ = attempts
}
\`\`\`

### Zero Values

In Go, every variable has a default value if you don't assign one. This is called the **zero value**:

\`\`\`go
var i int       // 0
var f float64   // 0.0
var s string    // "" (empty string)
var b bool      // false
var p *int      // nil (we'll cover pointers in Chapter 5)
\`\`\`

This eliminates an entire class of bugs found in languages where uninitialized variables contain garbage data. In Go, you always know what you're starting with.

### Basic Types

\`\`\`go
// Integers
var small int8 = 127        // -128 to 127
var medium int32 = 2147483647
var large int64 = 9223372036854775807
var auto int = 42           // Platform-dependent: 32 or 64 bit

// Unsigned integers (no negative values)
var positive uint = 42
var byteVal byte = 255      // byte is an alias for uint8

// Floating point
var pi float64 = 3.14159265358979
var approx float32 = 3.14

// Boolean
var active bool = true

// String
var greeting string = "Hello, Go!"

// Rune (a Unicode code point: alias for int32)
var letter rune = 'A'
var emoji rune = '🚀'
\`\`\`

### Constants

Constants are values that never change. They're set at compile time:

\`\`\`go
const Pi = 3.14159265358979
const MaxUsers = 10000
const AppName = "MyService"

// Group related constants
const (
    StatusOK    = 200
    StatusNotFound = 404
    StatusError = 500
)
\`\`\`

**\`iota\`**: Go's constant generator for sequential values:

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

\`iota\` starts at 0 and increments by 1 for each constant in the block. It's commonly used for enumerations.

### Type Conversions

Go does not do implicit type conversion. You must convert explicitly:

\`\`\`go
var i int = 42
var f float64 = float64(i)    // int → float64
var u uint = uint(f)          // float64 → uint

// String conversions
s := strconv.Itoa(42)         // int → string: "42"
n, err := strconv.Atoi("42") // string → int: 42, nil
\`\`\`

This strictness prevents subtle bugs. In Python, \`"5" + 3\` might do string concatenation or addition depending on context. In Go, it's a compile error. You must be explicit about what you mean.

### The Four Declaration Forms and When Each Is Idiomatic

There are technically four shapes a variable declaration can take, and an experienced reviewer will notice when you use the wrong one:

\`\`\`go
// 1. var with explicit type, no initialiser. Use at package scope or when
//    the zero value is the right starting point.
var counter int

// 2. var with type and initialiser. Use when the literal alone would not
//    pick the type you want, for example var size int32 = 1024.
var size int32 = 1024

// 3. var with initialiser, no type (inferred). Use at package scope when
//    short declaration is not allowed but you still want type inference.
var defaultPort = 8080

// 4. Short declaration. The default inside functions for any new binding.
port := 8080
\`\`\`

The non-obvious rule is that \`:=\` requires at least one new variable on the left. \`a, b := 1, 2\` is fine even when \`a\` already exists, as long as \`b\` is new. This is why mixed-declaration patterns work in error-handling chains:

\`\`\`go
v, err := getThing()
if err != nil { return err }
w, err := getOther()  // err is reused, w is new — legal
\`\`\`

It is also why this innocent-looking code shadows \`err\` and silently throws away the failure:

\`\`\`go
v, err := getThing()
if err != nil {
    v, err := tryFallback()  // new v, new err inside the if-block
    _ = v                     // outer err is untouched
}
\`\`\`

The shadowed-\`err\` bug is one of the top three Go mistakes that ship to production every year, and it is the entry point for countless take-home-assignment failures. Configure \`go vet -shadow\` (or the \`shadow\` analyser via \`golangci-lint\`) on day one of any new Go project.

### \`int\` Is Not Always 32 Bits

A subtle source of cross-platform bugs is the assumption that \`int\` is 32 bits. On 64-bit operating systems, which is essentially everything in 2026, \`int\` is 64 bits. This matters when serialising to a fixed-width binary format, encoding integers in protobuf or msgpack, or computing sizes that interact with C code via cgo. The rule for portable code is simple. If the width matters, write \`int32\` or \`int64\` explicitly. If the width does not matter, write \`int\` and let the compiler use the platform-native word size for performance. The same applies to \`uint\`. The default width follows the platform, the explicit widths do not.

### \`string\` Is Bytes, Not Characters

The single most surprising thing about Go's \`string\` type is that its \`len()\` returns the number of bytes, not the number of characters. \`len("café")\` is 5, not 4, because the \`é\` is two UTF-8 bytes. Iterating with \`for i := 0; i < len(s); i++\` walks bytes. Iterating with \`for i, r := range s\` walks runes (Unicode code points), and \`i\` jumps by the rune width, not by 1. If you slice a string with \`s[2:4]\` you get a substring of bytes, which can land in the middle of a multi-byte rune and produce invalid UTF-8. The \`unicode/utf8\` package, the \`strings\` package, and Go 1.16's \`strings.Cut\` plus 1.18's generics-friendly slice helpers are how you do correct multilingual text processing. This is also why Go has both \`byte\` (alias for \`uint8\`) and \`rune\` (alias for \`int32\`). The two are for two different jobs and confusing them is the root cause of "why is my UTF-8 broken" bug reports.

### \`iota\` Done Properly

\`iota\` is more powerful than the day-of-the-week example shows. It can be combined with expressions and bit shifts to define flag enums idiomatically:

\`\`\`go
type Permission uint8

const (
    PermRead    Permission = 1 << iota // 1
    PermWrite                          // 2
    PermExecute                        // 4
    PermDelete                         // 8
)

func (p Permission) Has(other Permission) bool {
    return p&other == other
}
\`\`\`

This pattern is how the standard library defines flags in \`os\` (file modes), \`regexp\` (compile options), and many others. Read it once and keep it in your back pocket. It comes up in interview rounds where the candidate is asked to model a permissions or feature-flag system from scratch.

The \`iota\`-resets-per-block rule is also worth memorising. Each \`const ( ... )\` block resets \`iota\` to 0, and \`iota\` increments per line within the block, even on lines that do not mention it. Mistakes here produce off-by-one bugs in serialised enums, which then become wire-format-compatibility bugs when one client and one server are built from different commits.

### Code-Review Lens (Senior Track)

Three patterns that recur in code review on senior-led Go services:

1. **Untyped constants vs typed constants.** Prefer untyped constants where possible (\`const MaxRetries = 3\` rather than \`const MaxRetries int = 3\`) because untyped constants compose with any compatible numeric type without conversion. Typed constants force conversions at the call site. The exception is when the constant is part of a public API and the type itself is meaningful, for example a \`Permission\` flag from the \`iota\` example above.
2. **Magic numbers vs named constants.** A literal \`30\` in code is invisible. A named \`const MaxLoginAttempts = 30\` is searchable, refactorable, and self-documenting. The rule is not "no magic numbers ever" because \`0\`, \`1\`, \`-1\`, and small loop bounds are universally understood. The rule is "if a literal carries domain meaning, name it." A junior PR with \`if attempts > 30\` is a yellow flag. The same code with \`const MaxLoginAttempts = 30\` and \`if attempts > MaxLoginAttempts\` is a green flag.
3. **Conversion-heavy code.** A function body sprinkled with \`int(x)\`, \`float64(y)\`, \`int32(z)\` is usually a sign that the surrounding API has the wrong types. The fix is rarely to add more conversions. It is to change the function signature to take the type the caller already has, and let the caller do the conversion at the boundary. Conversions belong at the edge of the program (parsing, serialisation), not in the middle.

### Migration Lens

Coming from JavaScript or Python you are used to dynamic typing where \`5 + "5"\` produces \`"55"\` or \`10\` depending on the language and you mostly do not think about it. Go is the opposite extreme. The compiler will reject \`5 + "5"\` outright with \`mismatched types int and string\`. This feels punitive for the first hour and becomes a productivity feature by the end of the first week, because the class of "I expected an int and got a string" runtime errors that haunt dynamic languages simply cannot occur. Coming from Java or C# you are used to widening conversions happening implicitly (\`int\` to \`long\`, \`float\` to \`double\`). Go does not do that either. \`var f float64 = anInt\` is a compile error. You write \`float64(anInt)\` every time. The repetitive feel disappears within a week and the explicitness pays off forever in code review.
`;
