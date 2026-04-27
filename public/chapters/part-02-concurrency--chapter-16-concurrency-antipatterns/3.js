export default `## 16.2 Deadlocks

Deadlocks occur when goroutines wait for each other indefinitely.

### Lock Ordering Deadlock

A lock ordering deadlock occurs when two goroutines each hold a lock the other needs and wait indefinitely for the other to release it, a circular wait. The canonical fix is to enforce a global lock acquisition order throughout the codebase: if every goroutine always acquires \`mu1\` before \`mu2\`, the cycle is broken and deadlock becomes impossible.

\`\`\`go
// DEADLOCK
var mu1, mu2 sync.Mutex

func goroutine1() {
    mu1.Lock()
    defer mu1.Unlock()
    time.Sleep(time.Millisecond)
    mu2.Lock()  // Waiting for mu2
    defer mu2.Unlock()
}

func goroutine2() {
    mu2.Lock()
    defer mu2.Unlock()
    time.Sleep(time.Millisecond)
    mu1.Lock()  // Waiting for mu1 - DEADLOCK!
    defer mu1.Unlock()
}
\`\`\`

**Fix: Consistent lock ordering:**
\`\`\`go
func goroutine1() {
    mu1.Lock()
    defer mu1.Unlock()
    mu2.Lock()  // Always lock mu1 before mu2
    defer mu2.Unlock()
}

func goroutine2() {
    mu1.Lock()  // Same order as goroutine1
    defer mu1.Unlock()
    mu2.Lock()
    defer mu2.Unlock()
}
\`\`\`

### Channel Deadlock

Channel deadlocks in Go are easy to introduce because an unbuffered send blocks until a receiver is ready, and a receive blocks until a sender writes. If neither party ever arrives, because the goroutine was never started, panicked before sending, or the channel was simply never wired up, the blocked goroutine waits forever. The Go runtime will terminate the program with "all goroutines are asleep, deadlock!" only when every goroutine is blocked. If even one goroutine is still running, the deadlock goes undetected at runtime.

\`\`\`go
// DEADLOCK: unbuffered channel, no receiver
func main() {
    ch := make(chan int)
    ch <- 1  // Blocks forever, no goroutine to receive
}

// DEADLOCK: waiting for send that never happens
func main() {
    ch := make(chan int)
    go func() {
        // Forgot to send!
    }()
    <-ch  // Blocks forever
}
\`\`\`

### Self-Deadlock with RWMutex

A self-deadlock happens when a single goroutine tries to acquire a lock it already holds, with no other goroutine able to release it. With \`sync.RWMutex\`, calling \`Lock()\` while the same goroutine holds an \`RLock()\` will block indefinitely because the write lock waits for all read locks to be released, including the one held by itself. This pattern often appears in helper methods that acquire a read lock and then unexpectedly call another method that attempts a write lock.

\`\`\`go
// DEADLOCK: RLock then Lock
func selfDeadlock(rw *sync.RWMutex) {
    rw.RLock()
    defer rw.RUnlock()

    rw.Lock()  // Deadlock! Waiting for RLock to release
    rw.Unlock()
}
\`\`\`

### Detecting Deadlocks

The Go runtime detects total deadlocks automatically, when every goroutine in the program is blocked, it terminates with a stack trace:

\`\`\`
fatal error: all goroutines are asleep - deadlock!
\`\`\`

Partial deadlocks, where some goroutines are still running but others are permanently stuck, escape runtime detection. For these cases, set \`GOTRACEBACK=all\` to dump every goroutine's stack on crash, or send a signal to a running process to capture its state:

\`\`\`bash
GOTRACEBACK=all ./myapp
\`\`\`

On Linux/macOS, sending SIGABRT produces a full goroutine dump from a running process without requiring a restart:

\`\`\`bash
kill -ABRT <pid>
\`\`\`

### Staff Lens: Lock Hierarchy as Architecture

Deadlocks happen when lock acquisition order is inconsistent. The prevention is a documented lock hierarchy: every time multiple locks are acquired, they are acquired in the same order. Document this at the struct level:

\`\`\`go
// Account lock order: always by account ID ascending.
// Never hold account lock while acquiring transaction log lock.
\`\`\`

Without explicit documentation, every engineer independently reasons about lock order and eventually someone gets it wrong. With documentation, the reviewer can check against the spec. Teams that grow past a handful of locks must adopt this discipline or deal with recurring deadlocks.

### Principal Lens: Lock Minimisation as a Design Goal

Every lock is a potential deadlock contributor. The principal-level instinct: minimise the number of locks in the design. Strategies:

- Single-owner goroutine per state, coordinated via channels (no locks).
- Immutable snapshots with atomic swap (readers never lock).
- Sharded state where each shard has one lock (no cross-shard operations).

These strategies eliminate deadlock categories entirely, at the cost of design sophistication. Worth the investment for critical paths.

---
`;
