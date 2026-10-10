## 16.2 Deadlocks

Deadlocks occur when goroutines wait for each other indefinitely.

### Lock Ordering Deadlock

A lock ordering deadlock occurs when two goroutines each hold a lock the other needs and wait indefinitely for the other to release it, a circular wait. The canonical fix is to enforce a global lock acquisition order throughout the codebase: if every goroutine always acquires `mu1` before `mu2`, the cycle is broken and deadlock becomes impossible.

```go
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
```

**Fix: Consistent lock ordering:**
```go
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
```

### Channel Deadlock

Channel deadlocks in Go are easy to introduce because an unbuffered send blocks until a receiver is ready, and a receive blocks until a sender writes. If neither party ever arrives, because the goroutine was never started, panicked before sending, or the channel was simply never wired up, the blocked goroutine waits forever. The Go runtime will terminate the program with "all goroutines are asleep, deadlock!" only when every goroutine is blocked. If even one goroutine is still running, the deadlock goes undetected at runtime.

```go
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
```

### Self-Deadlock with RWMutex

A self-deadlock happens when a single goroutine tries to acquire a lock it already holds, with no other goroutine able to release it. With `sync.RWMutex`, calling `Lock()` while the same goroutine holds an `RLock()` will block indefinitely because the write lock waits for all read locks to be released, including the one held by itself. This pattern often appears in helper methods that acquire a read lock and then unexpectedly call another method that attempts a write lock.

```go
// DEADLOCK: RLock then Lock
func selfDeadlock(rw *sync.RWMutex) {
    rw.RLock()
    defer rw.RUnlock()

    rw.Lock()  // Deadlock! Waits for the RLock this goroutine holds
    rw.Unlock()
}
```

State this plainly, because the wishful version of it causes real bugs: **there is no lock upgrade in Go, and there is no way to add one.** `RWMutex` offers no `UpgradeLock`, and the sequence above is not an upgrade, it is a goroutine waiting for itself. A read-then-write operation must `RUnlock`, then `Lock`, then **re-check the state**, because the data can change while you hold no lock at all. That re-check is not defensive coding, it is the only thing making the pattern correct.

Now the trap that catches people who already know all that. **Recursive `RLock` also deadlocks.** Two `RLock` calls on the same mutex look harmless, since read locks share. They do not share when a writer is waiting in between:

```go
rw.RLock()          // Goroutine A acquires a read lock
                    // Goroutine B calls rw.Lock() and queues, blocking new readers
rw.RLock()          // Goroutine A blocks behind B. B blocks behind A. Deadlock.
```

`RWMutex` blocks new readers once a writer is queued, otherwise a stream of readers would starve every writer forever. That anti-starvation rule is exactly what makes recursive read locking unsafe. The Go documentation says so directly: if a goroutine holds a `RWMutex` for reading and another goroutine might call `Lock`, no goroutine should expect to be able to acquire a read lock until the initial read lock is released. In practice this means never calling a method that takes `RLock` from inside a function that already holds it, which is easy to violate through a refactor because neither call site looks wrong on its own.

### Detecting Deadlocks

The Go runtime detects only *total* deadlocks. When every goroutine in the program is blocked, it terminates with a stack trace:

```
fatal error: all goroutines are asleep - deadlock!
```

Read the word "all" literally, because it is the whole story. The check fires only when the runtime has nothing left to schedule. Any real service always has something runnable, whether an HTTP listener, a ticker, a metrics exporter, or a signal handler, so **the condition is never met in production**. Two goroutines can sit in a perfect AB-BA deadlock while one unrelated goroutine sleeps in a loop, and the runtime prints nothing: no panic, no trace, no exit. The process simply hangs, holding whatever those goroutines were serving.

That is the normal case, not the exception. The built-in detector is a teaching aid for single-purpose programs and effectively never fires in a server. Plan to diagnose deadlocks yourself.

For partial deadlocks, the reliable tool is a goroutine dump. A blocked goroutine shows its state and how long it has been stuck:

```bash
# Dump ALL goroutine stacks, not just the one that failed.
GOTRACEBACK=all ./myapp
```

The non-destructive way to inspect a live process is the pprof goroutine profile, which is the one to reach for in production because the service keeps serving:

```bash
# Full stacks for every goroutine, process stays alive
curl 'http://localhost:6060/debug/pprof/goroutine?debug=2'
```

Signals also produce a dump, but be clear about the cost:

```bash
kill -ABRT <pid>   # or -QUIT
```

This dumps every goroutine's stack **and then aborts the process**. It is not a way to peek at a running service, it is a way to capture state while killing it. Use it on a hung process you were going to restart anyway, and use the pprof endpoint on one you want to keep. Note that a goroutine parked forever on a mutex reports `[sync.Mutex.Lock]` along with how many minutes it has been waiting, and a wait time in the minutes is your deadlock.

### Staff Lens: Lock Hierarchy as Architecture

Deadlocks happen when lock acquisition order is inconsistent. The prevention is a documented lock hierarchy: every time multiple locks are acquired, they are acquired in the same order. Document this at the struct level:

```go
// Account lock order: always by account ID ascending.
// Never hold account lock while acquiring transaction log lock.
```

Without explicit documentation, every engineer independently reasons about lock order and eventually someone gets it wrong. With documentation, the reviewer can check against the spec. Teams that grow past a handful of locks must adopt this discipline or deal with recurring deadlocks.

### Principal Lens: Lock Minimisation as a Design Goal

Every lock is a potential deadlock contributor. The principal-level instinct: minimize the number of locks in the design. Strategies:

- Single-owner goroutine per state, coordinated via channels (no locks).
- Immutable snapshots with atomic swap (readers never lock).
- Sharded state where each shard has one lock (no cross-shard operations).

These strategies eliminate deadlock categories entirely, at the cost of design sophistication. Worth the investment for critical paths.

---
