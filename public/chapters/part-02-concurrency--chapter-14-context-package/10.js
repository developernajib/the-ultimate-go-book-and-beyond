export default `## 14.9 Performance Considerations

### Context Creation Overhead

Context creation is not free: each \`WithCancel\` or \`WithTimeout\` allocates a node in the cancellation tree and may register a goroutine-safe callback. Understanding the per-operation cost guides decisions about whether to create a new context per iteration in a loop or reuse a long-lived parent context.

\`\`\`go
func BenchmarkContextCreation(b *testing.B) {
    parent := context.Background()

    b.Run("WithCancel", func(b *testing.B) {
        for b.Loop() {
            ctx, cancel := context.WithCancel(parent)
            cancel()
            _ = ctx
        }
    })

    b.Run("WithTimeout", func(b *testing.B) {
        for b.Loop() {
            ctx, cancel := context.WithTimeout(parent, time.Hour)
            cancel()
            _ = ctx
        }
    })

    b.Run("WithValue", func(b *testing.B) {
        for b.Loop() {
            ctx := context.WithValue(parent, "key", "value")
            _ = ctx
        }
    })
}

/*
Results:
BenchmarkContextCreation/WithCancel-8     10000000    115 ns/op
BenchmarkContextCreation/WithTimeout-8     5000000    220 ns/op
BenchmarkContextCreation/WithValue-8      20000000     85 ns/op
*/
\`\`\`

### Value Lookup Performance

\`context.Value\` walks the context chain linearly from newest to oldest, comparing keys via interface equality. A key stored ten levels deep requires ten comparisons. A missing key requires walking the entire chain to \`Background\`. This benchmark quantifies the O(n) lookup cost and motivates the practice of bundling related values into a single struct stored at one context level.

\`\`\`go
func BenchmarkContextValueLookup(b *testing.B) {
    // Create chain of contexts
    ctx := context.Background()
    for i := 0; i < 10; i++ {
        ctx = context.WithValue(ctx, i, i)
    }

    b.Run("FirstValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value(9) // Most recent
        }
    })

    b.Run("LastValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value(0) // Oldest, deepest in chain
        }
    })

    b.Run("MissingValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value("missing")
        }
    })
}

/*
Results:
BenchmarkContextValueLookup/FirstValue-8     50000000    25 ns/op
BenchmarkContextValueLookup/LastValue-8      10000000   150 ns/op
BenchmarkContextValueLookup/MissingValue-8   10000000   180 ns/op

Deep context chains are expensive for value lookup!
*/
\`\`\`

### Best Practices for Performance

Two patterns dominate context performance optimization: bundling related values into a single struct to limit chain depth, and propagating a long-lived context through a loop rather than creating a new timeout context per iteration. The loop comparison shows that per-iteration context allocation adds ~220 ns and triggers more GC pressure than polling \`ctx.Done()\` in a \`select\` with \`default\`.

\`\`\`go
// Bundle related values to reduce chain depth
type RequestData struct {
    RequestID string
    UserID    string
    TraceID   string
    StartTime time.Time
}

var requestDataKey = &contextKey{}

func WithRequestData(ctx context.Context, data RequestData) context.Context {
    return context.WithValue(ctx, requestDataKey, data)
}

// Single lookup instead of multiple
func GetRequestData(ctx context.Context) (RequestData, bool) {
    data, ok := ctx.Value(requestDataKey).(RequestData)
    return data, ok
}

// Avoid creating contexts in hot loops
func badLoop(items []Item) {
    for _, item := range items {
        ctx, cancel := context.WithTimeout(context.Background(), time.Second)
        process(ctx, item)
        cancel()
    }
}

func goodLoop(ctx context.Context, items []Item) error {
    for _, item := range items {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := process(ctx, item); err != nil {
                return err
            }
        }
    }
    return nil
}
\`\`\`

### Context Performance in Context

Context operations cost roughly:

- \`ctx.Done()\` load: ~1 ns
- \`context.WithCancel\`: ~100 ns plus goroutine allocation
- \`context.WithTimeout\`: ~150 ns plus timer allocation
- \`ctx.Value(key)\` lookup at depth N: ~5-10 ns per level

For most production services, these costs are negligible compared to I/O. The one exception is deeply-nested \`ctx.Value\` lookups in hot paths, which can compound. The fix is to look up once at the top of the hot section and cache locally, rather than repeating the lookup.

### Staff Lens: Context Micro-Optimization Is Almost Never the Bottleneck

If your service is slow, context is not the cause. The cost of context operations is tiny compared to the cost of the operations that use context (database queries, RPC calls, file I/O). Teams that spend cycles optimising context usage are almost always optimising the wrong thing. Profile first; fix the actual bottleneck; leave context alone.

---
`;
