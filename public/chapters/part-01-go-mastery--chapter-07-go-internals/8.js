export default `## 7.7 Channel Internals

### The hchan Structure

Channels are implemented as a \`hchan\` struct containing a circular buffer, two wait queues for blocked senders and receivers, and a mutex. Understanding this structure explains channel semantics and why buffered channels avoid context switches.

\`\`\`go
// Simplified runtime.hchan
type hchan struct {
    qcount   uint           // Current elements in circular buffer
    dataqsiz uint           // Buffer capacity
    buf      unsafe.Pointer // Pointer to circular buffer
    elemsize uint16         // Element size
    closed   uint32         // Channel closed flag
    elemtype *_type         // Element type
    sendx    uint           // Send index in circular buffer
    recvx    uint           // Receive index in circular buffer
    recvq    waitq          // List of blocked receivers
    sendq    waitq          // List of blocked senders
    lock     mutex          // Protects all fields
}

type waitq struct {
    first *sudog
    last  *sudog
}

type sudog struct {
    g     *g           // Waiting goroutine
    elem  unsafe.Pointer // Data element
    next  *sudog
    prev  *sudog
    // ... other fields
}
\`\`\`

### Channel Operation Internals

Send and receive operations follow a decision tree based on buffer state and waiting goroutines. Direct goroutine-to-goroutine handoff is the fast path that avoids locking and buffering overhead.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Channel Send Operation (ch <- value)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Acquire channel lock                                                     │
│                                                                              │
│  2. Check if channel is closed                                               │
│     └─ If closed: panic("send on closed channel")                           │
│                                                                              │
│  3. Check for waiting receiver (recvq not empty)                            │
│     └─ If receiver waiting:                                                 │
│        a. Dequeue receiver from recvq                                       │
│        b. Copy value directly to receiver's memory                          │
│        c. Wake up receiver goroutine                                        │
│        d. Release lock and return                                           │
│                                                                              │
│  4. Check if buffer has space (qcount < dataqsiz)                           │
│     └─ If space available:                                                  │
│        a. Copy value to buf[sendx]                                          │
│        b. Increment sendx (wrap around)                                     │
│        c. Increment qcount                                                  │
│        d. Release lock and return                                           │
│                                                                              │
│  5. Buffer full, no receiver waiting                                        │
│     a. Create sudog for current goroutine                                   │
│     b. Store value pointer in sudog                                         │
│     c. Enqueue sudog in sendq                                               │
│     d. Release lock                                                         │
│     e. Park goroutine (gopark)                                              │
│     f. When woken: value has been received, return                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                   Channel Receive Operation (<-ch)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Acquire channel lock                                                     │
│                                                                              │
│  2. Check for waiting sender (sendq not empty)                              │
│     └─ If sender waiting:                                                   │
│        For unbuffered: Copy directly from sender                            │
│        For buffered: Copy from buffer, then from sender to buffer          │
│        Wake up sender                                                       │
│        Release lock and return value                                        │
│                                                                              │
│  3. Check if buffer has data (qcount > 0)                                   │
│     └─ If data available:                                                   │
│        a. Copy value from buf[recvx]                                        │
│        b. Increment recvx (wrap around)                                     │
│        c. Decrement qcount                                                  │
│        d. Release lock and return value                                     │
│                                                                              │
│  4. Check if channel is closed                                               │
│     └─ If closed: Return zero value and false                               │
│                                                                              │
│  5. Buffer empty, no sender waiting, not closed                             │
│     a. Create sudog for current goroutine                                   │
│     b. Enqueue sudog in recvq                                               │
│     c. Release lock                                                         │
│     d. Park goroutine (gopark)                                              │
│     e. When woken: value has been sent or channel closed                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Channel Behavior Edge Cases

Several channel edge cases arise in production: sending on a closed channel panics, receiving from a closed channel returns the zero value, and nil channels block forever. The following examples cover each scenario.

\`\`\`go
package main

import (
    "fmt"
    "time"
)

func main() {
    // Nil channel behavior
    var nilChan chan int

    // Select with nil channel (case is disabled)
    go func() {
        select {
        case <-nilChan:
            fmt.Println("Received from nil") // Never executes
        case <-time.After(10 * time.Millisecond):
            fmt.Println("Nil channel blocks forever in select")
        }
    }()

    // Closed channel behavior
    ch := make(chan int, 3)
    ch <- 1
    ch <- 2
    close(ch)

    // Can receive remaining values
    fmt.Println(<-ch) // 1
    fmt.Println(<-ch) // 2

    // Receives zero value after empty
    val, ok := <-ch
    fmt.Printf("val=%d, ok=%v\\n", val, ok) // val=0, ok=false

    // Close detection in for-range
    ch2 := make(chan int, 2)
    ch2 <- 10
    ch2 <- 20
    close(ch2)

    for v := range ch2 {
        fmt.Println("Range received:", v)
    }
    fmt.Println("Range loop exited after close")

    time.Sleep(50 * time.Millisecond)
}
\`\`\`

### Channel Performance Reality

For a senior engineer, channels are not free. Three costs to know:

1. **Unbuffered channel send/receive is a goroutine handoff.** The sender blocks until a receiver is ready. This is roughly a context switch plus a few hundred nanoseconds of runtime work. For high-throughput coordination, a mutex is often faster.
2. **Buffered channels amortise the handoff.** Sending into buffer space is O(1) with no goroutine switch. For producer-consumer patterns with batchable work, buffers help.
3. **\`select\` with many cases is linear.** A select with N cases checks each one. For many-channel dispatch, consider alternative patterns (reflection-based \`reflect.Select\` is slow, and dedicated dispatcher goroutines are faster).

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **Unbuffered channel in a hot path.** Benchmark against a mutex.
2. **Channel as a semaphore with unit values.** Works but \`semaphore.Weighted\` from \`golang.org/x/sync\` is clearer.
3. **Closing a channel from the receiver.** The convention is that the sender closes. Receiver-closes leads to send-on-closed panics.

---
`;
