## 12.1 Generator Pattern

Generators produce values on demand, enabling lazy evaluation and memory-efficient processing of large or infinite sequences.

### Basic Generator

The generator pattern wraps a goroutine and returns a receive-only channel, transferring ownership of value production to the background goroutine while the caller consumes at its own pace. The channel acts as the synchronization point: the producer blocks on each send until the consumer is ready, so no explicit mutex or condition variable is needed. Closing the channel after all values are sent signals completion to the consumer's `range` loop cleanly.

```go
// generator creates a channel that yields values one at a time
func generator(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}

// Usage
func main() {
    for n := range generator(1, 2, 3, 4, 5) {
        fmt.Println(n)
    }
}
```

### Infinite Generators

Because the generator goroutine blocks on each send until the consumer receives, an infinite loop inside the goroutine does not spin or burn CPU. It simply suspends until the next value is requested. This makes infinite generators practical for mathematical sequences, event streams, and test data factories.

The termination story is where this pattern goes wrong, and it is worth being blunt about it. An infinite generator never closes its output channel, so the consumer has to decide when to stop. But the consumer stopping is *not* enough. If the consumer simply walks away, or a `take` combinator stops reading after ten values, the generator goroutine is left parked forever on `out <- n`, waiting for a receive that will never come. That is a textbook goroutine leak, exactly the shape section 11.8 warns about. A `take` combinator bounds the *consumer*, not the producer.

The only thing that actually retires the producer is a cancellation signal it selects on. So an infinite generator must take a context, and every send must be guarded:

```go
// counter generates an infinite sequence of incrementing integers.
// The ctx case is what lets the goroutine exit. Without it, this
// generator leaks the moment its consumer stops reading.
func counter(ctx context.Context, start int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := start; ; n++ {
            select {
            case <-ctx.Done():
                return
            case out <- n:
            }
        }
    }()
    return out
}

// fibonacci generates the Fibonacci sequence infinitely.
func fibonacci(ctx context.Context) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        a, b := 0, 1
        for {
            select {
            case <-ctx.Done():
                return
            case out <- a:
            }
            a, b = b, a+b
        }
    }()
    return out
}
```

The consumer must therefore always pair an infinite generator with a cancel, and `defer cancel()` is what collects the goroutine:

```go
ctx, cancel := context.WithCancel(context.Background())
defer cancel() // Retires the generator goroutine on the way out.

for v := range take(ctx, 10, fibonacci(ctx)) {
    fmt.Println(v)
}
```

The concurrent Sieve of Eratosthenes is the classic showcase for this pattern, and also the classic illustration of its cost. Each discovered prime adds another `filter` stage, and therefore another goroutine and another channel, chained to the previous one. It is a beautiful demonstration of composition and a genuinely bad way to compute primes: every candidate is copied through the entire chain, so finding the *n*th prime costs O(n) goroutines and a channel hop per stage. A simple sieve over a `[]bool` is orders of magnitude faster. Read it for what it teaches about composition, not as an algorithm to use.

```go
// primes generates prime numbers using a concurrent sieve.
// Every stage takes ctx so that cancelling the consumer tears down
// the whole chain rather than stranding one goroutine per prime.
func primes(ctx context.Context) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        ch := counter(ctx, 2)
        for {
            prime, ok := <-ch
            if !ok {
                return // Upstream cancelled.
            }
            select {
            case <-ctx.Done():
                return
            case out <- prime:
            }
            ch = filter(ctx, ch, prime)
        }
    }()
    return out
}

func filter(ctx context.Context, in <-chan int, prime int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            if n%prime != 0 {
                select {
                case <-ctx.Done():
                    return
                case out <- n:
                }
            }
        }
    }()
    return out
}
```

### Generator Combinators

Combinators are higher-order functions that transform, filter, or limit generators without knowing anything about the values flowing through them. Each combinator takes a channel as input and returns a new channel as output, so they compose naturally: `take(ctx, 10, skip(ctx, 5, fibonacci()))` skips the first five Fibonacci numbers and yields the next ten. Every combinator accepts a `context.Context` for cancellation, preventing goroutine leaks when the consumer stops reading early.

```go
// take limits a generator to n values
func take(ctx context.Context, n int, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for i := 0; i < n; i++ {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }
    }()
    return out
}

// skip discards the first n values
func skip(ctx context.Context, n int, in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)

        // Skip first n
        for i := 0; i < n; i++ {
            select {
            case <-ctx.Done():
                return
            case _, ok := <-in:
                if !ok {
                    return
                }
            }
        }

        // Forward the rest
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }
    }()
    return out
}

// takeWhile yields values while predicate is true
func takeWhile(ctx context.Context, in <-chan int, pred func(int) bool) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok || !pred(v) {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }
    }()
    return out
}

// repeat creates a generator that cycles through values
func repeat(ctx context.Context, values ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for {
            for _, v := range values {
                select {
                case <-ctx.Done():
                    return
                case out <- v:
                }
            }
        }
    }()
    return out
}
```

### Generic Generator

Go 1.18+ generics remove the need to write separate generator and combinator functions for each element type. A single `Generator[T any]` works for integers, strings, structs, or any other type, and the compiler enforces type safety at each composition point. The `Map`, `Filter`, and `Reduce` functions below mirror their functional-programming counterparts, giving you a reusable streaming toolkit that works across any channel-based pipeline.

```go
// Generator creates a channel from any slice
func Generator[T any](ctx context.Context, values ...T) <-chan T {
    out := make(chan T)
    go func() {
        defer close(out)
        for _, v := range values {
            select {
            case <-ctx.Done():
                return
            case out <- v:
            }
        }
    }()
    return out
}

// Map transforms generator values
func Map[T, U any](ctx context.Context, in <-chan T, fn func(T) U) <-chan U {
    out := make(chan U)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                select {
                case <-ctx.Done():
                    return
                case out <- fn(v):
                }
            }
        }
    }()
    return out
}

// Filter keeps values matching predicate
func Filter[T any](ctx context.Context, in <-chan T, pred func(T) bool) <-chan T {
    out := make(chan T)
    go func() {
        defer close(out)
        for {
            select {
            case <-ctx.Done():
                return
            case v, ok := <-in:
                if !ok {
                    return
                }
                if pred(v) {
                    select {
                    case <-ctx.Done():
                        return
                    case out <- v:
                    }
                }
            }
        }
    }()
    return out
}

// Reduce collects values into a single result
func Reduce[T, U any](ctx context.Context, in <-chan T, initial U, fn func(U, T) U) U {
    result := initial
    for {
        select {
        case <-ctx.Done():
            return result
        case v, ok := <-in:
            if !ok {
                return result
            }
            result = fn(result, v)
        }
    }
}
```

### Go 1.23+: `iter.Seq` and Range-Over-Function

Go 1.23 introduced range-over-function iterators via the `iter` package. For many use cases that previously required a channel-based generator, `iter.Seq[T]` provides a cleaner, allocation-free alternative:

```go
func Range(start, end int) iter.Seq[int] {
    return func(yield func(int) bool) {
        for i := start; i < end; i++ {
            if !yield(i) { return }
        }
    }
}

for v := range Range(0, 10) {
    fmt.Println(v)
}
```

The iter version runs in the caller's goroutine (no channel allocation, no goroutine spawn) and supports early termination via the `yield` return. For single-threaded consumption with no concurrent producer, prefer `iter.Seq` over a channel-based generator. For genuine producer-consumer-on-separate-goroutines patterns (lazy loading from I/O while the consumer processes), stick with channels. The two mechanisms serve different needs and both belong in a modern Go engineer's toolkit.

### Staff Lens: Generators vs Streams

At scale, the generator pattern is often the wrong abstraction. For in-memory sequences, a slice or `iter.Seq` wins. For data-on-disk or data-over-network, a stream-processing library (with explicit backpressure, buffer management, and flow control) wins. The channel-based generator is best in the narrow case where the producer is computation-heavy, the consumer can process items fast, and the producer-consumer pair fits in a single process. For anything larger, lift to a real streaming system (Kafka, NATS, Pulsar) where durability, replay, consumer groups, and flow control are the platform's job rather than yours. The staff-level instinct is to recognize when "generator" is too small a hammer for the problem, and specifically to notice that a channel gives you backpressure but nothing else: no durability, no replay, no observability into depth.

---
