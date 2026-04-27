export default `## 11.6 WaitGroup

\`sync.WaitGroup\` coordinates goroutine completion. It blocks the calling goroutine until a counter, incremented with \`Add\` and decremented with \`Done\`, reaches zero, guaranteeing all spawned work has finished before the program moves on.

### Correct Usage Pattern

The critical rule with \`WaitGroup\` is that \`Add\` must be called before the goroutine starts, not inside it, because the goroutine may not be scheduled immediately and \`Wait\` could return too early. Using \`defer wg.Done()\` at the top of the goroutine ensures the counter decrements even if the function panics or returns early.

\`\`\`go
func processItems(items []Item) {
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)  // Add BEFORE starting goroutine
        go func(i Item) {
            defer wg.Done()  // Done AFTER work completes
            process(i)
        }(item)
    }

    wg.Wait()  // Wait for ALL Done() calls
}
\`\`\`

### WaitGroup with Results

When goroutines need to return values, a common pattern is to pre-allocate a results slice and let each goroutine write to its own index. This avoids data races because each goroutine owns a distinct memory location, so no mutex is needed to protect the writes.

\`\`\`go
func processAll(items []Item) []Result {
    results := make([]Result, len(items))
    var wg sync.WaitGroup

    for i, item := range items {
        wg.Add(1)
        go func(idx int, it Item) {
            defer wg.Done()
            results[idx] = process(it)  // Safe: each goroutine writes to different index
        }(i, item)
    }

    wg.Wait()
    return results
}
\`\`\`

### WaitGroup with Error Collection

Collecting errors from concurrent goroutines follows the same index-based technique as collecting results. Each goroutine stores its error at its own slot in a parallel errors slice, and after \`Wait\` returns the main goroutine filters out the \`nil\` entries to build the final error list.

\`\`\`go
func processWithErrors(items []Item) ([]Result, []error) {
    results := make([]Result, len(items))
    errors := make([]error, len(items))
    var wg sync.WaitGroup

    for i, item := range items {
        wg.Add(1)
        go func(idx int, it Item) {
            defer wg.Done()
            result, err := process(it)
            results[idx] = result
            errors[idx] = err  // May be nil
        }(i, item)
    }

    wg.Wait()

    // Collect non-nil errors
    var errs []error
    for _, err := range errors {
        if err != nil {
            errs = append(errs, err)
        }
    }

    return results, errs
}
\`\`\`

### Nested WaitGroups

\`WaitGroup\` instances can be nested when work has a two-level structure, such as processing multiple batches where each batch itself contains parallel items. Each level gets its own \`WaitGroup\`. The inner one synchronizes items within a single batch goroutine, while the outer one waits for all batch goroutines to finish.

\`\`\`go
func processBatches(batches [][]Item) {
    var outerWg sync.WaitGroup

    for _, batch := range batches {
        outerWg.Add(1)
        go func(b []Item) {
            defer outerWg.Done()

            var innerWg sync.WaitGroup
            for _, item := range b {
                innerWg.Add(1)
                go func(i Item) {
                    defer innerWg.Done()
                    process(i)
                }(item)
            }
            innerWg.Wait()  // Wait for batch to complete
        }(batch)
    }

    outerWg.Wait()  // Wait for all batches
}
\`\`\`

### Go 1.25+: WaitGroup.Go

Go 1.25 added \`WaitGroup.Go\`, which combines \`Add(1)\`, \`go\`, and \`defer Done()\` into a single call. The pattern becomes:

\`\`\`go
var wg sync.WaitGroup
for _, item := range items {
    wg.Go(func() { process(item) })
}
wg.Wait()
\`\`\`

This eliminates the most common WaitGroup bug: forgetting \`Add\` before starting the goroutine, or forgetting \`defer Done()\` inside it. In Go 1.25+, prefer \`wg.Go\` for new code. For older Go, keep the traditional pattern.

### Prefer \`errgroup.Group\` When Any Goroutine Can Fail

If any of the goroutines can return an error, \`errgroup.Group\` from \`golang.org/x/sync/errgroup\` is almost always a better choice than raw \`sync.WaitGroup\`.

\`\`\`go
g, ctx := errgroup.WithContext(ctx)
for _, item := range items {
    g.Go(func() error { return process(ctx, item) })
}
if err := g.Wait(); err != nil { return err }
\`\`\`

Benefits: first error wins and cancels the shared context, remaining goroutines see \`ctx.Done()\` and exit early instead of doing useless work, the returned error is the first failure. This is the canonical modern Go pattern for concurrent-with-error-propagation. Teaching \`WaitGroup\` without teaching \`errgroup\` is teaching 2015 Go.

### WaitGroup Pitfalls to Flag in Review

1. **\`Add(1)\` inside the goroutine.** The goroutine might not start before \`Wait\` runs, causing the wait to return prematurely. Always add before the goroutine.
2. **Reusing a \`WaitGroup\` without waiting.** Calling \`Add\` after \`Wait\` has returned is a data race. Use a fresh \`WaitGroup\` for each round.
3. **Copying a \`WaitGroup\`.** Like all sync primitives, \`WaitGroup\` must not be copied. \`go vet\` catches this. Pass by pointer, or use an unnamed field in a struct.
4. **\`Done\` never called on panic.** Always use \`defer wg.Done()\`. A panicking goroutine without defer leaks the wait forever.
5. **Negative counter panics.** More \`Done\` than \`Add\`. Usually a logic bug. The runtime panics explicitly so the bug is visible.

### Staff Lens: Replace WaitGroup With Errgroup by Default

For the senior-and-above code review discipline: \`sync.WaitGroup\` without error propagation is a smell in modern Go. The cases where raw \`WaitGroup\` is correct are narrow (truly error-free coordination, which is rare). The default should be \`errgroup.Group\`, and the reviewer should ask "why not errgroup" on any raw WaitGroup PR. This is a small discipline that prevents a large class of "we forgot to handle this goroutine's error" bugs. Write the guideline. Enforce it.

---
`;
