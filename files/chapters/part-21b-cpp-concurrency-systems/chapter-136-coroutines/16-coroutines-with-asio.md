## Coroutines with Boost.Asio

Asio is the de-facto C++ networking library. Since Boost 1.75 it has first-class C++20 coroutine support via `boost::asio::awaitable<T>` and `co_spawn`. Production servers built on Asio 1.18+ should use coroutines. The callback style (`async_read(... callback)`) survives only in legacy code and tight inner loops where you measured a real difference.

### boost::asio::awaitable

`awaitable<T, Executor>` is Asio's task type. It is lazy by default and tracks its executor as a template parameter. Every coroutine in Asio land returns `awaitable<T>`.

```cpp
#include <boost/asio.hpp>
namespace asio = boost::asio;
using asio::awaitable;
using asio::use_awaitable;
using asio::ip::tcp;

awaitable<void> echo(tcp::socket sock) {
    char data[1024];
    for (;;) {
        std::size_t n = co_await sock.async_read_some(asio::buffer(data), use_awaitable);
        co_await asio::async_write(sock, asio::buffer(data, n), use_awaitable);
    }
}
```

`use_awaitable` is the completion token that turns Asio's async APIs into awaitables. Replacing it with `asio::detached` produces a fire-and-forget coroutine. With `asio::use_future` you get a future. The completion token is the abstraction that lets one async API serve every concurrency model.

### co_spawn

`awaitable` is lazy. To start a top-level coroutine, you need `co_spawn`.

```cpp
asio::io_context ctx;
asio::co_spawn(ctx, echo(std::move(sock)), asio::detached);
ctx.run();
```

`co_spawn(ex, awaitable, token)` schedules the coroutine on the executor `ex` and reports completion through `token`. With `asio::detached` you get fire-and-forget. With a lambda token you get a callback on completion. With `use_future` you get a `std::future<T>`. With `use_awaitable` you get back an `awaitable<T>` (useful for parent coroutines spawning siblings).

The executor parameter is consequential. Asio attaches every async operation initiated by a coroutine to the coroutine's associated executor. Hopping is explicit:

```cpp
awaitable<void> work() {
    co_await asio::dispatch(asio::bind_executor(other_ex, asio::use_awaitable));
    // now running on other_ex
}
```

### Executor Tracking

Every awaitable carries its executor. When you write `co_await sock.async_read_some(...)`, Asio enforces that `sock`'s executor matches the coroutine's executor (or a strand thereof). Mismatches throw at runtime in debug builds. Production code should configure executors explicitly per coroutine.

```cpp
awaitable<void> handler(tcp::socket sock, asio::strand<asio::any_io_executor> strand) {
    co_await asio::dispatch(asio::bind_executor(strand, asio::use_awaitable));
    // sock and the coroutine now share the strand
    co_await echo(std::move(sock));
}
```

Strands give you per-connection serialization without locks. One strand per session, all session work runs on it. Asio will queue operations behind in-flight ones automatically.

#### Junior to FAANG callout

A junior writes Asio code without understanding strands and adds a `std::mutex` to protect socket state. Asio sockets are not thread-safe, but they are strand-safe. Bind the coroutine to a strand and the mutex disappears, along with its contention. The serialization cost still exists (one operation at a time per session), but it is implicit in the strand and free of explicit locking.

### async_initiate: Adapting Custom Async APIs

The way to make your own async API work with `use_awaitable`, `use_future`, and callbacks uniformly is `async_initiate`. It is the adapter that turns a "start operation, call back when done" function into a token-aware async function.

```cpp
template <typename CompletionToken>
auto async_my_op(int fd, std::span<char> buf, CompletionToken&& token) {
    return asio::async_initiate<CompletionToken, void(boost::system::error_code, size_t)>(
        [fd, buf](auto handler) {
            // start the underlying operation. When done, call:
            //   std::move(handler)(error_code{...}, n_bytes) -             start_underlying(fd, buf, [h = std::move(handler)](auto ec, auto n) mutable {
                std::move(h)(ec, n);
            });
        },
        token);
}
```

After this, `co_await async_my_op(fd, buf, use_awaitable)` works. So does the future and callback variants. One adapter, three concurrency models.

The completion handler `handler` is move-only and must be called exactly once. Calling it twice is undefined. Failing to call it leaks the awaiting coroutine forever (no resumption). This contract is the entire async surface of Asio.

### Mixing Callbacks with Coroutines

You can call legacy callback APIs from coroutines via `async_initiate` or via the simpler one-shot pattern: build a small awaiter inline.

```cpp
template <typename Init>
auto await_callback_api(Init init) {
    struct awaiter {
        Init init;
        std::error_code ec;
        bool ready = false;
        std::coroutine_handle<> waiter;

        bool await_ready() noexcept { return false; }
        void await_suspend(std::coroutine_handle<> h) {
            waiter = h;
            init([this](std::error_code e) {
                ec = e;
                if (waiter) waiter.resume();
            });
        }
        std::error_code await_resume() noexcept { return ec; }
    };
    return awaiter{std::move(init)};
}

awaitable<void> bridge() {
    auto ec = co_await await_callback_api([](auto cb) {
        legacy_async_op(cb);
    });
    if (ec) throw std::system_error{ec};
}
```

The hazard: if `init` invokes the callback synchronously before `await_suspend` returns, the resume happens before the suspend is established. `waiter` is still default-constructed when `cb` runs. Real implementations test for this race: capture the handle inside `await_suspend`, then call `init`, and have `init`'s callback enqueue the resumption rather than calling `resume()` directly when the handle is not yet set.

### Exception Transport Across Awaits

Asio coroutines integrate with C++ exceptions. Errors raised by `async_*` operations appear as exceptions when using `use_awaitable`.

```cpp
awaitable<void> client() {
    try {
        co_await sock.async_connect(endpoint, use_awaitable);
        co_await asio::async_write(sock, buffer, use_awaitable);
    } catch (const boost::system::system_error& e) {
        log_error(e);
    }
}
```

If you prefer error codes (cheaper, no unwinding), use `as_tuple(use_awaitable)`:

```cpp
auto [ec, n] = co_await sock.async_read_some(buf, asio::as_tuple(use_awaitable));
if (ec) { /* handle */ }
```

`as_tuple` returns the completion args as a tuple instead of throwing. For tight loops where every read may fail (network code), this is the senior choice. Throwing per-error allocates an exception object and unwinds through the coroutine frame.

`redirect_error(use_awaitable, ec)` is a third option: the error code goes into a referenced variable, the value is returned normally. Same cost profile as `as_tuple`, slightly more verbose.

### awaitable Cancellation

Asio supports cancellation via `cancellation_signal`. The signal is bound to the `co_spawn` token.

```cpp
asio::cancellation_signal sig;
asio::co_spawn(ctx, work(), asio::bind_cancellation_slot(sig.slot(), asio::detached));

// later, from anywhere:
sig.emit(asio::cancellation_type::terminal);
```

Inside a coroutine you can intercept cancellation with `this_coro::cancellation_state`:

```cpp
awaitable<void> work() {
    auto state = co_await asio::this_coro::cancellation_state;
    if (state.canceled() != asio::cancellation_type::none) co_return;
    // ...
}
```

The cancellation types form a hierarchy: `terminal > partial > total > none`. Operations declare what level they cooperate with. `terminal` is the strongest (always honored, may leave state in undefined shape). `total` is graceful (operation rolls back to a consistent point). Most async operations support `total`.

This is more nuanced than `std::stop_token`'s binary "stop or not". The cost is operations must be authored with a cancellation philosophy. The benefit is precise control over how much rollback you accept.

### Composing with when_all / when_any

Boost.Asio added `experimental::make_parallel_group` for this:

```cpp
namespace this_coro = asio::this_coro;
using namespace asio::experimental::awaitable_operators;

awaitable<void> with_timeout(tcp::socket& sock, asio::steady_timer& timer) {
    auto result = co_await (
        sock.async_read_some(buf, use_awaitable)
        || timer.async_wait(use_awaitable)
    );
    if (result.index() == 1) {
        sock.cancel();
        throw std::runtime_error{"timeout"};
    }
}
```

The `||` operator is the awaitable equivalent of `when_any`. The `&&` operator is `when_all`. Both are in the `awaitable_operators` namespace and require an explicit `using` declaration.

Cancellation propagates: when one branch completes, the others receive a cancellation signal. The branch that completed first wins, the others are canceled and their results discarded.

### SSL/TLS Integration

Asio's SSL stream wraps OpenSSL. With coroutines:

```cpp
awaitable<void> https_client(asio::ssl::context& ssl_ctx, std::string host) {
    auto resolver = asio::ip::tcp::resolver{co_await this_coro::executor};
    auto endpoints = co_await resolver.async_resolve(host, "443", use_awaitable);
    asio::ssl::stream<tcp::socket> stream{co_await this_coro::executor, ssl_ctx};
    co_await asio::async_connect(stream.lowest_layer(), endpoints, use_awaitable);
    stream.set_verify_mode(asio::ssl::verify_peer);
    stream.set_verify_callback(asio::ssl::host_name_verification(host));
    co_await stream.async_handshake(asio::ssl::stream_base::client, use_awaitable);
    // ... use stream like any asio stream ...
    co_await stream.async_shutdown(asio::as_tuple(use_awaitable));
}
```

Note the `as_tuple` on shutdown: `async_shutdown` regularly fails with `stream truncated` from servers that close without proper TLS close_notify. Treat as non-fatal in production.

### Pitfalls

- Calling `ctx.run()` from a coroutine is a deadlock. The coroutine holds the executor, `run()` waits for work.
- Forgetting `co_spawn` and just calling a coroutine: the body never runs (lazy start).
- Capturing references to locals in `co_spawn(ctx, [&]{ ... }, detached)` lambdas. The lambda becomes a coroutine, locals destructed at scope exit. Capture by value or move.
- Mixing `use_awaitable` with non-coroutine code calling `.get()` on a future inside the same `io_context`: deadlock. Use a separate executor for sync waits or do not.
- Setting an executor on the awaitable that does not match the IO objects' executors. Asio requires alignment. Use strands or explicit `bind_executor`.
- Not handling `asio::error::operation_aborted` distinctly: it means the operation was canceled (often by your own timeout), not a network error. Different recovery path.
