## 16.7 Channel Misuse

### Sending on Closed Channel

Sending to a closed channel panics at runtime rather than returning an error, and the panic happens in the *sending* goroutine, which usually means the process dies. This makes close-then-send one of the most dangerous channel mistakes.

```go
// PANIC
ch := make(chan int)
close(ch)
ch <- 1  // panic: send on closed channel
```

#### The "SafeChannel" that is not safe

The instinctive fix is to wrap the channel: guard `Close` with `sync.Once`, guard `Send` with a mutex and a `closed` flag. This design is widespread and it is a deadlock:

```go
// BROKEN. Read the Send method carefully.
type SafeChannel struct {
    ch     chan int
    once   sync.Once
    closed bool
    mu     sync.Mutex
}

func (s *SafeChannel) Close() {
    s.once.Do(func() {
        s.mu.Lock()          // Can never be acquired. See below.
        s.closed = true
        close(s.ch)
        s.mu.Unlock()
    })
}

func (s *SafeChannel) Send(v int) bool {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.closed {
        return false
    }
    s.ch <- v  // BLOCKING OPERATION, WITH s.mu HELD
    return true
}
```

`s.ch <- v` blocks until a receiver arrives. The `defer` means `s.mu` stays locked for that entire time. So one `Send` with no receiver ready parks forever *holding the mutex*, and `Close` blocks on `s.mu` for eternity. The type deadlocks, silently, with no panic and no runtime message, because the deadlock detector needs every goroutine asleep.

**Never hold a mutex across a blocking operation.** Channel sends, channel receives, network I/O, `sync.Cond.Wait`, or any call that might do those. The mutex is supposed to protect a brief state transition. The moment it spans an operation with unbounded duration, it becomes the bottleneck at best and a deadlock at worst. This one rule prevents more production hangs than any other in this chapter.

Note also that this design fails on its own terms even without the deadlock. Making the `closed` check and the send atomic *is* the requirement, and a check-then-send under a lock the closer also needs cannot be satisfied. That is a hint that the wrapper is the wrong idea, not that it needs a better lock.

#### The actual fix: do not close to signal

Closing is not the only way to tell senders to stop, and it is the wrong one, because `close` communicates with *receivers*, not senders. Use a separate cancellation channel that senders select on. Nothing ever closes the data channel, so send-on-closed is unreachable by construction:

```go
type Sender struct {
    ch   chan int
    done chan struct{}
    once sync.Once
}

func NewSender(buf int) *Sender {
    return &Sender{ch: make(chan int, buf), done: make(chan struct{})}
}

// Stop signals senders to give up. Idempotent, and it never touches
// s.ch, so no send can ever hit a closed channel.
func (s *Sender) Stop() {
    s.once.Do(func() { close(s.done) })
}

// Send blocks until the value is delivered or Stop is called. No lock
// is held across the send, because no lock is involved at all: the
// select does the coordination.
func (s *Sender) Send(v int) bool {
    select {
    case s.ch <- v:
        return true
    case <-s.done:
        return false
    }
}
```

`close(s.done)` is safe because `done` has exactly one closer and no senders. `s.ch` is never closed at all. If receivers need to know when to stop, let them select on `s.done` too, or have the *owning sender* close `s.ch` after it has finished sending, which is the ownership rule below.

### Double Close

Closing an already-closed channel panics unconditionally, and there is no error return to check. `sync.Once` around the close makes it idempotent, which is what the `Stop` method above does. That works because `done` has a single closer and no senders.

Reaching for `sync.Once` is a smell worth noticing, though. Needing it usually means several goroutines each believe they own the channel's lifecycle, and the ownership rule below is the real fix.

```go
// PANIC
ch := make(chan int)
close(ch)
close(ch)  // panic: close of closed channel
```

### Nil Channel Operations

A nil channel is distinct from a closed or empty channel: sends and receives on a nil channel block forever, and closing one panics. This makes nil channels useful as a deliberate disable mechanism in `select` statements, setting a case's channel to nil permanently disables that case, but accidental nil channels produce subtle blocking bugs.

```go
var ch chan int  // nil

ch <- 1   // Blocks forever
<-ch      // Blocks forever
close(ch) // Panic
```

### Channel Ownership Rule

Every channel has one owner responsible for closing it. The owner is the writer. Readers never close. Applied consistently, this rule prevents:

- Send-on-closed panic (only owner closes, only after all sends).
- Double-close panic (only one owner exists).
- Close-of-nil panic (owner verifies channel was created).

In code review, the question is always "who owns this channel?" If the answer is unclear, the design is wrong. Fan-in patterns where multiple senders converge need an explicit coordinator that owns the shared channel: each producer signals completion, typically via `WaitGroup`, and the coordinator closes once after `wg.Wait()` returns.

The rule also explains why the `SafeChannel` above cannot be rescued. It exists to let *anyone* close the channel, which is precisely the thing the ownership rule forbids. No amount of mutex work fixes a design whose premise is shared ownership of a lifecycle that admits only one owner. When you find yourself building machinery to make close safe from arbitrary callers, the machinery is not the answer. Single ownership is.

### Staff Lens: Channel Bugs Are Design Bugs

Most channel misuse patterns trace back to unclear ownership or lifecycle. The staff-level fix is architectural: document the ownership of every channel, verify in review, refactor code that violates the ownership rule. This prevents an entire class of panics.

---
