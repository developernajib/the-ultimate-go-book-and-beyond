## Question 5: defer, panic, recover

**Level**: Mid

**Question**: What does this code output? Explain defer execution order and when recover works.

```go
func main() {
    fmt.Println("Start:", test())
}

func test() (result string) {
    defer func() {
        result = "defer3: " + result
    }()

    defer func() {
        if r := recover(); r != nil {
            result = "recovered: " + fmt.Sprint(r)
        }
    }()

    defer func() {
        result = "defer1: " + result
    }()

    panic("something went wrong")

    return "normal"
}
```

**Answer**:

```
Start: defer3: recovered: something went wrong
```

**Explanation**:

Defer statements execute in **LIFO (Last In, First Out)** order. Here's the execution flow:

1. First defer registered: `result = "defer3: " + result`
2. Second defer registered: `recover()` handler
3. Third defer registered: `result = "defer1: " + result`
4. `panic("something went wrong")` occurs
5. **Defers execute in reverse order**:
 - Third defer runs: `result = "defer1: "` (result was "")
 - Second defer runs: `recover()` catches panic, `result = "recovered: something went wrong"`
 - First defer runs: `result = "defer3: recovered: something went wrong"`
6. Function returns normally (panic was recovered)

**Defer Execution Order**:

```go
func deferOrder() {
    defer fmt.Println("First")
    defer fmt.Println("Second")
    defer fmt.Println("Third")
}
// Output:
// Third
// Second
// First
```

Think of defers as a stack:

```
Push → [First]
Push → [Second, First]
Push → [Third, Second, First]
Pop  → Third
Pop  → Second
Pop  → First
```

**Defer Argument Evaluation**:

```go
func deferEval() {
    i := 0
    defer fmt.Println("Deferred:", i)  // Evaluates i NOW (0)
    i++
    fmt.Println("Before return:", i)
}
// Output:
// Before return: 1
// Deferred: 0

// To capture current value, use closure:
func deferEvalClosure() {
    i := 0
    defer func() {
        fmt.Println("Deferred:", i)  // Captures i reference
    }()
    i++
    fmt.Println("Before return:", i)
}
// Output:
// Before return: 1
// Deferred: 1
```

**recover() Rules**:

recover() only works when:
1. Called directly in a deferred function
2. During an active panic

```go
// ✓ WORKS: recover in defer
func works1() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("Recovered:", r)
        }
    }()
    panic("error")
}

// ✗ DOESN'T WORK: recover not in defer
func doesntWork1() {
    if r := recover(); r != nil {  // Always nil
        fmt.Println("Recovered:", r)
    }
    panic("error")
}

// ✓ WORKS: recover in directly deferred function
func works2() {
    defer helper()
    panic("error")
}

func helper() {
    if r := recover(); r != nil {  // Works: helper is the deferred function
        fmt.Println("Recovered:", r)
    }
}

// ✗ DOESN'T WORK: recover in function called by deferred function
func doesntWork2() {
    defer func() {
        helper2()  // recover() inside helper2 is not directly in the deferred function
    }()
    panic("error")
}

func helper2() {
    if r := recover(); r != nil {  // Won't catch: nested too deep
        fmt.Println("Recovered:", r)
    }
}
```

**defer with Named Returns**:

```go
func namedReturn() (result int) {
    defer func() {
        result++  // Modifies return value
    }()
    return 5  // Returns 6, not 5!
}

func anonymousReturn() int {
    result := 0
    defer func() {
        result++  // Doesn't affect return value
    }()
    return 5  // Returns 5
}
```

**Production Use Cases**:

```go
// 1. Resource cleanup
func readFile(filename string) ([]byte, error) {
    f, err := os.Open(filename)
    if err != nil {
        return nil, err
    }
    defer f.Close()  // Ensures file closes

    return io.ReadAll(f)
}

// 2. Mutex unlock
func updateCache(key string, value any) {
    cacheMu.Lock()
    defer cacheMu.Unlock()  // Ensures unlock even if panic

    cache[key] = value
}

// 3. Timing functions
func slowFunction() {
    defer track(time.Now(), "slowFunction")
    // ... work ...
}

func track(start time.Time, name string) {
    log.Printf("%s took %s", name, time.Since(start))
}

// 4. Panic recovery in HTTP handlers
func safeHandler(w http.ResponseWriter, r *http.Request) {
    defer func() {
        if err := recover(); err != nil {
            log.Printf("Panic in handler: %v", err)
            http.Error(w, "Internal Server Error", 500)
        }
    }()

    // Handler logic that might panic
}

// 5. Transaction rollback
func transferMoney(from, to string, amount int) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer func() {
        if err != nil {
            tx.Rollback()
        }
    }()

    if err := debit(tx, from, amount); err != nil {
        return err
    }
    if err := credit(tx, to, amount); err != nil {
        return err
    }

    return tx.Commit()
}
```

**Common Mistake - defer in loops**:

```go
// ✗ BAD: Defers accumulate
func processFiles(filenames []string) error {
    for _, name := range filenames {
        f, err := os.Open(name)
        if err != nil {
            return err
        }
        defer f.Close()  // Won't close until function returns!

        // Process file
    }
    return nil
}
// With 1000 files, you'll have 1000 open file handles!

// ✓ GOOD: Use a function
func processFiles(filenames []string) error {
    for _, name := range filenames {
        if err := processFile(name); err != nil {
            return err
        }
    }
    return nil
}

func processFile(name string) error {
    f, err := os.Open(name)
    if err != nil {
        return err
    }
    defer f.Close()  // Closes after each iteration

    // Process file
    return nil
}
```

**Companies that asked this**: Google, Uber, Netflix, Meta

---
