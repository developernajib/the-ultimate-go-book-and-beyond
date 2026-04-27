export default `## 13.5 WaitGroup: Goroutine Synchronization

\`sync.WaitGroup\` waits for a collection of goroutines to complete.

### Basic Usage

\`wg.Add(1)\` must be called before launching the goroutine, not inside it, because the goroutine might be scheduled and complete before \`Add\` is called, causing \`Wait\` to return prematurely. Passing the loop variable as an argument rather than capturing it in the closure avoids the classic loop variable capture bug.

\`\`\`go
func processItems(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)  // Must be before goroutine
        go func(item Item) {
            defer wg.Done()
            process(item)
        }(item)
    }

    wg.Wait()  // Block until all done
}
\`\`\`

### WaitGroup with Error Collection

\`errgroup.Group\` from \`golang.org/x/sync/errgroup\` handles the common pattern of collecting the first error from concurrent goroutines, but when you need all errors, not just the first, a manually managed error slice under a mutex is the straightforward approach. Wrapping each error with the item's identifier makes the aggregate error actionable.

\`\`\`go
func processWithErrors(ctx context.Context, items []Item) error {
    var wg sync.WaitGroup
    var mu sync.Mutex
    var errs []error

    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done()

            if err := processItem(ctx, item); err != nil {
                mu.Lock()
                errs = append(errs, fmt.Errorf("item %s: %w", item.ID, err))
                mu.Unlock()
            }
        }(item)
    }

    wg.Wait()

    if len(errs) > 0 {
        return errors.Join(errs...)
    }
    return nil
}
\`\`\`

### WaitGroup with Semaphore for Concurrency Control

Launching an unbounded number of goroutines can exhaust system resources when processing large batches. A buffered channel of fixed capacity acts as a semaphore: each goroutine must send into the channel before starting work, blocking when the channel is full, and releases its slot by receiving from it when done. Combining this pattern with a \`WaitGroup\` ensures both that concurrency stays bounded and that the function does not return until every item has been processed.

\`\`\`go
func processWithLimit(items []Item, maxConcurrent int) {
    var wg sync.WaitGroup
    sem := make(chan struct{}, maxConcurrent)

    for _, item := range items {
        wg.Add(1)
        sem <- struct{}{}  // Acquire semaphore

        go func(item Item) {
            defer func() {
                <-sem  // Release semaphore
                wg.Done()
            }()
            process(item)
        }(item)
    }

    wg.Wait()
}
\`\`\`

### WaitGroup with Context Cancellation

When any one goroutine encounters a fatal error it makes sense to abandon the remaining work rather than wait for every item to finish. The pattern below uses a single-element buffered error channel to capture the first error without blocking, calls \`cancel()\` to signal all other goroutines to stop, and then drains the \`WaitGroup\` in a separate goroutine so that closing \`errCh\` serves as the completion signal.

\`\`\`go
func processWithCancellation(ctx context.Context, items []Item) error {
    var wg sync.WaitGroup
    errCh := make(chan error, 1)

    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    for _, item := range items {
        wg.Add(1)
        go func(item Item) {
            defer wg.Done()

            select {
            case <-ctx.Done():
                return
            default:
            }

            if err := process(ctx, item); err != nil {
                select {
                case errCh <- err:
                    cancel()  // Cancel other goroutines
                default:
                    // Error already captured
                }
            }
        }(item)
    }

    // Wait in separate goroutine
    go func() {
        wg.Wait()
        close(errCh)
    }()

    // Return first error or nil
    return <-errCh
}
\`\`\`

### Common WaitGroup Mistakes

\`sync.WaitGroup\` misuse tends to fall into a handful of recurring categories, all of which are silent at compile time but cause data races or panics at runtime. The four wrong examples below show calling \`Add\` inside the goroutine, forgetting \`Add\` entirely, mismatching the counter with the actual goroutine count, and reusing the \`WaitGroup\` before \`Wait\` has returned, followed by the correct sequential-batch approach.

\`\`\`go
// Mistake 1: Add inside goroutine
func wrong1() {
    var wg sync.WaitGroup

    for i := 0; i < 10; i++ {
        go func() {
            wg.Add(1)  // WRONG: Race with Wait()!
            defer wg.Done()
            doWork()
        }()
    }

    wg.Wait()  // May return before all Add() calls
}

// Mistake 2: Forgetting Add
func wrong2() {
    var wg sync.WaitGroup

    for i := 0; i < 10; i++ {
        // WRONG: Forgot wg.Add(1)!
        go func() {
            defer wg.Done()  // Will panic: negative counter
            doWork()
        }()
    }

    wg.Wait()
}

// Mistake 3: Wrong counter
func wrong3() {
    var wg sync.WaitGroup
    wg.Add(10)

    for i := 0; i < 9; i++ {  // WRONG: Only 9 iterations
        go func() {
            defer wg.Done()
            doWork()
        }()
    }

    wg.Wait()  // Hangs forever
}

// Mistake 4: Reusing before Wait completes
func wrong4() {
    var wg sync.WaitGroup

    // First batch
    wg.Add(5)
    for i := 0; i < 5; i++ {
        go func() {
            defer wg.Done()
            doWork()
        }()
    }

    // WRONG: Adding before Wait returns
    wg.Add(5)  // May race with Done() from first batch

    wg.Wait()
}

// Correct: Wait fully before reuse
func correct() {
    var wg sync.WaitGroup

    // First batch
    wg.Add(5)
    for i := 0; i < 5; i++ {
        go func() {
            defer wg.Done()
            doWork()
        }()
    }
    wg.Wait()  // Complete first batch

    // Second batch - safe to reuse
    wg.Add(5)
    for i := 0; i < 5; i++ {
        go func() {
            defer wg.Done()
            doWork()
        }()
    }
    wg.Wait()
}
\`\`\`

### Go 1.25+: WaitGroup.Go

Go 1.25 added \`WaitGroup.Go\`:

\`\`\`go
var wg sync.WaitGroup
for _, item := range items {
    wg.Go(func() { process(item) })
}
wg.Wait()
\`\`\`

This combines \`Add(1)\`, \`go\`, and \`defer Done()\` into one call, eliminating the most common bugs (forgetting Add, forgetting defer Done). Prefer \`wg.Go\` in Go 1.25+ code.

### Prefer errgroup When Errors Can Occur

As noted in Chapter 11, raw \`sync.WaitGroup\` is rarely the right choice when goroutines can fail. \`errgroup.Group\` from \`golang.org/x/sync/errgroup\` provides error propagation and shared-context cancellation. Use it by default for concurrent-with-error-propagation patterns. Raw \`WaitGroup\` is for coordination without errors (signal handling, cleanup barriers, simple fan-out without failure modes).

### Staff Lens: WaitGroup as a Legacy Pattern

In modern Go, most \`sync.WaitGroup\` usage can be replaced with \`errgroup\` or the new \`wg.Go\` helper. The raw pattern (\`Add\`, \`go\`, \`defer Done\`, \`Wait\`) is teaching material for understanding the primitive. Production code should use the higher-level helpers. A review finding worth raising: any raw WaitGroup pattern in new code should justify why errgroup or \`wg.Go\` does not fit. Usually it does, and the PR is cleaner after the swap.

---
`;
