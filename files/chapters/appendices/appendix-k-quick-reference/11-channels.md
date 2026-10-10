## Channels

Channels are Go's primary mechanism for communication between goroutines, following the philosophy "share memory by communicating." Unbuffered channels block the sender until the receiver is ready, providing natural synchronization. Buffered channels allow sending without blocking until the buffer is full. Use directional channel types (`chan<-` for send-only, `<-chan` for receive-only) in function signatures to make your intent clear and let the compiler catch mistakes.

```go
// Create channel
ch := make(chan int)           // Unbuffered
ch := make(chan int, 10)       // Buffered (capacity 10)

// Send
ch <- 42

// Receive
value := <-ch
<-ch  // Receive and discard

// Close
close(ch)

// Check if closed
value, ok := <-ch
if !ok {
    // Channel closed
}

// Range over channel
for value := range ch {
    // Exits when channel closed
}

// Select
select {
case msg := <-ch1:
    // Received from ch1
case msg := <-ch2:
    // Received from ch2
case ch3 <- value:
    // Sent to ch3
default:
    // Non-blocking
}

// Timeout pattern
select {
case msg := <-ch:
    // Received
case <-time.After(5 * time.Second):
    // Timeout
}

// Done channel pattern
done := make(chan struct{})
go func() {
    // Do work
    done <- struct{}{}
}()
<-done  // Wait for completion

// Or with close
done := make(chan struct{})
go func() {
    defer close(done)
    // Do work
}()
<-done  // Wait for completion

// Channel direction
func send(ch chan<- int) {   // Send-only
    ch <- 42
}

func receive(ch <-chan int) {  // Receive-only
    value := <-ch
}

// Nil channel
var ch chan int  // nil
<-ch             // Blocks forever
ch <- 1          // Blocks forever

// Closed channel
ch := make(chan int)
close(ch)
<-ch     // Returns zero value immediately
ch <- 1  // PANIC!

// Buffered channel behavior
ch := make(chan int, 2)
ch <- 1  // Doesn't block
ch <- 2  // Doesn't block
ch <- 3  // Blocks until receive

// Fan-out pattern
func fanOut(in <-chan int, workers int) []<-chan int {
    channels := make([]<-chan int, workers)
    for i := 0; i < workers; i++ {
        channels[i] = worker(in)
    }
    return channels
}

// Fan-in pattern
func fanIn(channels ...<-chan int) <-chan int {
    out := make(chan int)
    var wg sync.WaitGroup
    for _, ch := range channels {
        wg.Add(1)
        go func(c <-chan int) {
            defer wg.Done()
            for v := range c {
                out <- v
            }
        }(ch)
    }
    go func() {
        wg.Wait()
        close(out)
    }()
    return out
}

// Pipeline pattern
func gen(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}

func sq(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            out <- n * n
        }
    }()
    return out
}

// Use: for n := range sq(sq(gen(2, 3))) { }

// Semaphore pattern
sem := make(chan struct{}, maxConcurrent)
for _, item := range items {
    sem <- struct{}{}  // Acquire
    go func(item Item) {
        defer func() { <-sem }()  // Release
        process(item)
    }(item)
}
// Drain
for i := 0; i < maxConcurrent; i++ {
    sem <- struct{}{}
}
```

---
