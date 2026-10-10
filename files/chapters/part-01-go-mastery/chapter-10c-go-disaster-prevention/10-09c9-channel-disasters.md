## 10C.9 Channel Disasters

### Sending on a Closed Channel: Always Panics

Sending a value to a closed channel causes an immediate panic. In code where multiple goroutines send, the closing goroutine must coordinate with senders to ensure no goroutine sends after the channel is closed.

```go
package main

func main() {
    ch := make(chan int, 5)
    close(ch)

    // PANIC: send on closed channel. Note the buffer has room, and it does
    // not help. Closedness is checked before capacity.
    // ch <- 1 // panic: send on closed channel

    // Receiving, by contrast, is always safe: a closed channel yields
    // buffered values first, then the zero value with ok == false forever.

    // DISASTER PATTERN: closing from multiple goroutines.
    // Whichever close lands second panics with "close of closed channel".
    // Which one that is varies per run, so this is the kind of bug that
    // passes CI and then fails at 3am.
    ch2 := make(chan int, 5)
    go func() { close(ch2) }()
    go func() { close(ch2) }()
}
```

### Safe Channel Patterns

The safest channel pattern is to close only from the single goroutine responsible for sending, using a separate done channel or context cancellation to signal other goroutines to stop.

```go
package main

import (
    "context"
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

// PATTERN 2: multi-sender shutdown via a separate done channel.
//
// The tempting version guards a `closed bool` with a mutex and closes the
// data channel under that lock. It deadlocks. Send holds the lock across
// `sc.ch <- v`, that send blocks once the buffer fills, and Close then waits
// forever for a lock the blocked sender will never release. Worse, a mutex
// cannot make the close safe anyway: a sender can be parked inside the
// runtime's send path having already passed the check.
//
// The working shape closes a signal channel and never closes the data
// channel at all. Closing is idempotent through sync.Once, and every send
// races the done signal in a select rather than a lock.
type SafeChannel[T any] struct {
    ch   chan T
    done chan struct{}
    once sync.Once
}

func NewSafeChannel[T any](buf int) *SafeChannel[T] {
    return &SafeChannel[T]{
        ch:   make(chan T, buf),
        done: make(chan struct{}),
    }
}

func (sc *SafeChannel[T]) Send(v T) (ok bool) {
    // Check done first, so an already-closed channel never accepts a value
    // just because the buffer happens to have room.
    select {
    case <-sc.done:
        return false
    default:
    }
    select {
    case sc.ch <- v:
        return true
    case <-sc.done:
        return false // shut down while we were blocked on a full buffer
    }
}

func (sc *SafeChannel[T]) Close() {
    sc.once.Do(func() { close(sc.done) })
}

// Receivers select on both: ch for values, Done for termination. Nothing
// ever closes ch, so no sender can panic.
func (sc *SafeChannel[T]) Receive() <-chan T        { return sc.ch }
func (sc *SafeChannel[T]) Done() <-chan struct{}    { return sc.done }

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

    // Receiving from a nil channel blocks forever. Not a panic, a deadlock.
    // Sending to one does the same. If it is the only goroutine left, the
    // runtime reports "all goroutines are asleep - deadlock!". If it is not,
    // the goroutine just leaks in silence.
    // v := <-ch // blocks forever

    // In a select, a nil channel case is NEVER selected. That is an idiom,
    // not a wart, and the merge function below turns it into a feature.
    select {
    case v := <-ch: // nil channel: never fires
        fmt.Println(v)
    default:
        fmt.Println("channel is nil, taking default")
    }
}
```

### Nil Channel as a Control Mechanism

Setting a channel variable to nil in a `select` statement permanently disables that case. This technique stops processing from a particular source while continuing to drain other channels.

```go
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
```

---
