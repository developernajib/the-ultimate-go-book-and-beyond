## Coroutines with gRPC and HTTP/3

Modern RPC and HTTP/3 servers in C++ are async by necessity. gRPC C++ exposes a callback-based async API. HTTP/3 implementations like msquic and nghttp3 are event-driven. Wiring either to coroutines is a matter of writing the right awaiters. This chapter shows the integration shape.

### gRPC C++ Async API Overview

gRPC C++ has three API tiers.

1. Synchronous: blocking, one thread per RPC. Easy, slow at scale.
2. Async (CompletionQueue): callback-style with completion queue events. Fast but verbose.
3. Callback API (introduced in gRPC 1.30+): sets a callback on each RPC. The runtime drives a thread pool. Modern, mostly replaces the CQ tier.

For coroutines, the callback API is the sweet spot. We adapt callbacks into awaiters.

### Callback to Awaiter

```cpp
template <typename Resp>
class grpc_unary_awaiter {
    Resp resp_;
    grpc::Status status_;
    std::coroutine_handle<> waiter_;
    std::function<void(std::function<void(Resp&, grpc::Status&)>)> initiate_;

public:
    explicit grpc_unary_awaiter(auto initiate)
        : initiate_{std::move(initiate)} {}

    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        waiter_ = h;
        initiate_([this](Resp& r, grpc::Status& s) {
            resp_ = std::move(r);
            status_ = std::move(s);
            waiter_.resume();
        });
    }
    Resp await_resume() {
        if (!status_.ok()) {
            throw grpc_error{std::move(status_)};
        }
        return std::move(resp_);
    }
};
```

The `initiate` callable encapsulates the gRPC call setup: stub method, request, completion callback. The awaiter parks the coroutine and provides the completion callback to gRPC. When gRPC fires the callback, we move results in and resume.

Wrap a stub method:

```cpp
template <typename StubT, typename Req, typename Resp>
auto async_call(StubT& stub,
                void (StubT::*method)(grpc::ClientContext*, const Req*, Resp*,
                                      std::function<void(grpc::Status)>),
                grpc::ClientContext* ctx, Req req) -> task<Resp> {
    Resp resp;
    co_return co_await grpc_unary_awaiter<Resp>{
        [&](auto cb) {
            (stub.*method)(ctx, &req, &resp, [cb = std::move(cb), &resp](grpc::Status s) mutable {
                cb(resp, s);
            });
        }
    };
}
```

Now from a coroutine you can `co_await async_call(stub, &Stub::AsyncEcho, &ctx, request)`.

### Server-Side Streaming as async_generator

A server-streaming RPC produces multiple responses. The gRPC callback API gives you `Read(Resp*, std::function<void(bool)>)` that fires per response.

```cpp
template <typename Resp>
async_generator<Resp> grpc_server_stream(auto reader_factory) {
    auto reader = reader_factory();
    Resp resp;
    while (true) {
        bool ok = co_await read_awaiter{reader.get(), &resp};
        if (!ok) break;
        co_yield resp;
    }
    grpc::Status status = co_await finish_awaiter{reader.get()};
    if (!status.ok()) throw grpc_error{std::move(status)};
}
```

The generator pairs two awaiters: `read_awaiter` invokes `Read` and waits for the callback, `finish_awaiter` invokes `Finish` to drain the trailing status. Each yield is a complete response. Backpressure exists naturally: if the consumer is slow, the next `Read` call is delayed.

Consumer:

```cpp
task<void> consume(stub& s) {
    grpc::ClientContext ctx;
    Req req{...};
    auto stream = grpc_server_stream<Resp>([&] {
        return s.AsyncListChanges(&ctx, req);
    });
    co_await for (auto&& chunk : stream) {
        co_await process(chunk);
    }
}
```

The for-co_await loop is C++23 (P2502 brings ranges and async ranges). Earlier you write the manual iterator loop.

### Bidirectional Streaming

Two streams: one for sends, one for receives. Both are async. Treat the receive side as an `async_generator<Resp>` and the send side as a `task<void> send(Req)`.

```cpp
template <typename Req, typename Resp>
class bidi_stream {
    std::shared_ptr<grpc_bidi_state> state_;

public:
    task<void> send(Req r) {
        co_await write_awaiter{state_, std::move(r)};
    }
    async_generator<Resp> recv() {
        Resp r;
        while (co_await read_awaiter{state_, &r}) {
            co_yield r;
        }
    }
    task<void> writes_done() { co_await writes_done_awaiter{state_}; }
    task<grpc::Status> finish() { co_return co_await finish_awaiter{state_}; }
};
```

The `state_` is shared because send and recv are independent coroutines (likely spawned separately) but both need access to the underlying gRPC reader-writer. Reference counting ensures cleanup happens after both sides drain.

### Client-Side Cancellation

`grpc::ClientContext::TryCancel()` cancels an in-flight RPC. Wire to stop_token:

```cpp
task<Resp> cancellable_call(stub& s, Req req, std::stop_token st) {
    grpc::ClientContext ctx;
    std::stop_callback cb{st, [&] { ctx.TryCancel(); }};
    co_return co_await async_call(s, &Stub::AsyncEcho, &ctx, std::move(req));
}
```

The callback registers when entering the function, fires on stop, cancels the gRPC call. The gRPC runtime returns `CANCELED` status to the completion callback. The awaiter throws a `grpc_error{CANCELED}` which the user catches at the policy boundary.

The `stop_callback` destructor synchronizes with any in-flight invocation. After the coroutine exits, `ctx.TryCancel()` will not be called again, even if the stop_token is signaled later.

### Server-Side Coroutine Handlers

The gRPC callback API on the server side: register handlers, the runtime drives them. Each handler can be a coroutine.

```cpp
class EchoServiceImpl final : public Echo::CallbackService {
public:
    grpc::ServerUnaryReactor* SayHello(grpc::CallbackServerContext* ctx,
                                        const HelloReq* req, HelloResp* resp) override {
        auto* reactor = ctx->DefaultReactor();
        spawn_detached(handle_say_hello(ctx, req, resp, reactor), scope_);
        return reactor;
    }

private:
    task<void> handle_say_hello(grpc::CallbackServerContext* ctx,
                                const HelloReq* req, HelloResp* resp,
                                grpc::ServerUnaryReactor* reactor) {
        try {
            auto data = co_await fetch_user(req->name());
            resp->set_message("hello " + data.name);
            reactor->Finish(grpc::Status::OK);
        } catch (std::exception& e) {
            reactor->Finish({grpc::StatusCode::INTERNAL, e.what()});
        }
    }
};
```

The reactor is the gRPC handle for the response. Calling `Finish` from inside the coroutine completes the RPC. The coroutine itself is detached: gRPC owns the reactor lifetime, and the coroutine's only output is the call to `Finish`.

`async_scope` (passed as `scope_`) tracks all in-flight handler coroutines so server shutdown can wait for them to drain.

#### Junior to FAANG callout

A junior writes a server handler as a regular function that does blocking IO inside. The gRPC callback thread blocks. Throughput collapses to "one request per callback thread, in flight at a time". The senior wraps the blocking IO in coroutines (or hops to an io_uring backend) and returns the reactor immediately. The callback thread is for orchestration, not work. This is the same lesson Node.js taught everyone in 2010.

### Streaming Responses on the Server

Server-streaming handler with a coroutine generator:

```cpp
grpc::ServerWriteReactor<Resp>* StreamUpdates(
        grpc::CallbackServerContext* ctx, const Req* req) override {
    auto* reactor = new MyReactor(req, scope_);
    reactor->start();
    return reactor;
}

class MyReactor : public grpc::ServerWriteReactor<Resp> {
    Req req_;
    async_scope& scope_;
    std::optional<async_generator<Resp>> gen_;
    std::optional<async_generator<Resp>::iterator> it_;

public:
    void start() {
        scope_.spawn(drive());
    }

    void OnDone() override { delete this; }

    task<void> drive() {
        gen_ = produce_updates(req_);
        co_await gen_->begin();
        while (!gen_->done()) {
            Resp r = std::move(*gen_->it());
            co_await send_awaiter{this, std::move(r)};
            co_await gen_->advance();
        }
        Finish(grpc::Status::OK);
    }

    void OnWriteDone(bool ok) override {
        // resume waiter inside send_awaiter
    }
};
```

The reactor extends `ServerWriteReactor` and pairs with a coroutine that walks an async_generator and writes each value via `send_awaiter`. The reactor's callback (`OnWriteDone`) resumes the awaiter when the network has accepted the write.

The reactor lives until `OnDone`. The coroutine ends when the generator drains. Reference counting (or `async_scope`) keeps both alive cooperatively.

### HTTP/3 with msquic

Microsoft's msquic is a portable QUIC implementation. The C API uses callback-based event delivery. Wrapping with coroutines follows the same shape.

```cpp
struct quic_stream_awaiter {
    QUIC_HANDLE* stream;
    std::span<const uint8_t> data;
    QUIC_STATUS status;
    std::coroutine_handle<> waiter;

    bool await_ready() noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        waiter = h;
        QUIC_BUFFER buf{(uint32_t)data.size(), const_cast<uint8_t*>(data.data())};
        // The send completion event is delivered via the connection's callback,
        // which we route to this awaiter via stream context.
        StreamSetCallbackContext(stream, this);
        status = MsQuic->StreamSend(stream, &buf, 1, QUIC_SEND_FLAG_NONE, this);
        if (QUIC_FAILED(status)) {
            // fail synchronously
            waiter.resume();
        }
    }
    void await_resume() {
        if (QUIC_FAILED(status)) throw quic_error{status};
    }
};
```

The msquic event handler maps `QUIC_STREAM_EVENT_SEND_COMPLETE` back to the awaiter via the context pointer. The coroutine resumes once the kernel acks the send (or the local QUIC stack accepts it, depending on the stream's flow control state).

A QUIC server's per-stream handler:

```cpp
task<void> handle_request(quic_stream& s, async_scope& scope) {
    auto headers = co_await read_h3_headers(s);
    auto body = co_await read_h3_body(s);
    auto resp = co_await dispatch(headers, body);
    co_await write_h3_headers(s, resp.headers);
    co_await write_h3_body(s, resp.body);
    co_await close_stream(s);
}
```

The HTTP/3 framing (HEADERS frame, DATA frames, QPACK encoding) is library-provided (nghttp3 is the common choice). The coroutine layer is unaware of the framing, it sees a stream of bytes and frames.

### nghttp3 Integration

nghttp3 is a callback-based HTTP/3 framer. Wire it to msquic streams and adapt the event callbacks to coroutine awaiters.

The shape:

1. Each QUIC stream becomes an HTTP/3 request stream.
2. nghttp3 calls back when a complete header block is ready, when DATA frames arrive, when stream is closed.
3. The handler coroutine awaits at each phase.

```cpp
class h3_request {
    nghttp3_conn* conn;
    int64_t stream_id;
    std::vector<header> headers;
    std::vector<uint8_t> body;
    std::optional<std::coroutine_handle<>> headers_waiter;
    std::optional<std::coroutine_handle<>> body_waiter;

public:
    auto headers_ready() {
        struct awaiter {
            h3_request* r;
            bool await_ready() noexcept { return !r->headers.empty(); }
            void await_suspend(std::coroutine_handle<> h) {
                r->headers_waiter = h;
            }
            std::vector<header> await_resume() { return std::move(r->headers); }
        };
        return awaiter{this};
    }
    // ... body_ready, etc ...
};
```

The nghttp3 callbacks (`on_headers_complete`, `on_data`, `on_stream_close`) flip flags on the `h3_request` and resume any waiter. The coroutine that handles the request awaits each phase and produces a response.

### Cancellation through QUIC

QUIC supports stream-level cancellation via `STOP_SENDING` and `RESET_STREAM` frames. Map to stop_token:

```cpp
std::stop_callback cb{stop_token, [stream] {
    MsQuic->StreamShutdown(stream, QUIC_STREAM_SHUTDOWN_FLAG_ABORT, 0);
}};
```

The QUIC stack delivers `QUIC_STREAM_EVENT_PEER_RECEIVE_ABORTED` (or local equivalent) which propagates to all waiting awaiters. Each awaiter resolves with an error, the coroutine throws and unwinds.

### Performance Notes

A coroutine-driven gRPC service over io_uring on Linux 6.x typically reaches:

- 600-800K QPS per core for unary calls (small request/response, cache-hot).
- 8-12 GB/s aggregate throughput for streaming RPCs (saturating 100GbE).
- Sub-50us p50 latency end-to-end for cache-hot calls inside one host.

A msquic-based HTTP/3 server with coroutines:

- 200-400K req/s per core depending on TLS overhead and connection migration.
- Latency: 100-300us p50 over loopback, dominated by the QUIC ACK latency.

These numbers are roughly comparable to Tokio + Hyper in Rust. The C++ stack edges ahead on memory (smaller per-coroutine footprint, no garbage collection ceremony) and tracks Rust on CPU.

### Pitfalls

- gRPC's `ClientContext` and `CallbackServerContext` have specific lifetime rules: they outlive the call. A coroutine that captures them by reference must keep them alive through completion. Pass as parameter, store in the frame.
- gRPC reactors must be created on each call, they cannot be reused. The coroutine that drives a reactor is one-shot.
- nghttp3 expects callbacks not to throw. If the awaiter's resume path throws, catch at the callback boundary.
- HTTP/3 connection migration may move a QUIC stream between paths. The coroutine layer is unaffected, but logging that captures network identity (peer IP) at coroutine start may be wrong by the time it logs at coroutine end.
- TLS/QUIC handshake is async with multiple round trips. Wrapping it as a single awaiter is fine, but timeouts on the handshake should be separate from per-request timeouts.
- gRPC's `CompletionQueue` API (the older, lower-level tier) has different lifetime semantics than the callback API. Mixing the two in one process is supported but error-prone.
