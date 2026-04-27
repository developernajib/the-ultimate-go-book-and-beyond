export default `## 11.3 Channels

Channels are typed conduits for communication between goroutines. They're the primary mechanism for goroutine coordination in Go.

### Channel Semantics

Channels support four operations: creation with \`make\`, sending with \`<-\` on the right, receiving with \`<-\` on the left, and closing with \`close\`. The second return value on a receive indicates whether the channel is still open, which is how consumers detect that the sender has finished.

\`\`\`go
// Channel operations
ch := make(chan int)     // Create unbuffered channel
ch := make(chan int, 10) // Create buffered channel with capacity 10

ch <- value              // Send value to channel
value := <-ch            // Receive value from channel
value, ok := <-ch        // Receive with closed check

close(ch)                // Close channel (only sender should do this)
\`\`\`

### Unbuffered Channels: Synchronization Points

Unbuffered channels provide **synchronous** communication, a send blocks until a receiver is ready, and vice versa:

\`\`\`go
func main() {
    ch := make(chan string)  // Unbuffered

    go func() {
        fmt.Println("Goroutine: about to send")
        ch <- "hello"  // Blocks until main receives
        fmt.Println("Goroutine: sent")
    }()

    time.Sleep(time.Second)  // Demonstrate blocking

    fmt.Println("Main: about to receive")
    msg := <-ch  // Unblocks the sender
    fmt.Println("Main: received", msg)
}

// Output:
// Goroutine: about to send
// Main: about to receive
// Goroutine: sent
// Main: received hello
\`\`\`

Unbuffered channels create a **rendezvous point** - both parties must be present for communication to occur.

### Buffered Channels: Decoupling

Buffered channels allow sends to proceed without a receiver (up to the buffer capacity):

\`\`\`go
func main() {
    ch := make(chan int, 3)  // Buffer capacity 3

    // Send without blocking (buffer has space)
    ch <- 1
    ch <- 2
    ch <- 3
    fmt.Println("Sent 3 values without blocking")

    // Fourth send would block
    // ch <- 4  // Would block until someone receives

    // Receive values
    fmt.Println(<-ch)  // 1
    fmt.Println(<-ch)  // 2
    fmt.Println(<-ch)  // 3
}
\`\`\`

### Buffer Sizing Guidelines

| Buffer Size | Use Case | Example |
|-------------|----------|---------|
| 0 (unbuffered) | Synchronization | Signaling completion |
| 1 | Handoff with decoupling | Latest value pattern |
| Small (5-100) | Smooth producer/consumer | Request queue |
| Large (1000+) | High-throughput batch | Log processing |

\`\`\`go
// Unbuffered: synchronization signal
done := make(chan struct{})
go func() {
    doWork()
    close(done)  // Signal completion
}()
<-done  // Wait for signal

// Buffer of 1: latest value pattern
latest := make(chan Update, 1)
go func() {
    for {
        select {
        case latest <- getUpdate():
        default:
            <-latest  // Drain old value
            latest <- getUpdate()
        }
    }
}()

// Larger buffer: smooth out bursts
requests := make(chan Request, 100)
// Producer can burst up to 100 requests without blocking
\`\`\`

### Channel Direction: Type Safety

Go lets you restrict a channel to send-only (\`chan<- T\`) or receive-only (\`<-chan T\`) in function signatures. The compiler enforces these restrictions, preventing a consumer from accidentally closing a channel it should only read from, or a producer from reading values meant for someone else. Bidirectional channels convert implicitly to directional ones when passed to such functions.

\`\`\`go
// Generator: returns send-only channel (from caller's perspective)
func generator(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out  // Converts to receive-only for caller
}

// Worker: receives input, sends output
func worker(in <-chan int, out chan<- int) {
    for n := range in {
        out <- n * n
    }
    close(out)
}

// Main: orchestrates the channels
func main() {
    // generator returns <-chan int (receive-only)
    nums := generator(1, 2, 3, 4, 5)

    // Create bidirectional channel
    results := make(chan int)

    // worker receives from nums, sends to results
    go worker(nums, results)

    // Consume results
    for result := range results {
        fmt.Println(result)
    }
}
\`\`\`

### Channel Closing: Best Practices

Only the **sender** should close a channel. Closing is a broadcast signal:

\`\`\`go
func producer(out chan<- int, count int) {
    defer close(out)  // Always close when done sending
    for i := 0; i < count; i++ {
        out <- i
    }
}

func consumer(in <-chan int) {
    // Range automatically handles closed channel
    for v := range in {
        process(v)
    }
    fmt.Println("Channel closed, consumer exiting")
}

// Manual close check
func manualConsumer(in <-chan int) {
    for {
        v, ok := <-in
        if !ok {
            // Channel is closed and empty
            return
        }
        process(v)
    }
}
\`\`\`

### Channel Nil Behavior

A nil channel, one declared but never initialized with \`make\`, has well-defined semantics: sends and receives on it block forever, and closing it panics. This might seem useless, but it turns out to be the cleanest way to disable a case inside a \`select\` at runtime.

\`\`\`go
var ch chan int  // nil channel

// Send blocks forever
go func() {
    ch <- 1  // Blocks forever (deadlock if no other goroutines)
}()

// Receive blocks forever
go func() {
    <-ch  // Blocks forever
}()

// Close panics
close(ch)  // panic: close of nil channel
\`\`\`

**Use case**: Disable a select case:

\`\`\`go
func merge(ch1, ch2 <-chan int) <-chan int {
    out := make(chan int)

    go func() {
        defer close(out)

        for ch1 != nil || ch2 != nil {
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
        }
    }()

    return out
}
\`\`\`

### Channel Ownership

The "channel ownership" rule: every channel has one owner responsible for closing it. The owner is typically the writer. Readers never close. This convention, applied consistently, prevents the most common channel bugs: send-on-closed panic, close-of-nil panic, double-close panic. In code review, the question is always "who owns this channel", and if the answer is unclear, the design is wrong.

When multiple senders need to converge on a single channel, the pattern is a dedicated coordinator goroutine that owns the channel and multiplexes inputs through a fan-in. Or, more commonly: use \`errgroup\` or \`sync.WaitGroup\` to coordinate the senders and let a separate goroutine close the channel after they all finish.

### Channel Performance Characteristics

On modern Go, channel operations cost roughly:
- Unbuffered send/receive with ready counterpart: ~60 ns
- Buffered send/receive with space available: ~25 ns
- Contention (many goroutines on one channel): degrades with contention

For low-contention coordination (signaling, fan-out to a handful of workers), channels are the right answer. For high-frequency counters, mutex-protected state, or atomic operations, channels are 10 to 100 times slower than \`sync/atomic\` and \`sync.Mutex\`. The proverb "share memory by communicating" is about design ethos, not about replacing every mutex with a channel. The staff-level rule: use channels for ownership transfer and coordination. Use mutexes and atomics for bounded shared state that stays in one place. Measure before switching.

### The "Don't Use Channels for Every Shared State" Reality Check

A common Go mistake is implementing a counter or set via a goroutine-plus-channel instead of a mutex. The pattern "send operations to a dedicated goroutine that owns the state" is elegant but wasteful for simple shared state. A mutex-protected counter is a handful of nanoseconds per increment. A channel-based counter is hundreds of nanoseconds plus a goroutine's worth of scheduling. The shape matters when the operation count is large. For a counter hit ten thousand times per second, the channel version costs several percent of a CPU core. The mutex version is invisible.

### Staff Lens: Channel Shape Decisions

Three channel-shape decisions that recur in design reviews:

1. **Buffered or unbuffered?** Unbuffered is a synchronisation point: the sender knows the receiver got it. Buffered is decoupling: the sender can proceed without a receiver waiting. Default to unbuffered for correctness signalling. Use buffered when you have quantifiable evidence of throughput benefit, and size the buffer based on producer burst size, not a guess.
2. **Channel or sync.Cond?** For fan-out notification (one producer signals N consumers), channels are clean. For wait-until-condition patterns (N goroutines wait for a shared state transition), \`sync.Cond\` is closer to the metal and avoids channel allocation. Most teams use channels everywhere and pay a small cost. Teams that measure and care use \`sync.Cond\` where it wins.
3. **Channel or explicit done channel vs context.Context?** For cancellation signalling, \`context.Context\` is idiomatic in modern Go. A raw done channel is correct but carries less information (no cause, no deadline). New code should use context unless there is a specific reason not to.

### Principal Lens: Channels Are Not Always the Answer

A Go codebase that uses channels for everything is a Go codebase that will have performance problems at scale. The principal-level instinct is to recognise when the channel is the wrong abstraction. Signs: the channel is being used as a queue with zero-to-one consumers (use a function call or a mutex-protected slice), the channel is being used to serialise access to shared state (use a mutex), the channel is being used to broadcast to N goroutines (use \`sync.Cond\` or a broadcast pattern built on channel-close). Each of these has a channel-based solution that works. Each of them has a non-channel solution that is simpler or faster. Teach the team to recognise the shape and pick the right tool. Channels are a great primitive. They are not the only one.

---
`;
