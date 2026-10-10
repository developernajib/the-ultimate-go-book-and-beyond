## 11.4 Select Statement

The `select` statement is Go's control structure for channel operations. It's like a `switch` but for channels.

### Basic Select

`select` blocks until one of its channel cases can proceed, then runs that case. The precise order matters: on entry, the channel operands and the right-hand side of any send are each evaluated exactly once, in source order, regardless of which case is eventually chosen. Only then does the statement wait. If more than one case is ready, Go picks among them at random, providing fair scheduling without any extra logic. That single-evaluation rule is easy to forget and is a real source of bugs, since a function call in a send case runs on every pass through the `select` even when that case loses. A `default` branch makes the entire statement non-blocking, executing immediately when no channel is ready rather than waiting.

```go
select {
case v := <-ch1:
    fmt.Println("received from ch1:", v)
case v := <-ch2:
    fmt.Println("received from ch2:", v)
case ch3 <- value:
    fmt.Println("sent to ch3")
default:
    fmt.Println("no channel ready")
}
```

### Non-Blocking Operations

Adding a `default` case turns any channel operation into a non-blocking check. Without `default`, a `select` with a single channel case behaves identically to a bare send or receive: it blocks until the operation can proceed. With `default`, the statement returns immediately when the channel is not ready, letting you probe a channel's state without committing to wait.

```go
// Non-blocking receive
select {
case v := <-ch:
    fmt.Println("received:", v)
default:
    fmt.Println("nothing ready")
}

// Non-blocking send
select {
case ch <- value:
    fmt.Println("sent")
default:
    fmt.Println("channel full or no receiver")
}
```

### Timeout Pattern

`time.After` returns a channel that receives a value after the specified duration, making it straightforward to add a deadline to any channel-based operation inside a `select`. The pattern below runs the fetch in a goroutine and races its result and error channels against the timer channel, returning whichever arrives first. Using buffered channels of size 1 ensures the goroutine can send its result even if the caller has already returned due to a timeout, preventing a goroutine leak.

```go
func fetchWithTimeout(url string, timeout time.Duration) ([]byte, error) {
    result := make(chan []byte, 1)
    errCh := make(chan error, 1)

    go func() {
        data, err := fetch(url)
        if err != nil {
            errCh <- err
            return
        }
        result <- data
    }()

    select {
    case data := <-result:
        return data, nil
    case err := <-errCh:
        return nil, err
    case <-time.After(timeout):
        return nil, fmt.Errorf("timeout after %v", timeout)
    }
}
```

### Random Selection

When more than one case is ready, Go's runtime picks among them with uniform random probability. This prevents starvation: no channel gets perpetually deprioritized. The function below demonstrates this by running 10,000 iterations against two always-ready channels and showing that each gets selected roughly half the time.

```go
func fairConsumer(ch1, ch2 <-chan int) {
    counts := make(map[string]int)

    for i := 0; i < 10000; i++ {
        select {
        case <-ch1:
            counts["ch1"]++
        case <-ch2:
            counts["ch2"]++
        }
    }

    fmt.Printf("ch1: %d, ch2: %d\n", counts["ch1"], counts["ch2"])
    // Output approximately: ch1: 5000, ch2: 5000
}
```

### Priority Select Pattern

Because `select` chooses randomly among ready cases, it cannot express priority on its own. To always drain a high-priority channel before handling low-priority work, use a two-stage pattern: a non-blocking `select` that checks only the high-priority channel, followed by a blocking `select` that listens to both. The `continue` after the high-priority case jumps back to the first stage, ensuring high-priority messages are fully drained before any low-priority message is processed.

```go
func prioritySelect(high, low <-chan int) {
    for {
        // Priority: drain high-priority first
        select {
        case v := <-high:
            process(v)
            continue  // Check high again
        default:
        }

        // Then check both
        select {
        case v := <-high:
            process(v)
        case v := <-low:
            process(v)
        }
    }
}
```

### Select with Context

Integrating `context.Context` into a `select`-driven worker loop is the idiomatic way to support cancellation and deadlines in Go. The `ctx.Done()` channel is closed when the context is canceled or its deadline expires, so placing it as a case alongside the jobs channel ensures the worker exits promptly rather than processing more work that will ultimately be discarded. Notice that the send of the result is also wrapped in a nested `select` against `ctx.Done()`, preventing the worker from blocking indefinitely when the downstream consumer has stopped reading.

```go
func worker(ctx context.Context, jobs <-chan Job, results chan<- Result) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()  // Canceled or deadline exceeded
        case job, ok := <-jobs:
            if !ok {
                return nil  // Channel closed normally
            }
            result := processJob(job)

            // Also check context when sending result
            select {
            case <-ctx.Done():
                return ctx.Err()
            case results <- result:
            }
        }
    }
}
```

### Empty Select

An empty `select{}` with no cases blocks the current goroutine indefinitely. The runtime detects the deadlock if every goroutine is blocked this way, but it serves as a simple way to park `main` when all real work happens in background goroutines. In production code, prefer signal-based shutdown (covered in section 11.16) instead of blocking forever.

```go
select {}  // Blocks forever

// Useful to keep main alive when goroutines do the work
func main() {
    go startServer()
    select {}  // Block forever
}
```

### time.After in Loops: A Historical Leak, Fixed in Go 1.23

For a decade, `time.After` in a `select` loop was the canonical slow memory leak: each iteration allocated a new timer, and the runtime could not reclaim it until it fired.

```go
for {
    select {
    case v := <-ch: handle(v)
    case <-time.After(time.Second): // leaked until fired, pre-1.23
    }
}
```

Go 1.23 fixed this for modules whose `go` directive is 1.23 or higher: unreferenced timers are garbage collected immediately, and timer channels became unbuffered with synchronous delivery. Two consequences for modern code:

1. **`time.After` in a loop is acceptable again.** The per-iteration allocation still exists (a `Reset` on a reused timer is cheaper in very hot loops), but the unbounded leak is gone.
2. **The drain-before-Reset dance is obsolete.** The old idiom `if !timer.Stop() { <-timer.C }` guarded against a stale value sitting in the buffered timer channel. With unbuffered timer channels there is no stale value to drain, and `timer.Reset` can be called directly:

```go
timer := time.NewTimer(time.Second)
defer timer.Stop()
for {
    select {
    case v := <-ch:
        handle(v)
        timer.Reset(time.Second) // no drain needed on go >= 1.23 modules
    case <-timer.C:
        return
    }
}
```

Go 1.27 completes the transition by removing the `asynctimerchan` GODEBUG escape hatch, so the new semantics are simply the semantics. The historical behavior still matters in two places: modules pinned below `go 1.23`, where the old leak and the old drain idiom both still apply, and interviews, where "why was `time.After` in a loop a leak, and what changed?" is a favorite question precisely because it tests whether your knowledge is current.

### Context-Aware Timeout Instead of time.After

Modern Go replaces the `time.After` timeout pattern with `context.WithTimeout`:

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
select {
case v := <-ch: return v
case <-ctx.Done(): return ctx.Err()
}
```

The context version has two advantages over `time.After`: the timeout propagates through any function the value is handed to (so downstream operations also respect it), and calling `cancel` cleans up the timer immediately without waiting for it to fire. Prefer context-based timeouts in new code.

### Staff Lens: Select as a Design Surface

The shape of a select statement is a design decision, not just a control flow. A select with six cases is a smell. It usually means the code is doing too many things in one loop, or the state machine implicit in the select should be explicit (a state variable with transitions). When you see more than three or four cases, ask whether the loop should be split. Two goroutines each with a focused two-case select are usually easier to reason about than one goroutine with a four-case select.

Similarly, a select with a `default` is a probe, not a wait. Using `default` to avoid blocking is correct in some patterns (non-blocking drain, priority) and wrong in others (busy-loop that burns CPU checking a never-ready channel). The code-review heuristic: if a loop contains a `select` with `default`, verify there is a reason to not block. If not, remove the `default` and let the goroutine block.

### Principal Lens: Select Readability at Scale

A codebase full of intricate select statements is a codebase where every concurrency bug takes a day to debug. The principal-level investment is making concurrent code boring to read. Extract select loops into named functions with clear responsibilities. Use `errgroup` instead of hand-rolled goroutine coordination where it fits. Use `golang.org/x/sync/semaphore` instead of buffered-channel semaphores. Use `context.Context` everywhere. The goal is not to eliminate select (you cannot, it is load-bearing), but to restrict its appearance to the places where it genuinely helps. When a new engineer reads the code, the concurrency shape should be obvious. When a senior engineer reviews it, they should not need to simulate the goroutine interleavings in their head.

---
