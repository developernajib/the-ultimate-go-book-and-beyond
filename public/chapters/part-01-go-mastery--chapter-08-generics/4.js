export default `## 8.3 Constraints

Constraints define which operations a type parameter supports. Without constraints, a generic function can only assign, pass, and return a value of type \`T\` - it cannot add two \`T\` values, compare them, or call methods on them. Constraints give the compiler proof that specific operations are valid, and they give callers a clear contract.

### The any Constraint

\`any\` is an alias for \`interface{}\` and places no restrictions on the type argument. This makes it the most permissive constraint, but also the most limited in what you can do with the value inside the function.

\`\`\`go
func Print[T any](v T) {
    fmt.Printf("%v\\n", v)
}

func Swap[T any](a, b *T) {
    *a, *b = *b, *a
}

// Works with any type
Print(42)
Print("hello")
Print([]int{1, 2, 3})
Print(struct{ Name string }{"Alice"})
\`\`\`

**Limitation**: With \`any\`, you can only use operations valid for all types:
- Assignment
- Passing as argument
- Returning from function
- Taking address
- Type assertion

You **cannot** use \`==\`, \`<\`, \`+\`, etc. without a more specific constraint.

### The comparable Constraint

The \`comparable\` constraint permits \`==\` and \`!=\` but not ordering operators like \`<\` or \`>\`. It matches all types that Go allows as map keys: numeric types, strings, booleans, pointers, channels, arrays of comparable types, and structs whose fields are all comparable. Slices and maps are not comparable.

\`\`\`go
func Contains[T comparable](slice []T, target T) bool {
    for _, v := range slice {
        if v == target {  // Requires comparable
            return true
        }
    }
    return false
}

func Index[T comparable](slice []T, target T) int {
    for i, v := range slice {
        if v == target {
            return i
        }
    }
    return -1
}

// Works with comparable types
Contains([]int{1, 2, 3}, 2)         // true
Contains([]string{"a", "b"}, "c")   // false
Contains([]float64{1.1, 2.2}, 2.2)  // true

// Compile error: slices are not comparable
// Contains([][]int{{1}}, []int{1})

// Compile error: maps are not comparable
// Contains([]map[string]int{}, map[string]int{})

// Comparable types include:
// - All numeric types
// - string
// - bool
// - Pointers
// - Channels
// - Arrays of comparable types
// - Structs with all comparable fields
// - Interfaces (compared by dynamic type and value)
\`\`\`

### The cmp.Ordered Constraint

From the \`cmp\` package (Go 1.21+), allows ordered comparison with \`<\`, \`<=\`, \`>\`, \`>=\`:

\`\`\`go
import "cmp"

func Min[T cmp.Ordered](a, b T) T {
    if a < b {  // Requires Ordered
        return a
    }
    return b
}

func Max[T cmp.Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}

func Clamp[T cmp.Ordered](value, min, max T) T {
    if value < min {
        return min
    }
    if value > max {
        return max
    }
    return value
}

// cmp.Ordered includes:
// - All signed integers: int, int8, int16, int32, int64
// - All unsigned integers: uint, uint8, uint16, uint32, uint64, uintptr
// - All floats: float32, float64
// - string

// Usage
Min(5, 3)           // 3
Max("apple", "zoo") // "zoo"
Clamp(150, 0, 100)  // 100
\`\`\`

### Interface Constraints

Any named interface can serve as a constraint, requiring that the type argument implement specific methods. This bridges generics with Go's existing interface system, you get compile-time type safety while still requiring behavioral contracts.

\`\`\`go
type Stringer interface {
    String() string
}

func Stringify[T Stringer](items []T) []string {
    result := make([]string, len(items))
    for i, item := range items {
        result[i] = item.String()
    }
    return result
}

// Custom interface for JSON serialization
type JSONSerializable interface {
    ToJSON() ([]byte, error)
}

func SerializeAll[T JSONSerializable](items []T) ([][]byte, error) {
    result := make([][]byte, len(items))
    for i, item := range items {
        data, err := item.ToJSON()
        if err != nil {
            return nil, err
        }
        result[i] = data
    }
    return result, nil
}
\`\`\`

### Type Set Constraints

Type set constraints list the exact types a parameter may be instantiated with, using the \`|\` union operator. This gives you access to operators like \`+\` and \`<\` that are only valid for specific built-in types.

\`\`\`go
// Signed integer types
type Signed interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}

// Unsigned integer types
type Unsigned interface {
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr
}

// All integer types
type Integer interface {
    Signed | Unsigned
}

// All numeric types
type Number interface {
    Integer | ~float32 | ~float64 | ~complex64 | ~complex128
}

// Usage
func Sum[T Number](slice []T) T {
    var sum T
    for _, v := range slice {
        sum += v  // Works because all Number types support +
    }
    return sum
}

Sum([]int{1, 2, 3})           // 6
Sum([]float64{1.5, 2.5, 3.0}) // 7.0
Sum([]uint8{10, 20, 30})      // 60
\`\`\`

### The ~ Operator (Underlying Type Approximation)

\`~T\` means "any type whose underlying type is T":

\`\`\`go
// Without ~: only exact type matches
type ExactInt interface {
    int  // Only int, not type aliases or defined types
}

// With ~: underlying type matches
type ApproxInt interface {
    ~int  // int and any type with underlying type int
}

// Example
type UserID int    // Underlying type is int
type Score int     // Underlying type is int
type Count uint    // Underlying type is uint

func Double[T ~int](x T) T {
    return x * 2
}

var id UserID = 5
var score Score = 100

Double(id)     // Works: UserID has underlying type int
Double(score)  // Works: Score has underlying type int
Double(42)     // Works: int has underlying type int
// Double(uint(1))  // Error: uint doesn't match ~int

// Practical example: ID types
type Identifier interface {
    ~int | ~int64 | ~string
}

func FormatID[T Identifier](id T) string {
    return fmt.Sprintf("ID:%v", id)
}
\`\`\`

### Union Constraints with Methods

A constraint can require both a type set (for operator access) and methods (for behavioral contracts). The type argument must satisfy both requirements. This is powerful but restrictive, no built-in type will match, so only user-defined types with the right underlying type and methods qualify.

\`\`\`go
// Must be a number AND implement String()
type NumberStringer interface {
    ~int | ~int64 | ~float64
    String() string
}

// Example implementation
type FormattedInt int

func (f FormattedInt) String() string {
    return fmt.Sprintf("Formatted: %d", f)
}

func PrintNumber[T NumberStringer](n T) {
    fmt.Println(n.String())
    fmt.Println(n * 2)  // Works because T is a number
}

var fi FormattedInt = 42
PrintNumber(fi)  // Works: FormattedInt is ~int and has String()
// PrintNumber(42)  // Error: int doesn't have String() method
\`\`\`

### Built-in Constraint Packages

The standard library provides pre-defined constraints so you do not need to redeclare common type unions. The \`cmp\` package (Go 1.21+) replaces the earlier \`golang.org/x/exp/constraints\` module.

\`\`\`go
import "cmp"

// cmp.Ordered (Go 1.21+): types that support < > <= >=
// Before 1.21, the equivalent was golang.org/x/exp/constraints.Ordered
func Sort[T cmp.Ordered](s []T) { ... }

// Standard library constraint definitions:
// type Ordered interface {
//     ~int | ~int8 | ~int16 | ~int32 | ~int64 |
//     ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 | ~uintptr |
//     ~float32 | ~float64 |
//     ~string
// }
\`\`\`

### Constraint Design Discipline

Prefer standard-library constraints (\`any\`, \`comparable\`, \`cmp.Ordered\`) over hand-rolled ones. A custom constraint is justified when the standard ones do not express the needed behaviour (a specific method set, a specific union of types). Otherwise, the custom constraint is dead weight that the next reader has to learn.

---
`;
