export default `## 16.10 Prevention Strategies

### Code Review Checklist

Use the following checklist during code reviews of concurrent Go code. Each item corresponds to a specific anti-pattern covered earlier in this chapter.

- [ ] All shared state protected by mutex or atomic
- [ ] Locks acquired in consistent order
- [ ] All goroutines have exit conditions
- [ ] Channels are closed by senders only
- [ ] Context cancellation is checked
- [ ] No loop variable capture bugs
- [ ] Tests run with -race

### Static Analysis

Static analysis tools catch concurrency issues that code review misses. The race detector instruments every memory access at build time and reports data races at runtime with the exact goroutines and stack traces involved. It should be enabled in CI even if not in production due to its overhead. \`staticcheck\` and \`golangci-lint\` catch a broader class of suspicious patterns including forgotten error returns from goroutines.

\`\`\`bash
# Race detection
go build -race

# Vet for concurrency issues
go vet ./...

# staticcheck
staticcheck ./...

# golangci-lint
golangci-lint run
\`\`\`

### Testing Patterns

Stress-testing concurrent code by launching many goroutines performing simultaneous operations makes data races more likely to manifest even without the race detector. Running such tests under \`go test -race\` combines high contention with race instrumentation, significantly improving the probability of catching subtle timing-dependent bugs that sequential tests cannot expose.

\`\`\`go
// Stress test for race conditions
func TestConcurrentAccess(t *testing.T) {
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < 1000; j++ {
                // Access shared state
            }
        }()
    }
    wg.Wait()
}

// Test with race detector
func TestRace(t *testing.T) {
    // This test should always pass with -race
}
\`\`\`

### Design Principles

1. **Share by communicating**: Use channels instead of shared memory
2. **Minimize shared state**: Fewer shared resources = fewer races
3. **Use immutable data**: Immutable data needs no synchronization
4. **Scope locks narrowly**: Hold locks for minimum time
5. **Prefer higher-level primitives**: sync.Map, errgroup, singleflight

### CI Integration

The prevention strategy is only effective if enforced automatically. CI should:

1. Run \`go test -race\` on every test invocation.
2. Include \`goleak.VerifyTestMain\` in every package.
3. Run \`staticcheck\` and \`go vet\` (catches mutex copy, ineffective locks, etc.).
4. Run \`golangci-lint\` with custom concurrency rules enabled.

Without CI enforcement, every prevention strategy relies on human discipline, which degrades over time. With CI enforcement, regressions are caught before merge.

### Staff Lens: Prevention Is a Multi-Layered Investment

Preventing concurrency bugs requires coordinated effort across layers:

1. **Design review.** Anti-patterns caught at design time are free.
2. **Code review.** Anti-patterns caught at PR time are cheap.
3. **CI testing.** Anti-patterns caught at merge time are moderately expensive.
4. **Production monitoring.** Anti-patterns caught in production are expensive.
5. **Incident postmortem.** Anti-patterns caught after an incident are very expensive.

Invest in earlier layers. Each layer catches what earlier layers miss. Skipping layers means the bug costs more when eventually caught.

---
`;
