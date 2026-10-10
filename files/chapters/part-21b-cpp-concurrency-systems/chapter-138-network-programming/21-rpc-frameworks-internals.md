## RPC Framework Internals: gRPC, Thrift, Cap'n Proto, FlatBuffers

When a senior engineer joins a team that uses an RPC framework, the most useful thing they can do in the first month is understand what the framework hides. This chapter dissects the four big choices for C++ services.

### 1. gRPC C++ core

gRPC is a layered system: at the bottom, a portable transport (`HTTP/2` over TCP+TLS or QUIC), in the middle the **core** (C, in `src/core`), at the top language wrappers (`src/cpp`, `src/python`, ...). Knowing the core matters because performance and correctness bugs almost always live there.

#### Architecture

```
+----------------------+
|  C++ stub / service  |   user code, generated .grpc.pb.h
+----------------------+
|  C++ wrapper layer   |   src/cpp: ClientContext, ServerCompletionQueue
+----------------------+
|  Core (C surface)    |   src/core: call, channel, completion queue
+----------------------+
|  Transport           |   chttp2 transport, HTTP/2 framer, BDP estimator
+----------------------+
|  Endpoint / iomgr    |   sockets, epoll/iocp, timers
+----------------------+
```

#### Completion queue model

The async path uses one or more `CompletionQueue` objects. Every operation (read message, write message, finish) produces a `tag` (a `void*`) that you receive back from `cq->Next(&tag, &ok)`. The tag is your closure pointer, you switch on its type and resume.

```cpp
class GreeterImpl final : public Greeter::AsyncService {
 public:
  void Run() {
    grpc::ServerBuilder b;
    b.AddListeningPort("0.0.0.0:50051", grpc::InsecureServerCredentials());
    b.RegisterService(this);
    cq_ = b.AddCompletionQueue();
    server_ = b.BuildAndStart();
    new CallData(this, cq_.get());
    void* tag; bool ok;
    while (cq_->Next(&tag, &ok))
      static_cast<CallData*>(tag)->Proceed(ok);
  }
 private:
  std::unique_ptr<grpc::ServerCompletionQueue> cq_;
  std::unique_ptr<grpc::Server> server_;
};

class CallData {
 public:
  CallData(GreeterImpl* svc, grpc::ServerCompletionQueue* cq)
    : svc_(svc), cq_(cq), responder_(&ctx_), state_(CREATE) {
    Proceed(true);
  }
  void Proceed(bool ok) {
    if (!ok) { delete this; return; }
    switch (state_) {
      case CREATE:
        state_ = PROCESS;
        svc_->RequestSayHello(&ctx_, &req_, &responder_, cq_, cq_, this);
        break;
      case PROCESS:
        new CallData(svc_, cq_);                     // accept the next call
        resp_.set_message("Hello, " + req_.name());
        state_ = FINISH;
        responder_.Finish(resp_, grpc::Status::OK, this);
        break;
      case FINISH:
        delete this;
        break;
    }
  }
 private:
  GreeterImpl* svc_;
  grpc::ServerCompletionQueue* cq_;
  grpc::ServerContext ctx_;
  HelloRequest req_; HelloReply resp_;
  grpc::ServerAsyncResponseWriter<HelloReply> responder_;
  enum { CREATE, PROCESS, FINISH } state_;
};
```

Each `CallData` is a state machine. The first `RequestSayHello` registers interest in the next incoming call, when the network has a request, the CQ produces the tag and you transition. The "spawn next CallData on first PROCESS" idiom keeps the listener armed.

#### Threading model

You can run multiple threads pulling from one `CompletionQueue`, or use multiple CQs (one per thread, recommended for high QPS to avoid lock contention inside the CQ). Modern recommendation: one CQ per worker thread, one server-side worker thread per CPU core, plus an "executor" pool for blocking work.

#### Callback API (gRPC 1.40+)

The newer callback API replaces explicit state machines with C++ callbacks. Generated code creates `Reactor` classes:

```cpp
class GreeterImpl final : public Greeter::CallbackService {
 public:
  grpc::ServerUnaryReactor* SayHello(grpc::CallbackServerContext* ctx,
                                     const HelloRequest* req,
                                     HelloReply* resp) override {
    resp->set_message("Hello, " + req->name());
    auto* r = ctx->DefaultReactor();
    r->Finish(grpc::Status::OK);
    return r;
  }
};
```

Underneath, the callback API still drives a CQ, it just hides it. For maximum perf or fine-grained concurrency, the async API is still preferred. For maintainability, the callback API wins.

#### Wire format -- HTTP/2 + protobuf

On the wire, gRPC is HTTP/2 with reserved pseudo-headers (`:path = /pkg.Service/Method`), a custom content-type (`application/grpc`), and length-prefixed protobuf messages on each `DATA` frame. Trailers carry status (`grpc-status`, `grpc-message`).

Each message frame: `[1 byte compression flag][4 byte big-endian length][protobuf bytes]`. Streaming methods send multiple such frames on one HTTP/2 stream.

#### Flow control

HTTP/2 has connection-level and stream-level flow control windows (`WINDOW_UPDATE`). gRPC core implements BDP estimation (bandwidth-delay product) to dynamically adjust window sizes, without it, default 64 KiB windows starve high-BDP links.

#### Hot-path tuning

- `GRPC_ARG_KEEPALIVE_TIME_MS`, `GRPC_ARG_KEEPALIVE_TIMEOUT_MS`: HTTP/2 PING-based keepalive.
- `GRPC_ARG_HTTP2_MAX_PINGS_WITHOUT_DATA = 0` on the client to allow pings on idle (server defaults reject excessive pings).
- `GRPC_ARG_INITIAL_RECONNECT_BACKOFF_MS`, `GRPC_ARG_MAX_RECONNECT_BACKOFF_MS`: control reconnect timing.
- `GRPC_ARG_MAX_RECEIVE_MESSAGE_LENGTH`: default is 4 MiB, raise carefully (memory pressure).
- `GRPC_ARG_USE_LOCAL_SUBCHANNEL_POOL = 1`: per-channel subchannel pool, avoids a global lock under load.

### 2. Apache Thrift

Thrift (Facebook 2007, Apache project since 2008) predates gRPC and is still in heavy use at Meta (FBThrift fork), Pinterest, Airbnb. The C++ flavor has multiple transports (`TSocket`, `TFramedTransport`, `THeaderTransport`), multiple protocols (`TBinaryProtocol`, `TCompactProtocol`, `TJSONProtocol`), and multiple servers (`TThreadedServer`, `TNonblockingServer`, `TThreadPoolServer`).

For a modern C++ service, the realistic choices are:

- **Apache Thrift `TNonblockingServer`** + `TFramedTransport` + `TBinaryProtocol`: classic, libevent-based.
- **Facebook's FBThrift** (`thrift/lib/cpp2`): asynchronous, integrated with Folly, uses `RSocket` or HTTP/2 transports, has its own service router (`SR`).

Wire format (binary protocol): each message is `[name][type][seqid][struct fields]`. Each field carries its own field id and type tag, so adding a new field is backward-compatible if old clients just skip unknown fields. Compact protocol uses zigzag varints, smaller bytes, same semantic.

FBThrift adds:
- Header transport with metadata (priority, timeouts, request id) -- equivalent to gRPC metadata.
- `Stream<T>` for server-streaming.
- Sinks for client-streaming.
- Native TLS via Folly's `AsyncSSLSocket`.

When to pick Thrift over gRPC: an existing Thrift IDL ecosystem, FBThrift's tooling, integration with Folly's coroutines. When to avoid: cross-language polyglot (gRPC has stronger non-C++/Java ecosystems), HTTP/2-required environments.

### 3. Cap'n Proto

Cap'n Proto (Kenton Varda, 2013, the original protobuf author) is **schema + RPC** with two distinguishing features:

1. **Zero-copy reads**: the wire format is the in-memory format. You do not parse, you point a reader at the buffer and access fields directly. No allocation, no copy.
2. **Promise pipelining**: you can call `c.foo().bar().baz()` and the network stack pipelines all three calls into one round trip. The intermediate values are promises that the receiver fulfills locally.

Wire layout: messages are arenas of 8-byte words, 64-bit aligned. Pointers are offsets within the arena. Reading requires only a bounds check.

```cpp
::capnp::MallocMessageBuilder msg;
auto root = msg.initRoot<Person>();
root.setName("Alice");
auto emails = root.initEmails(2);
emails.set(0, "alice@example.com");
emails.set(1, "alice@work.example.com");

::kj::FdOutputStream out(fd);
::capnp::writeMessage(out, msg);

// reader:
::capnp::PackedFdMessageReader reader(fd);
auto person = reader.getRoot<Person>();
std::string n = person.getName();   // pointer arithmetic, no alloc
```

When it wins: low-latency local RPC (Sandstorm.io was the canonical user), in-memory IPC where you genuinely cannot afford parse cost, complex object graphs traversed lazily.

When it does not: cross-language ecosystem outside C++ / Rust / TypeScript is thin compared to protobuf. The "no parse" sales pitch is undercut by the fact that protobuf parses small messages in microseconds anyway.

### 4. FlatBuffers

FlatBuffers (Google, 2014) is similar in spirit to Cap'n Proto: read-without-parse. Wire format uses vtables for forward/backward compatibility (so unlike Cap'n Proto's fixed offsets, fields can be reordered).

```cpp
flatbuffers::FlatBufferBuilder b;
auto name = b.CreateString("Alice");
auto e1 = b.CreateString("alice@example.com");
flatbuffers::Offset<flatbuffers::String> emails_arr[] = {e1};
auto emails = b.CreateVector(emails_arr, 1);
auto person = CreatePerson(b, name, emails);
b.Finish(person);
auto buf = b.GetBufferPointer();   // ready to write to socket

// reader:
auto p = GetPerson(buf);
auto n = p->name()->str();
```

Used heavily in game engines (read assets without parse cost), in some Google internal services, and in machine learning model serving (TensorFlow Lite uses FlatBuffers). RPC is bolted on (the `flatbuffers::grpc` adapter speaks gRPC with FlatBuffers payloads).

### 5. Wire format size and decode cost (rough numbers)

For a 1 KiB struct with mixed fields, encoded sizes:

| Format | Size | Decode cost (per-field access) |
|-------------------|------------|--------------------------------|
| Protobuf | baseline | varint decode per field |
| Thrift Binary | ~1.1x | typed, fast |
| Thrift Compact | ~0.85x | varint decode |
| JSON | ~3-5x | parse |
| Cap'n Proto | ~1.2x | pointer chase |
| FlatBuffers | ~1.3x | vtable indirection |

Numbers vary wildly with payload shape. The point: encoding wins are rarely the bottleneck, framework overhead (locks, allocations, completion queue dispatch) usually dominates.

### 6. Choosing per workload

| Workload | Recommendation |
|-------------------------------------------|----------------------------|
| Polyglot microservices, public APIs | gRPC |
| Existing Meta/FB stack | FBThrift |
| Existing Apache stack, Java + C++ | Apache Thrift |
| Latency-critical local IPC | Cap'n Proto |
| ML model serving / asset pipelines | FlatBuffers |
| Browser-facing | gRPC-Web or Connect-RPC |
| HTTP REST mandatory | protobuf + grpc-gateway |

### 7. Common production traps

- gRPC: forgetting to set deadlines. A request without `set_deadline` waits forever. Adopt a global default in your client wrapper.
- gRPC: using the synchronous server in a single-threaded event loop. The sync server has its own thread pool and conflicts with your reactor.
- Thrift: `TThreadedServer` spawns a thread per connection. Fine for 100 connections, fatal for 10,000.
- Cap'n Proto: forgetting that reads are pointer chases into a possibly hostile buffer. Always parse from a `MessageReader` with bounds, never blind-cast a network buffer to a `StructReader`.
- FlatBuffers: schema evolution requires care, misusing `force_align` or removing required fields breaks readers.
- All four: protobuf/thrift/capnp/flatc compilers' generated headers can drag minutes onto every clean build. Use `bazel`/`buck` rules to cache codegen, never run the compiler from CMake's `add_custom_command` without dep tracking.

> Senior @ FAANG: invest one engineer-week in the framework's source. For gRPC C++, that means reading `src/core/lib/transport/transport.h`, `src/core/ext/filters/client_channel/client_channel.cc`, and `src/core/lib/iomgr/ev_epoll1_linux.cc`. The black-box mental model breaks the moment you debug a tail-latency regression, only the source-level model survives.

