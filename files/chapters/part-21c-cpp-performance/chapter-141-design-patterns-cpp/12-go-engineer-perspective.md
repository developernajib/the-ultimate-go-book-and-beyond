## The Go Engineer's Perspective

After ten sections of C++ patterns, it is worth stepping back and asking: when should a Go engineer reach for each of these tools, and what does their Go intuition map to? The patterns are not alien, they solve the same problems Go solves, just with different trade-offs. Understanding the mapping turns C++ from a foreign language into a familiar one with a different cost model.

### Pattern Mapping Table

| Go Pattern | Problem Solved | C++ Equivalent | Key Difference |
|---|---|---|---|
| `defer f()` | Cleanup on scope exit | RAII / `ScopeGuard` / `std::scope_exit` | C++ is block-scoped, Go is function-scoped |
| `interface{}` / `any` | Hold arbitrary value | `std::any` | C++ requires RTTI. Go's any is built-in |
| Named interface | Polymorphism | Virtual base class | C++ requires explicit inheritance |
| Implicit interface satisfaction | Duck typing | C++20 Concepts | Concepts are checked at constraint site, not use site |
| Type switch `switch v.(type)` | Dispatch on type | `std::visit` + `std::variant` | `std::visit` is exhaustive. Go type switch is not |
| `struct` embedding | Mixin / composition | CRTP mixin / policy inheritance | CRTP resolves return types. Go embedding is simpler |
| Functional options `func(*Config)` | Named optional params | Builder + method chaining | C++ Builder centralizes validation. Go options compose |
| Channels for events | Async event delivery | `AsyncEventBus` + `std::thread` | Go channels have backpressure built in |
| Goroutine-per-state | Concurrent state machine | `std::variant` state machine | C++ variant is synchronous. Go goroutine is concurrent |
| Interface injection | Dependency injection | Constructor injection + interfaces | Both prefer explicit constructor-based DI |
| `sync.Mutex` + shared state | Thread-safe observer | Observer + copy-on-write list | Same problem, same solution |

### What Go Does Better

**Simplicity and safety by default.** Go's interface satisfaction is implicit, you never write `implements`. Forgetting to handle a goroutine panic gives you a crash with a stack trace. Forgetting to handle a C++ exception in a destructor gives you `std::terminate` with less context.

**Concurrency as a first-class tool.** Go's goroutine-per-connection model maps naturally to state machines and event loops. Writing an async event bus in Go is ten lines. The C++ version shown in this chapter is eighty. Go makes the easy concurrent case actually easy.

**No foot-guns around object lifetime.** The dangling pointer problem that motivates RAII, ScopeGuard, and `weak_ptr`-based observer auto-unsubscription does not exist in Go. The garbage collector handles it. C++ gives you control. Go gives you safety. For most application code, safety is worth more.

**Readable error paths.** Go's explicit `error` return forces you to handle failures at each call site. C++ exception-based code can skip error handling across multiple stack frames, RAII is designed to make that safe, but it requires discipline. Go makes the discipline mandatory.

### What C++ Does Better

**Zero-overhead abstractions.** A template Strategy, a policy-based Logger, or a custom type-erased callable with SBO incurs literally zero overhead compared to the abstract interface it replaces. Go interfaces always pay the two-word header + indirect call cost. For per-element comparators, vectorization-critical loops, or embedded systems with no heap, C++ templates are the only tool that delivers both abstraction and performance.

**Compile-time exhaustiveness.** `std::variant` + `std::visit` fails to compile if you miss an alternative. Go type switches silently default. In a large codebase, the difference between a compile error and a runtime panic is the difference between a review comment and an incident.

**Memory layout control.** ECS architectures, custom allocators, SIMD-friendly SoA layouts, all of these require precise control over where data lives in memory. Go gives you structs and slices, but not the ability to say "these 10,000 Position components must be contiguous, 16-byte aligned, and the compiler must auto-vectorize iteration." C++ gives you all of that.

**Richer metaprogramming.** Policy-based design, CRTP, and expression templates let you generate entire families of types at compile time with zero runtime cost. Go's generics (1.18+) cover the common cases but do not yet approach C++ template metaprogramming in expressiveness.

### Which Patterns to Reach For First

As a Go engineer writing C++, start with these patterns, they map most directly to Go idioms:

1. **RAII + ScopeGuard**, reach for this first for any resource management. It is Go's `defer` with more precision.
2. **Constructor injection with interfaces**, identical philosophy to Go. Write `IPaymentProcessor` as a pure virtual base class. Inject it in the constructor.
3. **Builder with method chaining**, when you have more than four constructor parameters, use a builder. The Go functional options pattern and the C++ builder pattern are solving exactly the same readability problem.
4. **`std::function`-based observer**, when you need callbacks with lifetime safety. More powerful than Go's channel fans-out for many-to-many subscriptions.
5. **`std::variant` + `std::visit`**, whenever you find yourself writing `enum class State` + `switch`. Use it for state machines and closed-type ASTs.

Defer these until you need them:

- **Policy-based design**, only when profiling proves virtual dispatch is the bottleneck on a hot path.
- **Custom type erasure**, only when `std::function` allocates and you cannot afford it.
- **ECS**, only for data-intensive iteration over hundreds of thousands of homogeneous entities.
- **Pimpl**, only when build times are a measurable problem or you are shipping a binary ABI.

### The Cost Model Shift

The most important mental shift for a Go engineer in C++ is moving from a "safe by default" model to a "precise by default" model. Go asks you to be explicit about errors and concurrent access. C++ asks you to be explicit about lifetimes, ownership, and the cost of each abstraction. Neither is strictly harder, they are different disciplines. The patterns in this chapter are the vocabulary of C++ discipline: they encode the right answers to the lifetime and abstraction questions so that you do not have to rediscover them.

---
