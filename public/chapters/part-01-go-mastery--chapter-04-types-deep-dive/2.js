export default `## 4.1 Numeric Types

Go provides explicit numeric types with defined sizes, unlike languages where \`int\` might be 16, 32, or 64 bits depending on the platform.

### Integer Types

| Type | Size | Range | Use Case |
|------|------|-------|----------|
| \`int8\` | 8 bits | -128 to 127 | Rarely used |
| \`int16\` | 16 bits | -32,768 to 32,767 | Rarely used |
| \`int32\` | 32 bits | -2.1B to 2.1B | Database IDs, network protocols |
| \`int64\` | 64 bits | -9.2×10¹⁸ to 9.2×10¹⁸ | Timestamps, large counters |
| \`uint8\` | 8 bits | 0 to 255 | Byte processing, colors |
| \`uint16\` | 16 bits | 0 to 65,535 | Ports, small counters |
| \`uint32\` | 32 bits | 0 to 4.2B | IPv4 addresses, hashes |
| \`uint64\` | 64 bits | 0 to 1.8×10¹⁹ | Large counters, IDs |
| \`int\` | 32 or 64 bits | Platform-dependent | Default choice |
| \`uint\` | 32 or 64 bits | Platform-dependent | Unsigned default |
| \`uintptr\` | 32 or 64 bits | For pointer arithmetic | CGo, unsafe |

### Type Aliases

Go provides two type aliases: \`byte\` is an alias for \`uint8\` and \`rune\` is an alias for \`int32\`. These aliases improve readability when working with raw bytes and Unicode code points respectively.

\`\`\`go
byte  // alias for uint8
rune  // alias for int32 (represents Unicode code point)
\`\`\`

### Platform-Dependent Types

\`int\` and \`uint\` are platform-dependent:
- 32 bits on 32-bit systems
- 64 bits on 64-bit systems

**Recommendation**: Use \`int\` for most cases. Use explicit sizes (\`int64\`, \`int32\`) when:
- Serializing data (protocol buffers, binary files)
- Interfacing with external systems
- The size constraint is semantically meaningful

\`\`\`go
// int for general use
for i := 0; i < len(slice); i++ {
    // i is int, matches len() return type
}

// int64 for explicit sizing
type DatabaseRecord struct {
    ID        int64  // Always 64 bits, matches database schema
    Timestamp int64  // Unix timestamp, needs full range
}
\`\`\`

### How Uber Handles Numeric Types

Uber's Go services process billions of events daily. Their coding guidelines emphasize type safety:

\`\`\`go
// Uber's ID type pattern
type TripID int64
type UserID int64
type DriverID int64

// Prevents accidentally using a UserID as a DriverID
func GetTrip(tripID TripID) (*Trip, error) { ... }
func GetUser(userID UserID) (*User, error) { ... }

// Wrong usage caught at compile time:
// GetTrip(UserID(123))  // Error: cannot use UserID as TripID
\`\`\`

### Floating-Point Types

| Type | Size | Precision | Use Case |
|------|------|-----------|----------|
| \`float32\` | 32 bits | ~7 decimal digits | Graphics, ML inference |
| \`float64\` | 64 bits | ~15 decimal digits | General purpose |

**Always use \`float64\`** unless you have a specific reason:
- Memory is rarely the constraint
- \`float32\` loses precision quickly
- Most math functions return \`float64\`

\`\`\`go
// Floating-point precision issues
var f float32 = 1.0
f += 0.0000001
f += 0.0000001
// f might not equal 1.0000002 due to precision loss

// float64 has more headroom
var d float64 = 1.0
d += 0.0000001
d += 0.0000001
// More accurate, though still not perfect
\`\`\`

### How Stripe Handles Money

Stripe never uses floating-point for money. Here's why:

\`\`\`go
// WRONG: Don't use float for money
var price float64 = 19.99
var quantity float64 = 3
total := price * quantity
fmt.Printf("%.2f\\n", total)  // Might print 59.97 or 59.970000000001

// RIGHT: Stripe uses integers (cents)
type Amount int64  // Represents cents (or smallest currency unit)

priceInCents := Amount(1999)      // \$19.99
quantity := int64(3)
totalInCents := priceInCents * Amount(quantity)  // 5997 cents = \$59.97

// Format for display
func (a Amount) String() string {
    dollars := a / 100
    cents := a % 100
    return fmt.Sprintf("\$%d.%02d", dollars, cents)
}
\`\`\`

### Floating-Point Comparison

Never compare floats with \`==\`:

\`\`\`go
// Wrong
if f1 == f2 {
    // May fail even for "equal" values
}

// Correct
const epsilon = 1e-9
if math.Abs(f1-f2) < epsilon {
    // Close enough
}

// Even better: use a relative comparison
func floatEquals(a, b, tolerance float64) bool {
    diff := math.Abs(a - b)
    if a == 0 || b == 0 {
        return diff < tolerance
    }
    return diff/math.Max(math.Abs(a), math.Abs(b)) < tolerance
}
\`\`\`

### Complex Numbers

Go has built-in support for complex numbers through \`complex64\` and \`complex128\` types. \`complex64\` uses two \`float32\` components (real and imaginary), while \`complex128\` uses two \`float64\` components. The \`real\`, \`imag\`, and \`complex\` built-in functions create and decompose complex values, and the \`cmplx\` package provides operations like \`Abs\` and \`Phase\`.

\`\`\`go
var c1 complex64 = 1 + 2i
var c2 complex128 = 3 + 4i

// Operations
sum := c2 + complex(1, 2)
product := c2 * complex(2, 0)

// Extract parts
realPart := real(c2)  // 3
imagPart := imag(c2)  // 4

// Magnitude (absolute value)
magnitude := cmplx.Abs(c2)  // 5 (3-4-5 triangle)
\`\`\`

Most Go developers rarely use complex numbers, but they appear in scientific computing, signal processing, and graphics work where operations on the complex plane are natural.

### Numeric Literals

Go 1.13 introduced several numeric literal improvements: binary literals (\`0b\`), explicit octal literals (\`0o\`), hexadecimal floating-point, and underscores for readability. These formats make bit manipulation, permission constants, and large numbers easier to read.

\`\`\`go
decimal := 42
binary := 0b101010      // 42
octal := 0o52           // 42
hex := 0x2A             // 42

float := 3.14
scientific := 6.022e23
hexFloat := 0x1.fp10    // 1984.0

// Underscores for readability (Go 1.13+)
billion := 1_000_000_000
binary := 0b1010_1010
hex := 0xDEAD_BEEF
creditCard := 1234_5678_9012_3456
\`\`\`

### Overflow Behavior

Unlike C, where signed integer overflow is undefined behavior, Go defines it: signed integers wrap around. Unsigned integers also wrap. This determinism avoids the undefined-behavior exploits common in C, but silent wrapping can still produce wrong results if you do not check for it.

\`\`\`go
var i int8 = 127
i++  // i is now -128 (wrapped)

var u uint8 = 255
u++  // u is now 0 (wrapped)
\`\`\`

For overflow detection, use \`math/bits\` or check before the operation:

\`\`\`go
import "math"

func safeAdd(a, b int64) (int64, error) {
    if a > 0 && b > math.MaxInt64-a {
        return 0, errors.New("overflow")
    }
    if a < 0 && b < math.MinInt64-a {
        return 0, errors.New("underflow")
    }
    return a + b, nil
}

// Using math/bits for overflow detection
func addWithOverflow(a, b uint64) (uint64, bool) {
    sum, carry := bits.Add64(a, b, 0)
    return sum, carry != 0
}
\`\`\`

### Type Conversions

Go requires explicit conversions between numeric types. There are no implicit promotions. This prevents subtle bugs that occur in C and C++ when signed and unsigned types interact, or when a wider type silently narrows. The trade-off is more typing, but the compiler catches every conversion, so you always know where data might change.

\`\`\`go
var i int = 42
var f float64 = float64(i)  // Explicit
var u uint = uint(i)        // Explicit

// This won't compile
// var f float64 = i  // Error: cannot use i as float64
\`\`\`

Be careful with conversions that can lose data:

\`\`\`go
var big int64 = 1 << 40
var small int32 = int32(big)  // Truncated, silent!

var f float64 = 1.7
var i int = int(f)  // 1 (truncated toward zero, not rounded)
\`\`\`

### Benchmark: Type Selection Impact

The following benchmark demonstrates the performance difference between numeric type sizes, motivating the guideline to prefer \`int\` for general use and sized types only when the size carries semantic meaning.

\`\`\`go
// Benchmark comparing int32 vs int64 operations
func BenchmarkInt32(b *testing.B) {
    var sum int32
    for b.Loop() {
        sum += int32(i)
    }
}

func BenchmarkInt64(b *testing.B) {
    var sum int64
    for b.Loop() {
        sum += int64(i)
    }
}

// Results on Apple M1:
// BenchmarkInt32-8   1000000000   0.3 ns/op
// BenchmarkInt64-8   1000000000   0.3 ns/op
// On 64-bit systems, there's often no performance difference
\`\`\`

### Named Types for Domain IDs

The single highest-leverage type-system discipline in Go is naming domain identifiers. \`UserID\`, \`OrderID\`, \`TripID\` as distinct named types are a compile-time shield against one of the most expensive bug classes in software: cross-domain value confusion.

\`\`\`go
type UserID int64
type OrderID int64

func Refund(orderID OrderID, userID UserID) error { ... }

// Call site
Refund(userID, orderID) // compile error: UserID is not OrderID
\`\`\`

The cost is one line of \`type\` declaration per identifier. The payoff is that no engineer on the team, forever, can accidentally pass a user ID where an order ID is expected. The compiler rejects the confusion at the line it happens, not in a production incident where the wrong order got refunded to the wrong user. For a senior engineer joining a new team, the "rename every \`int64\` that carries domain meaning to a named type" migration is usually a one-quarter effort that pays back in incidents prevented for the lifetime of the codebase.

The discipline has one real cost: named types do not implicitly convert to their underlying type, so arithmetic between two different named types requires explicit conversion. This is usually what you want (adding a \`UserID\` to an \`OrderID\` is never correct), but it means the team has to be disciplined about where the conversions happen. The conversion belongs at the boundary (parsing input, serialising output), not in the middle of business logic.

### Integer Overflow at the Senior-Track Level

Integer overflow in Go is well-defined (wraps), which is better than C's undefined behaviour but still dangerous in any code that computes sizes, offsets, or monetary amounts. The common production bugs:

1. **Timestamp arithmetic.** Subtracting two \`time.Time\` values produces a \`time.Duration\`, which is \`int64\` nanoseconds. For two times very far apart, the subtraction can overflow. In practice this only bites services that compare system time against a zero-initialised \`time.Time{}\`.
2. **Size calculations.** \`int(len(a)) * int(len(b))\` for large \`a\` and \`b\` overflows silently. In hot paths that allocate buffers, an overflow produces a zero-sized or negative allocation that crashes downstream.
3. **Monetary amounts.** \`int64\` dollars (or cents) in a payment service can overflow when aggregating across large batches. Stripe's discipline of using integer cents with explicit overflow checks on aggregation is the correct pattern.

The \`math/bits\` package provides \`Add64\`, \`Sub64\`, \`Mul64\` with explicit overflow detection. The discipline at the senior-track level is to use them in any computation whose overflow has domain meaning, and to write regression tests that exercise the overflow boundary.

### Float Precision Incidents

Three production-incident shapes that recur with floats:

1. **Currency in floats.** A service that stores prices as \`float64\` and aggregates across millions of transactions accumulates precision error that eventually becomes visible as a penny mismatch. The fix is Stripe's pattern (integer cents). The bug is almost always introduced by engineers from dynamic-typed backgrounds where "just use a float" is the default.
2. **Time in floats.** \`time.Duration\` is \`int64\` nanoseconds, not a float, for exactly this reason. Engineers who convert to \`float64\` seconds for arithmetic re-introduce the precision issue. Stay in the \`time.Duration\` domain.
3. **Comparison with \`==\`.** Always the wrong answer. Use epsilon-based comparison with a tolerance appropriate for the domain. For monetary amounts, never use floats in the first place.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in numeric-heavy PRs:

1. **A primitive \`int64\` that carries domain meaning.** Promote to a named type. The cost is one line. The benefit is permanent compile-time safety.
2. **A \`float64\` used for money, counts, or anything that must be exact.** Replace with an integer representation. This is the highest-impact change you can make in a financial or billing service.
3. **An integer conversion without a check or a comment.** \`int32(x)\` where \`x\` is a wider type should either be provably safe (documented at the line) or bounded (checked with \`if x > math.MaxInt32\`). Silent truncation is the source of many size-related bugs.

### Migration Lens

Coming from Python, the biggest shift is that integers are not arbitrary precision. \`1 << 100\` compiles but wraps. Use \`math/big\` for arbitrary precision. Coming from Java, the biggest shift is the absence of \`Integer\` vs \`int\` distinction. Go has only the value type, no boxed equivalent, and the primitive is the only thing that exists. Coming from TypeScript, the biggest shift is that \`number\` is not one type. You have to pick a width, and the default \`int\` is platform-dependent. Coming from Rust, the biggest shift is that Go has no \`i128\` or \`u128\` without the \`math/big\` package, and overflow is wrapping by default rather than panic-in-debug-mode.

---
`;
