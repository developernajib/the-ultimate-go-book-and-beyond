## Control Flow

Go keeps control flow simple and readable. The `if` statement supports an optional initialization clause, and `for` is the only loop keyword in the language, it covers traditional loops, while-style loops, and infinite loops. The `switch` statement does not fall through by default (unlike C), making it safer. Go also provides `select` for multiplexing channel operations, `defer` for cleanup that runs when a function returns, and `panic`/`recover` for handling truly exceptional situations.

```go
// If statement
if x > 0 {
    // ...
}

if x > 0 {
    // ...
} else {
    // ...
}

if x > 0 {
    // ...
} else if x < 0 {
    // ...
} else {
    // ...
}

// If with initialization
if err := doSomething(); err != nil {
    return err
}

if value, ok := m[key]; ok {
    // use value
}

// For loop (only loop in Go)
for i := 0; i < 10; i++ {
    // ...
}

// While-style loop
for condition {
    // ...
}

// Infinite loop
for {
    // ...
    if done {
        break
    }
}

// Range loop (arrays, slices)
for index, value := range slice {
    // ...
}

// Range loop (maps)
for key, value := range myMap {
    // ...
}

// Range loop (strings - iterates over runes)
for index, runeValue := range "Hello, 世界" {
    // ...
}

// Range loop (channels)
for value := range channel {
    // ...
}

// Ignore index/key
for _, value := range slice {
    // ...
}

// Just index/key
for index := range slice {
    // ...
}

// Continue and break
for i := 0; i < 10; i++ {
    if i%2 == 0 {
        continue  // Skip to next iteration
    }
    if i > 7 {
        break     // Exit loop
    }
}

// Labels with break/continue
outer:
for i := 0; i < 3; i++ {
    for j := 0; j < 3; j++ {
        if condition {
            break outer
        }
    }
}

// Switch statement
switch value {
case 1:
    // ...
case 2, 3, 4:
    // ...
default:
    // ...
}

// Switch with initialization
switch value := getValue(); value {
case 1:
    // ...
}

// Switch without condition (replaces if-else chains)
switch {
case x < 0:
    // ...
case x == 0:
    // ...
default:
    // ...
}

// Type switch
switch v := i.(type) {
case int:
    // v is int
case string:
    // v is string
case bool, float64:
    // v is any
default:
    // v is any
}

// Fallthrough (rarely used)
switch value {
case 1:
    // ...
    fallthrough
case 2:
    // Executes even if value == 1
}

// Select (for channels)
select {
case msg := <-ch1:
    // Received from ch1
case msg := <-ch2:
    // Received from ch2
case ch3 <- value:
    // Sent to ch3
default:
    // Non-blocking, executes if no channel ready
}

// Defer
defer cleanup()  // Executes when function returns
defer func() {
    if r := recover(); r != nil {
        log.Println("Recovered:", r)
    }
}()

// Panic and recover
panic("something went wrong")

// Goto (discouraged)
goto label
// ...
label:
    // ...
```

---
