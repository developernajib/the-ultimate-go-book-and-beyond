## 2.4 Control Flow

### If/Else

Go's `if` doesn't use parentheses around conditions, but braces are always required:

```go
age := 25

if age >= 18 {
    fmt.Println("Adult")
} else if age >= 13 {
    fmt.Println("Teenager")
} else {
    fmt.Println("Child")
}
```

**Init statement**: You can declare a variable scoped to the if block:

```go
if err := doSomething(); err != nil {
    fmt.Println("Error:", err)
    return
}
// err is not accessible here: it only exists inside the if block
```

This pattern is extremely common in Go. You'll see it hundreds of times throughout this book.

### For Loop

Go has only one looping construct: `for`. But it covers every case:

```go
// Classic C-style for
for i := 0; i < 10; i++ {
    fmt.Println(i)
}

// While loop (just a for with only a condition)
count := 0
for count < 5 {
    fmt.Println(count)
    count++
}

// Infinite loop
for {
    fmt.Println("forever")
    break  // Use break to exit
}

// Range loop: iterate over slices, maps, strings, channels
numbers := []int{10, 20, 30}
for index, value := range numbers {
    fmt.Printf("Index %d: %d\n", index, value)
}

// Ignore the index
for _, value := range numbers {
    fmt.Println(value)
}

// Ignore the value (just count)
for index := range numbers {
    fmt.Println(index)
}
```

There is no `while` keyword in Go. `for` does everything.

### Switch

Go's switch is cleaner than most languages. No `break` is needed because cases don't fall through by default:

```go
day := "Monday"

switch day {
case "Monday":
    fmt.Println("Start of the week")
case "Friday":
    fmt.Println("Almost weekend")
case "Saturday", "Sunday":
    fmt.Println("Weekend!")
default:
    fmt.Println("Midweek")
}
```

**Switch without a condition**: acts like a clean if/else chain:

```go
hour := 15

switch {
case hour < 12:
    fmt.Println("Good morning")
case hour < 17:
    fmt.Println("Good afternoon")
default:
    fmt.Println("Good evening")
}
```

**Type switch**: check the concrete type of an interface:

```go
func describe(val any) {  // `any` is the Go 1.18+ alias for interface{}
    switch v := val.(type) {
    case int:
        fmt.Printf("Integer: %d\n", v)
    case string:
        fmt.Printf("String: %s\n", v)
    case bool:
        fmt.Printf("Boolean: %t\n", v)
    default:
        fmt.Printf("Unknown type: %T\n", v)
    }
}
```

### Break, Continue, and Labels

```go
// break exits the innermost loop
for i := 0; i < 10; i++ {
    if i == 5 {
        break  // Stop the loop entirely
    }
}

// continue skips to the next iteration
for i := 0; i < 10; i++ {
    if i%2 == 0 {
        continue  // Skip even numbers
    }
    fmt.Println(i)  // Only prints odd: 1, 3, 5, 7, 9
}

// Labels: break out of nested loops
outer:
    for i := 0; i < 3; i++ {
        for j := 0; j < 3; j++ {
            if i == 1 && j == 1 {
                break outer  // Breaks BOTH loops
            }
        }
    }
```

### Range-Over-Function (Go 1.23)

Go 1.23 (released August 2024) added new forms of `range`. You can now `range` over a function that yields values, opening the door to user-defined iterators that look exactly like ranging over a slice or map. The signatures come in three shapes, `func(yield func() bool)`, `func(yield func(V) bool)`, and `func(yield func(K, V) bool)`. The runtime calls your function, your function calls `yield` for each item, and the loop body runs each time `yield` is called. If the loop body breaks early, `yield` returns false and your iterator stops. The standard library has begun adopting this in `maps.Keys`, `maps.Values`, `slices.All`, and similar helpers added or stabilized in 1.23 and 1.24:

```go
import "maps"

m := map[string]int{"a": 1, "b": 2, "c": 3}
for k, v := range maps.All(m) {
    fmt.Println(k, v)
}
```

Adoption has grown steadily since 1.23, and the standard library now exposes its own iteration helpers this way, so iterators are the norm rather than the novelty in 2026. For interview purposes, know the signature and be able to sketch a paginated iterator. For day-to-day code, prefer `iter.Seq`-based APIs when designing new sequence-producing functions, and reserve channel-based iteration for producers that are genuinely concurrent.

### Loop-Variable Scope (the 1.22 Change)

Before Go 1.22, the loop variable in `for i := range xs` was a single variable reused across iterations. After 1.22, it is a fresh variable per iteration when the module's `go` directive is `1.22` or higher. The practical impact is that the closure-capture footgun shown in Section 2.3 is gone for new code:

```go
// Pre-1.22: prints 3 3 3 (one shared i)
// 1.22+:    prints 0 1 2 in some order (one i per iteration)
for i := 0; i < 3; i++ {
    go func() { fmt.Println(i) }()
}
```

Two implications a senior reviewer will check:

1. **Reading old code requires knowing which Go version it was written for.** A loop in a library with `go 1.20` in its `go.mod` still has the old semantics, even when compiled by a 1.27 toolchain. The fix is to either bump the module's `go` directive (after auditing) or capture explicitly with `i := i`.
2. **Performance-conscious code that previously relied on the shared variable.** A vanishingly small number of programs deliberately captured the post-loop value of `i`. If yours did, the upgrade silently changes behavior. Run your tests.

### `for range` Over an Integer (Go 1.22)

Go 1.22 also added the ability to range over an integer literal directly:

```go
for i := range 10 {
    fmt.Println(i) // 0 through 9
}
```

This is purely cosmetic but it removes the noise of `for i := 0; i < 10; i++` for the common case of "do this N times". It is the kind of change that looks trivial until you have read enough Go to realize how many `for i := 0; i < N; i++` lines you have written.

### `switch` Is Not C's `switch`

Three differences from C-family languages that every newcomer must internalize:

1. **No fall-through by default.** If you want C-style fall-through, write `fallthrough` explicitly. The default of "one case, one branch, no break needed" eliminates the entire class of "I forgot the break" bugs that haunt C and JavaScript.
2. **Cases can be expressions, not just constants.** A `switch` without an expression evaluates each `case` as a boolean condition, replacing long `if/else if/else` chains in idiomatic Go.
3. **Type switch is a first-class construct.** The `switch v := i.(type)` form has no equivalent in most other languages without reflection. It is the safe, fast, idiomatic way to dispatch on the dynamic type of an `any` (or `interface{}`) value, and the compiler dispatches it using cheap comparisons on the value's type descriptor, not by attempting each assertion in turn.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in control-flow-heavy code:

1. **Deep nesting.** Three levels of `if` inside a `for` inside an `if` is almost always refactorable into early returns or guard clauses. The Go community-wide convention is "happy path on the left, error returns on the right", which means error checks should be `if err != nil { return ... }` followed by the success path at zero indentation, not nested inside an `else` branch.
2. **`switch` chains that are really enum dispatch.** When a `switch` on a string or int has more than three cases, the underlying type usually wants to be a named enum. Promote `string` to `type Status string` plus typed constants, then the `switch` becomes type-checked rather than string-matched, and the `default` branch can be a `panic("exhaustiveness violation")` or, better, caught by a linter like `exhaustive` or `enumcheck`.
3. **Labels other than for break-from-nested-loop.** Labels in Go are strictly scoped and have one legitimate use, which is breaking out of nested loops. Any other use (especially `goto`, which Go retains for code generation) deserves a comment explaining why the structured alternative does not work.

### Migration Lens

Coming from Python, the absence of a `while` loop is the single biggest visual surprise. The replacement is `for cond { ... }`, which reads identically once your eyes adjust. Coming from JavaScript, the `for...of` and `for...in` distinction collapses into a single `for ... range`, which iterates by index-and-value for slices, key-and-value for maps, byte-index-and-rune for strings, and value-only for channels. There is one syntax to learn and four behaviors, and the behavior is determined by the type, not by a separate keyword. Coming from Java's enhanced for loop, `for _, item := range items` is the direct translation, with the explicit `_` reminding you that the index exists and you are deliberately discarding it.
