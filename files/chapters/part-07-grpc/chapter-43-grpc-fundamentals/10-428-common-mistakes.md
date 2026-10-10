## 43.8 Common Mistakes

### Mistake 1: Not Setting Deadlines

Without a deadline on the context, a gRPC call blocks indefinitely if the server is slow or hung, exhausting goroutines in the caller. The fix is either adding `context.WithTimeout` per call, or attaching a unary interceptor at connection creation that injects a default timeout only when the incoming context has no deadline already.

```go
// WRONG: No deadline - request can hang forever
func (c *Client) GetUser(ctx context.Context, id string) (*pb.User, error) {
    // If server is slow or unresponsive, this blocks forever
    return c.client.GetUser(ctx, &pb.GetUserRequest{Id: id})
}

// CORRECT: Always set deadline/timeout
func (c *Client) GetUser(ctx context.Context, id string) (*pb.User, error) {
    // Set timeout for this specific call
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resp, err := c.client.GetUser(ctx, &pb.GetUserRequest{Id: id})
    if err != nil {
        // Handle deadline exceeded specifically
        if status.Code(err) == codes.DeadlineExceeded {
            return nil, fmt.Errorf("request timed out after 5s: %w", err)
        }
        return nil, err
    }

    return resp.User, nil
}

// BETTER: Configure default timeout at client creation.
// Use grpc.NewClient, as grpc.Dial and DialContext were deprecated in v1.63.
func NewUserClient(addr string) (*UserClient, error) {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        // Default timeout for all unary calls
        grpc.WithUnaryInterceptor(TimeoutInterceptor(10*time.Second)),
    )
    if err != nil {
        return nil, err
    }

    return &UserClient{client: pb.NewUserServiceClient(conn)}, nil
}

func TimeoutInterceptor(timeout time.Duration) grpc.UnaryClientInterceptor {
    return func(ctx context.Context, method string, req, reply any,
        cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {

        // Don't override if context already has deadline
        if _, ok := ctx.Deadline(); !ok {
            var cancel context.CancelFunc
            ctx, cancel = context.WithTimeout(ctx, timeout)
            defer cancel()
        }

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}
```

### Mistake 2: Not Handling Stream Errors Properly

A gRPC stream `Recv` returns `io.EOF` to signal normal end-of-stream, but any other error means the stream was terminated abnormally, and must be checked explicitly. Ignoring non-EOF errors causes the client to silently miss records that were never sent, presenting incomplete data as a successful result.

```go
// WRONG: Ignoring stream errors
func (c *Client) ListUsers(ctx context.Context) ([]*pb.User, error) {
    stream, err := c.client.ListUsers(ctx, &pb.ListUsersRequest{})
    if err != nil {
        return nil, err
    }

    var users []*pb.User
    for {
        user, err := stream.Recv()
        if err == io.EOF {
            break
        }
        // WRONG: Other errors are ignored!
        users = append(users, user)
    }

    return users, nil
}

// CORRECT: Handle all stream errors
func (c *Client) ListUsers(ctx context.Context) ([]*pb.User, error) {
    stream, err := c.client.ListUsers(ctx, &pb.ListUsersRequest{})
    if err != nil {
        return nil, fmt.Errorf("failed to start stream: %w", err)
    }

    var users []*pb.User
    for {
        user, err := stream.Recv()
        if err == io.EOF {
            break // Normal end of stream
        }
        if err != nil {
            // Check for specific error conditions
            st, ok := status.FromError(err)
            if ok {
                switch st.Code() {
                case codes.Canceled:
                    return users, fmt.Errorf("stream canceled: %w", err)
                case codes.DeadlineExceeded:
                    return users, fmt.Errorf("stream deadline exceeded: %w", err)
                case codes.Unavailable:
                    return users, fmt.Errorf("service unavailable: %w", err)
                }
            }
            return nil, fmt.Errorf("stream error: %w", err)
        }

        users = append(users, user)
    }

    return users, nil
}

// Server-side: Don't forget to check context cancellation
func (s *Server) ListUsers(req *pb.ListUsersRequest, stream pb.UserService_ListUsersServer) error {
    ctx := stream.Context()

    users, err := s.store.List(ctx)
    if err != nil {
        return status.Errorf(codes.Internal, "failed to list users: %v", err)
    }

    for _, user := range users {
        // IMPORTANT: Check context before each send
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        if err := stream.Send(user); err != nil {
            return status.Errorf(codes.Internal, "failed to send: %v", err)
        }
    }

    return nil
}
```

### Mistake 3: Returning Internal Errors with Sensitive Information

Propagating raw database error messages in the gRPC status leaks schema names, query structure, and internal state to callers, a significant information disclosure vulnerability. The server must log the full error internally with a trace ID, then return a generic `codes.Internal` status with a safe, non-revealing message.

```go
// WRONG: Exposing internal details
func (s *Server) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
    user, err := s.db.Query("SELECT * FROM users WHERE id = ?", req.Id)
    if err != nil {
        // WRONG: Exposes database details, query, and internal error messages
        return nil, status.Errorf(codes.Internal, "database error: %v", err)
    }
    // ...
}

// CORRECT: Log internal details, return safe error
func (s *Server) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
    user, err := s.db.Query("SELECT * FROM users WHERE id = ?", req.Id)
    if err != nil {
        // Log full error internally
        s.logger.Error("database query failed",
            "error", err,
            "query", "GetUser",
            "user_id", req.Id,
            "trace_id", getTraceID(ctx),
        )

        // Return generic error to client
        return nil, status.Error(codes.Internal, "internal error")
    }

    if user == nil {
        return nil, status.Errorf(codes.NotFound, "user %s not found", req.Id)
    }

    return &pb.GetUserResponse{User: toProto(user)}, nil
}

// BETTER: Use error interceptor for consistent handling
func ErrorInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler) (any, error) {

        resp, err := handler(ctx, req)
        if err != nil {
            st, ok := status.FromError(err)
            if !ok || st.Code() == codes.Unknown {
                // Unknown error - log and sanitize
                logger.Error("unhandled error",
                    "method", info.FullMethod,
                    "error", err,
                    "trace_id", getTraceID(ctx),
                )

                return nil, status.Error(codes.Internal, "internal error")
            }

            // Log all non-OK errors for monitoring
            if st.Code() != codes.OK {
                logger.Info("grpc error",
                    "method", info.FullMethod,
                    "code", st.Code(),
                    "message", st.Message(),
                    "trace_id", getTraceID(ctx),
                )
            }
        }

        return resp, err
    }
}
```

### Mistake 4: Not Closing Client Connections

Creating a new `grpc.ClientConn` per request allocates TCP connections, TLS handshakes, and HTTP/2 session state that are never reclaimed, eventually exhausting file descriptors. The `ClientConn` should be created once at application startup, shared across all RPCs via dependency injection, and closed with `conn.Close()` only during graceful shutdown.

```go
// WRONG: Connection leak
func GetUser(addr, userID string) (*pb.User, error) {
    // Creates new connection every call - LEAK!
    conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
    if err != nil {
        return nil, err
    }
    // Missing: conn.Close()

    client := pb.NewUserServiceClient(conn)
    resp, err := client.GetUser(context.Background(), &pb.GetUserRequest{Id: userID})
    if err != nil {
        return nil, err
    }

    return resp.User, nil
}

// CORRECT: Manage connection lifecycle properly
type UserClient struct {
    conn   *grpc.ClientConn
    client pb.UserServiceClient
}

func NewUserClient(addr string) (*UserClient, error) {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        // Configure keepalive for long-lived connections
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
        client: pb.NewUserServiceClient(conn),
    }, nil
}

func (c *UserClient) Close() error {
    return c.conn.Close()
}

func (c *UserClient) GetUser(ctx context.Context, userID string) (*pb.User, error) {
    resp, err := c.client.GetUser(ctx, &pb.GetUserRequest{Id: userID})
    if err != nil {
        return nil, err
    }
    return resp.User, nil
}

// Usage
func main() {
    client, err := NewUserClient("localhost:50051")
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close() // Always close!

    // Use client for multiple requests...
}
```

### Mistake 5: Breaking Proto Compatibility

Protocol Buffer backward compatibility depends on field numbers remaining stable across versions. Adding new fields with previously unused numbers is safe. Changing a field's type, reusing a field number for a different field, or removing a field number without reserving it breaks existing clients that were compiled against the older definition.

```go
// WRONG: Breaking changes to proto
/*
// Original proto
message User {
  string id = 1;
  string name = 2;
  string email = 3;
}

// WRONG: Changed field type - BREAKING!
message User {
  int64 id = 1;  // Was string!
  string name = 2;
  string email = 3;
}

// WRONG: Reused field number - BREAKING!
message User {
  string id = 1;
  string full_name = 2;  // Was "name" - reusing number!
  string email = 3;
}

// WRONG: Removed field number - BREAKING for some clients!
message User {
  string id = 1;
  // Field 2 removed
  string email = 3;
}
*/

// CORRECT: Non-breaking evolution
/*
// Original proto
message User {
  string id = 1;
  string name = 2;
  string email = 3;
}

// CORRECT: Add new field with new number
message User {
  string id = 1;
  string name = 2;
  string email = 3;
  string phone = 4;  // NEW field, new number
}

// CORRECT: Deprecate field (keep number reserved)
message User {
  string id = 1;
  string name = 2 [deprecated = true];  // Mark as deprecated
  string email = 3;
  string full_name = 4;  // New field for name

  reserved 5, 6;  // Reserve numbers you won't use
  reserved "old_field";  // Reserve names too
}
*/

// Use buf for breaking change detection
/*
# buf.yaml
version: v1
breaking:
  use:
    - FILE

# Then run:
# buf breaking --against '.git#branch=main'
*/
```

### Junior → FAANG: Recognizing and Fixing the Five Mistakes in Interviews

Each mistake above maps to a specific interview signal. Learn to recognize them in code review questions and coding exercises.

**Mistake 1: No deadlines.** In interviews, you will often be asked to review a client function that calls a gRPC method. If the context passed has no deadline, call it out immediately. The correct answer is: "I'd add `context.WithTimeout` here, or add a default timeout interceptor at the client creation point so every call gets a bounded deadline." Missing deadlines are a goroutine-leak waiting to happen on the server side and an indefinite-block on the client side.

**Mistake 2: Stream error handling.** The correct stream receive loop always checks for `io.EOF` separately from other errors. Any other error is abnormal termination. In an interview exercise where you are implementing a server or client streaming handler, always write the `if err == io.EOF { break }` before `if err != nil { return err }` pattern. Getting this wrong signals unfamiliarity with the streaming protocol.

**Mistake 3: Leaking internal errors.** If you see `status.Errorf(codes.Internal, "database error: %v", err)` in a code review exercise, mark it as a security issue: it leaks internal implementation details to the caller. The correct fix is to log the full error internally and return `status.Error(codes.Internal, "internal error")`. In an interview, this is often presented as a "find the bug" question about a handler that passes the raw database error to the gRPC status.

**Mistake 4: Connection per request.** If you see `grpc.NewClient` inside a function that is called per request, it is a resource leak. The fix is to construct the client once at startup and share it. In an interview, mention that `ClientConn` is safe for concurrent use and is designed to be shared.

**Mistake 5: Proto breaking changes.** The correct evolution rules are: add new fields with new numbers, reserve removed numbers and names, never change field types or numbers. When asked "how do you add a new field to a proto without breaking clients?", the answer is a new field number plus `reserved` for anything removed.

### Senior @ FAANG: Systematic Mistake Prevention Through Platform Controls

At the L6 level, the goal is not to catch mistakes in code review. Code review is too late. Mistakes reach code review because there was no earlier gate. The senior engineer designs the system that prevents these mistakes before code is written.

**Automated deadline enforcement.** Mistake 1 (no deadlines) is solved at the platform level by making the correct behavior the default. The platform's client wrapper includes a `TimeoutInterceptor` that injects a configurable default deadline when none is present. Teams opt out of this interceptor, not in. Any team that opts out must document why (for example, a long-running stream that by design has no deadline). This moves the exception to explicit and the safe behavior to implicit.

**Lint rules for streaming patterns.** Mistake 2 (ignoring stream errors) is difficult to enforce with static analysis, but `errcheck` and `staticcheck` catch ignored errors on function calls including `stream.Recv`. Add these to the CI lint step. For the server-side context check, write a custom `go/analysis` pass that detects streaming handler functions that do not reference `stream.Context()` or `ctx.Done()` anywhere in the function body. This is a false-positive-prone heuristic, but it catches the gross omission.

**Error sanitization at the infrastructure layer.** Mistake 3 (leaking internal errors) is eliminated by the error sanitization interceptor in the platform's standard server chain. No matter what a handler returns, the interceptor ensures that any error not recognized as a properly constructed `*status.Status` becomes `codes.Internal` with a safe message before it leaves the server process. This is defense-in-depth: the interceptor does not replace good handler code, but it ensures that mistakes do not reach production callers.

**Connection lifecycle enforcement.** Mistake 4 (connection per request) is prevented by the platform's dependency injection framework. Services declare their external dependencies as injected `*UserClient` instances, not by calling `grpc.NewClient` themselves. The DI framework creates one client per target at application startup and injects it into all components that declare a dependency. This makes it structurally impossible to create a client per request, because the client is provided by the framework, not created by the component.

**Automated breaking change detection.** Mistake 5 (proto breaking changes) is prevented by CI. Every proto PR runs `buf breaking --against '.git#branch=main'` and blocks merge if any breaking change is detected. The breaking change policy (`FILE`, `PACKAGE`, or `WIRE_JSON`) is documented in the platform's proto style guide and set in `buf.yaml`. Teams that need to make a breaking change (adding a new version of the service, for example) follow a documented migration runbook that includes a coordination protocol with all known consumers.

---
