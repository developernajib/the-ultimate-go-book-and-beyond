export default `## 2.2b Operators Reference

Go has a small, regular operator set. There is no operator overloading, what you see is what the language does. This section is a single-page reference you can come back to.

### Arithmetic

| Operator | Meaning | Notes |
|---|---|---|
| \`+\` | sum | also string concatenation |
| \`-\` | difference | also unary negation |
| \`*\` | product | |
| \`/\` | quotient | integer division truncates toward zero |
| \`%\` | remainder | sign matches the dividend |
| \`++\` | increment | statement only, not an expression |
| \`--\` | decrement | statement only, not an expression |

\`\`\`go
fmt.Println(7 / 2)    // 3   (integer division)
fmt.Println(7.0 / 2)  // 3.5 (one float operand → float result)
fmt.Println(-7 % 2)   // -1  (sign of dividend)

x := 5
x++          // ok, statement
// y := x++  // compile error, ++ is not an expression
\`\`\`

\`++\` and \`--\` not being expressions is a deliberate choice to remove a class of C bugs (\`a[i++] = i++\`).

### Comparison

| Operator | Meaning |
|---|---|
| \`==\` | equal |
| \`!=\` | not equal |
| \`<\` \`<=\` \`>\` \`>=\` | ordered comparison |

Comparison rules:

- Numbers compare by value. Comparing across types (e.g., \`int\` and \`int64\`) is a compile error, you must convert.
- Strings compare lexicographically by bytes, not by Unicode collation.
- Pointers compare by address. Two non-nil pointers are equal only if they point to the same variable.
- Structs are comparable if all their fields are comparable. Two struct values are equal when every field is equal.
- Arrays are comparable if their element type is. Slices, maps, and functions are not comparable (except against \`nil\`).
- Interfaces are equal if their dynamic types and dynamic values are equal. Comparing two interfaces holding non-comparable dynamic types panics at runtime.

\`\`\`go
var a, b []int
// _ = a == b   // compile error: slice can only be compared to nil
_ = a == nil    // ok
\`\`\`

### Logical

| Operator | Meaning | Short-circuits? |
|---|---|---|
| \`&&\` | logical AND | yes |
| \`\\|\\|\` | logical OR | yes |
| \`!\` | logical NOT | n/a |

Short-circuit evaluation is guaranteed. \`if p != nil && p.Valid()\` is the idiomatic nil-guard.

### Bitwise and Shift

| Operator | Meaning |
|---|---|
| \`&\` | bitwise AND |
| \`\\|\` | bitwise OR |
| \`^\` | bitwise XOR (also unary bitwise NOT) |
| \`&^\` | bit clear (AND NOT) |
| \`<<\` | left shift |
| \`>>\` | right shift |

Two things surprise newcomers:

1. **\`^\` is both XOR and bitwise NOT.** Unary \`^x\` flips every bit, the same as \`~x\` in C.
2. **\`&^\` is unique to Go.** \`a &^ b\` clears in \`a\` every bit that is set in \`b\`. It is the same as \`a & (^b)\` but reads more clearly when masking flags off.

\`\`\`go
const (
    FlagRead  = 1 << 0
    FlagWrite = 1 << 1
    FlagExec  = 1 << 2
)

perms := FlagRead | FlagWrite | FlagExec
perms = perms &^ FlagWrite   // clear write
fmt.Printf("%b\\n", perms)    // 101
\`\`\`

Right shift on a signed integer is arithmetic (sign-extending). On an unsigned integer it is logical (zero-filling). The shift count must be an unsigned integer or an untyped constant, since Go 1.13 a signed shift count is allowed but must be non-negative at runtime.

### Assignment and Compound Assignment

| Operator | Meaning |
|---|---|
| \`=\` | assign |
| \`:=\` | short variable declaration (covered in 2.2) |
| \`+=\` \`-=\` \`*=\` \`/=\` \`%=\` | arithmetic assignment |
| \`&=\` \`\\|=\` \`^=\` \`<<=\` \`>>=\` \`&^=\` | bitwise assignment |

\`\`\`go
flags := uint(0)
flags |= FlagRead
flags &^= FlagExec
\`\`\`

### Address-of and Indirection

| Operator | Meaning |
|---|---|
| \`&\` (unary) | take the address of a variable, returns \`*T\` |
| \`*\` (unary) | dereference a pointer, returns the value |

\`\`\`go
x := 42
p := &x      // p is *int
*p = 100     // x is now 100
\`\`\`

You cannot take the address of a literal, a map element, or the return value of a function. You can take the address of a struct field through a pointer (\`p.field\` auto-dereferences \`p\`).

### Channel Operators (Forward Pointer)

\`<-\` is the channel send/receive operator, covered in the concurrency part. Listed here for completeness:

\`\`\`go
ch <- v        // send v on channel ch
v := <-ch      // receive from ch into v
v, ok := <-ch  // receive, with ok=false if channel is closed and drained
\`\`\`

### Operator Precedence

Go has only **five** levels of binary-operator precedence, far fewer than C. From highest to lowest:

| Level | Operators |
|---|---|
| 5 | \`*\` \`/\` \`%\` \`<<\` \`>>\` \`&\` \`&^\` |
| 4 | \`+\` \`-\` \`\\|\` \`^\` |
| 3 | \`==\` \`!=\` \`<\` \`<=\` \`>\` \`>=\` |
| 2 | \`&&\` |
| 1 | \`\\|\\|\` |

Unary operators (\`+\`, \`-\`, \`!\`, \`^\`, \`*\`, \`&\`, \`<-\`) bind tighter than any binary operator. When in doubt, parenthesize. The compiler does not warn about unclear precedence the way some C compilers do.

### What Go Does Not Have

- No ternary \`?:\`. Use a normal \`if\` statement, or a small helper.
- No comma operator. \`a, b = 1, 2\` is a tuple assignment, not a comma expression.
- No operator overloading. \`+\` on your custom type is a compile error unless that type is a numeric or string type alias.
- No power operator. Use \`math.Pow\` for floats or write your own integer power.
- No null-coalescing or null-conditional. Idiom is an explicit \`if x != nil\` check.

### Code-Review Lens (Senior Track)

- Mixing \`int\` and \`uint\` in arithmetic forces a conversion, often a sign that the type choice is inconsistent. Pick one signedness per data flow.
- A \`&^\` is almost always a flag operation, an \`& ^const\` is a hand-rolled version of the same thing. Prefer \`&^\` for readability.
- Bit-shifts on \`int\` (signed) deep inside hashing code are a red flag, a constant-time hash usually wants \`uint64\` arithmetic.
- A long boolean expression with mixed \`&&\` and \`||\` is a re-write target. Extract named booleans, the operator-precedence table is not a substitute for a clearly named predicate.

### Migration Lens

- **From C/C++:** No bitfields, no comma operator, no compound conditional like \`0 < x < 10\` (that one parses as \`(0 < x) < 10\`). Integer overflow is defined as wraparound for unsigned types and is implementation-specific for signed types in C, in Go signed integer overflow is also wraparound, defined behavior.
- **From Python:** No \`**\` for power, no \`//\` for floor division (Go's \`/\` already truncates for ints). No chained comparisons.
- **From JavaScript:** No \`===\`, \`==\` is already strict. No \`??\` or \`?.\`, you write the nil check yourself.
- **From Rust:** No \`?\` operator for error propagation, you write \`if err != nil { return err }\`.
`;
