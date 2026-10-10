## 103.7 gRPC Instrumentation

### Server-Side gRPC Instrumentation

gRPC uses Protocol Buffers for strongly typed, binary-encoded communication between services, providing lower latency and smaller payloads than JSON-based REST. On the server side, `otelgrpc.NewServerHandler` plugs into gRPC's stats handler hooks so every incoming RPC gets a server span with trace context extracted from the request metadata.

```go
package grpcserver

import (
    "context"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"

    pb "myapp/proto/user"
)

var tracer = otel.Tracer("grpc-server")

// UserServer implements the gRPC UserService
type UserServer struct {
    pb.UnimplementedUserServiceServer
    repo UserRepository
}

// SetupGRPCServer creates an instrumented gRPC server
func SetupGRPCServer() *grpc.Server {
    // Create gRPC server with OpenTelemetry interceptors
    server := grpc.NewServer(
        grpc.StatsHandler(otelgrpc.NewServerHandler(
            otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
            otelgrpc.WithMeterProvider(otel.GetMeterProvider()),
            otelgrpc.WithPropagators(otel.GetTextMapPropagator()),
        )),
    )

    // Register services
    pb.RegisterUserServiceServer(server, &UserServer{})

    return server
}

// GetUser implements the GetUser RPC with custom tracing
func (s *UserServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
    // Create child span for business logic
    ctx, span := tracer.Start(ctx, "UserServer.GetUser.BusinessLogic",
        trace.WithAttributes(
            attribute.String("user.id", req.UserId),
            attribute.String("rpc.method", "GetUser"),
        ),
    )
    defer span.End()

    // Extract metadata for additional context
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if clientIDs := md.Get("x-client-id"); len(clientIDs) > 0 {
            span.SetAttributes(attribute.String("client.id", clientIDs[0]))
        }
    }

    // Fetch user with traced repository call
    user, err := s.fetchUserFromDB(ctx, req.UserId)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "failed to fetch user")
        return nil, err
    }

    span.SetStatus(codes.Ok, "user fetched successfully")
    return &pb.GetUserResponse{
        User: user,
    }, nil
}

func (s *UserServer) fetchUserFromDB(ctx context.Context, userID string) (*pb.User, error) {
    ctx, span := tracer.Start(ctx, "UserServer.fetchUserFromDB",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    span.AddEvent("querying database")

    user, err := s.repo.FindByID(ctx, userID)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }

    span.SetAttributes(
        attribute.String("db.operation", "SELECT"),
        attribute.String("db.table", "users"),
    )

    return user, nil
}

// StreamUsers implements server-streaming with tracing
func (s *UserServer) StreamUsers(req *pb.StreamUsersRequest, stream pb.UserService_StreamUsersServer) error {
    ctx := stream.Context()
    ctx, span := tracer.Start(ctx, "UserServer.StreamUsers",
        trace.WithSpanKind(trace.SpanKindInternal),
        trace.WithAttributes(
            attribute.Int("filter.limit", int(req.Limit)),
        ),
    )
    defer span.End()

    users, err := s.repo.List(ctx, int(req.Limit))
    if err != nil {
        span.RecordError(err)
        return err
    }

    sentCount := 0
    for _, user := range users {
        if err := stream.Send(&pb.StreamUsersResponse{User: user}); err != nil {
            span.RecordError(err)
            span.SetAttributes(attribute.Int("users.sent", sentCount))
            return err
        }
        sentCount++
    }

    span.SetAttributes(attribute.Int("users.sent", sentCount))
    span.SetStatus(codes.Ok, "stream completed")
    return nil
}
```

### Client-Side gRPC Instrumentation

The client mirrors the server: `otelgrpc.NewClientHandler` injects the trace context into outgoing metadata so the downstream server span joins the caller's trace, and manual spans wrap each call site with business attributes.

```go
package grpcclient

import (
    "context"
    "io"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/metadata"

    pb "myapp/proto/user"
)

var tracer = otel.Tracer("grpc-client")

// UserClient wraps the gRPC client with instrumentation
type UserClient struct {
    conn   *grpc.ClientConn
    client pb.UserServiceClient
}

// NewUserClient creates an instrumented gRPC client
func NewUserClient(target string) (*UserClient, error) {
    conn, err := grpc.NewClient(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithStatsHandler(otelgrpc.NewClientHandler(
            otelgrpc.WithTracerProvider(otel.GetTracerProvider()),
            otelgrpc.WithMeterProvider(otel.GetMeterProvider()),
        )),
    )
    if err != nil {
        return nil, err
    }

    return &UserClient{
        conn:   conn,
        client: pb.NewUserServiceClient(conn),
    }, nil
}

// GetUser calls the GetUser RPC with tracing
func (c *UserClient) GetUser(ctx context.Context, userID string) (*pb.User, error) {
    ctx, span := tracer.Start(ctx, "UserClient.GetUser",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("user.id", userID),
            attribute.String("rpc.service", "UserService"),
            attribute.String("rpc.method", "GetUser"),
        ),
    )
    defer span.End()

    // Add custom metadata
    ctx = metadata.AppendToOutgoingContext(ctx,
        "x-client-id", "api-gateway",
        "x-request-timeout", "5s",
    )

    // Set deadline
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resp, err := c.client.GetUser(ctx, &pb.GetUserRequest{UserId: userID})
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetStatus(codes.Ok, "user retrieved")
    return resp.User, nil
}

// StreamUsers consumes a server stream with tracing
func (c *UserClient) StreamUsers(ctx context.Context, limit int) ([]*pb.User, error) {
    ctx, span := tracer.Start(ctx, "UserClient.StreamUsers",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    stream, err := c.client.StreamUsers(ctx, &pb.StreamUsersRequest{Limit: int32(limit)})
    if err != nil {
        span.RecordError(err)
        return nil, err
    }

    var users []*pb.User
    for {
        resp, err := stream.Recv()
        if err != nil {
            if err == io.EOF {
                break
            }
            span.RecordError(err)
            return nil, err
        }
        users = append(users, resp.User)
    }

    span.SetAttributes(attribute.Int("users.received", len(users)))
    return users, nil
}

func (c *UserClient) Close() error {
    return c.conn.Close()
}
```

### Junior → FAANG: gRPC Spans and the Interceptor Chain

gRPC instrumentation works through gRPC's stats handler hooks, which play a role analogous to HTTP middleware. `otelgrpc.NewServerHandler` adds OTel instrumentation to the server side: it extracts the trace context from incoming gRPC metadata, creates a server span, and stores it in the request context. `otelgrpc.NewClientHandler` injects the trace context into outgoing metadata. The older `otelgrpc.UnaryServerInterceptor` and related interceptor constructors are deprecated in favor of the stats handler API.

With interceptor-based instrumentation, a common mistake was registering the tracing interceptor in the wrong order relative to authentication, rate limiting, and logging interceptors. The stats handler approach avoids this class of bug: it hooks the transport layer directly, so it always observes the full request lifetime, including time spent in authentication interceptors.

Interview entry point: "How does trace context propagate in gRPC?" gRPC uses metadata (headers) for context propagation. The `otelgrpc` interceptor reads and writes the `traceparent` and `tracestate` metadata keys following the W3C TraceContext spec. This is the same mechanism as HTTP, just using a different transport layer.

### Senior @ FAANG: gRPC Observability at Scale, Streaming, and Service Mesh Interaction

**Streaming RPC instrumentation is fundamentally different.** Unary RPC maps cleanly to a single span: one request, one response, one span. Streaming RPC does not. A server-streaming RPC that sends 10,000 messages cannot create a child span per message (cardinality explosion) but a single span spanning the full stream lifetime loses message-level timing information. The senior-level decision is to use a single span for the stream lifecycle with a message counter attribute, and emit per-message events using `span.AddEvent()` for the first and last message plus any errors, but not every intermediate message.

**Service mesh double-instrumentation.** In Kubernetes environments with a service mesh (Istio, Linkerd), the mesh's sidecar proxy already generates spans for every gRPC call at the network level. This means every call produces two sets of spans: one from the OTel SDK in the application, one from the mesh proxy. Without coordination, traces appear to have duplicate spans with inconsistent timing. The resolution is to configure the mesh to propagate W3C `traceparent` headers and to use the same trace ID, so the application span and the mesh proxy span appear as parent and child within a single trace rather than as two disconnected traces. An L6 engineer documents this interaction in the platform observability runbook and verifies it during mesh upgrades.

**gRPC status codes as SLO signals.** gRPC has a richer status code vocabulary than HTTP (OK, CANCELED, UNKNOWN, INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, RESOURCE_EXHAUSTED, etc.). SLO definitions for gRPC services must specify which status codes count as errors for the error rate SLI. Treating `NOT_FOUND` as an error inflates the error rate with expected client behavior. A senior engineer defines the error policy in the SLO document and ensures the OTel span status (`codes.Error` vs `codes.Ok`) and the Prometheus metric label (`status="ok"` vs `status="error"`) both follow the same policy.

---
