## Question 13: Select Statement

**Level**: Mid-Senior

**Question**: Explain the select statement. What does this code do?

```go
func main() {
    ch1 := make(chan string)
    ch2 := make(chan string)

    go func() {
        time.Sleep(1 * time.Second)
        ch1 <- "one"
    }()

    go func() {
        time.Sleep(2 * time.Second)
        ch2 <- "two"
    }()

    for i := 0; i < 2; i++ {
        select {
        case msg1 := <-ch1:
            fmt.Println("Received", msg1)
        case msg2 := <-ch2:
            fmt.Println("Received", msg2)
        }
    }
}
```

**Answer**:

```
Received one    (after 1 second)
Received two    (after 2 seconds)
```

**Explanation**:

The `select` statement lets a goroutine wait on multiple channel operations. It blocks until one case can proceed, then executes that case.

**Select Semantics**:

```go
select {
case v := <-ch1:
    // Executes if ch1 has value
case ch2 <- value:
    // Executes if ch2 ready to receive
case v, ok := <-ch3:
    // Executes if ch3 has value or is closed
default:
    // Executes immediately if no other case ready
}
```

**Random Selection** (when multiple cases ready):

```go
func main() {
    ch1 := make(chan string, 1)
    ch2 := make(chan string, 1)

    ch1 <- "one"
    ch2 <- "two"

    select {
    case msg := <-ch1:
        fmt.Println("ch1:", msg)
    case msg := <-ch2:
        fmt.Println("ch2:", msg)
    }
    // Output is random! Either "ch1: one" or "ch2: two"
}
```

**Timeout Pattern**:

```go
func doWorkWithTimeout() {
    result := make(chan string)

    go func() {
        time.Sleep(2 * time.Second)
        result <- "completed"
    }()

    select {
    case res := <-result:
        fmt.Println("Result:", res)
    case <-time.After(1 * time.Second):
        fmt.Println("Timeout!")
    }
}
// Output: Timeout!
```

**Non-blocking Send/Receive**:

```go
// Non-blocking send
select {
case ch <- value:
    fmt.Println("Sent")
default:
    fmt.Println("Channel full, dropped value")
}

// Non-blocking receive
select {
case v := <-ch:
    fmt.Println("Received:", v)
default:
    fmt.Println("Nothing to receive")
}
```

**Cancellation with Context**:

```go
func doWork(ctx context.Context) error {
    result := make(chan string)

    go func() {
        // Long-running work
        time.Sleep(5 * time.Second)
        result <- "done"
    }()

    select {
    case res := <-result:
        fmt.Println(res)
        return nil
    case <-ctx.Done():
        return ctx.Err()  // context.Canceled or context.DeadlineExceeded
    }
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
    defer cancel()

    if err := doWork(ctx); err != nil {
        fmt.Println("Error:", err)
    }
}
// Output: Error: context deadline exceeded
```

**Quit Channel Pattern**:

```go
func worker(quit <-chan struct{}) {
    for {
        select {
        case <-quit:
            fmt.Println("Worker stopping")
            return
        default:
            // Do work
            fmt.Println("Working...")
            time.Sleep(500 * time.Millisecond)
        }
    }
}

func main() {
    quit := make(chan struct{})

    go worker(quit)

    time.Sleep(2 * time.Second)
    close(quit)  // Signal worker to stop
    time.Sleep(100 * time.Millisecond)
}
```

**Fan-In Pattern** (merge multiple channels):

```go
func fanIn(ch1, ch2 <-chan string) <-chan string {
    out := make(chan string)

    go func() {
        defer close(out)
        for {
            select {
            case v, ok := <-ch1:
                if !ok {
                    ch1 = nil  // Disable this case
                    continue
                }
                out <- v
            case v, ok := <-ch2:
                if !ok {
                    ch2 = nil  // Disable this case
                    continue
                }
                out <- v
            }

            // Both channels closed
            if ch1 == nil && ch2 == nil {
                return
            }
        }
    }()

    return out
}
```

**Priority Select** (using nested selects):

```go
func prioritySelect(high, low <-chan string) {
    for {
        select {
        case msg := <-high:
            fmt.Println("High priority:", msg)
        default:
            select {
            case msg := <-high:
                fmt.Println("High priority:", msg)
            case msg := <-low:
                fmt.Println("Low priority:", msg)
            }
        }
    }
}
// High priority channel always checked first
```

**Common Mistakes**:

```go
// ✗ MISTAKE: time.After in loop causes memory leak
func leaky() {
    ch := make(chan int)
    for {
        select {
        case v := <-ch:
            process(v)
        case <-time.After(time.Second):  // Creates new timer each iteration!
            timeout()
        }
    }
}

// ✓ FIX: Create timer once
func fixed() {
    ch := make(chan int)
    timer := time.NewTimer(time.Second)
    defer timer.Stop()

    for {
        select {
        case v := <-ch:
            process(v)
            timer.Reset(time.Second)
        case <-timer.C:
            timeout()
            timer.Reset(time.Second)
        }
    }
}
```

**Empty Select** (blocks forever):

```go
func blockForever() {
    select {}  // Blocks forever
}

// Useful for keeping main alive:
func main() {
    go backgroundWorker()

    select {}  // Keep main from exiting
}
```

**Companies that asked this**: Google, Uber, Netflix, Meta, Stripe

---
