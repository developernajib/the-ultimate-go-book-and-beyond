export default `## 16.7 Channel Misuse

### Sending on Closed Channel

Sending to a closed channel panics at runtime rather than returning an error, making close-then-send one of the most dangerous channel mistakes. The idiomatic solution is to encapsulate close behind \`sync.Once\` and guard sends with a mutex-protected closed flag, so the channel transitions to the closed state exactly once and subsequent sends are safely rejected.

\`\`\`go
// PANIC
ch := make(chan int)
close(ch)
ch <- 1  // panic: send on closed channel
\`\`\`

**Fix: Track channel state or use sync.Once:**
\`\`\`go
type SafeChannel struct {
    ch     chan int
    once   sync.Once
    closed bool
    mu     sync.Mutex
}

func (s *SafeChannel) Close() {
    s.once.Do(func() {
        s.mu.Lock()
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
    s.ch <- v
    return true
}
\`\`\`

### Double Close

Closing an already-closed channel panics unconditionally. There is no recover-able error path. The \`sync.Once\`-based \`SafeChannel\` above prevents this by ensuring the close operation executes exactly once regardless of how many goroutines call it.

\`\`\`go
// PANIC
ch := make(chan int)
close(ch)
close(ch)  // panic: close of closed channel
\`\`\`

### Nil Channel Operations

A nil channel is distinct from a closed or empty channel: sends and receives on a nil channel block forever, and closing one panics. This makes nil channels useful as a deliberate disable mechanism in \`select\` statements, setting a case's channel to nil permanently disables that case, but accidental nil channels produce subtle blocking bugs.

\`\`\`go
var ch chan int  // nil

ch <- 1   // Blocks forever
<-ch      // Blocks forever
close(ch) // Panic
\`\`\`

### Channel Ownership Rule

Every channel has one owner responsible for closing it. The owner is the writer. Readers never close. Applied consistently, this rule prevents:

- Send-on-closed panic (only owner closes, only after all sends).
- Double-close panic (only one owner exists).
- Close-of-nil panic (owner verifies channel was created).

In code review, the question is always "who owns this channel?" If the answer is unclear, the design is wrong. Fan-in patterns where multiple senders converge need an explicit coordinator that owns the shared channel.

### Staff Lens: Channel Bugs Are Design Bugs

Most channel misuse patterns trace back to unclear ownership or lifecycle. The staff-level fix is architectural: document the ownership of every channel, verify in review, refactor code that violates the ownership rule. This prevents an entire class of panics.

---
`;
