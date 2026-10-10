## Summary

C++20 coroutines provide a compiler-level transformation that turns functions into suspendable state machines. Three keywords drive the system: `co_await` to suspend and wait, `co_yield` to produce values, and `co_return` to complete. The promise type customizes every aspect of coroutine behavior, from initial suspension to exception handling to return value storage.

Unlike Go's goroutines, which are runtime-scheduled stackful green threads with built-in channels and preemption, C++ coroutines are stackless, cooperative, and scheduler-agnostic. They give you maximal control at the cost of writing more machinery. Libraries like `folly::coro` fill the gap with production-ready task types, generators, structured concurrency, and executors.

The fundamental tradeoff: Go gives you concurrency out of the box with minimal boilerplate. C++ gives you a toolkit to build exactly the concurrency model your application needs, with zero overhead you did not ask for.

Choose coroutines when you need lazy evaluation, fine-grained control over scheduling, integration with existing event loops, or minimal per-task memory overhead. Choose goroutines when you want simplicity, rapid development, and a proven runtime that handles scheduling, preemption, and communication for you.

---

| [◀ Chapter 135: Lock-Free Programming](../chapter-135-lock-free-programming/00-introduction.md) | [Chapter 136: Coroutines (C++20)](00-introduction.md) | [Chapter 137: Systems Programming](../chapter-137-systems-programming/00-introduction.md) ▶ |

