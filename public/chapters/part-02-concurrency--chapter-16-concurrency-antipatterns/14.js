export default `## 16.13 Common Mistake Patterns

### Mistake 1: Returning While Holding Lock

Every early return from a function requires a corresponding \`Unlock\` call. As the number of return paths grows, it becomes easy to miss one, leaving the lock permanently held. Using \`defer mu.Unlock()\` immediately after \`Lock()\` eliminates this class of bug entirely, the unlock fires on every return path including panics.

\`\`\`go
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
\`\`\`

### Mistake 2: Channel Direction Confusion

Typed channel directions (\`chan<-\` and \`<-chan\`) encode ownership at the type level: only the sender should close a channel, and the compiler enforces this when directional types are used. The canonical pattern is for the producer function to take a \`chan<-\` parameter and call \`defer close(ch)\`, while the consumer takes a \`<-chan\` parameter and uses \`range\` to consume until closure.

\`\`\`go
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
\`\`\`

### Mistake 3: WaitGroup Misuse

Calling \`wg.Add(1)\` inside the goroutine body creates a race with \`wg.Wait()\`, if the scheduler runs \`Wait\` before the goroutine calls \`Add\`, \`Wait\` sees a counter of zero and returns immediately. The fix is always to call \`Add\` in the spawning goroutine before the \`go\` statement, ensuring the counter is incremented before \`Wait\` could possibly observe it.

\`\`\`go
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
\`\`\`

### Mistake 4: Select Without Default for Non-Blocking

A plain channel receive always blocks until a value is available, making it unsuitable for polling or optional receives. Adding a \`default\` case to \`select\` makes the receive non-blocking: if no value is ready, the default branch runs immediately, turning the receive into a try-receive operation.

\`\`\`go
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
\`\`\`

### Mistake 5: Timer Leak

\`time.After\` allocates a new \`Timer\` on every call and leaks it if the channel receive case is not selected, the timer and its goroutine persist until it fires. Creating a timer with \`time.NewTimer\` and calling \`defer timer.Stop()\` ensures the underlying resources are released regardless of which \`select\` case is chosen.

\`\`\`go
// WRONG: Timer never stopped
func timeoutWrong(ch <-chan int, timeout time.Duration) (int, bool) {
    select {
    case v := <-ch:
        return v, true
    case <-time.After(timeout):  // Creates new timer each call, leaks!
        return 0, false
    }
}

// CORRECT: Reuse timer and stop it
func timeout(ch <-chan int, timeout time.Duration) (int, bool) {
    timer := time.NewTimer(timeout)
    defer timer.Stop()  // Always stop!

    select {
    case v := <-ch:
        if !timer.Stop() {
            <-timer.C
        }
        return v, true
    case <-timer.C:
        return 0, false
    }
}
\`\`\`

### Staff Lens: Timer Leaks Are Silent Memory Growth

A \`time.After\` in a tight loop is a slow memory leak. The timer garbage is collected eventually, but in a high-throughput loop the accumulated garbage can be significant. The review discipline: flag every \`time.After\` in a loop or repeatedly-called function. Replace with a reset-and-stop pattern or (preferably) a context with timeout.

### Prefer Context Over Timer for Most Cases

Most production uses of \`time.After\` should be replaced with \`context.WithTimeout\`:

\`\`\`go
ctx, cancel := context.WithTimeout(ctx, timeout)
defer cancel()
select {
case v := <-ch: return v
case <-ctx.Done(): return ctx.Err()
}
\`\`\`

The context version has two advantages: the timeout propagates through downstream calls (vs \`time.After\` which is local), and calling \`cancel()\` releases the timer immediately without waiting for it to fire.

---
`;
