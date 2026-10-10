## 43.4 Implementing gRPC Client

### Client Implementation

A gRPC client is constructed by calling `grpc.NewClient` on a target address to obtain a `grpc.ClientConn`, then passing that connection to the generated `New*Client` constructor. The connection is shared across all RPCs and manages the underlying HTTP/2 stream lifecycle. Always attach a deadline via `context.WithTimeout` before calling an RPC to prevent indefinite blocking on slow or unresponsive servers.

**Use `grpc.NewClient`, not `grpc.Dial` or `grpc.DialContext`.** `Dial`/`DialContext` were deprecated in grpc-go v1.63 (2024) and remain deprecated. `NewClient` is lazy, it does not establish a TCP connection until the first RPC, uses the DNS resolver by default (instead of `passthrough`), and treats the target as an RFC 3986 URI. The old `grpc.WithBlock()` option is incompatible with `NewClient` and should not be used: block-on-dial was a common source of production incidents because it turned a transient DNS failure at startup into a fatal `context deadline exceeded`. Production code should surface connection problems through the first RPC's context deadline, not at construction time.

**`ClientConn` is expensive. reuse it.** A `*grpc.ClientConn` owns HTTP/2 transport state, subchannels per-address, keepalive state, and the resolver/balancer loop. Creating one per request destroys the multiplexing advantage and leaks goroutines if `Close` is missed. Treat `ClientConn` as process-scoped (one per target, stored in a package-level singleton or injected dependency) and call `Close` only at shutdown.

**Transport credentials in production.** Use real credentials via `credentials.NewTLS` or `credentials.NewClientTLSFromFile`. `insecure.NewCredentials()` disables TLS entirely, acceptable for unit tests and localhost, never for anything that crosses a trust boundary. The examples below use `insecure` to keep the focus on the client API. A production `NewUserClient` would accept a `credentials.TransportCredentials` parameter.

```go
package client

import (
    "context"
    "io"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"

    userv1 "github.com/myapp/gen/user/v1"
)

// UserClient wraps the gRPC client
type UserClient struct {
    conn   *grpc.ClientConn
    client userv1.UserServiceClient
}

// NewUserClient creates a new user client.
// The returned ClientConn is lazy: no TCP connection is opened until the first RPC.
// Connection errors surface via the first RPC's context (typically as codes.Unavailable).
func NewUserClient(address string) (*UserClient, error) {
    conn, err := grpc.NewClient(address,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        // Keepalive keeps long-lived connections through stateful NATs/LBs and
        // detects half-open connections faster than TCP keepalive alone.
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                30 * time.Second,
            Timeout:             10 * time.Second,
            PermitWithoutStream: true,
        }),
    )
    if err != nil {
        return nil, err
    }

    return &UserClient{
        conn:   conn,
        client: userv1.NewUserServiceClient(conn),
    }, nil
}

// Close closes the client connection
func (c *UserClient) Close() error {
    return c.conn.Close()
}

// GetUser calls the GetUser RPC
func (c *UserClient) GetUser(ctx context.Context, id string) (*userv1.User, error) {
    resp, err := c.client.GetUser(ctx, &userv1.GetUserRequest{
        Id: id,
    })
    if err != nil {
        return nil, err
    }
    return resp.GetUser(), nil
}

// CreateUser calls the CreateUser RPC
func (c *UserClient) CreateUser(ctx context.Context, email, name, password string, roles []string) (*userv1.User, error) {
    resp, err := c.client.CreateUser(ctx, &userv1.CreateUserRequest{
        Email:    email,
        Name:     name,
        Password: password,
        Roles:    roles,
    })
    if err != nil {
        return nil, err
    }
    return resp.GetUser(), nil
}

// ListUsers streams users from the server
func (c *UserClient) ListUsers(ctx context.Context, pageSize int32, statusFilter userv1.UserStatus) ([]*userv1.User, error) {
    stream, err := c.client.ListUsers(ctx, &userv1.ListUsersRequest{
        PageSize:     pageSize,
        StatusFilter: statusFilter,
    })
    if err != nil {
        return nil, err
    }

    var users []*userv1.User
    for {
        user, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return nil, err
        }
        users = append(users, user)
    }

    return users, nil
}

// BulkCreateUsers streams user creation requests
func (c *UserClient) BulkCreateUsers(ctx context.Context, users []CreateUserInput) (*userv1.BulkCreateUsersResponse, error) {
    stream, err := c.client.BulkCreateUsers(ctx)
    if err != nil {
        return nil, err
    }

    // Send all users
    for _, u := range users {
        if err := stream.Send(&userv1.CreateUserRequest{
            Email:    u.Email,
            Name:     u.Name,
            Password: u.Password,
            Roles:    u.Roles,
        }); err != nil {
            return nil, err
        }
    }

    // Close and receive response
    return stream.CloseAndRecv()
}

// WatchUserUpdates opens a bidirectional stream for user updates
func (c *UserClient) WatchUserUpdates(ctx context.Context, userIDs []string, updates chan<- *userv1.User) error {
    stream, err := c.client.UserUpdates(ctx)
    if err != nil {
        return err
    }

    // Subscribe to user IDs
    for _, id := range userIDs {
        if err := stream.Send(&userv1.UserUpdateRequest{
            UserId: id,
        }); err != nil {
            return err
        }
    }

    // Receive updates
    for {
        user, err := stream.Recv()
        if err == io.EOF {
            close(updates)
            return nil
        }
        if err != nil {
            return err
        }
        updates <- user
    }
}

type CreateUserInput struct {
    Email    string
    Name     string
    Password string
    Roles    []string
}
```

### Client Usage Example

The following `main` function demonstrates the full client lifecycle: creating a connection, calling unary and streaming RPCs, and handling errors by extracting gRPC status codes. The `handleGRPCError` helper switches on the status code to produce specific log messages for each failure category.

```go
package main

import (
    "context"
    "log"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    userv1 "github.com/myapp/gen/user/v1"
    "github.com/myapp/client"
)

func main() {
    // Create client
    userClient, err := client.NewUserClient("localhost:50051")
    if err != nil {
        log.Fatalf("failed to create client: %v", err)
    }
    defer userClient.Close()

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Create user
    user, err := userClient.CreateUser(ctx, "test@example.com", "Test User", "password123", []string{"user"})
    if err != nil {
        handleGRPCError(err)
        return
    }
    log.Printf("Created user: %s", user.GetId())

    // Get user
    user, err = userClient.GetUser(ctx, user.GetId())
    if err != nil {
        handleGRPCError(err)
        return
    }
    log.Printf("Got user: %s (%s)", user.GetName(), user.GetEmail())

    // List users (streaming)
    users, err := userClient.ListUsers(ctx, 10, userv1.UserStatus_USER_STATUS_ACTIVE)
    if err != nil {
        handleGRPCError(err)
        return
    }
    log.Printf("Listed %d users", len(users))

    // Bulk create (client streaming)
    resp, err := userClient.BulkCreateUsers(ctx, []client.CreateUserInput{
        {Email: "user1@example.com", Name: "User 1", Password: "pass1"},
        {Email: "user2@example.com", Name: "User 2", Password: "pass2"},
    })
    if err != nil {
        handleGRPCError(err)
        return
    }
    log.Printf("Bulk created %d users", resp.GetCreatedCount())
}

func handleGRPCError(err error) {
    st, ok := status.FromError(err)
    if !ok {
        log.Printf("Non-gRPC error: %v", err)
        return
    }

    switch st.Code() {
    case codes.NotFound:
        log.Printf("Not found: %s", st.Message())
    case codes.InvalidArgument:
        log.Printf("Invalid argument: %s", st.Message())
    case codes.AlreadyExists:
        log.Printf("Already exists: %s", st.Message())
    case codes.PermissionDenied:
        log.Printf("Permission denied: %s", st.Message())
    case codes.Unauthenticated:
        log.Printf("Unauthenticated: %s", st.Message())
    default:
        log.Printf("gRPC error [%s]: %s", st.Code(), st.Message())
    }
}
```

### Junior → FAANG: Client Habits That Prevent Production Incidents

The `NewUserClient` function above demonstrates the two most important client creation habits:

**Use `grpc.NewClient`, not `grpc.Dial`.** `grpc.Dial` and `grpc.DialContext` are deprecated as of grpc-go v1.63. Beyond the deprecation, the behavioral difference matters: `grpc.Dial` defaults to the `passthrough` resolver (treats the address as literal, no DNS re-resolution), while `grpc.NewClient` defaults to the DNS resolver (re-resolves on reconnection). For static addresses like `localhost:50051`, the difference is invisible. For production service discovery against a headless Kubernetes service, the difference determines whether your client sees new pods or not.

**`ClientConn` is a process-scoped singleton.** Every call to `grpc.NewClient` allocates goroutines for the resolver loop, the balancer, and keepalive management. Creating one per request exhausts file descriptors and goroutines quickly. Inject the `UserClient` struct (not the raw `*grpc.ClientConn`) into every component that needs it. Store one instance per service target.

**Always extract the status code when handling errors.** The `handleGRPCError` function demonstrates `status.FromError(err)`. The `ok` return value is critical: if the error is not a gRPC status error (for example, a context cancellation before the call is sent), `ok` is `false` and `st.Code()` returns `codes.Unknown`, not `codes.Canceled`. Check `ok` before switching on the code.

One interviewer favorite: "What happens if you call a gRPC method after the connection context is canceled?" The answer is: the call returns `codes.Canceled` immediately without going to the server. This is different from the server canceling mid-request, which also returns `codes.Canceled`. Distinguish the two in error logs by checking whether the error arrived before or after a network round-trip (the client interceptor chain can record this via timestamps).

### Senior @ FAANG: Client Design for Reliability and Observability at Scale

**Client wrapper as a platform abstraction.** The `UserClient` struct is the correct abstraction boundary. At the platform level, the wrapper adds:
- A retry interceptor that respects idempotency semantics (implemented as a `grpc.UnaryClientInterceptor` and a `grpc.StreamClientInterceptor` pair, not bespoke per-method logic).
- An observability interceptor that records method name, status code, and duration to Prometheus, emits spans to the tracing backend, and attaches correlation IDs from the incoming context.
- A circuit breaker that trips to `OPEN` state after a configurable failure rate threshold and rejects calls with `codes.Unavailable` locally, preventing cascade failure by not adding load to an already-struggling downstream.

The platform publishes this wrapper as a generated package alongside the proto stubs. Teams call `userclient.New(conn)` and get all of the above for free. They never touch `grpc.UnaryClientInterceptor` directly.

**Connection pool vs single connection.** gRPC's HTTP/2 multiplexing means a single `*grpc.ClientConn` handles thousands of concurrent RPCs. In practice, a single connection can become a bottleneck in two scenarios: (a) very high-throughput services where the TLS encryption/decryption overhead on one connection saturates a CPU core, and (b) services where the peer restricts connections per source IP via `max_concurrent_streams`. In these cases, the solution is a custom balancer (or a resolver that returns each backend address multiple times) so the pool opens N connections per backend rather than one. This is an advanced tuning decision that requires profiling to justify. Document it as an ADR if adopted.

**Context propagation in streaming clients.** The `WatchUserUpdates` function above passes a `ctx` to the stream. The lifetime of that context is the lifetime of the stream. If the context is a `http.Request` context, the stream dies when the HTTP request completes. If the stream is meant to outlive any single HTTP request (for example, a background synchronization job), use a long-lived context derived from `context.Background()` with its own cancellation linked to application shutdown. This is a subtle but common cause of premature stream termination in production. Document the expected lifetime of each streaming client in the code comment.

**Deadline budget management.** The chapter shows `context.WithTimeout(context.Background(), 30*time.Second)` in the main function. In a real service, the timeout is not constant. It is derived from the incoming request's remaining deadline minus a safety buffer. A unary client interceptor that does this automatically (as shown in the `TimeoutInterceptor` in the common mistakes file) ensures that downstream calls never outlive their caller. The staff-level design question: should this interceptor live in the client wrapper (applied to all outgoing calls) or in the server handler (applied to a specific downstream call)? The client wrapper is the right place for a default. Handlers can override by providing a context with a shorter timeout for specific expensive downstream calls.

---
