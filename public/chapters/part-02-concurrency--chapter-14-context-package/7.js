export default `## 14.6 Context in gRPC

gRPC has first-class context support, automatically propagating deadlines and metadata.

### Server-Side Context

gRPC automatically serializes the client's deadline into the wire protocol and reconstructs it as a \`context.DeadlineExceeded\` on the server. A server-side handler should check the remaining deadline before dispatching expensive operations, if less than 100 ms remains, returning \`codes.DeadlineExceeded\` immediately is more honest than starting work that will be cancelled mid-flight.

\`\`\`go
package server

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type UserServer struct {
    pb.UnimplementedUserServiceServer
    db *Database
}

func (s *UserServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.User, error) {
    // Context contains:
    // - Deadline from client (if set)
    // - Metadata (headers)
    // - Cancellation signal

    // Check deadline
    if deadline, ok := ctx.Deadline(); ok {
        remaining := time.Until(deadline)
        if remaining < 100*time.Millisecond {
            return nil, status.Error(codes.DeadlineExceeded,
                "insufficient time remaining")
        }
    }

    // Extract metadata
    md, ok := metadata.FromIncomingContext(ctx)
    if ok {
        // Get trace ID
        if traceIDs := md.Get("x-trace-id"); len(traceIDs) > 0 {
            ctx = WithTraceID(ctx, traceIDs[0])
        }

        // Get authorization
        if auths := md.Get("authorization"); len(auths) > 0 {
            user, err := validateToken(auths[0])
            if err != nil {
                return nil, status.Error(codes.Unauthenticated, "invalid token")
            }
            ctx = WithAuthUser(ctx, user)
        }
    }

    // Propagate context to database
    user, err := s.db.GetUser(ctx, req.GetId())
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            return nil, status.Error(codes.DeadlineExceeded, "database timeout")
        }
        if errors.Is(err, context.Canceled) {
            return nil, status.Error(codes.Canceled, "request cancelled")
        }
        return nil, status.Error(codes.Internal, err.Error())
    }

    return user, nil
}

// Streaming RPC with context
func (s *UserServer) StreamUsers(req *pb.StreamRequest, stream pb.UserService_StreamUsersServer) error {
    ctx := stream.Context()

    users, err := s.db.ListUsers(ctx)
    if err != nil {
        return status.Error(codes.Internal, err.Error())
    }

    for _, user := range users {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := stream.Send(user); err != nil {
                return err
            }
        }
    }

    return nil
}
\`\`\`

### Client-Side Context

On the client side, the context serves two distinct roles: it carries the deadline that gRPC will serialize into the wire protocol as a deadline header, and it carries metadata, arbitrary key-value pairs that travel as HTTP/2 headers alongside the RPC. Using a \`UnaryClientInterceptor\` centralizes this propagation so every outgoing call automatically attaches trace IDs and request IDs without requiring each call site to do so manually.

\`\`\`go
package client

import (
    "context"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
)

type UserClient struct {
    client pb.UserServiceClient
}

func (c *UserClient) GetUser(ctx context.Context, id string) (*pb.User, error) {
    // Set timeout
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // Add metadata (headers)
    ctx = metadata.AppendToOutgoingContext(ctx,
        "x-trace-id", TraceID(ctx),
        "x-request-id", RequestID(ctx),
    )

    return c.client.GetUser(ctx, &pb.GetUserRequest{Id: id})
}

// Interceptor for automatic context propagation
func UnaryClientInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Propagate trace context
        if trace, ok := Trace(ctx); ok {
            ctx = metadata.AppendToOutgoingContext(ctx,
                "x-trace-id", trace.TraceID,
                "x-span-id", trace.SpanID,
            )
        }

        // Propagate request ID
        if reqID := RequestID(ctx); reqID != "" {
            ctx = metadata.AppendToOutgoingContext(ctx, "x-request-id", reqID)
        }

        start := time.Now()
        err := invoker(ctx, method, req, reply, cc, opts...)

        Logger(ctx).Info("gRPC call",
            "method", method,
            "duration", time.Since(start),
            "error", err,
        )

        return err
    }
}
\`\`\`

### gRPC Deadline Propagation Is Automatic

gRPC encodes the client's deadline in request metadata and reconstructs it on the server side. The server's \`ctx\` already has the correct deadline without any application code. This is one of the main reasons gRPC wins over raw HTTP for service-to-service communication: deadline propagation is the default, not an application concern.

Application code just needs to propagate the \`ctx\` received in the handler to any downstream calls. The deadline flows automatically. The handler needs no deadline arithmetic.

### Status Codes for Context Errors

When returning from a handler due to context cancellation, use the right gRPC status code:

\`\`\`go
if ctx.Err() != nil {
    switch {
    case errors.Is(ctx.Err(), context.DeadlineExceeded):
        return nil, status.Error(codes.DeadlineExceeded, "deadline exceeded")
    case errors.Is(ctx.Err(), context.Canceled):
        return nil, status.Error(codes.Canceled, "canceled")
    }
}
\`\`\`

gRPC automatically maps \`codes.DeadlineExceeded\` and \`codes.Canceled\` to appropriate client-side errors. Using generic \`codes.Internal\` or \`codes.Unknown\` loses information and causes client-side retry logic to misbehave.

### Staff Lens: gRPC as Deadline-Propagation Infrastructure

One of gRPC's strongest selling points over raw HTTP is deadline propagation. If your org does end-to-end service-to-service calls, gRPC (or equivalent framework) encodes deadlines automatically. If your org uses raw HTTP, you need to build and maintain this yourself. Principal engineers evaluating RPC framework choice should weight this feature heavily: the cost of not having deadline propagation is years of subtle timeout mismatches across services.

---
`;
