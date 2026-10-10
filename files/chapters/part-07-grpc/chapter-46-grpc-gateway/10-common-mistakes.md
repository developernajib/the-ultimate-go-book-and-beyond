## 46.8 Common Mistakes

### Mistake 1: Not Handling Header Propagation

The default `runtime.ServeMux` passes only a small allowlist of HTTP headers (e.g., `Content-Type`) into gRPC metadata. Headers like `Authorization` and `X-Request-ID` are silently dropped. Configuring `runtime.WithIncomingHeaderMatcher` with a custom function that explicitly forwards required headers ensures the gRPC handler receives the auth token and trace context it needs.

```go
// WRONG: Headers are lost in transcoding
func startGateway(ctx context.Context) {
    mux := runtime.NewServeMux() // Default options

    // Authorization header won't reach gRPC server!
}

// CORRECT: Configure header forwarding
func startGatewayCorrect(ctx context.Context) {
    mux := runtime.NewServeMux(
        // Forward specific headers to gRPC metadata
        runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
            switch strings.ToLower(key) {
            case "authorization", "x-request-id", "x-trace-id",
                "x-forwarded-for", "x-real-ip", "accept-language":
                return key, true
            default:
                // Also forward grpc- prefixed headers
                if strings.HasPrefix(strings.ToLower(key), "grpc-") {
                    return key, true
                }
                return "", false
            }
        }),

        // Forward metadata back as HTTP headers
        runtime.WithOutgoingHeaderMatcher(func(key string) (string, bool) {
            switch key {
            case "x-request-id", "x-trace-id", "x-ratelimit-remaining":
                return key, true
            default:
                return "", false
            }
        }),
    )
}
```

### Mistake 2: Blocking JSON Parsing with Zero Values

`protojson` omits zero-value fields by default (`false`, `0`, `""`), which breaks clients that distinguish "field not set" from "field set to zero". Setting `EmitUnpopulated: true` on `protojson.MarshalOptions` in the `runtime.JSONPb` marshaler ensures all proto fields appear in the JSON output regardless of their value.

```go
// WRONG: Zero values are not sent, breaking boolean fields
mux := runtime.NewServeMux(
    runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
        MarshalOptions: protojson.MarshalOptions{
            EmitUnpopulated: false, // Boolean "false" is omitted!
        },
    }),
)

// Client sends: {"enabled": false}
// Gateway receives: {} (field missing)
// Server sees: enabled = false (default, but intent is lost)

// CORRECT: Consider use case for EmitUnpopulated
mux := runtime.NewServeMux(
    runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
        MarshalOptions: protojson.MarshalOptions{
            // Include all fields for explicit API contracts
            EmitUnpopulated: true,
            // Or use field presence (proto3 optional)
        },
        UnmarshalOptions: protojson.UnmarshalOptions{
            // Allow clients to omit optional fields
            DiscardUnknown: true,
        },
    }),
)

// Better: Use wrapper types or field masks for explicit presence
// message UpdateRequest {
//     google.protobuf.BoolValue enabled = 1;
//     google.protobuf.FieldMask update_mask = 2;
// }
```

### Mistake 3: Missing CORS Configuration

Browser-based clients that call the gateway from a different origin will be blocked by the browser's same-origin policy unless the gateway responds with correct CORS headers. The default `runtime.ServeMux` does not set any CORS headers, so every cross-origin preflight `OPTIONS` request fails silently.

```go
// WRONG: Browser requests blocked by CORS
func main() {
    mux := runtime.NewServeMux()
    http.ListenAndServe(":8080", mux)
}

// CORRECT: Add CORS middleware for browser clients
func main() {
    mux := runtime.NewServeMux()

    handler := corsMiddleware(mux)
    http.ListenAndServe(":8080", handler)
}

func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        origin := r.Header.Get("Origin")

        // Validate origin against allowlist in production
        allowedOrigins := map[string]bool{
            "https://app.example.com":     true,
            "https://staging.example.com": true,
        }

        if allowedOrigins[origin] || isDevelopment() {
            w.Header().Set("Access-Control-Allow-Origin", origin)
            w.Header().Set("Access-Control-Allow-Methods",
                "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers",
                "Authorization, Content-Type, X-Request-ID")
            w.Header().Set("Access-Control-Expose-Headers",
                "X-Request-ID, X-RateLimit-Remaining")
            w.Header().Set("Access-Control-Max-Age", "86400")
            w.Header().Set("Access-Control-Allow-Credentials", "true")
        }

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Mistake 4: Improper Error Detail Exposure

The default error handler converts gRPC status codes to HTTP status codes but forwards the full error message verbatim, which may contain stack traces, SQL errors, or internal service names. A custom `runtime.ErrorHandlerFunc` should log the full gRPC error server-side and return only a sanitized JSON body to HTTP clients.

```go
// WRONG: Internal errors leak to clients
func customErrorHandler(ctx context.Context, mux *runtime.ServeMux,
    marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {

    st := status.Convert(err)

    // Exposes internal details like stack traces, SQL errors
    response := map[string]any{
        "error":   st.Message(), // May contain "pq: duplicate key..."
        "details": st.Details(), // May contain internal proto types
    }

    json.NewEncoder(w).Encode(response)
}

// CORRECT: Sanitize errors for external consumption
func safeErrorHandler(ctx context.Context, mux *runtime.ServeMux,
    marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {

    st := status.Convert(err)
    httpStatus := runtime.HTTPStatusFromCode(st.Code())

    // Map to user-friendly messages
    publicMessage := mapToPublicMessage(st)

    response := APIError{
        Status:  httpStatus,
        Code:    st.Code().String(),
        Message: publicMessage,
    }

    // Only include safe details
    for _, detail := range st.Details() {
        switch d := detail.(type) {
        case *errdetails.BadRequest:
            // Field validation errors are safe to expose
            for _, v := range d.GetFieldViolations() {
                response.Details = append(response.Details, ErrorDetail{
                    Field:   v.GetField(),
                    Message: v.GetDescription(),
                })
            }
        // Don't expose DebugInfo, internal errors, etc.
        }
    }

    // Log the full error internally
    slog.Error("grpc error",
        "code", st.Code(),
        "message", st.Message(),
        "request_id", r.Header.Get("X-Request-ID"),
    )

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(httpStatus)
    json.NewEncoder(w).Encode(response)
}

func mapToPublicMessage(st *status.Status) string {
    switch st.Code() {
    case codes.Internal:
        return "An internal error occurred. Please try again later."
    case codes.Unavailable:
        return "Service temporarily unavailable. Please retry."
    case codes.DeadlineExceeded:
        return "Request timed out. Please try again."
    default:
        return st.Message()
    }
}
```

### Mistake 5: Ignoring Streaming Errors

An SSE handler that calls `stream.Recv` in a bare loop without checking `err` will silently exit the loop on any gRPC error, leaving the HTTP connection open while the client receives no more events and no `data: error` line explaining why. Every non-nil, non-EOF error from `Recv` should write an error event to the SSE stream and close the handler.

```go
// WRONG: SSE stream dies silently on errors
func sseHandler(client pb.ServiceClient) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/event-stream")

        stream, _ := client.Watch(r.Context(), &pb.WatchRequest{})

        for {
            event, err := stream.Recv()
            if err != nil {
                return // Client sees connection close with no explanation
            }

            fmt.Fprintf(w, "data: %s\n\n", event)
        }
    }
}

// CORRECT: Handle all streaming error cases
func sseHandlerCorrect(client pb.ServiceClient) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")
        w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "streaming not supported", http.StatusInternalServerError)
            return
        }

        ctx := r.Context()
        stream, err := client.Watch(ctx, &pb.WatchRequest{})
        if err != nil {
            // Send error event before closing
            fmt.Fprintf(w, "event: error\ndata: {\"message\": \"failed to connect\"}\n\n")
            flusher.Flush()
            return
        }

        // Send keepalive to detect dead connections
        keepalive := time.NewTicker(30 * time.Second)
        defer keepalive.Stop()

        events := make(chan *pb.Event)
        errs := make(chan error)

        go func() {
            for {
                event, err := stream.Recv()
                if err != nil {
                    errs <- err
                    return
                }
                events <- event
            }
        }()

        for {
            select {
            case <-ctx.Done():
                fmt.Fprintf(w, "event: close\ndata: {\"reason\": \"client disconnect\"}\n\n")
                flusher.Flush()
                return

            case <-keepalive.C:
                fmt.Fprintf(w, ": keepalive\n\n")
                flusher.Flush()

            case event := <-events:
                data, _ := json.Marshal(event)
                fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n",
                    event.GetId(), event.GetType(), data)
                flusher.Flush()

            case err := <-errs:
                if err == io.EOF {
                    fmt.Fprintf(w, "event: complete\ndata: {}\n\n")
                } else {
                    // Provide retry hint for recoverable errors
                    st := status.Convert(err)
                    retryable := st.Code() == codes.Unavailable ||
                                 st.Code() == codes.ResourceExhausted
                    fmt.Fprintf(w, "event: error\ndata: {\"message\": %q, \"retryable\": %v}\nretry: 5000\n\n",
                        st.Message(), retryable)
                }
                flusher.Flush()
                return
            }
        }
    }
}
```

### Junior -> FAANG: Turning Mistakes into Debugging Instincts

The five mistakes in this section are a checklist, not just a reading list. Before shipping any gRPC-Gateway feature, run through each item mentally and verify you have addressed it.

**Header propagation** is the mistake that causes the most debugging time at the junior level because the symptom (auth failures, missing trace IDs) looks identical to a backend bug rather than a gateway configuration issue. The first thing to check when an authenticated endpoint returns 401 from the backend (not the gateway) is the header matcher. Add a debug log in the metadata annotator to print what metadata the gRPC handler actually receives, then compare it to what the HTTP client sent.

**Zero value emission** is the mistake that causes subtle client bugs rather than errors. A client that distinguishes `{"enabled": false}` (field explicitly set to false) from `{}` (field not set) will behave incorrectly when the gateway silently omits the field. The `EmitUnpopulated: true` option is the quick fix. The correct long-term fix for new proto definitions is to use `proto3 optional` fields so the distinction between "not set" and "set to zero" is explicit in the schema.

**CORS** is the mistake that every frontend engineer discovers on their first day of integration. The correct fix is a single well-reviewed CORS middleware function in a shared library that all gateways use. The common wrong fix is copy-pasting a CORS snippet from Stack Overflow that sets `Access-Control-Allow-Origin: *` permanently, which is a security problem for authenticated endpoints that use cookies.

**Error detail exposure** is the mistake that becomes a security incident. Make it a code review rule: every `customErrorHandler` implementation must show proof that `codes.Internal` maps to a generic message. Add a test that calls a handler that returns `status.Error(codes.Internal, "sql: no rows in result set")` and asserts the response body does not contain "sql".

**Streaming error handling** is the mistake that manifests as a bad user experience rather than an error: the stream just stops. Add an integration test that simulates a backend stream error mid-flight and asserts the SSE client receives an `event: error` line before the connection closes.

### Senior @ FAANG: Systematic Mistake Prevention at the Platform Level

Each mistake in this section represents a class of bugs that will recur across every team that adopts gRPC-Gateway unless the platform makes the correct behavior the default.

**Header propagation as a platform default.** The correct header matcher for your organization is not something each team should configure from scratch. A platform library should provide `platform.DefaultHeaderMatcher()` that forwards all required headers (auth, trace, correlation ID, client version) and is updated when the organization adopts a new tracing standard. Teams opt in to additional headers but do not need to think about the baseline. This also means that when the organization migrates from B3 tracing headers to W3C `traceparent`, the platform library update propagates to all services without each team touching their gateway config.

**Zero value and field presence as a proto design concern.** The `EmitUnpopulated` problem is a symptom of a deeper design issue: proto3's implicit zero values make it impossible to distinguish "not set" from "set to zero" for scalar fields. The platform should have a guideline: any field where the distinction matters (boolean flags, numeric limits, optional identifiers) must use `proto3 optional` or a wrapper type (`google.protobuf.BoolValue`). This is a `buf lint` rule that can be enforced automatically.

**CORS policy as a security review item.** CORS configuration that allows credentials (`Access-Control-Allow-Credentials: true`) must not use a wildcard origin. This is a security requirement, not a preference. A platform-level CORS middleware should enforce this invariant: if `DiscardUnknown: true` is set, the origin allowlist must be non-empty. Any gateway that specifies an empty allowlist should fail to start, not silently allow all origins.

**Error sanitization as a defense-in-depth layer.** At the platform level, error sanitization should happen in two places: the gRPC handler (which should never put internal details in the status message for production-facing services) and the gateway error handler (which is the last chance to catch anything that slipped through). The gateway error handler is a security boundary. Treat it as such: run it through a security review, add tests for every `codes.Internal` scenario, and include it in your threat model documentation.

**SSE connection lifecycle and the kill switch.** At scale, you need the ability to terminate all SSE connections for a specific service (for maintenance, security incidents, or load shedding). An in-process broadcaster has no kill switch beyond restarting the process. A platform-level SSE infrastructure should support a control plane API that can gracefully close all connections for a given route or service, sending a `event: shutdown` message before closing so clients can reconnect to a healthy instance.

---
