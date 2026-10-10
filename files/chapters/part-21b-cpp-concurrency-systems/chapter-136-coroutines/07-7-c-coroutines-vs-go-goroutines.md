## 7. C++ Coroutines vs Go Goroutines

This is the comparison that matters most for readers of this book. C++ coroutines and Go goroutines solve overlapping problems with fundamentally different philosophies.

### Scheduling Model

| Aspect | C++ Coroutines | Go Goroutines |
|---|---|---|
| **Type** | Stackless, cooperative | Stackful, preemptive |
| **Scheduling** | No built-in scheduler (you provide one) | Runtime scheduler (GMP model) |
| **Stack** | Heap-allocated frame (~100-500 bytes) | Segmented stack (starts at 2-8 KB, grows) |
| **Suspension** | Only at explicit co_await/co_yield points | At any function call (preemption points) |
| **Creation cost** | Very low (heap alloc + state init) | Low (stack alloc + goroutine struct) |
| **Context switch** | Direct function call (nanoseconds) | Runtime scheduling (~100-300 ns) |
| **Millions of instances** | Yes, minimal memory | Yes, but more memory per goroutine |

### Code Comparison

The same producer-consumer pattern in both languages:

**Go:**
```go
package main

import "fmt"

func producer(ch chan<- int) {
    for i := 0; i < 100; i++ {
        ch <- i    // Blocks if channel is full (preemptive yield)
    }
    close(ch)
}

func consumer(ch <-chan int) {
    for val := range ch {
        fmt.Println(val)
    }
}

func main() {
    ch := make(chan int, 10)
    go producer(ch)
    consumer(ch)
}
```

**C++ (with coroutines):**
```cpp
Generator<int> producer() {
    for (int i = 0; i < 100; ++i) {
        co_yield i;    // Explicit suspension point
    }
}

void consumer() {
    for (int val : producer()) {
        std::cout << val << "\n";
    }
}

int main() {
    consumer();
}
```

### Key Differences

**1. Stackless vs Stackful**: C++ coroutines are stackless, they can only suspend at the top-level function, not in nested calls. Go goroutines are stackful, any function in the call chain can trigger a suspension (via channel operations, I/O, or runtime preemption).

```cpp
// C++ - CANNOT do this:
Generator<int> outer() {
    inner_function();  // If inner_function wants to yield, it can't -
                       // only outer() has the coroutine machinery
}

// Go - CAN do this:
func outer(ch chan<- int) {
    innerFunction(ch)  // innerFunction can freely send on the channel
}
```

**2. Coloring Problem**: C++ coroutines "color" your code. A coroutine returns a special type (`Task<T>`, `Generator<T>`), and callers must handle that type differently. Regular functions and coroutines are not interchangeable. Go has no coloring, any function can be called as a goroutine with `go func()`.

**3. Error Handling**: Go uses explicit error returns (`value, err`). C++ coroutines propagate exceptions through the promise type, allowing normal try/catch.

**4. Communication**: Go goroutines communicate through channels (CSP model). C++ coroutines use direct value passing through co_yield/co_return and must build channel-like abstractions manually or use libraries.

**5. When to Choose Each**:

- **C++ coroutines** excel at: lazy evaluation, state machines, I/O multiplexing in systems with existing event loops, minimal-overhead async in latency-sensitive code.
- **Go goroutines** excel at: concurrent network services, fan-out/fan-in parallelism, simple concurrent pipelines, rapid prototyping of concurrent systems.

---
