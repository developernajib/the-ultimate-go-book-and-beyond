## gRPC C++ API

gRPC is Google's open-source RPC framework, used at Google, Square, Netflix, Lyft, Cloudflare, and across the cloud-native ecosystem. It uses Protocol Buffers for serialization, HTTP/2 for transport, and generates strongly-typed client and server stubs from `.proto` files. The C++ API is the most powerful, and most verbose, of all the language bindings.

### Setup: Proto → Generated Code

Given a service definition:

```protobuf
// user_service.proto
syntax = "proto3";
package user;

service UserService {
    rpc GetUser(GetUserRequest)           returns (GetUserResponse);
    rpc ListUsers(ListUsersRequest)       returns (stream UserRecord);
    rpc CreateUsers(stream CreateUserReq) returns (CreateUsersResponse);
    rpc Chat(stream ChatMessage)          returns (stream ChatMessage);
}

message GetUserRequest  { int64 user_id = 1; }
message GetUserResponse { string name = 1; string email = 2; }
```

The `protoc` compiler with the `grpc_cpp_plugin` generates:
- `user_service.pb.h` / `.cc`, message types
- `user_service.grpc.pb.h` / `.cc`, service stubs and skeletons

### Unary RPC: Client Side

The gRPC C++ client stub is generated from a `.proto` service definition and wraps each RPC method as a typed function call. `grpc::ClientContext` carries per-call metadata, deadline, and cancellation token. Passing a `std::chrono` deadline via `context.set_deadline` is the standard way to implement per-request timeouts without affecting other in-flight RPCs on the same channel.
```cpp
#include "user_service.grpc.pb.h"
#include <grpcpp/grpcpp.h>

class UserClient {
    std::unique_ptr<user::UserService::Stub> stub_;

public:
    explicit UserClient(std::shared_ptr<grpc::Channel> channel)
        : stub_(user::UserService::NewStub(channel)) {}

    std::optional<user::GetUserResponse> GetUser(int64_t user_id) {
        user::GetUserRequest request;
        request.set_user_id(user_id);

        user::GetUserResponse response;
        grpc::ClientContext context;

        // Set deadline -- 5 seconds from now
        context.set_deadline(
            std::chrono::system_clock::now() + std::chrono::seconds(5)
        );

        // Attach metadata (e.g., auth token)
        context.AddMetadata("authorization", "Bearer " + get_auth_token());

        grpc::Status status = stub_->GetUser(&context, request, &response);

        if (!status.ok()) {
            LOG(ERROR) << "GetUser failed: " << status.error_message()
                       << " code=" << status.error_code();
            return std::nullopt;
        }
        return response;
    }
};

// Create a channel and client
auto channel = grpc::CreateChannel(
    "localhost:50051",
    grpc::InsecureChannelCredentials()  // use SslCredentials() in production
);
UserClient client(channel);
```

### Server-Side Streaming RPC

In server-side streaming, the client sends one request and then reads responses sequentially from a `grpc::ClientReader<T>` until `Read()` returns false. This pattern is well-suited for paginated results or real-time data feeds where the server knows the full result set but the client should not wait for all rows to be buffered in memory before processing begins.
```cpp
// Server streams multiple responses for one request
void ListUsersStream(int64_t department_id) {
    user::ListUsersRequest request;
    request.set_department_id(department_id);

    grpc::ClientContext context;
    user::UserRecord record;

    std::unique_ptr<grpc::ClientReader<user::UserRecord>> reader =
        stub_->ListUsers(&context, request);

    while (reader->Read(&record)) {
        // Process each record as it arrives
        process_user(record);
    }

    grpc::Status status = reader->Finish();
    if (!status.ok()) {
        LOG(ERROR) << "ListUsers failed: " << status.error_message();
    }
}
```

### Client-Side Streaming RPC

Client-side streaming uses a `grpc::ClientWriter<T>` where the client calls `Write()` for each message and `WritesDone()` to signal end-of-stream. The server accumulates all messages and responds once with a single `grpc::Status`. This pattern is efficient for bulk ingestion, uploading a batch of log records or telemetry points, because gRPC flows control through the stream rather than requiring the client to wait for per-message acknowledgments.
```cpp
// Client sends a stream of messages, server responds once
user::CreateUsersResponse BulkCreateUsers(
    const std::vector<user::CreateUserReq>& users
) {
    grpc::ClientContext context;
    user::CreateUsersResponse response;

    std::unique_ptr<grpc::ClientWriter<user::CreateUserReq>> writer =
        stub_->CreateUsers(&context, &response);

    for (const auto& req : users) {
        if (!writer->Write(req)) {
            LOG(WARNING) << "Write failed -- server closed stream early";
            break;
        }
    }

    writer->WritesDone();  // half-close the stream
    grpc::Status status = writer->Finish();
    return response;
}
```

### Bidirectional Streaming RPC

Bidirectional streaming gives both sides a `grpc::ClientReaderWriter<W, R>` that supports interleaved `Read()` and `Write()` calls, making it the gRPC equivalent of a WebSocket. Because reads and writes are independent, the writer thread and reader thread can run concurrently. Coordinating them requires explicit synchronization (a mutex or channel) when the protocol requires a reply before the next message can be sent.
```cpp
// Both sides send streams -- think WebSocket over gRPC
void BidirectionalChat() {
    grpc::ClientContext context;
    std::shared_ptr<grpc::ClientReaderWriter<ChatMessage, ChatMessage>>
        stream = stub_->Chat(&context);

    // Writer thread
    std::thread writer([stream]() {
        ChatMessage msg;
        while (get_next_message(&msg)) {
            if (!stream->Write(msg)) break;
        }
        stream->WritesDone();
    });

    // Reader thread (or same thread with non-blocking reads)
    ChatMessage response;
    while (stream->Read(&response)) {
        handle_response(response);
    }

    writer.join();
    grpc::Status status = stream->Finish();
}
```

### Implementing a Server

A gRPC server implementation derives from the generated `Service::Service` base class and overrides each RPC method. Returning `grpc::Status::OK` signals success while `grpc::Status(grpc::StatusCode::NOT_FOUND, "message")` transmits a structured error the client can inspect via `status.error_code()` and `status.error_message()` without parsing error strings.
```cpp
#include <grpcpp/grpcpp.h>
#include "user_service.grpc.pb.h"

class UserServiceImpl final : public user::UserService::Service {
    grpc::Status GetUser(
        grpc::ServerContext*          context,
        const user::GetUserRequest*   request,
        user::GetUserResponse*        response
    ) override {
        // Check if client canceled
        if (context->IsCanceled()) {
            return grpc::Status(grpc::StatusCode::CANCELED, "canceled");
        }

        // Read client metadata
        auto& metadata = context->client_metadata();
        if (auto it = metadata.find("authorization"); it != metadata.end()) {
            std::string token(it->second.begin(), it->second.end());
            if (!validate_token(token)) {
                return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid token");
            }
        }

        auto user = db_.FindUser(request->user_id());
        if (!user) {
            return grpc::Status(grpc::StatusCode::NOT_FOUND,
                                "user not found: " + std::to_string(request->user_id()));
        }

        response->set_name(user->name);
        response->set_email(user->email);
        return grpc::Status::OK;
    }
};

void RunServer() {
    UserServiceImpl service;
    grpc::ServerBuilder builder;

    // Add credentials (TLS) -- use InsecureServerCredentials() for dev only
    builder.AddListeningPort("0.0.0.0:50051",
                              grpc::InsecureServerCredentials());
    builder.RegisterService(&service);

    // Tune thread pool
    builder.SetSyncServerOption(
        grpc::ServerBuilder::SyncServerOption::NUM_CQS, 4
    );

    std::unique_ptr<grpc::Server> server = builder.BuildAndStart();
    server->Wait();
}
```

### Async API: CompletionQueue

The synchronous API is simpler but ties up a thread per RPC. The async API uses a `CompletionQueue` to multiplex many RPCs over fewer threads:

```cpp
#include <grpcpp/grpcpp.h>

struct AsyncGetUserCall {
    user::GetUserResponse  response;
    grpc::ClientContext    context;
    grpc::Status           status;
    std::unique_ptr<grpc::ClientAsyncResponseReader<user::GetUserResponse>> reader;
};

grpc::CompletionQueue cq;

// Initiate async call -- returns immediately
auto* call = new AsyncGetUserCall;
call->reader = stub_->AsyncGetUser(&call->context, request, &cq);
call->reader->Finish(&call->response, &call->status, (void*)call);

// Poll the completion queue (usually in a dedicated thread)
void* tag;
bool ok;
while (cq.Next(&tag, &ok)) {
    auto* call = static_cast<AsyncGetUserCall*>(tag);
    if (ok && call->status.ok()) {
        handle_response(call->response);
    }
    delete call;
}
```

Go comparison: the Go gRPC API (`google.golang.org/grpc`) hides this complexity entirely. Go's goroutine-per-RPC model means the sync API (which looks like normal function calls) has no thread-pool exhaustion problem, goroutines are cheap. The C++ async API is necessary because OS threads are expensive. This is one of the clearest examples of Go's concurrency model simplifying an entire layer of infrastructure code.

---
