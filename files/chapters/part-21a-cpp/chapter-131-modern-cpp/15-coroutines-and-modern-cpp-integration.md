## Coroutines and Modern C++ Integration

C++20 introduced the coroutine **language feature** without standard-library types. Functions containing `co_await`, `co_yield`, or `co_return` are coroutines, but until C++23 every project had to define its own promise types or pull in third-party libraries (cppcoro, libunifex, asio). C++23 finally added `std::generator`. C++26 brings `std::lazy` and `std::execution` (senders/receivers). The coroutine ecosystem is finally usable from the standard library alone.

### std::generator (C++23)

A `std::generator<T>` is a coroutine that yields a sequence of `T` values. It models an input range, so it composes with `std::ranges` views.

```cpp
#include <generator>

std::generator<int> count_up(int from, int to) {
    for (int i = from; i < to; ++i) co_yield i;
}

for (int x : count_up(0, 10)) std::print("{} ", x);
```

The coroutine frame is heap-allocated (with potential elision on small frames under the Heap Allocation eLision Optimization, HALO). Each `co_yield` suspends, returns control to the consumer, and resumes on the next `++iterator`. There is no blocking, no thread switch, and no syscall.

Generators compose with views.

```cpp
auto evens = count_up(0, 1000)
           | std::views::filter([](int x){ return x % 2 == 0; })
           | std::views::take(5);

for (int x : evens) std::print("{}\n", x);
```

`std::generator` is a single-pass range. It cannot be sorted, reversed, or random-accessed. It can be filtered, transformed, taken, and dropped.

## Recursive Generators

`std::generator<T>` supports yielding from another generator with `co_yield std::ranges::elements_of(...)`. This is the recursive-generator feature, equivalent to Python's `yield from`.

```cpp
std::generator<int> walk(const Tree& t) {
    co_yield t.value;
    for (const auto& child : t.kids)
        co_yield std::ranges::elements_of(walk(child));
}
```

Without `elements_of`, recursion would re-suspend through every level, costing O(depth) per yielded element. The standard's recursive support flattens the call chain so each yield costs O(1).

### `task<T>` Idioms

A `task<T>` is an asynchronous computation that produces a single value. The standard does not yet provide one (P2300 / `std::execution` is the path forward, shipping fully in C++26). Production code uses cppcoro, folly, or asio's awaitable. The shape is consistent across libraries.

```cpp
// Pseudocode using cppcoro::task.
cppcoro::task<std::string> fetch(std::string url) {
    auto conn = co_await connect(url);
    auto data = co_await read_all(conn);
    co_return std::move(data);
}

cppcoro::task<int> count_words(std::string url) {
    auto body = co_await fetch(std::move(url));
    co_return std::ranges::count(body, ' ') + 1;
}
```

`co_await` suspends the coroutine until the awaited operation completes. The coroutine resumes on whatever thread the awaiter chose. Awaitables for I/O, timers, channels, mutexes, and barriers are how production async runtimes expose primitives.

The C++26 `std::execution` model formalizes this with **senders** and **receivers**. A sender is a lazy description of work. A receiver is a continuation. `co_await` over a sender plugs into the standard execution model and works with whatever scheduler the caller provides.

## Async Ranges

A range whose elements arrive over time is an **async range**. The C++ standard does not yet have one, but the design space is well understood. The pattern.

```cpp
// Pseudocode, sketch using async_generator from cppcoro / unifex.
async_generator<Message> subscribe(Channel& c) {
    while (true) {
        auto m = co_await c.receive();
        if (!m) co_return;
        co_yield std::move(*m);
    }
}

co_await for_each(subscribe(channel), [](Message m) {
    handle(std::move(m));
});
```

`co_await for_each` is itself a coroutine that drives the async range. Each iteration suspends on the next message. The model unifies pull-based iteration over async data with the synchronous range pipeline.

### Integrating Coroutines with std::format

Coroutines that produce log records benefit from `std::format`'s zero-allocation paths.

```cpp
std::generator<std::string> formatted_lines(std::generator<LogRecord> src) {
    for (auto&& r : src) {
        co_yield std::format("[{:%F %T}] {} {}", r.ts, r.level, r.message);
    }
}
```

For higher throughput, format directly into a shared output iterator, avoiding the intermediate `std::string`.

```cpp
template <typename Out>
std::generator<int> write_lines(std::generator<LogRecord> src, Out out) {
    for (auto&& r : src) {
        std::format_to(out, "[{:%F %T}] {} {}\n", r.ts, r.level, r.message);
        co_yield 1;   // line count
    }
}
```

The coroutine yields a metric (lines written) while pushing formatted output through the iterator. Composes cleanly with sinks that wrap files, sockets, or in-memory buffers.

### Structured Logging via Coroutines

A coroutine-based pipeline reads, parses, transforms, and writes log records without any explicit threading.

```cpp
std::generator<json> parse(std::generator<std::string> src);
std::generator<json> enrich(std::generator<json> src);
std::generator<std::string> serialize(std::generator<json> src);

auto pipeline = serialize(enrich(parse(read_lines("input.log"))));
for (auto&& line : pipeline) write(line);
```

Each stage is an independent coroutine. Backpressure is automatic: a slow consumer suspends the producer chain. A fast consumer pulls eagerly. There is no thread-pool tuning, no queue sizing, no lock contention. The only cost is one heap allocation per coroutine frame, which HALO often elides on small frames.

For multi-threaded variants, replace `std::generator` with `std::execution::sender` chains. The shape stays the same but each stage runs on a scheduler.

### Heap Allocation Elision

Every coroutine call notionally allocates a frame on the heap. The optimizer can prove that the frame's lifetime fits inside the caller's stack frame and elide the allocation. This is **HALO**. It triggers when:

1. The coroutine's lifetime is bounded by the caller (no escape).
2. The frame size is small enough.
3. Optimization level is high enough (`-O2` for Clang and GCC, `/O2` for MSVC).

Profile to confirm. The compiler does not guarantee elision. Production code that calls coroutines in a hot loop should run a microbenchmark to verify the frame allocates once or not at all. If it allocates per call, replace with a pooled allocator via the `std::generator` allocator template parameter or a custom `promise_type` with `operator new` overrides.

### Symmetric Transfer

When one coroutine awaits another, naive implementations push a frame for the awaiter onto the stack and resume it through the coroutine handle. Deep chains overflow the stack. **Symmetric transfer** lets the awaiter return a coroutine handle that the framework resumes directly, replacing the call with a tail call.

Standard `std::generator` and `std::execution` use symmetric transfer internally. Custom promise types should implement `await_suspend` returning a coroutine handle to participate.

### Compiler Support (2026)

`std::generator` ships in libstdc++ from GCC 14, libc++ from Clang 18, and MSVC 17.10+. The coroutine language feature has been stable since GCC 11, Clang 9, and MSVC 19.28.

`std::execution` (P2300) is implemented by reference libraries (NVIDIA's stdexec) and is on track for C++26. Production code using senders today should pin to a specific stdexec or unifex version.

### Junior to FAANG / Senior at FAANG

A junior should write a `std::generator<T>` for sequences that are awkward to express as a range adaptor, compose generators with `std::views`, and recognize when to use `std::ranges::elements_of` for recursive yielding. They should know that coroutines are single-pass and frame-allocating.

A senior is expected to design async ranges, implement custom `promise_type` for domain-specific awaitables, profile HALO behavior to verify allocation elision, integrate sender/receiver patterns with existing thread pools, and reason about coroutine lifetime rules around captured references. They should know why dangling references in coroutines are the most common production crash, how symmetric transfer prevents stack overflow in deep chains, and how to migrate cppcoro / unifex code to `std::execution` when C++26 ships.
