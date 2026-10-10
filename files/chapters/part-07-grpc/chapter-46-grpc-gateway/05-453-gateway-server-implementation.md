## 46.3 Gateway Server Implementation

### Basic Gateway Setup

The gateway implementation registers the generated `Register*HandlerFromEndpoint` function with a `runtime.ServeMux`, which is then mounted on a standard `net/http` server. Both gRPC (port 9090) and HTTP/JSON (port 8080) listeners can run concurrently in separate goroutines, sharing the same Go process and service implementation.

```go
package main

import (
    "context"
    "log"
    "net"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    userv1 "github.com/myapp/gen/user/v1"
)

func main() {
    ctx := context.Background()
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    // Start gRPC server
    go startGRPCServer()

    // Start HTTP gateway
    startHTTPGateway(ctx)
}

func startGRPCServer() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }

    grpcServer := grpc.NewServer()
    userv1.RegisterUserServiceServer(grpcServer, NewUserServer())

    log.Printf("gRPC server listening on :50051")
    if err := grpcServer.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}

func startHTTPGateway(ctx context.Context) {
    // Create gateway mux
    mux := runtime.NewServeMux()

    // Register gRPC-Gateway handlers
    opts := []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}

    err := userv1.RegisterUserServiceHandlerFromEndpoint(ctx, mux, "localhost:50051", opts)
    if err != nil {
        log.Fatalf("failed to register gateway: %v", err)
    }

    // Start HTTP server
    log.Printf("HTTP gateway listening on :8080")
    if err := http.ListenAndServe(":8080", mux); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}
```

### Production Gateway Setup

The production gateway wraps the generated `runtime.ServeMux` with TLS termination, request logging, CORS headers, and health check routes before binding it to the HTTP server. It also registers the gateway with the same `grpc.Server` on a shared port using `cmux` to multiplex gRPC (HTTP/2 with `application/grpc`) and REST (HTTP/1.1 or HTTP/2 without `application/grpc`) traffic over a single listener.

```go
package main

import (
    "context"
    "fmt"
    "io/fs"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/metadata"
    "google.golang.org/protobuf/encoding/protojson"

    userv1 "github.com/myapp/gen/user/v1"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Start gRPC server
    grpcServer := startGRPCServer(logger)

    // Start HTTP gateway
    httpServer := startHTTPGateway(ctx, logger)

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh

    logger.Info("shutting down servers")

    // Shutdown HTTP server
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    httpServer.Shutdown(shutdownCtx)
    grpcServer.GracefulStop()

    logger.Info("servers stopped")
}

func startGRPCServer(logger *slog.Logger) *grpc.Server {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        logger.Error("failed to listen", "error", err)
        os.Exit(1)
    }

    grpcServer := grpc.NewServer()
    userv1.RegisterUserServiceServer(grpcServer, NewUserServer())

    go func() {
        logger.Info("gRPC server listening", "addr", ":50051")
        if err := grpcServer.Serve(lis); err != nil {
            logger.Error("gRPC server error", "error", err)
        }
    }()

    return grpcServer
}

func startHTTPGateway(ctx context.Context, logger *slog.Logger) *http.Server {
    // Create gateway mux with custom options
    mux := runtime.NewServeMux(
        // Custom JSON marshaler
        runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   true,  // Use snake_case
                EmitUnpopulated: false, // Don't emit zero values
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true, // Ignore unknown fields
            },
        }),

        // Forward headers to gRPC metadata
        runtime.WithIncomingHeaderMatcher(customHeaderMatcher),

        // Add metadata to outgoing response
        runtime.WithOutgoingHeaderMatcher(func(key string) (string, bool) {
            switch key {
            case "x-request-id", "x-trace-id":
                return key, true
            default:
                return "", false
            }
        }),

        // Custom error handler
        runtime.WithErrorHandler(customErrorHandler),

        // Routing error handler (404s)
        runtime.WithRoutingErrorHandler(customRoutingErrorHandler),

        // Metadata annotator
        runtime.WithMetadata(func(ctx context.Context, r *http.Request) metadata.MD {
            return metadata.New(map[string]string{
                "x-forwarded-host": r.Host,
                "x-original-uri":   r.RequestURI,
            })
        }),
    )

    // Register service handlers
    opts := []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    }

    if err := userv1.RegisterUserServiceHandlerFromEndpoint(ctx, mux, "localhost:50051", opts); err != nil {
        logger.Error("failed to register user service", "error", err)
        os.Exit(1)
    }

    // Create HTTP server with middleware
    handler := http.Handler(mux)
    handler = loggingMiddleware(logger)(handler)
    handler = recoveryMiddleware(logger)(handler)
    handler = corsMiddleware()(handler)

    // Add additional routes
    rootMux := http.NewServeMux()
    rootMux.Handle("/", handler)
    rootMux.HandleFunc("/health", healthHandler)
    rootMux.HandleFunc("/openapi.json", swaggerHandler)
    rootMux.Handle("/docs/", http.StripPrefix("/docs/", swaggerUIHandler()))

    server := &http.Server{
        Addr:         ":8080",
        Handler:      rootMux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    go func() {
        logger.Info("HTTP gateway listening", "addr", ":8080")
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("HTTP server error", "error", err)
        }
    }()

    return server
}

// Custom header matcher - forward specific headers to gRPC
func customHeaderMatcher(key string) (string, bool) {
    switch key {
    case "Authorization", "X-Request-Id", "X-Trace-Id", "Accept-Language":
        return key, true
    default:
        return runtime.DefaultHeaderMatcher(key)
    }
}
```

### Custom Error Handler

The default gRPC-Gateway error handler converts gRPC status codes to HTTP status codes and writes a generic error body. For most production APIs, you need a custom error handler that returns a consistent JSON error envelope, extracts structured error details from gRPC status, and maps codes to application-specific error strings.

```go
package main

import (
    "context"
    "encoding/json"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/genproto/googleapis/rpc/errdetails"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// APIError represents a standardized error response
type APIError struct {
    Status  int           `json:"status"`
    Code    string        `json:"code"`
    Message string        `json:"message"`
    Details []ErrorDetail `json:"details,omitempty"`
}

type ErrorDetail struct {
    Field   string `json:"field,omitempty"`
    Message string `json:"message"`
}

func customErrorHandler(ctx context.Context, mux *runtime.ServeMux, marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
    st, ok := status.FromError(err)
    if !ok {
        st = status.New(codes.Internal, err.Error())
    }

    httpStatus := runtime.HTTPStatusFromCode(st.Code())

    apiErr := APIError{
        Status:  httpStatus,
        Code:    codeToString(st.Code()),
        Message: st.Message(),
    }

    // Extract details if present
    for _, detail := range st.Details() {
        switch d := detail.(type) {
        case *errdetails.BadRequest:
            for _, v := range d.GetFieldViolations() {
                apiErr.Details = append(apiErr.Details, ErrorDetail{
                    Field:   v.GetField(),
                    Message: v.GetDescription(),
                })
            }
        }
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(apiErr)
}

func customRoutingErrorHandler(ctx context.Context, mux *runtime.ServeMux, marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, httpStatus int) {
    apiErr := APIError{
        Status: httpStatus,
    }

    switch httpStatus {
    case http.StatusNotFound:
        apiErr.Code = "NOT_FOUND"
        apiErr.Message = "The requested resource was not found"
    case http.StatusMethodNotAllowed:
        apiErr.Code = "METHOD_NOT_ALLOWED"
        apiErr.Message = "The HTTP method is not allowed for this endpoint"
    default:
        apiErr.Code = "ROUTING_ERROR"
        apiErr.Message = "Routing error"
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(apiErr)
}

func codeToString(code codes.Code) string {
    switch code {
    case codes.OK:
        return "OK"
    case codes.InvalidArgument:
        return "INVALID_ARGUMENT"
    case codes.NotFound:
        return "NOT_FOUND"
    case codes.AlreadyExists:
        return "ALREADY_EXISTS"
    case codes.PermissionDenied:
        return "PERMISSION_DENIED"
    case codes.Unauthenticated:
        return "UNAUTHENTICATED"
    case codes.ResourceExhausted:
        return "RESOURCE_EXHAUSTED"
    case codes.FailedPrecondition:
        return "FAILED_PRECONDITION"
    case codes.Internal:
        return "INTERNAL_ERROR"
    case codes.Unavailable:
        return "SERVICE_UNAVAILABLE"
    default:
        return "UNKNOWN"
    }
}
```

### Junior -> FAANG: Understanding Why the Production Gateway Differs from the Basic Setup

The basic gateway setup (20 lines, no options) works for demos and local development. The production setup (100+ lines, multiple options) exists because every option it adds solves a real class of production failure.

`runtime.WithMarshalerOption` with `UseProtoNames: true` prevents the most common source of client confusion: a REST client sends `page_token` in the query string (because the proto says `page_token`) but the default marshaler expects `pageToken` (camelCase). Setting `UseProtoNames: true` makes the gateway accept the proto field name form, which matches what the OpenAPI spec generates.

`runtime.WithIncomingHeaderMatcher` is not optional if you have authentication. The default matcher forwards only a small allowlist of headers. Without a custom matcher, the `Authorization` header is silently dropped and every authenticated gRPC handler receives an empty metadata set, causing auth failures that look identical to a missing token.

`runtime.WithErrorHandler` is what separates a professional API from a hobby project. The default error handler leaks internal error messages (database error texts, service addresses, Go type names) to HTTP clients. Custom error handlers sanitize this before it leaves the process.

The graceful shutdown sequence matters. The HTTP server must stop accepting new connections before the gRPC server shuts down. If the gRPC server stops first, in-flight requests from the gateway to the backend fail mid-response. The order in the production example (HTTP `Shutdown`, then `GracefulStop`) is correct.

First-job habit: run your gateway with `GODEBUG=http2debug=2` in a local environment and watch what happens when the backend gRPC server restarts. You will see the gateway fail to reconnect and start returning errors. Then add the keepalive parameters and watch the behavior change. Understanding this at the network level makes debugging production reconnection issues much faster.

### Senior @ FAANG: Gateway Configuration as Organizational Policy

The `runtime.ServeMux` options in the production gateway are not just configuration knobs. They express organizational policies. A senior engineer's job is to decide which policies belong in the gateway and document them so the next team that reads the code understands why each option exists.

**Marshaler configuration and client compatibility.** The choice between `UseProtoNames: true` and the camelCase default is a breaking change if you have existing clients. If you ship camelCase first and later switch to snake_case because your OpenAPI tools expect it, every client that built against the original behavior breaks. Document this decision in the gateway's README and treat it as an API contract: once chosen, changing it requires a versioned migration.

**Header forwarding as a security boundary.** The `customHeaderMatcher` function controls which HTTP headers become gRPC metadata. This is a trust boundary: metadata that reaches the gRPC handler is trusted by downstream services. If the custom matcher forwards `X-User-ID` (a header that an attacker could inject), the gRPC handler should not trust it without verifying it came from the gateway and not from the client. The correct pattern is to have the gateway validate the auth token, extract the user principal, and set `X-User-ID` itself from the validated data, not from the request headers.

**The `ForwardResponseOption` and response shaping.** The `forwardResponse` function in this section sets caching headers based on the response type. This is appropriate at the gateway level because the gRPC handler should not know or care about HTTP caching semantics. However, if the cache TTL is wrong for a particular response type, the bug manifests as stale data for clients, not as a service error. Cache header logic belongs in tests, not just in code.

**Error handler as a contract.** The `APIError` shape produced by the custom error handler is a public API contract. External clients parse the `code` and `details` fields. Changing the field names or the set of detail types is a breaking change. Version the error schema the same way you version the REST API. The `codeToString` function mapping gRPC codes to string error codes is the seed of an error catalog: document each code in the OpenAPI spec's error response schema with a description of when it occurs and what the client should do.

**Timeout configuration.** The `ReadTimeout: 10 * time.Second` and `WriteTimeout: 30 * time.Second` in the HTTP server config are load-bearing. `WriteTimeout` must be longer than the maximum expected response time of the slowest backend RPC, plus the transcoding overhead. If `WriteTimeout` is shorter than the backend's deadline, the gateway closes the connection while the gRPC call is still in flight, producing a confusing partial response at the client and a "context canceled" error at the backend. Tie these timeouts to SLO budgets: if the p99 SLO is 2 seconds, set `WriteTimeout` to at least 5 seconds (3x headroom for tail latency).

---
