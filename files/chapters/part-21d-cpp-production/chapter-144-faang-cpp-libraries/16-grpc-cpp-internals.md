## gRPC C++ Internals

gRPC is the open-source descendant of Google's internal RPC system, Stubby. The public API hides a lot of mechanics. To debug a flaky deadline, write a custom interceptor, or design an async server that holds 50k concurrent streams, you need to know the layers underneath. This file traces a request from the wire up to your generated stub.

### The Stack

```
+------------------------------------------+
| Generated stub: HelloService::Stub::Say  |  proto-typed call
+------------------------------------------+
| Channel + ClientContext + CallCredentials|  load balancing, auth
+------------------------------------------+
| Core C ABI (grpc_call, grpc_op array)    |  language-agnostic core
+------------------------------------------+
| HTTP/2 framing (nghttp2 wrapped)         |  HEADERS, DATA, PING, GOAWAY
+------------------------------------------+
| TCP + TLS (BoringSSL or OpenSSL)         |  bytes
+------------------------------------------+
```

The C++ layer is a thin wrapper over `gRPC Core`, a C library implementing HTTP/2, flow control, and the operation engine. Core is shared with Python, Ruby, PHP, C#, Objective-C. C++ is just one binding.

### Stubby: the Internal Predecessor

Stubby is Google's internal RPC framework, dating back to 2003. It runs on a custom binary protocol (not HTTP/2), uses a separate naming layer (Borg + BNS for service discovery), and integrates with Boq (the load shedding system) and Chubby (for leader election). gRPC was built in 2015 to take Stubby's ideas to the open world over standardized HTTP/2.

If you join Google as L4, you write Stubby code, not gRPC. The APIs are similar enough that knowledge transfers, but the wire format and the naming are different.

### HTTP/2 Framing Layer

Every gRPC call is mapped to one HTTP/2 stream. The mapping:

- Method: HTTP `:path` header is `/<package>.<service>/<method>`.
- Request: one or more HTTP/2 DATA frames carrying length-prefixed protobuf messages.
- Trailers: HTTP/2 HEADERS frame after the DATA frames carrying `grpc-status` and `grpc-message`.

Each gRPC message is framed inside the DATA stream as:

```
+------+--------+----------+
| 1B   | 4B     | N bytes  |
| flag | length | proto    |
+------+--------+----------+
```

The flag byte is 0 for uncompressed, 1 for compressed (with gzip or snappy or whatever the channel negotiated). The length is the proto byte size, big-endian.

gRPC Core wraps `nghttp2` for HTTP/2 framing on the client side and a hand-rolled implementation (`chttp2_transport`) on the server. Flow control, header compression (HPACK), multiplexing of many streams over one TCP connection are all handled here.

### Channel and Credentials

A `grpc::Channel` is a logical connection to a service name. Internally it is a load-balancing policy plus a set of subchannels (one per backend address). The DNS or xDS resolver pushes address updates into the channel, the LB policy (pick_first, round_robin, grpclb, ring_hash, xds) chooses which subchannel handles each call.

```cpp
auto channel = grpc::CreateChannel(
    "dns:///service.example.com:443",
    grpc::SslCredentials(grpc::SslCredentialsOptions{}));
auto stub = HelloService::NewStub(channel);
```

`CallCredentials` (per-call, like an OAuth token) layer on top of `ChannelCredentials` (the connection-level TLS).

### ClientContext and Deadline Propagation

`ClientContext` holds metadata, deadline, and call-scoped credentials. Setting a deadline:

```cpp
grpc::ClientContext ctx;
ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(500));
```

The deadline is sent on the wire as a `grpc-timeout` header. When a server receives a call with `grpc-timeout: 500m`, it sets that deadline on its `ServerContext`. Any outgoing RPC the server makes can pass `ctx.deadline()` through, so deadlines propagate transitively across N hops.

This is the single most important reliability primitive in a microservice mesh. If A calls B with deadline 500 ms, and B calls C, then C should see a deadline of (500 ms minus B's own work so far). Without propagation, you get unbounded queue depths during incidents.

### CallData State Machine (Async Server)

The async server pattern is what high-QPS Google services use. Synchronous gRPC spawns one thread per call. Async runs N completion threads (typically `num_cores`) and multiplexes thousands of in-flight calls on each.

The canonical pattern (from `greeter_async_server.cc`):

```cpp
class CallData {
 public:
  CallData(HelloService::AsyncService* svc, grpc::ServerCompletionQueue* cq)
      : svc_(svc), cq_(cq), responder_(&ctx_), status_(CREATE) {
    Proceed();
  }

  void Proceed() {
    if (status_ == CREATE) {
      status_ = PROCESS;
      svc_->RequestSay(&ctx_, &request_, &responder_, cq_, cq_, this);
    } else if (status_ == PROCESS) {
      // Spawn the next CallData for the next incoming call.
      new CallData(svc_, cq_);
      // Do the work.
      reply_.set_message("hello " + request_.name());
      status_ = FINISH;
      responder_.Finish(reply_, grpc::Status::OK, this);
    } else {
      // FINISH: clean up.
      delete this;
    }
  }

 private:
  enum State { CREATE, PROCESS, FINISH };
  HelloService::AsyncService* svc_;
  grpc::ServerCompletionQueue* cq_;
  grpc::ServerContext ctx_;
  HelloRequest request_;
  HelloResponse reply_;
  grpc::ServerAsyncResponseWriter<HelloResponse> responder_;
  State status_;
};

void RunServer() {
  HelloService::AsyncService svc;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:50051", grpc::InsecureServerCredentials());
  builder.RegisterService(&svc);
  auto cq = builder.AddCompletionQueue();
  auto server = builder.BuildAndStart();

  new CallData(&svc, cq.get());
  void* tag;
  bool ok;
  while (cq->Next(&tag, &ok)) {
    static_cast<CallData*>(tag)->Proceed();
  }
}
```

The `tag` is the user-supplied void pointer that gRPC returns when an op completes. The `CallData` instance is its own tag, advancing through CREATE, PROCESS, FINISH. Each instance handles exactly one call. The factory pattern (one instance creates the next when it transitions to PROCESS) keeps the request queue primed.

For a streaming RPC the state machine has more states (READ, WRITE, FINISH) and you reuse the responder for multiple Read or Write ops.

### Completion Queue

`grpc::CompletionQueue` is the gRPC equivalent of an `epoll` loop. Every async op (RequestX, Read, Write, Finish) takes a `tag`. When the op completes, the tag is enqueued. `cq->Next` blocks until something is ready.

For maximum throughput, you run multiple completion queues (one per server thread) and shard incoming connections across them. The internal `BasicWorkQueue` and `EventEngine` (the modern replacement, since 2022) handle this.

### Generic Stub

`grpc::GenericStub` lets you call services without compile-time knowledge of the protos. The proxy and the gRPC reflection server use this. You hand it a method name and serialized bytes, and it sends them on a stream.

Used for service meshes (Envoy's gRPC support), generic load balancers, debug tools (`grpcurl`).

### Interceptors

`grpc::experimental::Interceptor` (still experimental in C++ as of gRPC 1.60+) lets you observe and modify calls without touching service code. Use cases: auth, tracing, logging, retries.

```cpp
class TraceInterceptor : public grpc::experimental::Interceptor {
 public:
  void Intercept(grpc::experimental::InterceptorBatchMethods* methods) override {
    if (methods->QueryInterceptionHookPoint(
            grpc::experimental::InterceptionHookPoints::PRE_SEND_INITIAL_METADATA)) {
      auto* md = methods->GetSendInitialMetadata();
      md->insert({"x-trace-id", GenerateTraceId()});
    }
    methods->Proceed();
  }
};
```

You attach a factory to the `ChannelArguments` for clients or `ServerBuilder::experimental_type` for servers. Multiple interceptors form a chain.

### Retry Policy

gRPC supports declarative retries via the service config (a JSON blob attached to the channel):

```json
{
  "methodConfig": [{
    "name": [{"service": "example.HelloService"}],
    "retryPolicy": {
      "maxAttempts": 3,
      "initialBackoff": "0.1s",
      "maxBackoff": "1s",
      "backoffMultiplier": 2,
      "retryableStatusCodes": ["UNAVAILABLE", "DEADLINE_EXCEEDED"]
    }
  }]
}
```

The channel reads this and applies retries transparently. Critically, retries respect the deadline. If you have 500 ms total and the first attempt burns 400 ms, the retry gets 100 ms, not a fresh 500 ms. This prevents retry storms during incidents.

`grpc-retry-pushback-ms` is a server header that tells the client to wait before the next retry. Servers under load emit this to shed traffic.

### hedging

Hedging sends a second request after a delay if the first has not returned. Configured similarly to retries:

```json
"hedgingPolicy": {
  "maxAttempts": 2,
  "hedgingDelay": "0.05s",
  "nonFatalStatusCodes": []
}
```

Used at Google for tail-latency-sensitive paths. Trade-off: 2x backend load on slow tails.

### Channelz

Channelz is a built-in introspection service. It exposes channel state, subchannel state, in-flight calls, and per-call counters via a gRPC service that any binary can serve. Visit it with `grpcdebug` or `grpcurl`. Essential for production debugging.

### Junior to FAANG: Async Beats Sync

A junior engineer writes a sync gRPC server with `Service::Say` and ships it. It scales to 500 QPS per core. A FAANG-track engineer reaches for the async pattern, knows what a tag is, and pushes 20k QPS per core on the same hardware. The CallData state machine is the dividing line.

### Senior at FAANG: When You Should Drop to Core

Most C++ code at Google uses the C++ wrapper. Senior engineers know when to drop to the C ABI: writing a custom transport, building a non-blocking embedded server, or wiring gRPC into a runtime that has its own event loop (Envoy does this). The `grpc_call`, `grpc_op` array, and `grpc_completion_queue_pluck` functions are the entry points. You are expected to read `core/lib/surface/call.cc` and find the bug, not file a ticket.
