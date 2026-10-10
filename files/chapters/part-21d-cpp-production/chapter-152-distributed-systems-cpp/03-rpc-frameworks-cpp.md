## RPC Frameworks in C++

RPC is the substrate every distributed C++ service is built on. The choice of framework determines tail latency, schema evolution path, and operational complexity for the lifetime of the system. This section walks through the four production-grade C++ RPC stacks and shows how to build a minimal one when none of them fit.

### gRPC C++

gRPC is the de facto industry default. HTTP/2 transport, Protobuf payloads, four streaming modes (unary, server stream, client stream, bidi), and an ecosystem that includes load balancers, service meshes, and observability tooling.

The C++ API has evolved through three generations. The synchronous API is fine for clients and toy servers. The asynchronous completion-queue API is the one used at scale. The newer callback API (sometimes called the "experimental" API for years before it stabilized) is the modern path forward.

#### Synchronous Client

```cpp
#include <grpcpp/grpcpp.h>
#include "billing.grpc.pb.h"

auto channel = grpc::CreateChannel("billing:9000",
                                   grpc::InsecureChannelCredentials());
auto stub = billing::Billing::NewStub(channel);

billing::ChargeRequest req;
req.set_account_id(42);
req.set_amount_cents(1500);

billing::ChargeReply reply;
grpc::ClientContext ctx;
ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(200));
auto status = stub->Charge(&ctx, req, &reply);
if (!status.ok()) {
    LOG(WARNING) << "Charge failed: " << status.error_message();
}
```

Two production-critical points. First, every `ClientContext` must have a deadline. Without one, a hung server will pin a thread and a connection forever. Google's internal style guide makes deadlines mandatory and the linter enforces it. Second, deadlines propagate: when this client is itself a server handling an upstream request, derive the downstream deadline from the upstream's remaining budget minus a fudge factor.

#### Async Server with Completion Queue

The completion-queue API is the high-throughput path. One thread services many in-flight RPCs by polling a queue of completion events.

```cpp
class ChargeRpc {
public:
    ChargeRpc(billing::Billing::AsyncService* svc, grpc::ServerCompletionQueue* cq)
        : svc_(svc), cq_(cq), responder_(&ctx_), state_(CREATE) { Proceed(); }

    void Proceed() {
        if (state_ == CREATE) {
            state_ = PROCESS;
            svc_->RequestCharge(&ctx_, &request_, &responder_, cq_, cq_, this);
        } else if (state_ == PROCESS) {
            new ChargeRpc(svc_, cq_);  // accept the next one.
            reply_.set_ok(true);
            state_ = FINISH;
            responder_.Finish(reply_, grpc::Status::OK, this);
        } else {  // FINISH
            delete this;
        }
    }

private:
    enum State { CREATE, PROCESS, FINISH } state_;
    billing::Billing::AsyncService* svc_;
    grpc::ServerCompletionQueue* cq_;
    grpc::ServerContext ctx_;
    billing::ChargeRequest request_;
    billing::ChargeReply reply_;
    grpc::ServerAsyncResponseWriter<billing::ChargeReply> responder_;
};

void RunServer() {
    billing::Billing::AsyncService service;
    grpc::ServerBuilder builder;
    builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
    builder.RegisterService(&service);
    auto cq = builder.AddCompletionQueue();
    auto server = builder.BuildAndStart();

    new ChargeRpc(&service, cq.get());
    void* tag;
    bool ok;
    while (cq->Next(&tag, &ok)) {
        static_cast<ChargeRpc*>(tag)->Proceed();
    }
}
```

The `tag` pattern (passing `this` as the cookie) is the heart of the async API. Every operation completes by surfacing its tag, and your code uses it to find which state machine to advance. The completion queue is thread-safe so you can run a pool of `Next()` workers across cores.

#### Callback API (Modern)

```cpp
class BillingImpl final : public billing::Billing::CallbackService {
    grpc::ServerUnaryReactor* Charge(grpc::CallbackServerContext* ctx,
                                     const billing::ChargeRequest* req,
                                     billing::ChargeReply* reply) override {
        reply->set_ok(true);
        auto* reactor = ctx->DefaultReactor();
        reactor->Finish(grpc::Status::OK);
        return reactor;
    }
};
```

The callback API removes the manual state machine. Internally gRPC schedules the user code on a thread pool. Use this for new services unless you have measured that the completion-queue API is faster for your specific workload.

### brpc (Apache, originated at Baidu)

brpc is the production C++ RPC framework most engineers outside Google have not used and probably should. It speaks multiple wire protocols (its own baidu_std, gRPC's HTTP/2, Thrift, Memcache, Redis), supports built-in load balancing strategies (rr, rand, locality-aware, c_murmurhash, c_md5), and ships with **braft** for Raft consensus.

A brpc client looks like this.

```cpp
#include <brpc/channel.h>
#include "billing.pb.h"

brpc::Channel channel;
brpc::ChannelOptions options;
options.timeout_ms = 200;
options.max_retry = 2;
channel.Init("list://10.4.2.17:9000,10.4.2.18:9000", "rr", &options);

billing::BillingService_Stub stub(&channel);
billing::ChargeRequest req;
billing::ChargeReply reply;
brpc::Controller cntl;
stub.Charge(&cntl, &req, &reply, nullptr);
if (cntl.Failed()) LOG(WARNING) << cntl.ErrorText();
```

The single `Channel` holds the connection pool, the load balancing strategy, and the retry policy. The fact that you can give it a list of peers and a strategy without writing a load balancer plugin is the brpc selling point.

brpc's bthread (cooperative M:N user-space threading) means a server thread can yield while waiting for I/O without blocking the OS thread. This gives you tens of thousands of concurrent in-flight RPCs per process at the cost of a stack switch per yield, similar to Go's goroutines but with C++ semantics.

### Cap'n Proto RPC

Cap'n Proto from Kenton Varda (the original author of Protobuf v2) takes a different design point. The wire format is the in-memory format: no encode/decode step. The RPC system supports promise pipelining, where you can call a method on the result of another call before the first completes.

```cpp
auto promise = client.getOrderRequest().send().getOrder().getCustomerRequest().send();
auto customer = promise.wait(waitScope).getCustomer();
```

That single line issues both RPCs in a pipelined fashion: the server fetches the order, then immediately fetches the customer, returning both in one round trip. For chained microservice calls this can cut a multi-hop latency by half.

The trade-off is operational maturity. Cap'n Proto RPC has fewer load balancers, fewer service mesh integrations, and a smaller community than gRPC. Use it when latency dominates and you control both ends.

### Apache Thrift

Thrift originated at Facebook and predates gRPC by years. It supports many transports (framed TCP, HTTP, in-process) and many protocols (binary, compact, JSON). The C++ codegen produces synchronous handlers that look much like gRPC's sync API. The Thrift schema language has richer types than Protobuf (sets, maps with non-string keys natively, enums with explicit values).

The reason to choose Thrift in 2026 is almost always: an existing Thrift-based ecosystem at your company. Facebook still runs on a fork called fbthrift. New green-field projects almost universally pick gRPC or brpc.

### Building a Minimal RPC on Asio + Protobuf

Sometimes none of the production frameworks fit. Latency targets are too tight, the dependency footprint is too heavy, or you need a custom wire format. Here is the skeleton of a minimal RPC framework on Asio with length-prefixed Protobuf messages.

```cpp
#include <asio.hpp>
#include "rpc.pb.h"  // your message types
#include <google/protobuf/message.h>

class RpcSession : public std::enable_shared_from_this<RpcSession> {
public:
    explicit RpcSession(asio::ip::tcp::socket s) : socket_(std::move(s)) {}

    void Start() { ReadHeader(); }

private:
    void ReadHeader() {
        auto self = shared_from_this();
        asio::async_read(socket_, asio::buffer(&header_, sizeof(header_)),
            [self](std::error_code ec, std::size_t) {
                if (ec) return;
                self->body_.resize(self->header_);  // length-prefixed
                self->ReadBody();
            });
    }

    void ReadBody() {
        auto self = shared_from_this();
        asio::async_read(socket_, asio::buffer(body_),
            [self](std::error_code ec, std::size_t) {
                if (ec) return;
                rpc::Request req;
                if (req.ParseFromArray(self->body_.data(), self->body_.size())) {
                    self->Dispatch(req);
                }
                self->ReadHeader();
            });
    }

    void Dispatch(const rpc::Request& req) {
        rpc::Reply reply;
        // Your dispatch table: req.method() -> handler.
        handlers_[req.method()](req, &reply);
        Send(reply);
    }

    void Send(const google::protobuf::Message& m) {
        auto self = shared_from_this();
        auto out = std::make_shared<std::string>();
        m.SerializeToString(out.get());
        uint32_t len = static_cast<uint32_t>(out->size());
        auto hdr = std::make_shared<uint32_t>(len);
        std::array<asio::const_buffer, 2> bufs{
            asio::buffer(hdr.get(), sizeof(uint32_t)),
            asio::buffer(*out)
        };
        asio::async_write(socket_, bufs,
            [hdr, out](std::error_code, std::size_t) {});
    }

    asio::ip::tcp::socket socket_;
    uint32_t header_;
    std::vector<char> body_;
    std::unordered_map<std::string, std::function<void(const rpc::Request&, rpc::Reply*)>> handlers_;
};
```

This is roughly 100 lines from nothing to a working request-response RPC. Production-hardening it requires deadlines, backpressure on the write queue, mTLS via Asio's SSL stream, and per-connection metrics. But it gives you a baseline against which to measure the overhead of gRPC or brpc.

### Choosing a Framework

| Framework | Wire | Strengths | Weaknesses |
|-----------|------|-----------|------------|
| gRPC C++ | HTTP/2 + Protobuf | Ecosystem, streaming, language coverage | Latency overhead, complex async API |
| brpc | Multi-protocol | Throughput, built-in LB, bthreads, braft | Smaller community outside China |
| Cap'n Proto | Custom | Zero-copy, promise pipelining | Smaller ecosystem |
| Thrift | Multi-protocol | Schema richness, polyglot | Stagnant outside Meta |
| Custom on Asio | Whatever | Full control, minimum overhead | You own everything |

The senior-engineer answer in an interview is: "default to gRPC, switch to brpc if we need its built-in features, switch to Cap'n Proto if pipelining materially helps, build custom only when measurement shows the framework is the bottleneck."

---
