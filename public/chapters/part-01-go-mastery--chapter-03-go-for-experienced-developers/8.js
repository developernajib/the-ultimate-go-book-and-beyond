export default `## 3.7 Common Gotchas for Newcomers

These are mistakes almost every Go newcomer makes.

### Loop Variable Capture (Fixed in Go 1.22+)

Before Go 1.22, loop variables were shared across all iterations. Goroutines or closures that captured a loop variable would all see the same final value, not the value at the iteration when they were created:

**Pre-Go 1.22 bug**:

\`\`\`go
funcs := []func(){}
for i := 0; i < 3; i++ {
    funcs = append(funcs, func() {
        fmt.Println(i)  // Bug: captures i by reference
    })
}
for _, f := range funcs {
    f()  // Prints: 3, 3, 3 (not 0, 1, 2)
}
\`\`\`

**Go 1.22+ fix**: Loop variables are now per-iteration, so this works correctly.

**Pre-1.22 workaround**:

\`\`\`go
for i := 0; i < 3; i++ {
    i := i  // Shadow with new variable
    funcs = append(funcs, func() {
        fmt.Println(i)  // Now works: 0, 1, 2
    })
}
\`\`\`

### Nil Interface vs Nil Pointer

This is one of Go's most confusing behaviors. An interface value stores two things internally: a type descriptor and a pointer to the concrete value. An interface is \`nil\` only when *both* components are nil:

\`\`\`go
type MyError struct{}

func (e *MyError) Error() string { return "my error" }

func getError() error {
    var e *MyError = nil  // nil pointer
    return e              // Returns interface holding (type=*MyError, value=nil)
}

func main() {
    err := getError()
    if err != nil {
        fmt.Println("error!")  // This prints! Interface is not nil
    }
}
\`\`\`

An interface value is nil only if both its type and value are nil. Here, the type is \`*MyError\`, so the interface is not nil.

**Fix**: Return \`nil\` explicitly:

\`\`\`go
func getError() error {
    var e *MyError = nil
    if e == nil {
        return nil  // Returns nil interface
    }
    return e
}
\`\`\`

### Slice Append Behavior

Slices in Go are backed by arrays. When two slices share the same backing array, appending to one can overwrite elements visible through the other. This catches developers from languages where collections are independent objects:

\`\`\`go
a := []int{1, 2, 3}
b := a[:2]           // b shares memory with a
b = append(b, 4)     // Modifies a's memory!
fmt.Println(a)       // [1 2 4] - not [1 2 3]
\`\`\`

If you need to modify a slice copy independently, use \`copy()\` or a full slice expression:

\`\`\`go
b := append([]int{}, a[:2]...)  // New backing array
// or
b := a[:2:2]  // Full slice expression limits capacity

// Demonstration of full slice expression
a := []int{1, 2, 3, 4, 5}
b := a[1:3:3]  // b = [2, 3], length=2, capacity=2 (not 4)
b = append(b, 6)  // Must allocate new array
fmt.Println(a)    // [1 2 3 4 5] - unchanged
fmt.Println(b)    // [2 3 6]
\`\`\`

### Map Iteration Order

Go deliberately randomizes map iteration order at runtime to prevent code from depending on a specific ordering. This means the same program may produce different output on different runs:

\`\`\`go
m := map[string]int{"a": 1, "b": 2, "c": 3}
for k, v := range m {
    fmt.Println(k, v)  // Order varies between runs
}
\`\`\`

If you need ordered iteration, sort the keys first:

\`\`\`go
keys := make([]string, 0, len(m))
for k := range m {
    keys = append(keys, k)
}
slices.Sort(keys)
for _, k := range keys {
    fmt.Println(k, m[k])
}

// Or use stdlib maps/slices packages (Go 1.21+)
// import "maps" and "slices"
keys = slices.Sorted(maps.Keys(m))
\`\`\`

### String Indexing Returns Bytes

Go strings are sequences of bytes, not characters. Indexing a string returns a byte, and \`len()\` returns the byte count, not the number of Unicode characters. Multi-byte characters (like Chinese, emoji, or accented letters) occupy more than one index position:

\`\`\`go
s := "Hello, 世界"
fmt.Println(len(s))      // 13 bytes, not 9 characters
fmt.Println(s[7])        // 228 (first byte of 世)
fmt.Println(s[7:10])     // 世 (three bytes = one rune)
\`\`\`

To iterate over runes:

\`\`\`go
for i, r := range s {
    fmt.Printf("%d: %c\\n", i, r)
}
// 0: H, 1: e, 2: l, 3: l, 4: o, 5: ,, 6: (space), 7: 世, 10: 界

// To get rune count
runeCount := utf8.RuneCountInString(s)  // 9

// To get nth rune
runes := []rune(s)
fmt.Println(string(runes[7]))  // 世
\`\`\`

### Shadow Variables

The \`:=\` operator in an inner scope creates a new variable that shadows the outer variable of the same name. The outer variable remains unchanged, which often leads to subtle bugs:

\`\`\`go
x := 1
if true {
    x := 2        // New x, shadows outer x
    fmt.Println(x) // 2
}
fmt.Println(x)     // 1 - outer x unchanged!
\`\`\`

This is often accidental. Use \`=\` to assign, \`:=\` to declare:

\`\`\`go
x := 1
if true {
    x = 2         // Assigns to outer x
    fmt.Println(x) // 2
}
fmt.Println(x)     // 2
\`\`\`

### Range Over Map While Modifying

The Go specification guarantees that deleting map entries during a \`range\` loop is safe, but adding new entries during iteration produces undefined behavior: the new key may or may not appear in subsequent iterations:

\`\`\`go
m := map[string]int{"a": 1, "b": 2, "c": 3}
for k := range m {
    if k == "a" {
        delete(m, "b")  // Safe
    }
}

// But this is undefined:
for k := range m {
    m["new_key"] = 100  // May or may not be iterated
}
\`\`\`

### Time Zones and \`time.Now()\`

\`time.Now()\` returns the local time in the system's local time zone, which is whatever the OS reports. For services that span time zones (containers in different regions, tests run on engineer laptops, batch jobs on different schedulers), the local time zone is a hidden source of bugs. The discipline:

1. **Always store and compare times in UTC.** Convert to local time only at the boundary (formatting for display, parsing user input that is unambiguously in a stated zone).
2. **Use \`time.Time.Equal\` to compare, not \`==\`.** The \`==\` comparison includes the \`time.Location\` pointer, so two times that represent the same instant but were constructed in different zones compare unequal. \`Equal\` compares the underlying instant.
3. **Use \`time.Now().UTC()\` in services.** Or, for testability, inject a \`time.Now\`-style function or use a clock interface (\`benbjohnson/clock\` is the de-facto choice).

### \`nil\` Channel and \`nil\` Map Are Different

Three distinct nil-collection behaviours that catch even experienced engineers:

\`\`\`go
var s []int
s = append(s, 1)  // OK: append on nil slice allocates

var m map[string]int
m["k"] = 1        // panic: assignment to entry in nil map

var c chan int
c <- 1            // blocks forever
<-c               // blocks forever
\`\`\`

The asymmetry is deliberate. Nil slice on append works because \`append\` semantically returns a new slice (and the runtime allocates a fresh backing array when the input is nil). Nil map on write fails because there is no bucket array to insert into and the runtime cannot lazily allocate one without changing the map header (which the caller's map variable points to). Nil channel on send or receive blocks forever because a nil channel has no sender or receiver, which is occasionally useful in \`select\` to disable a branch.

### \`context.Context\` Is Not Optional

A function that does I/O, takes a network call, or runs for a non-trivial amount of time should accept a \`context.Context\` as its first parameter. The convention is so universal that the absence of a \`ctx\` parameter is itself a code-review finding. Three rules:

1. **\`ctx\` is the first parameter, conventionally named \`ctx\`.** Not \`context\`, not \`c\`, not buried later in the signature.
2. **Never store \`ctx\` in a struct.** A request-scoped context belongs in the call chain, not in long-lived state. The exception is short-lived "request" structs that are scoped to one operation.
3. **Always check \`ctx.Done()\` in long-running loops.** A goroutine that does not check \`ctx.Done()\` cannot be cancelled, which is the entire point of \`context.Context\`.

This is one of the highest-leverage discipline rules in Go services and one of the easiest things to get wrong when migrating from a language without an equivalent.

### Comparing Errors with \`==\`

Pre-Go-1.13, error comparison was \`if err == ErrNotFound\`. With wrapped errors (introduced by \`fmt.Errorf("...%w", err)\` in 1.13), \`==\` no longer works because the outer error is not the same as the wrapped sentinel. The replacement is \`errors.Is(err, ErrNotFound)\`, which walks the wrap chain.

\`\`\`go
// Pre-1.13 idiom, broken by wrapping
if err == ErrNotFound { ... }

// 1.13+ idiom, works through wrapping
if errors.Is(err, ErrNotFound) { ... }
\`\`\`

A linter (\`errorlint\` from \`polyfloyd/go-errorlint\`) catches \`==\` comparisons against errors and recommends the replacement.

### Reflection Is a Last Resort

Go has a \`reflect\` package. It is the right tool for a small set of problems (encoding/decoding to formats whose schema is not known at compile time, framework-style libraries that need to inspect arbitrary types) and the wrong tool for almost everything else. The reasons:

1. **Reflection bypasses the type system.** Errors that the compiler would catch become runtime panics or silent misbehaviour.
2. **Reflection is slow.** A reflective field access is dozens of times slower than a direct one. In hot-path code, reflection shows up in profiles immediately.
3. **Reflective code is hard to read and refactor.** A function that takes \`reflect.Value\` is opaque to grep and to the IDE.

The senior-track default is "do not reach for \`reflect\` until you have written the same code three times without it and confirmed that the duplication is not the right answer". With generics (Go 1.18+) the cases where reflection was previously the only option have shrunk dramatically. The cases that remain (encoding/json, ORM-style libraries, deep equality) are usually solved by a well-tested library, not by hand-rolled reflection in your codebase.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in gotchas-related PRs:

1. **A function that accepts a slice argument and appends to it.** The function's name and contract should make the aliasing behaviour explicit. The default discipline is "if the function appends, document it or copy first".
2. **A \`time.Time\` comparison with \`==\`.** Replace with \`.Equal()\`. The lint rule is enforced by \`staticcheck\`.
3. **An error comparison with \`==\` against a sentinel.** Replace with \`errors.Is\`. Same lint rule.

### Migration Lens

Coming from any other language, the slice-aliasing behaviour is the single most surprising thing about Go. Every other language with growable arrays gives you copy-on-write semantics by default. Go does not, and the trade is faster code with sharper edges. The map-iteration randomisation is the second most surprising thing. Pre-Go map iteration in C++, Java, Python (pre-3.7), and Ruby was implementation-defined but stable in practice, and many programs accidentally depended on a specific order. Go's randomisation makes the dependency impossible. Coming from Java, the nil-interface-vs-nil-pointer behaviour is the closest analogue to Java's \`null instanceof MyType\` returning false even when the variable holds a typed null. Coming from Rust, the lack of borrow checking on slices means the patterns Rust prevents at compile time become things you have to remember to do correctly in Go.

---
`;
