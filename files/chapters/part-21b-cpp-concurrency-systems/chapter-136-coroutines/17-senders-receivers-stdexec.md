## Senders, Receivers, and std::execution (P2300)

P2300 (`std::execution`) is the C++ standardization of senders and receivers, voted into C++26 in mid-2024. The reference implementation is NVIDIA's `stdexec`. Predecessor work is libunifex (Meta) and the original P0443 executors proposal that was eventually superseded.

This is the model that will likely sit underneath every async C++ ecosystem in the second half of the decade. It coexists with coroutines and `task<T>`. Understanding both worlds is now table stakes for senior C++.

### The Core Concepts

A sender represents an asynchronous computation that has not started. A receiver is the consumer of one of three terminal signals: value, error, or stopped.

```
sender ----connect(receiver)---> operation_state
operation_state.start() begins the work
when work completes, the receiver gets exactly one of:
    set_value(receiver, results...)
    set_error(receiver, exception_or_error)
    set_stopped(receiver)
```

Three channels (value, error, stopped) instead of two (value, exception). `set_stopped` is the structured cancellation outcome: not an error, just early termination.

A sender is a description. Connecting it to a receiver produces an `operation_state` (an opaque object that holds whatever the sender needs to run). `start(op)` begins execution. The receiver is informed exactly once. This is the protocol.

### Adapter Pipelines

P2300 defines a fluent pipeline syntax via `operator|`:

```cpp
namespace ex = std::execution;

auto pipeline =
    ex::just(42)
    | ex::then([](int x) { return x + 1; })
    | ex::let_value([](int x) {
        return ex::just(x * 2);
      })
    | ex::then([](int x) { return std::format("{}", x); });

auto [result] = stdexec::sync_wait(std::move(pipeline)).value();
// result == "86"
```

Each adapter wraps the upstream sender and produces a new sender. No work runs until something starts the chain. The full graph is a value, so it can be returned, stored, composed.

Common adapters:

- `then(fn)`: transform the value on success.
- `upon_error(fn)`: transform errors.
- `upon_stopped(fn)`: handle cancellation.
- `let_value(fn)`: run another sender derived from the value.
- `let_error(fn)`: error-recovery flow that produces a new sender.
- `when_all(s1, s2, ...)`: run all in parallel, complete with a tuple.
- `on(scheduler, sender)`: run the sender on the scheduler.
- `transfer(scheduler)`: continue subsequent adapters on the scheduler.
- `bulk(n, fn)`: parallel-for over an integer range.

### Schedulers

A scheduler produces senders that complete on it.

```cpp
exec::static_thread_pool pool{8};
auto sched = pool.get_scheduler();

auto work =
    ex::schedule(sched)        // sender that completes on sched
    | ex::then([] { /* runs on pool */ });
```

`on(sched, sender)` is the common idiom: "run this sender starting on `sched`". `transfer(sched)` is "from this point onward, run on `sched`". The two compose for fine-grained executor control.

```cpp
auto pipeline =
    ex::just()
    | ex::let_value([] { return read_file("foo"); })   // starts on default
    | ex::transfer(cpu_sched)                           // hop to cpu pool
    | ex::then(parse)                                   // parse on cpu
    | ex::transfer(io_sched)                            // hop back to io
    | ex::let_value([](auto data) { return write_db(data); });
```

The scheduler hops are explicit. No magic affinity. The executor model pioneered by Asio with `bind_executor` becomes a first-class scheduler.

### Customization Points

The senders dictionary is open. You add new operations by writing senders and adapters that follow the protocol. P2300 specifies tag-based customization points.

```cpp
namespace stdexec {
    template <sender Upstream, typename F>
    struct __my_then_sender { /* ... */ };

    struct my_then_t {
        template <sender S, typename F>
        auto operator()(S&& s, F&& f) const {
            return __my_then_sender{(S&&)s, (F&&)f};
        }
    };
    inline constexpr my_then_t my_then{};
}
```

Senders advertise their behaviors via type queries: `completion_signatures_of_t<S, Env>` tells you what value, error, and stopped signatures the sender produces. This is how `when_all` knows the result type without running anything.

Schedulers can customize adapters. A GPU scheduler can specialize `bulk` to dispatch to the device. The framework picks the customization automatically. This is how stdexec gets its CUDA backend without infesting the core library.

### Receivers and Environments

A receiver carries an environment accessible via `get_env`. The env answers queries:

- `get_stop_token(env)`: the stop token in scope.
- `get_scheduler(env)`: the current scheduler.
- `get_allocator(env)`: the allocator.
- `get_delegatee_scheduler(env)`: the scheduler to use when no other is named.

This is how cancellation and scheduling propagate through a sender chain without being explicit at every adapter.

```cpp
template <typename Receiver>
void start(my_op_state<Receiver>& op) {
    auto stop = stdexec::get_stop_token(stdexec::get_env(op.receiver));
    if (stop.stop_requested()) {
        stdexec::set_stopped(std::move(op.receiver));
        return;
    }
    // ... run ...
}
```

The env is the answer to "how do we propagate cross-cutting context (cancellation, allocators, tracing) without explicit threading"? Coroutines do not have this. P2300 makes it first-class.

### Why P2300 Was Contentious

Three issues drove the long fight.

1. Complexity. The customization-point machinery via tag_invoke is dense. Reading P2300 cold is harder than reading the coroutine TS.
2. Compile time. Heavy use of templates and concepts. Early stdexec compiled benchmarks took 30+ seconds. Recent improvements (stdexec 2.0+) cut this significantly but it remains heavier than coroutines.
3. The "sender vs coroutine" debate. Coroutines have syntax. Senders are values. Both can express async work. The committee preferred senders for the standardization because they compose more cleanly and capture cancellation/error/value in three channels. Coroutines remain in the language and interoperate via `as_awaitable`.

The current stable position: P2300 standardizes the foundation, coroutines remain syntactic sugar that produces senders. `task<T>` becomes an awaitable adapter over the sender world.

### stdexec Library Status (2026)

stdexec (github.com/NVIDIA/stdexec) is the reference implementation. It tracks P2300 closely. Major features:

- Full sender protocol with completion_signatures and env.
- `static_thread_pool` (Niall Douglas's design).
- CUDA scheduler that dispatches `bulk` to GPU.
- `async_scope` for structured spawn.
- `system_context` (platform-default scheduler).

libunifex remains active at Meta but is feature-frozen relative to P2300 changes. New code should target stdexec or wait for the libstdc++/libc++ implementations of `<execution>`. As of GCC 14 and Clang 18, support is partial, full conformance is a 2026-2027 target across implementations.

### Coroutine and Sender Interop

```cpp
// Sender to awaitable.
auto x = co_await stdexec::as_awaitable(some_sender);

// Awaitable to sender (a coroutine task<T> can be connected directly if it satisfies the concept).
auto sender = some_task();
stdexec::sync_wait(std::move(sender));
```

`as_awaitable` plumbs the env through: when the coroutine is awaited within a sender chain, the cancellation token from the env reaches the awaitable's stop_token. The bridge is two-way. You can write a coroutine that awaits a sender, and you can plug a coroutine into a `let_value` adapter.

The choice for new code:

- Pick coroutines for sequential request-handler code where the syntax wins. Pair with a small `task<T>` that interops cleanly.
- Pick senders for compositional pipelines, especially when scheduling and cancellation are first-class concerns.
- Mix freely. The interop is sound.

### A Realistic Pipeline

```cpp
namespace ex = stdexec;

auto handle_request(Req req, exec::async_scope& scope) {
    return
        ex::just(std::move(req))
        | ex::let_value([](auto& r) { return read_db(r.id); })
        | ex::transfer(cpu_pool.get_scheduler())
        | ex::then(parse_and_validate)
        | ex::let_value([](auto data) {
              return ex::when_all(
                  fetch_user(data.user_id),
                  fetch_account(data.account_id));
          })
        | ex::then([](auto user, auto account) {
              return Resp{user, account};
          })
        | ex::upon_error([](auto err) {
              return Resp{.error = format_error(err)};
          });
}

void on_request(Req req) {
    scope_.spawn(handle_request(std::move(req), scope_));
}
```

The whole pipeline is a value. No coroutine frame, no heap allocations beyond what the operations themselves need. Cancellation flows from the scope into the pipeline through the env. Errors hit `upon_error` and produce a fallback Resp without unwinding. This is the production shape.

#### Junior to FAANG callout

A junior reads P2300 once and decides "this is too complex, I'll stick with coroutines and `std::async`". The senior reads P2300 three times, builds a small sender pipeline, measures compile times and runtime, and chooses based on data. The right answer for a CRUD service is often coroutines. The right answer for a streaming pipeline with multiple parallelism boundaries and rich cancellation is often senders. The wrong answer is choosing without measuring.

### Pitfalls

- Forgetting that adapters do not run anything. `auto x = pipeline | ex::then(f);` does nothing until connected and started. `sync_wait`, `start_detached`, or `spawn` actually launch.
- Connecting a sender twice. The protocol forbids it. Save the operation state if you need re-runs.
- Holding references in lambda captures across `transfer` boundaries. The lambda runs on a different thread. Lifetimes must be ensured.
- Mismatched completion signatures: `when_all(s1, s2)` requires both to complete with consistent error types. Errors that propagate through `let_value` chains can produce hard-to-read template diagnostics. Compiler explorer with reduced examples is the way to debug.
- Believing compile time scales linearly with pipeline depth. It does not. Heavy senders compile slowly. Use explicit instantiations or split modules.
