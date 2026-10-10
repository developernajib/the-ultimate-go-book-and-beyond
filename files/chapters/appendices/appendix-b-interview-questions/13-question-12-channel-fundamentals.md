## Question 12: Channel Fundamentals

**Level**: Mid

**Question**: What's the difference between buffered and unbuffered channels? What does this code do?

```go
func main() {
    // Unbuffered
    ch1 := make(chan int)

    // Buffered
    ch2 := make(chan int, 2)

    // Test unbuffered
    go func() {
        ch1 <- 1
        fmt.Println("Sent to ch1")
    }()

    time.Sleep(10 * time.Millisecond)
    fmt.Println("Receiving from ch1:", <-ch1)

    // Test buffered
    ch2 <- 1
    fmt.Println("Sent to ch2 (1)")
    ch2 <- 2
    fmt.Println("Sent to ch2 (2)")

    fmt.Println("Receiving from ch2:", <-ch2)
    fmt.Println("Receiving from ch2:", <-ch2)
}
```

**Answer**:

```
Receiving from ch1: 1
Sent to ch1
Sent to ch2 (1)
Sent to ch2 (2)
Receiving from ch2: 1
Receiving from ch2: 2
```

**Explanation**:

**Unbuffered Channel** (`make(chan T)`):
- Send blocks until receive ready
- Receive blocks until send ready
- Synchronization point
- Capacity = 0

**Buffered Channel** (`make(chan T, n)`):
- Send blocks only when buffer full
- Receive blocks only when buffer empty
- No synchronization unless buffer full
- Capacity = n

**Visual Representation**:

```
Unbuffered channel:
┌──────┐              ┌──────┐
│ Send │─────────────►│ Recv │
└──────┘              └──────┘
  Blocks until receiver ready

Buffered channel (size 2):
┌──────┐    ┌───┬───┐    ┌──────┐
│ Send │───►│ 1 │ 2 │───►│ Recv │
└──────┘    └───┴───┘    └──────┘
  Can send 2 values before blocking
```

**Unbuffered Example - Synchronization**:

```go
func main() {
    done := make(chan bool)  // Unbuffered

    go func() {
        fmt.Println("Working...")
        time.Sleep(time.Second)
        done <- true  // Blocks until main receives
        fmt.Println("Sent done")
    }()

    <-done  // Blocks until goroutine sends
    fmt.Println("Received done")
}

// Output:
// Working...
// Received done
// Sent done
```

**Buffered Example - Decoupling**:

```go
func main() {
    ch := make(chan int, 3)

    // Send 3 values (doesn't block)
    ch <- 1
    ch <- 2
    ch <- 3
    fmt.Println("Sent 3 values")

    // Send 4th value (would block!)
    // ch <- 4  // deadlock

    // Receive values
    fmt.Println(<-ch)  // 1
    fmt.Println(<-ch)  // 2
    fmt.Println(<-ch)  // 3
}

// Output:
// Sent 3 values
// 1
// 2
// 3
```

**Channel Operations**:

```go
// Send
ch <- value

// Receive
value := <-ch

// Receive and discard
<-ch

// Close
close(ch)

// Check if closed (receive with ok)
value, ok := <-ch
if !ok {
    // Channel closed
}

// Range over channel (receives until closed)
for value := range ch {
    fmt.Println(value)
}
```

**Closing Channels**:

```go
func main() {
    ch := make(chan int, 2)

    // Send values
    ch <- 1
    ch <- 2
    close(ch)  // Close channel

    // Can still receive remaining values
    fmt.Println(<-ch)  // 1
    fmt.Println(<-ch)  // 2

    // Receive from closed channel returns zero value
    fmt.Println(<-ch)  // 0

    // Check if closed
    val, ok := <-ch
    fmt.Println(val, ok)  // 0 false

    // Send to closed channel panics!
    // ch <- 3  // panic: send on closed channel

    // Close already closed channel panics!
    // close(ch)  // panic: close of closed channel
}
```

**Production Pattern - Producer/Consumer**:

```go
// Producer
func produce(ch chan<- int) {  // Send-only channel
    defer close(ch)

    for i := 0; i < 10; i++ {
        ch <- i
    }
}

// Consumer
func consume(ch <-chan int) {  // Receive-only channel
    for val := range ch {
        fmt.Println("Consumed:", val)
    }
}

func main() {
    ch := make(chan int, 5)  // Buffer size = 5

    go produce(ch)
    consume(ch)
}
```

**Channel Direction**:

```go
// Bidirectional (default)
var ch chan int = make(chan int)

// Send-only
var sendOnly chan<- int = ch
sendOnly <- 1
// <-sendOnly  // Compile error

// Receive-only
var recvOnly <-chan int = ch
val := <-recvOnly
// recvOnly <- 1  // Compile error
```

**Buffer Size Selection**:

```go
// Unbuffered: Use when you need synchronization
done := make(chan struct{})  // Signal channel

// Buffer = 1: Use for "non-blocking" send once
results := make(chan Result, 1)

// Buffer = N: Use when you know burst size
events := make(chan Event, 100)

// Large buffer: Use for high-throughput
logs := make(chan LogEntry, 10000)

// Don't use huge buffers to "fix" design issues!
// If buffer keeps growing, you have backpressure problem
```

**Deadlock Example**:

```go
// ✗ DEADLOCK: Unbuffered send with no receiver
func deadlock1() {
    ch := make(chan int)
    ch <- 1  // Blocks forever
    <-ch
}

// ✗ DEADLOCK: Unbuffered receive with no sender
func deadlock2() {
    ch := make(chan int)
    <-ch  // Blocks forever
}

// ✗ DEADLOCK: Both goroutines waiting
func deadlock3() {
    ch1 := make(chan int)
    ch2 := make(chan int)

    go func() {
        <-ch1  // Waits for ch1
        ch2 <- 1
    }()

    <-ch2  // Waits for ch2, but goroutine waiting for ch1!
    ch1 <- 1
}

// ✓ FIX: Use buffered channel or separate goroutines
func fixed() {
    ch1 := make(chan int, 1)  // Buffered
    ch2 := make(chan int, 1)

    go func() {
        <-ch1
        ch2 <- 1
    }()

    ch1 <- 1
    <-ch2
}
```

**Nil Channel Behavior**:

```go
var ch chan int  // nil channel

// Send to nil channel blocks forever
go func() {
    ch <- 1  // Blocks forever
}()

// Receive from nil channel blocks forever
go func() {
    <-ch  // Blocks forever
}()

// Close nil channel panics
// close(ch)  // panic: close of nil channel

// Select case with nil channel is ignored
select {
case ch <- 1:  // Never executes
case <-ch:     // Never executes
default:
    fmt.Println("This runs")
}
```

**Companies that asked this**: Google, Uber, Stripe, Netflix, Meta

---
