export default `## 12.1 Generator Pattern

Generators produce values on demand, enabling lazy evaluation and memory-efficient processing of large or infinite sequences.

### Basic Generator

The generator pattern wraps a goroutine and returns a receive-only channel, transferring ownership of value production to the background goroutine while the caller consumes at its own pace. The channel acts as the synchronization point: the producer blocks on each send until the consumer is ready, so no explicit mutex or condition variable is needed. Closing the channel after all values are sent signals completion to the consumer's \`range\` loop cleanly.

\`\`\`go
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
\`\`\`

### Infinite Generators

Because the generator goroutine blocks on each send until the consumer receives, an infinite loop inside the goroutine does not spin or allocate unbounded memory, it simply suspends until the next value is requested. This makes infinite generators practical for mathematical sequences, event streams, and test data factories. Note that infinite generators never close their output channel, so the consumer must use \`context\` cancellation or a \`take\` combinator to stop reading.

\`\`\`go
// counter generates an infinite sequence of incrementing integers
func counter(start int) <-chan int {
    out := make(chan int)
    go func() {
        for n := start; ; n++ {
            out <- n
        }
    }()
    return out
}

// fibonacci generates the Fibonacci sequence infinitely
func fibonacci() <-chan int {
    out := make(chan int)
    go func() {
        a, b := 0, 1
        for {
            out <- a
            a, b = b, a+b
        }
    }()
    return out
}

// primes generates prime numbers using the Sieve of Eratosthenes
func primes() <-chan int {
    out := make(chan int)
    go func() {
        ch := counter(2)
        for {
            prime := <-ch
            out <- prime
            ch = filter(ch, prime)
        }
    }()
    return out
}

func filter(in <-chan int, prime int) <-chan int {
    out := make(chan int)
    go func() {
        for n := range in {
            if n%prime != 0 {
                out <- n
            }
        }
    }()
    return out
}
\`\`\`

### Generator Combinators

Combinators are higher-order functions that transform, filter, or limit generators without knowing anything about the values flowing through them. Each combinator takes a channel as input and returns a new channel as output, so they compose naturally: \`take(ctx, 10, skip(ctx, 5, fibonacci()))\` skips the first five Fibonacci numbers and yields the next ten. Every combinator accepts a \`context.Context\` for cancellation, preventing goroutine leaks when the consumer stops reading early.

\`\`\`go
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
\`\`\`

### Generic Generator

Go 1.18+ generics remove the need to write separate generator and combinator functions for each element type. A single \`Generator[T any]\` works for integers, strings, structs, or any other type, and the compiler enforces type safety at each composition point. The \`Map\`, \`Filter\`, and \`Reduce\` functions below mirror their functional-programming counterparts, giving you a reusable streaming toolkit that works across any channel-based pipeline.

\`\`\`go
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
\`\`\`

### Go 1.23+: \`iter.Seq\` and Range-Over-Function

Go 1.23 introduced range-over-function iterators via the \`iter\` package. For many use cases that previously required a channel-based generator, \`iter.Seq[T]\` provides a cleaner, allocation-free alternative:

\`\`\`go
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
\`\`\`

The iter version runs in the caller's goroutine (no channel allocation, no goroutine spawn) and supports early termination via the \`yield\` return. For single-threaded consumption with no concurrent producer, prefer \`iter.Seq\` over a channel-based generator. For genuine producer-consumer-on-separate-goroutines patterns (lazy loading from I/O while the consumer processes), stick with channels. The two mechanisms serve different needs and both belong in a modern Go engineer's toolkit.

### Staff Lens: Generators vs Streams

At scale, the generator pattern is often the wrong abstraction. For in-memory sequences, a slice or \`iter.Seq\` wins. For data-on-disk or data-over-network, a stream-processing library (with explicit backpressure, buffer management, and flow control) wins. The channel-based generator is best in the narrow case where the producer is computation-heavy, the consumer can process items fast, and the producer-consumer pair fits in a single process. For anything larger, lift to a real stream processor (Kafka, NATS, or an in-process library like \`github.com/go-chassis/go-chassis\`). The staff-level instinct is to recognise when "generator" is too small a hammer for the problem.

---
`;
