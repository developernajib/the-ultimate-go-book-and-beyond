## 14.9 Performance Considerations

### Context Creation Overhead

Context creation is not free: each `WithCancel` or `WithTimeout` allocates a node in the cancellation tree, and `WithTimeout` additionally arms a `time.Timer`. Knowing the per-operation cost guides decisions about creating a context per loop iteration versus reusing a parent.

```go
type ctxKey int

func BenchmarkContextCreation(b *testing.B) {
    parent := context.Background()

    b.Run("WithCancel", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            ctx, cancel := context.WithCancel(parent)
            cancel()
            _ = ctx
        }
    })

    b.Run("WithTimeout", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            ctx, cancel := context.WithTimeout(parent, time.Hour)
            cancel()
            _ = ctx
        }
    })

    b.Run("WithValue", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            // Typed key, not a string: staticcheck SA1029, and it is what
            // real code does, so the benchmark should match.
            ctx := context.WithValue(parent, ctxKey(1), "value")
            _ = ctx
        }
    })
}
```

Measured on an 8-core laptop CPU:

```
BenchmarkContextCreation/WithCancel-8    	 1626092	       148.0 ns/op	      96 B/op	       2 allocs/op
BenchmarkContextCreation/WithTimeout-8   	  466333	       436.4 ns/op	     272 B/op	       4 allocs/op
BenchmarkContextCreation/WithValue-8     	 7491440	        34.96 ns/op	      48 B/op	       1 allocs/op
```

The ordering is the useful part. `WithValue` is cheap: one allocation, no cancellation machinery. `WithTimeout` is roughly 3x `WithCancel` and 12x `WithValue`, because on top of the cancel node it allocates and arms a timer. That is the cost you pay per call, and it is also why discarding the `cancel` matters: the timer stays armed for the full duration instead of being released at once.

**One myth to retire: `WithCancel` does not start a goroutine.** It is frequently claimed that it does. Creating 1000 cancellable contexts and counting:

```
goroutines before=2  after 1000 WithCancel=2  (delta=0)
```

Zero. Cancellation propagates by the parent holding a set of children and calling them directly, not by a goroutine per context watching a channel. A goroutine appears only in one narrow case: when you derive from a **custom** `Context` implementation that the runtime cannot recognize, `context` must spawn one goroutine to watch that parent's `Done()` channel. For every standard context, there is no goroutine. This is a good reason to avoid hand-rolled `Context` implementations, and a bad reason to avoid `WithCancel`.

### Value Lookup Performance

`context.Value` walks the context chain linearly from newest to oldest, comparing keys via interface equality. A key stored ten levels deep requires ten comparisons. A missing key requires walking the entire chain to `Background`. This benchmark quantifies the O(n) lookup cost and motivates the practice of bundling related values into a single struct stored at one context level.

```go
func BenchmarkContextValueLookup(b *testing.B) {
    // Create chain of contexts
    ctx := context.Background()
    for i := 0; i < 10; i++ {
        ctx = context.WithValue(ctx, ctxKey(i), i)
    }

    b.Run("FirstValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value(ctxKey(9)) // Most recent, depth 1
        }
    })

    b.Run("LastValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value(ctxKey(0)) // Oldest, depth 10
        }
    })

    b.Run("MissingValue", func(b *testing.B) {
        for b.Loop() {
            _ = ctx.Value(ctxKey(999)) // Walks the whole chain
        }
    })
}
```

Measured:

```
BenchmarkContextValueLookup/FirstValue-8     	40421610	         5.270 ns/op
BenchmarkContextValueLookup/LastValue-8      	 6739104	        36.51 ns/op
BenchmarkContextValueLookup/MissingValue-8   	 5022483	        46.95 ns/op
```

The shape is exactly the linear walk you would predict: about 5ns at depth 1, about 37ns at depth 10, roughly 3.5ns per level. A missing key is the worst case, since it walks all the way to `Background` before reporting failure, and it is also the case people forget to think about: an optional value that is usually absent costs full chain depth on every lookup.

Keep the magnitudes honest, though. Thirty-seven nanoseconds is not a performance problem. A single database round trip is five orders of magnitude larger. This benchmark justifies bundling related values into one struct, and it does not justify contorting your design around `Value` lookups. The real argument for bundling is coherence, several fields that always travel together should be one value, not five that can individually go missing.

### Best Practices for Performance

Two patterns dominate context performance work: bundling related values into a single struct to limit chain depth, and propagating one context through a loop rather than creating a fresh timeout context per iteration. Per the numbers above, per-iteration `WithTimeout` costs about 436ns and 4 allocations, versus a `select` on an existing `ctx.Done()` at roughly 3ns and zero allocations.

Note that `badLoop` below is not merely slower. It uses `context.Background()`, so it ignores cancellation entirely: the caller can cancel all it likes and the loop grinds through every item regardless. The performance difference is the least interesting thing wrong with it.

```go
// Bundle related values to reduce chain depth
type RequestData struct {
    RequestID string
    UserID    string
    TraceID   string
    StartTime time.Time
}

// A distinct unexported type as the key. Using &contextKey{} requires
// contextKey to be a struct type - if yours is `type contextKey int`,
// use a constant instead.
type requestDataKeyType struct{}

var requestDataKey = requestDataKeyType{}

func WithRequestData(ctx context.Context, data RequestData) context.Context {
    return context.WithValue(ctx, requestDataKey, data)
}

// Single lookup instead of multiple
func GetRequestData(ctx context.Context) (RequestData, bool) {
    data, ok := ctx.Value(requestDataKey).(RequestData)
    return data, ok
}

// BAD: a fresh timeout context per iteration, rooted at Background.
// Slow (436ns + 4 allocs each), and worse, completely uncancellable:
// Background never gets canceled, so the caller cannot stop this loop.
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
```

### Context Performance in Context

Measured costs on an 8-core laptop CPU:

| Operation | Cost | Allocations |
|-----------|------|-------------|
| `ctx.Done()` load | ~3 ns | 0 |
| `ctx.Value(key)` at depth 1 | ~5 ns | 0 |
| `context.WithValue` | ~35 ns | 1 (48 B) |
| `ctx.Value(key)` at depth 10 | ~37 ns | 0 |
| `ctx.Value(missing)`, chain of 10 | ~47 ns | 0 |
| `context.WithCancel` | ~148 ns | 2 (96 B), **no goroutine** |
| `context.WithTimeout` | ~436 ns | 4 (272 B), plus an armed timer |

For most production services these costs are negligible against I/O: a single database round trip dwarfs the entire table. The realistic exception is `WithTimeout` in a tight loop, where 436ns and four allocations per iteration are real, and where the deeper problem is usually that a per-iteration deadline was the wrong design anyway.

If `ctx.Value` genuinely shows up in a profile, look up once at the top of the hot section into a local variable rather than repeating the lookup. But profile first: the odds that context is your bottleneck are very low.

### Staff Lens: Context Micro-Optimization Is Almost Never the Bottleneck

If your service is slow, context is not the cause. The cost of context operations is tiny compared to the cost of the operations that use context (database queries, RPC calls, file I/O). Teams that spend cycles optimizing context usage are almost always optimizing the wrong thing. Profile first, fix the actual bottleneck, and leave context alone.

---
