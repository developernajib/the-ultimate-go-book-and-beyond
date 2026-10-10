## 43.6 Testing gRPC Services

### Unit Testing

Unit tests for gRPC handlers call the method directly on the server struct, bypassing the network stack entirely. This isolates business logic from transport concerns and keeps tests fast. The table-driven structure below covers the success path, a not-found case, and an invalid-argument case - the three most common code paths for a lookup RPC.

```go
package server_test

import (
    "context"
    "testing"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    userv1 "github.com/myapp/gen/user/v1"
    "github.com/myapp/server"
)

func TestUserServer_GetUser(t *testing.T) {
    store := NewMockUserStore()
    srv := server.NewUserServer(store)

    // Setup test data
    store.users["user-123"] = &User{
        ID:    "user-123",
        Email: "test@example.com",
        Name:  "Test User",
    }

    tests := []struct {
        name    string
        req     *userv1.GetUserRequest
        want    *userv1.User
        wantErr codes.Code
    }{
        {
            name: "success",
            req:  &userv1.GetUserRequest{Id: "user-123"},
            want: &userv1.User{
                Id:    "user-123",
                Email: "test@example.com",
                Name:  "Test User",
            },
        },
        {
            name:    "not found",
            req:     &userv1.GetUserRequest{Id: "nonexistent"},
            wantErr: codes.NotFound,
        },
        {
            name:    "empty id",
            req:     &userv1.GetUserRequest{Id: ""},
            wantErr: codes.InvalidArgument,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            resp, err := srv.GetUser(context.Background(), tt.req)

            if tt.wantErr != codes.OK {
                if err == nil {
                    t.Fatal("expected error, got nil")
                }
                st, ok := status.FromError(err)
                if !ok {
                    t.Fatalf("expected gRPC error, got: %v", err)
                }
                if st.Code() != tt.wantErr {
                    t.Errorf("code = %v, want %v", st.Code(), tt.wantErr)
                }
                return
            }

            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }

            if resp.GetUser().GetId() != tt.want.GetId() {
                t.Errorf("id = %v, want %v", resp.GetUser().GetId(), tt.want.GetId())
            }
        })
    }
}
```

### Integration Testing with bufconn

Integration tests exercise the full gRPC stack, marshaling, HTTP/2 framing, interceptors, deadline propagation, metadata headers, and handler logic, without opening real network ports. The `google.golang.org/grpc/test/bufconn` package provides an in-memory `net.Listener` backed by a pipe: the server binds to it, and the client dials through a custom `ContextDialer` that returns `lis.Dial()`. The same code paths execute as in production. Only the TCP socket is replaced with an in-memory buffer.

When to use bufconn: verifying that status codes round-trip correctly, that interceptor chains fire in order, that deadlines propagate as `grpc-timeout` headers, that metadata survives the round trip, and that `WithDetails` error payloads deserialize on the client. When to skip it: validating TLS/mTLS handshakes, testing OS-level networking behavior (e.g., NAT or socket tuning), or interop testing against non-Go clients, those need a real `net.Listen("tcp", ":0")`.

The test below creates a user, retrieves it, updates it, deletes it, and verifies the final `GetUser` returns `codes.NotFound`. Note the use of `grpc.NewClient` with `passthrough:///bufnet`, the `passthrough` scheme bypasses DNS resolution so the custom dialer is invoked directly.

```go
package server_test

import (
    "context"
    "net"
    "testing"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/test/bufconn"

    userv1 "github.com/myapp/gen/user/v1"
    "github.com/myapp/server"
)

const bufSize = 1024 * 1024

func setupTestServer(t *testing.T) (userv1.UserServiceClient, func()) {
    // Create in-memory listener
    lis := bufconn.Listen(bufSize)

    // Create server
    grpcServer := grpc.NewServer()
    store := NewInMemoryUserStore()
    userv1.RegisterUserServiceServer(grpcServer, server.NewUserServer(store))

    go func() {
        if err := grpcServer.Serve(lis); err != nil {
            t.Logf("Server error: %v", err)
        }
    }()

    // Create client. Use grpc.NewClient (Dial/DialContext are deprecated).
    // The passthrough:/// scheme skips DNS so our custom dialer is invoked directly.
    conn, err := grpc.NewClient("passthrough:///bufnet",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        t.Fatalf("Failed to create client: %v", err)
    }

    client := userv1.NewUserServiceClient(conn)

    cleanup := func() {
        conn.Close()
        grpcServer.Stop()
    }

    return client, cleanup
}

func TestUserServiceIntegration(t *testing.T) {
    client, cleanup := setupTestServer(t)
    defer cleanup()

    ctx := context.Background()

    // Create user
    createResp, err := client.CreateUser(ctx, &userv1.CreateUserRequest{
        Email:    "test@example.com",
        Name:     "Test User",
        Password: "password123",
        Roles:    []string{"user"},
    })
    if err != nil {
        t.Fatalf("CreateUser failed: %v", err)
    }

    userID := createResp.GetUser().GetId()

    // Get user
    getResp, err := client.GetUser(ctx, &userv1.GetUserRequest{
        Id: userID,
    })
    if err != nil {
        t.Fatalf("GetUser failed: %v", err)
    }

    if getResp.GetUser().GetEmail() != "test@example.com" {
        t.Errorf("email = %v, want test@example.com", getResp.GetUser().GetEmail())
    }

    // Update user
    updateResp, err := client.UpdateUser(ctx, &userv1.UpdateUserRequest{
        Id:   userID,
        Name: stringPtr("Updated Name"),
    })
    if err != nil {
        t.Fatalf("UpdateUser failed: %v", err)
    }

    if updateResp.GetUser().GetName() != "Updated Name" {
        t.Errorf("name = %v, want Updated Name", updateResp.GetUser().GetName())
    }

    // Delete user
    _, err = client.DeleteUser(ctx, &userv1.DeleteUserRequest{
        Id: userID,
    })
    if err != nil {
        t.Fatalf("DeleteUser failed: %v", err)
    }

    // Verify deletion
    _, err = client.GetUser(ctx, &userv1.GetUserRequest{
        Id: userID,
    })
    st, ok := status.FromError(err)
    if !ok || st.Code() != codes.NotFound {
        t.Errorf("expected NotFound error, got: %v", err)
    }
}

func stringPtr(s string) *string {
    return &s
}
```

### Junior → FAANG: Building a Testing Strategy for gRPC Services

The two test patterns shown above (direct method call for unit tests, bufconn for integration tests) are the foundation of a complete gRPC testing strategy. Know when to use each:

**Direct method calls (unit tests):** Use when testing business logic in isolation. Your mock store controls the inputs and outputs. The test is fast (microseconds), deterministic, and focused. Write these for every error code path your handler can return: `OK`, `NotFound`, `InvalidArgument`, `AlreadyExists`, and `Internal` at minimum. Interviewers ask "how do you test that your handler returns the right error code?" and want to see a table-driven test that covers each case.

**bufconn (integration tests):** Use when testing that the full stack works correctly, serialization, interceptor chain, metadata propagation, and deadline handling. Write at least one integration test that exercises the create/read/update/delete lifecycle for each resource your service manages. This catches mistakes that unit tests cannot, such as using the wrong field in a proto response or forgetting to register a required interceptor.

What bufconn does not test: TLS handshakes, OS-level socket tuning, and interop with non-Go clients. For those you need a real network listener. Run these in a separate integration test suite against a deployed environment, not in unit tests.

A first-job checklist for gRPC tests:
- Table-driven unit tests covering all error code paths for each handler.
- At least one bufconn integration test per RPC that exercises the happy path end-to-end.
- A test that verifies deadline propagation: set a very short deadline on the context, confirm the handler returns `codes.DeadlineExceeded` before doing expensive work.
- A test that verifies your error sanitization interceptor converts unknown errors to `codes.Internal` with a safe message.

### Senior @ FAANG: Test Infrastructure and Contract Verification at Scale

**Generated mock clients for consumer-driven contract testing.** The integration test in this chapter tests the server directly with a real client. In a polyglot microservices environment, the more critical test is the consumer-driven contract test: does the Go server satisfy the contract that the Java client was compiled against? This requires proto-level contract testing, not just language-level unit tests. Tools like `buf`'s breaking change detector (which runs in CI) plus service-level integration tests with real generated clients from each consuming language give you confidence that a proto change does not break dependent services before it is deployed.

**Test helpers as platform infrastructure.** The `setupTestServer` function should be a platform utility, not copy-pasted across every service test file. The platform team publishes a `grpctest` package that provides `StartTestServer(t, svc)` (which creates a bufconn listener, starts the server with the standard interceptor chain, returns a client, and registers cleanup with `t.Cleanup`) and `RequireStatusCode(t, err, codes.NotFound)` (which extracts the status from a gRPC error and calls `t.Fatal` if it does not match). Standardizing these helpers means all service tests look the same, can be linted for common mistakes, and benefit from improvements to the underlying infrastructure without per-team changes.

**Interceptor testing.** The integration test above does not include the production interceptor chain (auth, rate limiting, error sanitization). This is intentional for unit tests but must be addressed in a separate integration test that builds the server exactly as production does. Create a test fixture that constructs the full server with the production interceptor chain, injects a test implementation of the auth validator, and exercises paths that exercise the interceptors: an unauthenticated call that should return `codes.Unauthenticated`, a rate-limited call that should return `codes.ResourceExhausted` with a `RetryInfo` detail. If the interceptor chain is never tested together with the service implementation, deployment surprises are guaranteed.

**Testing streaming under backpressure.** A streaming integration test that immediately reads all messages from a server stream does not verify correct behavior under a slow consumer. Add a test that introduces an artificial delay in the `Recv` loop and verifies the server respects context cancellation and does not leak goroutines. Use `goleak` or `runtime.NumGoroutine` snapshots before and after the test to detect goroutine leaks introduced by streaming handlers that do not check `ctx.Done()`. This type of test catches the stream-leak incident described in the pitfalls file before it reaches production.

---
