export default `## 3.5 Control Flow

Go's control flow statements look familiar but have differences that trip up experienced developers. The \`if\` statement supports inline initialization, \`switch\` does not fall through by default, and \`for\` is the only loop keyword. These small changes reduce common bug categories at the cost of some initial adjustment.

### If with Initialization

Go's \`if\` statement accepts an optional initialization clause before the condition, separated by a semicolon. Variables declared in this clause are scoped to the entire \`if\`-\`else\` chain and are not visible outside it:

\`\`\`go
if err := doSomething(); err != nil {
    // err is scoped to this if-else block
    return err
}
// err is not accessible here

// Also works with ok pattern
if value, ok := cache.Get(key); ok {
    return value
}
// value and ok not accessible here
\`\`\`

This pattern keeps error variables scoped tightly.

### Switch without Break

Unlike C, C++, and Java, Go's \`switch\` does not fall through to the next case by default. Each case body has an implicit \`break\`, so you never need to write one:

\`\`\`go
switch day {
case "Saturday", "Sunday":  // Multiple values
    fmt.Println("Weekend!")
case "Friday":
    fmt.Println("TGIF!")
default:
    fmt.Println("Weekday")
}
\`\`\`

Use \`fallthrough\` when you want C-style behavior:

\`\`\`go
switch n {
case 1:
    fmt.Println("one")
    fallthrough
case 2:
    fmt.Println("two or followed from one")
}
\`\`\`

### Expression-less Switch

A \`switch\` with no expression evaluates each case condition as a boolean, producing a cleaner alternative to long \`if\`-\`else\` chains:

\`\`\`go
// Instead of this
if score >= 90 {
    grade = "A"
} else if score >= 80 {
    grade = "B"
} else if score >= 70 {
    grade = "C"
} else {
    grade = "F"
}

// Do this
switch {
case score >= 90:
    grade = "A"
case score >= 80:
    grade = "B"
case score >= 70:
    grade = "C"
default:
    grade = "F"
}
\`\`\`

### Type Switches

A type switch branches on the dynamic type stored inside an interface value. The \`v.(type)\` syntax extracts the concrete type, and each case binds the value to a variable of that specific type:

\`\`\`go
func describe(v any) {
    switch x := v.(type) {
    case int:
        fmt.Printf("int: %d\\n", x)
    case string:
        fmt.Printf("string: %q\\n", x)
    case bool:
        fmt.Printf("bool: %t\\n", x)
    case []int:
        fmt.Printf("[]int with %d elements\\n", len(x))
    case nil:
        fmt.Println("nil")
    default:
        fmt.Printf("unknown type: %T\\n", x)
    }
}
\`\`\`

### For Loop Variations

Go uses \`for\` as its only loop keyword. There is no \`while\` or \`do-while\`. The \`for\` keyword covers every looping pattern through different syntax forms:

\`\`\`go
// Traditional
for i := 0; i < 10; i++ {
    fmt.Println(i)
}

// While-style
for condition {
    // loop while condition is true
}

// Infinite
for {
    // break or return to exit
}

// Range over slice
for i, v := range slice {
    fmt.Println(i, v)
}

// Range over map
for k, v := range m {
    fmt.Println(k, v)
}

// Range over string (runes!)
for i, r := range "Hello, 世界" {
    fmt.Printf("%d: %c\\n", i, r)
}

// Range over channel
for msg := range ch {
    fmt.Println(msg)
}

// Range over int (Go 1.22+)
for i := range 10 {
    fmt.Println(i)  // 0 through 9
}

// Range over func (Go 1.23+)
for v := range myIterator {
    fmt.Println(v)
}
\`\`\`

### Loop Variable Scoping (Go 1.22+)

Before Go 1.22, the loop variable in \`for i := 0; i < n; i++\` and \`for k, v := range xs\` was a single variable reused across iterations. After Go 1.22 (when the module's \`go\` directive is \`1.22\` or higher), the variable is fresh per iteration. This fixed a class of long-standing bugs that bit every Go programmer at least once:

\`\`\`go
// Pre-1.22: every goroutine prints the same value (often N, the post-loop value)
// 1.22+:    every goroutine prints its own iteration value
for i := 0; i < 3; i++ {
    go func() { fmt.Println(i) }()
}
\`\`\`

The senior-track corollary: when reading code in a library that pins \`go 1.20\` in its \`go.mod\`, the old semantics still apply. Code review across mixed-version modules has to keep the rule in mind.

### Pattern: Early Return Over Nested If

Idiomatic Go puts the happy path on the left and error returns on the right:

\`\`\`go
// Idiomatic
func handle(req *Request) error {
    if err := validate(req); err != nil {
        return fmt.Errorf("validate: %w", err)
    }
    user, err := load(req.UserID)
    if err != nil {
        return fmt.Errorf("load user: %w", err)
    }
    return process(user, req)
}

// Anti-pattern: nested ifs
func handle(req *Request) error {
    if err := validate(req); err == nil {
        if user, err := load(req.UserID); err == nil {
            return process(user, req)
        } else {
            return err
        }
    } else {
        return err
    }
}
\`\`\`

The nested form is what engineers from languages with deep \`try\` blocks reach for instinctively. The idiomatic form is what every Go reviewer expects. The unwritten rule is: if you find yourself writing an \`else\` branch that contains a \`return\`, restructure as early returns.

### Switch as Dispatch

The expression-less \`switch\` is the idiomatic Go replacement for \`if/else if/else\` chains and for the visitor pattern in OO languages. The type switch is the idiomatic replacement for \`instanceof\` chains. Both are first-class language constructs, not just sugar:

\`\`\`go
// Type switch as dispatcher
func process(v any) (string, error) {
    switch x := v.(type) {
    case *http.Request:
        return processRequest(x)
    case *http.Response:
        return processResponse(x)
    case error:
        return "", x  // propagate
    case nil:
        return "", errors.New("nil input")
    default:
        return "", fmt.Errorf("unsupported type: %T", x)
    }
}
\`\`\`

Two senior-track rules:

1. **Always include a \`default\` case in a type switch.** The compiler does not enforce exhaustiveness on type switches over interfaces (because the set of implementations is open), so the \`default\` is the only way to handle "the caller passed something I did not anticipate". Without it, the function silently returns the zero values of its return types when an unexpected type comes in.
2. **For string and int switches with a closed set of values, use a linter to enforce exhaustiveness.** The \`exhaustive\` analyser from \`nishanths/exhaustive\` is the standard choice. It catches the case where someone adds a new \`Status\` constant and forgets to add a switch arm.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in control-flow PRs:

1. **A \`for\` loop with an explicit counter that should be a \`range\`.** \`for i := 0; i < len(xs); i++ { x := xs[i]; ... }\` is rarely what you want. \`for i, x := range xs { ... }\` is shorter and faster (the compiler avoids the bounds check on the indexed access).
2. **A long \`if/else if\` chain that should be a \`switch\`.** Past three branches, the chain is harder to read than a \`switch\`. The conversion is mechanical and the \`gofmt\`-aligned \`case\` lines read better.
3. **A \`for\` loop that hides a goroutine leak.** A loop that spawns goroutines without a coordinated shutdown (no \`sync.WaitGroup\`, no \`errgroup\`, no \`context.Context\`) is a goroutine leak waiting to happen. The pattern is acceptable in \`main\` for one-off setup. In a long-lived service it is a bug.

### Migration Lens

Coming from C, C++, or Java, the absence of fall-through by default is the biggest behaviour change in \`switch\`. Coming from Python, the absence of \`while\` and \`do-while\` and the unification under \`for\` is initially confusing and quickly comfortable. Coming from JavaScript, the loop-variable-per-iteration semantics introduced in Go 1.22 align Go with what JavaScript's \`let\` already provides, so the corner case that bit every Go programmer is now familiar to JS engineers as well. Coming from Rust, the lack of pattern matching with payloads is the biggest gap, and the workaround is interface-based dispatch plus type switches, which is more verbose than Rust's \`match\` but covers the same ground.

---
`;
