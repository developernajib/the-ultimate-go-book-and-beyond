## 16.13 Common Mistake Patterns

### Mistake 1: Returning While Holding Lock

Every early return from a function requires a corresponding `Unlock` call. As the number of return paths grows, it becomes easy to miss one, leaving the lock permanently held. Using `defer mu.Unlock()` immediately after `Lock()` eliminates this class of bug entirely, the unlock fires on every return path including panics.

```go
// WRONG: Easy to forget to unlock
func (s *Service) GetDataWrong() (Data, error) {
    s.mu.Lock()

    if s.closed {
        s.mu.Unlock()
        return Data{}, ErrClosed
    }

    data := s.data

    if !data.Valid {
        s.mu.Unlock()  // Easy to miss this!
        return Data{}, ErrInvalid
    }

    s.mu.Unlock()
    return data, nil
}

// CORRECT: Use defer
func (s *Service) GetData() (Data, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if s.closed {
        return Data{}, ErrClosed
    }

    if !s.data.Valid {
        return Data{}, ErrInvalid
    }

    return s.data, nil
}
```

### Mistake 2: Channel Direction Confusion

Typed channel directions (`chan<-` and `<-chan`) encode ownership at the type level: only the sender should close a channel, and the compiler enforces this when directional types are used. The canonical pattern is for the producer function to take a `chan<-` parameter and call `defer close(ch)`, while the consumer takes a `<-chan` parameter and uses `range` to consume until closure.

```go
// WRONG: Closing receive-only channel (won't compile, but shows intent)
func consumer(ch <-chan int) {
    for v := range ch {
        process(v)
    }
    // close(ch) // Cannot close receive-only channel
}

// Pattern: Sender closes, receiver ranges
func producer(ch chan<- int) {
    defer close(ch)  // Sender closes
    for i := 0; i < 10; i++ {
        ch <- i
    }
}

func consumer(ch <-chan int) {
    for v := range ch {  // Receiver ranges
        process(v)
    }
    // Exits when channel is closed
}
```

### Mistake 3: WaitGroup Misuse

Calling `wg.Add(1)` inside the goroutine body creates a race with `wg.Wait()`, if the scheduler runs `Wait` before the goroutine calls `Add`, `Wait` sees a counter of zero and returns immediately. The fix is always to call `Add` in the spawning goroutine before the `go` statement, ensuring the counter is incremented before `Wait` could possibly observe it.

```go
// WRONG: Adding after Wait started
func wrongWaitGroup() {
    var wg sync.WaitGroup

    go func() {
        wg.Add(1)  // Race with Wait!
        defer wg.Done()
        work()
    }()

    wg.Wait()  // Might return early
}

// CORRECT: Add before starting goroutine
func correctWaitGroup() {
    var wg sync.WaitGroup

    wg.Add(1)  // Add first
    go func() {
        defer wg.Done()
        work()
    }()

    wg.Wait()
}
```

### Mistake 4: Select Without Default for Non-Blocking

A plain channel receive always blocks until a value is available, making it unsuitable for polling or optional receives. Adding a `default` case to `select` makes the receive non-blocking: if no value is ready, the default branch runs immediately, turning the receive into a try-receive operation.

```go
// WRONG: Blocks when channel is empty
func tryReceiveWrong(ch <-chan int) (int, bool) {
    v := <-ch  // Blocks!
    return v, true
}

// CORRECT: Use select with default
func tryReceive(ch <-chan int) (int, bool) {
    select {
    case v := <-ch:
        return v, true
    default:
        return 0, false
    }
}
```

### Mistake 5: Timer Leak

Before Go 1.23, `time.After` allocated a `Timer` that persisted until it fired even when the other `select` case won, which made it a real leak in repeatedly-called functions. Since Go 1.23 (for modules with `go 1.23` or higher), unreferenced timers are collected immediately, so the leak is gone and what remains is a per-call allocation. `time.NewTimer` with `defer timer.Stop()` is still the cheaper form in hot paths and the only safe form on older modules.

```go
// WRONG: Timer never stopped
func timeoutWrong(ch <-chan int, timeout time.Duration) (int, bool) {
    select {
    case v := <-ch:
        return v, true
    case <-time.After(timeout):  // Per-call timer alloc (leaked pre-1.23)
        return 0, false
    }
}

// CORRECT on a go 1.23+ module: no drain needed
func timeout(ch <-chan int, timeout time.Duration) (int, bool) {
    timer := time.NewTimer(timeout)
    defer timer.Stop()

    select {
    case v := <-ch:
        return v, true
    case <-timer.C:
        return 0, false
    }
}

// The pre-1.23 drain idiom, for modules pinned below go 1.23 ONLY:
//
//	case v := <-ch:
//	    if !timer.Stop() {
//	        <-timer.C  // drain the stale value
//	    }
//	    return v, true
```

The drain deserves its own explanation, because it is muscle memory for a lot of Go engineers and it is now both unnecessary and unsafe.

Go 1.23 made timer channels unbuffered (`cap(timer.C) == 0`) and changed `Stop`'s contract. `time.Timer.Stop` now documents that "as of Go 1.23, any receive from `t.C` after `Stop` has returned is guaranteed to block rather than receive a stale time value from before the `Stop` - if the program has not received from `t.C` already and the timer is running, `Stop` is guaranteed to return true."

Both halves matter. Because `Stop` returns **true** whenever you have not already received, the `if !timer.Stop()` branch is *unreachable* in the pattern above: it is dead code. And because a receive after `Stop` is *guaranteed to block*, that dead code would hang the goroutine forever if anything ever did reach it. So on a modern module the drain is a hazard sitting in a branch that never runs, which is the worst kind of code to leave lying around. Delete it.

Verify rather than trust either version. `cap(timer.C)` reports 0 on a `go 1.23`+ module and 1 below it, which tells you instantly which semantics your module has, and, as with loop variables, it is the `go` directive in `go.mod` that decides, not the toolchain you installed.

### Staff Lens: Timer Leaks Are Silent Memory Growth

On a modern (1.23+) module, `time.After` in a tight loop is allocation pressure, not a leak. The review discipline: in hot loops, replace with a reset-and-stop pattern or (preferably) a context with timeout, and correct reviewers who still flag it as a leak on modern modules. On modules pinned below 1.23, treat it as the leak it historically was.

### Prefer Context Over Timer for Most Cases

Most production uses of `time.After` should be replaced with `context.WithTimeout`:

```go
ctx, cancel := context.WithTimeout(ctx, timeout)
defer cancel()
select {
case v := <-ch: return v
case <-ctx.Done(): return ctx.Err()
}
```

The context version has two advantages: the timeout propagates through downstream calls (vs `time.After` which is local), and calling `cancel()` releases the timer immediately without waiting for it to fire.

---
