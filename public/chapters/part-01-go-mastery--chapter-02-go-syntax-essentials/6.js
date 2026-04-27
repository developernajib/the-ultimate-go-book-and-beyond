export default `## 2.3 Functions

### Basic Functions

Go functions declare their parameter types after the parameter names, and the return type comes last. Each function signature reads as a contract: what goes in, what comes out.

\`\`\`go
func greet(name string) string {
    return "Hello, " + name + "!"
}

func add(a int, b int) int {
    return a + b
}

// When parameters share a type, you can shorten:
func multiply(a, b int) int {
    return a * b
}
\`\`\`

### Multiple Return Values

This is one of Go's most distinctive features. Functions can return multiple values, and this is used everywhere, especially for error handling:

\`\`\`go
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("cannot divide by zero")
    }
    return a / b, nil
}

func main() {
    result, err := divide(10, 3)
    if err != nil {
        fmt.Println("Error:", err)
        return
    }
    fmt.Println("Result:", result)  // Result: 3.3333...
}
\`\`\`

If you don't need one of the return values, use the blank identifier \`_\`:

\`\`\`go
result, _ := divide(10, 3)  // Ignore the error (not recommended in production)
\`\`\`

### Named Return Values

You can name return values, which acts as documentation and allows "naked returns":

\`\`\`go
func split(sum int) (x, y int) {
    x = sum * 4 / 9
    y = sum - x
    return  // Returns x and y implicitly
}
\`\`\`

Use named returns for short functions where the meaning is clear. Avoid them in long functions. They make it hard to track what's being returned.

### Variadic Functions

Functions that accept any number of arguments:

\`\`\`go
func sum(numbers ...int) int {
    total := 0
    for _, n := range numbers {
        total += n
    }
    return total
}

func main() {
    fmt.Println(sum(1, 2, 3))       // 6
    fmt.Println(sum(1, 2, 3, 4, 5)) // 15
    
    nums := []int{10, 20, 30}
    fmt.Println(sum(nums...))        // 60: spread a slice with ...
}
\`\`\`

### Functions as Values

Functions in Go are first-class values. You can assign them to variables, pass them as arguments, and return them from other functions:

\`\`\`go
// Assign function to a variable
double := func(x int) int {
    return x * 2
}
fmt.Println(double(5))  // 10

// Pass function as argument
func apply(f func(int) int, value int) int {
    return f(value)
}
fmt.Println(apply(double, 7))  // 14
\`\`\`

### Defer

\`defer\` postpones a function call until the surrounding function returns. It's primarily used for cleanup:

\`\`\`go
func readFile(path string) error {
    file, err := os.Open(path)
    if err != nil {
        return err
    }
    defer file.Close()  // Guaranteed to run when readFile() returns
    
    // ... read from file ...
    // Even if an error occurs here, file.Close() will run
    return nil
}
\`\`\`

Deferred calls execute in LIFO (last-in, first-out) order:

\`\`\`go
defer fmt.Println("first")
defer fmt.Println("second")
defer fmt.Println("third")
// Output: third, second, first
\`\`\`

### Closures and Captured Variables

The function-as-value example above hides one of the most useful and most dangerous features in Go. A function literal can refer to variables from the enclosing scope, and those references are by reference, not by copy:

\`\`\`go
func makeCounter() func() int {
    count := 0
    return func() int {
        count++
        return count
    }
}

c := makeCounter()
c() // 1
c() // 2
c() // 3
\`\`\`

Each call to \`makeCounter\` produces a brand-new \`count\`, captured by the returned closure. Two separately-constructed counters do not share state. This is the standard idiom for stateful function objects in Go and it shows up in middleware, rate limiters, and test fixtures throughout the standard library.

The dangerous corner of closures was the loop-variable bug that bit Go programmers for over a decade. Pre-Go 1.22, this code printed \`3 3 3\` instead of \`0 1 2\`:

\`\`\`go
for i := 0; i < 3; i++ {
    go func() { fmt.Println(i) }()
}
\`\`\`

Because every goroutine captured the same \`i\`. Go 1.22 (released February 2024) changed the loop semantics so that \`i\` is per-iteration, and the snippet now prints \`0 1 2\` in some order. If your team is on Go 1.22 or newer the bug is gone. If you maintain code that targets \`go 1.21\` or earlier in \`go.mod\`, the old semantics still apply, and you must capture explicitly with \`i := i\` inside the loop body. This is the kind of nuance a senior reviewer catches that a junior would not, and it is a popular phone-screen question precisely because it tests whether the candidate has tracked Go's evolution.

### \`defer\` Has Three Sharp Edges

\`defer\` is one of Go's most beloved features and it has three corners that catch even experienced engineers:

1. **Arguments are evaluated at the \`defer\` line, not at execution time.** \`defer fmt.Println(time.Now())\` captures \`time.Now()\` at the moment the \`defer\` is reached, not when the deferred call runs. If you want the value at execution time, wrap in a closure: \`defer func() { fmt.Println(time.Now()) }()\`.
2. **Deferred calls in long-running loops accumulate.** A function that opens 10,000 files and writes \`defer f.Close()\` inside the loop holds 10,000 file descriptors open until the function returns, often exhausting the OS limit. The fix is to extract the per-iteration body into a helper function so the defer fires per iteration.
3. **\`defer\` has a non-zero cost.** It is small (around 10ns per call on a 2026-era CPU after the inlining improvements that landed in Go 1.14 and were tightened further through 1.21) but in a tight inner loop measured in millions of operations per second, even that adds up. The runtime team has progressively shrunk the cost over the years and the gap between deferred-cleanup and manual-cleanup is now small enough to ignore in almost all practical code, but the pattern of "open-and-defer-close in a million-iteration loop" still shows up in profiles. Move the defer to the per-iteration helper, not the outer loop.

### Functions Are Not Methods

Go has both functions and methods, and the distinction matters at the language level. A function lives at package scope and is called as \`pkg.Func(args)\`. A method has a receiver and is called as \`value.Method(args)\`. We get to methods properly in Section 2.6, but the relevant point for a function chapter is that you cannot freely add methods to types you do not own. You can write a free function \`func ProcessOrder(o Order) error\` that takes any type, but you cannot write \`func (o ExternalType) Process()\` against a type defined in another package. This is a deliberate language constraint and it is the lever Go uses to keep interfaces and types decoupled. Engineers from Ruby, Swift, or C# (where extension methods, monkey-patching, or category-style additions are routine) need to internalise this early.

### Variadic Argument Allocation

The variadic parameter \`...int\` is implemented as a slice. Every call site to a variadic function with at least one argument allocates a backing array unless the compiler can prove the slice does not escape. For hot-path code, prefer a slice parameter \`func sum(numbers []int) int\` and let the caller allocate once and reuse. This is the kind of micro-optimisation you reach for only when pprof flags it, but it is worth knowing at the senior-track level because variadic-in-a-hot-loop is a recurring pattern in performance regressions.

### Code-Review Lens (Senior Track)

Three things a staff reviewer scans for in any function-heavy PR:

1. **Functions over five parameters.** Past five parameters, callers struggle to keep argument order straight, and the function is almost always doing more than one thing. The fix is one of: introduce a struct to hold related parameters (often called an "options struct" or "request struct"), split the function into two, or use the functional-options pattern (see Chapter 9). Five is not a hard rule. It is a smell threshold.
2. **Boolean parameters.** \`func send(msg string, async bool, retry bool)\` reads horribly at the call site as \`send("hi", true, false)\`, where the reader has to look up which \`true\` and which \`false\` is which. Replace booleans with named types (\`type Mode int\` plus \`const (Async Mode = iota; Sync)\`) or split into two functions (\`SendAsync\` and \`Send\`). This is one of the most common code-review findings on Go PRs across the industry, and it is worth catching early.
3. **Naked returns past three lines.** Named returns plus \`return\` (with no values) is concise for short helpers. In a 30-line function with three exits, the naked return is invisible at the bottom and reviewers cannot tell what is being returned without scrolling up. The rule is simple. If the function fits on one screen with no scrolling, naked returns are fine. Otherwise, return the values explicitly.

### Migration Lens

Coming from Python, the absence of default parameter values feels punitive. Go has no \`def fn(x, y=10)\`. The idiomatic replacement is the functional-options pattern (covered in Chapter 9) or, for simple cases, an options struct passed by value. Coming from JavaScript, the absence of optional parameters and overloading similarly feels restrictive. The Go answer is the same: model your variants explicitly. Coming from C++ or Java where overloading is routine, you will write \`SendString(s string)\` and \`SendBytes(b []byte)\` as two separate functions. This is a feature, not a limitation, because the call site tells the reader which overload is being invoked without IDE help.
`;
