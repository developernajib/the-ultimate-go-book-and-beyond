export default `## 10C.9 Channel Disasters

### Sending on a Closed Channel: Always Panics

Sending a value to a closed channel causes an immediate panic. In code where multiple goroutines send, the closing goroutine must coordinate with senders to ensure no goroutine sends after the channel is closed.

\`\`\`go
package main

import "fmt"

func main() {
    ch := make(chan int, 5)
    close(ch)

    // PANIC: send on closed channel
    // ch <- 1 // panic: send on closed channel

    // DISASTER PATTERN: closing from multiple goroutines
    // If two goroutines both try to close the same channel, one will panic.
    ch2 := make(chan int, 5)
    go func() { close(ch2) }()
    go func() { close(ch2) }() // panic: close of closed channel
    // Even closing once from a goroutine that might race with another is dangerous.
}
\`\`\`

### Safe Channel Patterns

The safest channel pattern is to close only from the single goroutine responsible for sending, using a separate done channel or context cancellation to signal other goroutines to stop.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

// PATTERN 1: Only the sender closes the channel
// The goroutine that writes to a channel is responsible for closing it.
// Never close from a receiver.
func producer(ch chan<- int, count int) {
    defer close(ch) // safe: only the producer closes
    for i := range count {
        ch <- i
    }
}

// PATTERN 2: Use sync.Once to protect close in multi-sender scenarios
type SafeChannel[T any] struct {
    ch     chan T
    once   sync.Once
    closed bool
    mu     sync.Mutex
}

func NewSafeChannel[T any](buf int) *SafeChannel[T] {
    return &SafeChannel[T]{ch: make(chan T, buf)}
}

func (sc *SafeChannel[T]) Send(v T) (ok bool) {
    sc.mu.Lock()
    defer sc.mu.Unlock()
    if sc.closed {
        return false
    }
    sc.ch <- v
    return true
}

func (sc *SafeChannel[T]) Close() {
    sc.once.Do(func() {
        sc.mu.Lock()
        defer sc.mu.Unlock()
        sc.closed = true
        close(sc.ch)
    })
}

func (sc *SafeChannel[T]) Receive() <-chan T {
    return sc.ch
}

// PATTERN 3: Use context for cancellation instead of closing
func workerWithContext(ctx context.Context, ch <-chan int) {
    for {
        select {
        case <-ctx.Done():
            return // clean shutdown via context
        case v, ok := <-ch:
            if !ok {
                return // channel closed
            }
            fmt.Println(v)
        }
    }
}

// TRAP: Receiving from nil channel blocks forever
func nilChannelTrap() {
    var ch chan int // nil channel

    // Receiving from nil channel blocks forever - not a panic, a deadlock
    // v := <-ch // blocks forever

    // In a select, nil channel case is NEVER selected (useful idiom!)
    select {
    case v := <-ch: // nil channel: never fires
        fmt.Println(v)
    default:
        fmt.Println("channel is nil, taking default")
    }
}
\`\`\`

### Nil Channel as a Control Mechanism

Setting a channel variable to nil in a \`select\` statement permanently disables that case. This technique stops processing from a particular source while continuing to drain other channels.

\`\`\`go
package main

import "fmt"

// Useful idiom: set a channel to nil to "disable" it in a select
func merge(ch1, ch2 <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for ch1 != nil || ch2 != nil {
            select {
            case v, ok := <-ch1:
                if !ok {
                    ch1 = nil // disable this case by setting to nil
                    continue
                }
                out <- v
            case v, ok := <-ch2:
                if !ok {
                    ch2 = nil // disable this case
                    continue
                }
                out <- v
            }
        }
    }()
    return out
}
\`\`\`

---
`;
