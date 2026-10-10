## 46.11 gRPC-Gateway Pitfalls: When REST Meets RPC

### Pitfall 1: The Path Parameter Collision Catastrophe

**Incident Report**: An API exposed `/users/{user_id}` and `/users/search` via gRPC-Gateway. The gateway matched `/users/search` to the first route, interpreting "search" as a user_id. Production searches returned 404s for two hours before the pattern was discovered.

```protobuf
// WRONG: Ambiguous path patterns
service UserService {
  // These patterns collide!
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }

  rpc SearchUsers(SearchRequest) returns (SearchResponse) {
    option (google.api.http) = {
      get: "/v1/users/search"  // Matched as user_id="search"!
    };
  }
}
```

```protobuf
// CORRECT: Unambiguous patterns with proper ordering
service UserService {
  // More specific patterns first in proto definition
  rpc SearchUsers(SearchRequest) returns (SearchResponse) {
    option (google.api.http) = {
      get: "/v1/users/search"
    };
  }

  // Or use different path structure
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }

  // Better: Use distinct path prefixes
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
    option (google.api.http) = {
      get: "/v1/user-search"  // Distinct path
      additional_bindings {
        get: "/v1/users:search"  // Or use custom method style
      }
    };
  }
}
```

```go
// CORRECT: Validate patterns at startup
func validatePathPatterns(patterns []string) error {
    sort.Slice(patterns, func(i, j int) bool {
        // More specific patterns (fewer wildcards) first
        iWildcards := strings.Count(patterns[i], "{")
        jWildcards := strings.Count(patterns[j], "{")
        return iWildcards < jWildcards
    })

    for i := 0; i < len(patterns)-1; i++ {
        if couldCollide(patterns[i], patterns[i+1]) {
            return fmt.Errorf("potential collision: %s vs %s", patterns[i], patterns[i+1])
        }
    }
    return nil
}
```

### Pitfall 2: The SSE Connection Leak Disaster

**Incident Report**: A dashboard used SSE via gRPC-Gateway for real-time updates. When users closed browser tabs, the SSE connections weren't properly cleaned up. After a week, the gateway had 50,000 zombie connections consuming memory, leading to cascading failures.

```go
// WRONG: No cleanup on client disconnect
func (s *DashboardServer) StreamUpdates(req *pb.DashboardRequest, stream pb.Dashboard_StreamUpdatesServer) error {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for range ticker.C {
        update := s.getLatestMetrics()
        // If client disconnects, Send() eventually errors,
        // but we might hold resources much longer
        if err := stream.Send(update); err != nil {
            return err
        }
    }
    return nil
}

// CORRECT: Proactive connection health monitoring
func (s *DashboardServer) StreamUpdates(req *pb.DashboardRequest, stream pb.Dashboard_StreamUpdatesServer) error {
    ctx := stream.Context()

    // Register connection for monitoring
    connID := uuid.New().String()
    s.connectionTracker.Register(connID)
    defer s.connectionTracker.Unregister(connID)

    ticker := time.NewTicker(time.Second)
    heartbeat := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    defer heartbeat.Stop()

    for {
        select {
        case <-ctx.Done():
            log.Printf("Client disconnected: %s", connID)
            return status.FromContextError(ctx.Err()).Err()

        case <-heartbeat.C:
            // Send empty heartbeat to detect dead connections faster
            if err := stream.Send(&pb.DashboardUpdate{Type: "heartbeat"}); err != nil {
                log.Printf("Heartbeat failed for %s: %v", connID, err)
                return err
            }

        case <-ticker.C:
            update := s.getLatestMetrics()
            if err := stream.Send(update); err != nil {
                return err
            }
        }
    }
}

// Connection tracker with cleanup
type ConnectionTracker struct {
    mu          sync.RWMutex
    connections map[string]time.Time
}

func (t *ConnectionTracker) StartCleanupRoutine(ctx context.Context) {
    ticker := time.NewTicker(time.Minute)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            t.cleanupStale()
        }
    }
}

func (t *ConnectionTracker) cleanupStale() {
    t.mu.Lock()
    defer t.mu.Unlock()

    staleThreshold := time.Now().Add(-5 * time.Minute)
    for id, lastSeen := range t.connections {
        if lastSeen.Before(staleThreshold) {
            log.Printf("Cleaning up stale connection: %s", id)
            delete(t.connections, id)
        }
    }
}
```

### Pitfall 3: The gRPC Error Code Lost in Translation

**Incident Report**: Backend services returned proper gRPC error codes (InvalidArgument, NotFound, PermissionDenied). But clients always received HTTP 500 with generic error messages. The gateway's custom error handler was swallowing the original codes.

```go
// WRONG: Custom error handler loses gRPC error semantics
func customErrorHandler(ctx context.Context, mux *runtime.ServeMux, marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
    // Loses all gRPC status information
    w.WriteHeader(http.StatusInternalServerError)
    json.NewEncoder(w).Encode(map[string]string{
        "error": err.Error(),  // Also leaks internal details
    })
}

// CORRECT: Preserve gRPC error semantics
func properErrorHandler(ctx context.Context, mux *runtime.ServeMux, marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
    st, ok := status.FromError(err)
    if !ok {
        st = status.New(codes.Unknown, "unknown error")
    }

    // Map gRPC codes to HTTP codes
    httpStatus := runtime.HTTPStatusFromCode(st.Code())

    // Build response with proper error structure
    errResp := &ErrorResponse{
        Code:    int32(st.Code()),
        Message: sanitizeErrorMessage(st.Message()),
        Details: extractErrorDetails(st),
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Grpc-Code", st.Code().String())
    w.WriteHeader(httpStatus)

    body, _ := marshaler.Marshal(errResp)
    w.Write(body)
}

type ErrorResponse struct {
    Code    int32             `json:"code"`
    Message string            `json:"message"`
    Details []*ErrorDetail    `json:"details,omitempty"`
}

type ErrorDetail struct {
    Type        string          `json:"@type"`
    FieldErrors []FieldError    `json:"field_errors,omitempty"`
}

type FieldError struct {
    Field       string `json:"field"`
    Description string `json:"description"`
}

func sanitizeErrorMessage(msg string) string {
    // Remove internal details like stack traces, SQL queries
    if strings.Contains(msg, "pq:") {
        return "database error"
    }
    if strings.Contains(msg, "connection refused") {
        return "service temporarily unavailable"
    }
    return msg
}

func extractErrorDetails(st *status.Status) []*ErrorDetail {
    var details []*ErrorDetail
    for _, d := range st.Details() {
        switch v := d.(type) {
        case *errdetails.BadRequest:
            detail := &ErrorDetail{Type: "BadRequest"}
            for _, violation := range v.FieldViolations {
                detail.FieldErrors = append(detail.FieldErrors, FieldError{
                    Field:       violation.Field,
                    Description: violation.Description,
                })
            }
            details = append(details, detail)
        }
    }
    return details
}
```

### Pitfall 4: The Header Propagation Black Hole

**Incident Report**: Distributed tracing stopped working after adding gRPC-Gateway. Trace IDs from HTTP headers weren't being forwarded to gRPC calls. Services appeared as isolated islands in Jaeger, making debugging impossible.

```go
// WRONG: Headers not propagated to gRPC metadata
func main() {
    mux := runtime.NewServeMux()  // Default config loses headers

    // Register handlers...
    http.ListenAndServe(":8080", mux)
}

// CORRECT: Explicit header propagation
func main() {
    mux := runtime.NewServeMux(
        // Forward specific incoming HTTP headers to gRPC metadata
        runtime.WithIncomingHeaderMatcher(customHeaderMatcher),

        // Forward gRPC response metadata to HTTP headers
        runtime.WithOutgoingHeaderMatcher(customOutgoingMatcher),

        // Forward errors from metadata
        runtime.WithMetadata(func(ctx context.Context, r *http.Request) metadata.MD {
            md := make(map[string]string)

            // Tracing headers
            for _, h := range []string{
                "X-Request-Id",
                "X-Trace-Id",
                "X-Span-Id",
                "X-B3-TraceId",
                "X-B3-SpanId",
                "X-B3-ParentSpanId",
                "X-B3-Sampled",
                "Traceparent",
                "Tracestate",
            } {
                if v := r.Header.Get(h); v != "" {
                    md[strings.ToLower(h)] = v
                }
            }

            // Auth headers
            if auth := r.Header.Get("Authorization"); auth != "" {
                md["authorization"] = auth
            }

            // Client identification
            md["x-forwarded-for"] = r.RemoteAddr
            md["x-original-uri"] = r.RequestURI
            md["x-original-method"] = r.Method

            return metadata.New(md)
        }),
    )

    // Register handlers...
}

func customHeaderMatcher(key string) (string, bool) {
    // Headers to propagate to gRPC
    switch strings.ToLower(key) {
    case "x-request-id", "x-trace-id", "x-correlation-id":
        return key, true
    case "authorization":
        return key, true
    case "accept-language", "x-timezone":
        return key, true
    }

    // Propagate all x-custom-* headers
    if strings.HasPrefix(strings.ToLower(key), "x-custom-") {
        return key, true
    }

    return "", false
}

func customOutgoingMatcher(key string) (string, bool) {
    // gRPC metadata to expose as HTTP headers
    switch strings.ToLower(key) {
    case "x-request-id", "x-trace-id":
        return key, true
    case "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset":
        return key, true
    }
    return "", false
}
```

### Pitfall 5: The WebSocket Upgrade Timeout Trap

**Incident Report**: WebSocket connections through gRPC-Gateway worked in development but failed in production with 504 Gateway Timeout. The load balancer enforced a 30-second timeout on HTTP connections, but the WebSocket upgrade negotiation didn't complete fast enough under load.

```go
// WRONG: No timeout handling for WebSocket upgrade
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
    upgrader := websocket.Upgrader{
        CheckOrigin: func(r *http.Request) bool { return true },  // Also insecure!
    }

    conn, err := upgrader.Upgrade(w, r, nil)  // Can hang indefinitely
    if err != nil {
        log.Printf("Upgrade failed: %v", err)
        return
    }
    defer conn.Close()

    // Handle WebSocket...
}

// CORRECT: Proper WebSocket handling with timeouts
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    upgrader := websocket.Upgrader{
        HandshakeTimeout: 10 * time.Second,  // Fast upgrade or fail
        CheckOrigin:      validateOrigin,
        EnableCompression: true,
    }

    // Set response headers before upgrade
    w.Header().Set("X-Request-Id", r.Header.Get("X-Request-Id"))

    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        log.Printf("WebSocket upgrade failed: %v", err)
        return
    }
    defer conn.Close()

    // Configure connection timeouts
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetWriteDeadline(time.Now().Add(10 * time.Second))

    // Pong handler resets read deadline
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // Ping routine keeps connection alive through LB
    go func() {
        ticker := time.NewTicker(20 * time.Second)  // Less than LB timeout
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
                if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                    return
                }
            }
        }
    }()

    // Start gRPC bidirectional stream
    stream, err := grpcClient.BidiStream(ctx)
    if err != nil {
        conn.WriteMessage(websocket.CloseMessage,
            websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "backend unavailable"))
        return
    }

    // Bridge WebSocket <-> gRPC stream
    bridgeWebSocketToGrpc(ctx, conn, stream)
}

func validateOrigin(r *http.Request) bool {
    origin := r.Header.Get("Origin")
    allowedOrigins := map[string]bool{
        "https://app.example.com":     true,
        "https://staging.example.com": true,
    }

    if os.Getenv("ENV") == "development" {
        return true  // Allow all in dev
    }

    return allowedOrigins[origin]
}
```

### Pitfall 6: The OpenAPI Spec Divergence Disaster

**Incident Report**: Auto-generated OpenAPI specs from proto files said the API accepted `{ "user_id": "123" }`. But the actual HTTP binding used a path parameter `/users/123`. Client SDKs generated from the spec were incompatible with the actual API.

```protobuf
// WRONG: OpenAPI generation doesn't reflect actual bindings
service UserService {
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"  // Path param
    };
    // OpenAPI might show user_id as body/query param instead
  }
}

message GetUserRequest {
  string user_id = 1;  // No explicit annotation
}
```

```protobuf
// CORRECT: Explicit OpenAPI annotations
service UserService {
  rpc GetUser(GetUserRequest) returns (User) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Get a user by ID"
      description: "Retrieves user details for the specified user ID"
      tags: "Users"
      responses: {
        key: "404"
        value: {
          description: "User not found"
          schema: {
            json_schema: {
              ref: ".api.v1.ErrorResponse"
            }
          }
        }
      }
    };
  }
}

message GetUserRequest {
  // Explicitly document path parameter
  string user_id = 1 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    description: "Unique user identifier"
    pattern: "^[a-zA-Z0-9-]+$"
    min_length: 1
    max_length: 64
  }];
}
```

```go
// CORRECT: Validate generated spec matches reality
func TestOpenAPIMatchesImplementation(t *testing.T) {
    spec, err := loadOpenAPISpec("api/openapi.yaml")
    require.NoError(t, err)

    // Test each path
    for path, pathItem := range spec.Paths {
        for method, op := range pathItem.Operations() {
            t.Run(fmt.Sprintf("%s %s", method, path), func(t *testing.T) {
                // Build request from spec
                req := buildRequestFromSpec(path, method, op)

                // Send to actual gateway
                resp, err := httpClient.Do(req)
                require.NoError(t, err)

                // Verify status code is documented
                _, documented := op.Responses[strconv.Itoa(resp.StatusCode)]
                assert.True(t, documented,
                    "Status %d not documented for %s %s",
                    resp.StatusCode, method, path)

                // Verify response matches schema
                if schema := op.Responses[strconv.Itoa(resp.StatusCode)].Schema; schema != nil {
                    body, _ := io.ReadAll(resp.Body)
                    err := validateAgainstSchema(body, schema)
                    assert.NoError(t, err)
                }
            })
        }
    }
}
```

### Quick Reference: gRPC-Gateway Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Path collision | Wrong handler invoked | Order specific paths first, use distinct prefixes |
| SSE connection leak | Memory growth, connection exhaustion | Connection tracking, heartbeats, cleanup routines |
| Error code loss | All errors return 500 | Custom error handler preserving gRPC status |
| Header black hole | Broken tracing/auth | Explicit header matchers for propagation |
| WebSocket timeout | 504s in production | Ping/pong within LB timeout, fast handshake |
| OpenAPI divergence | SDK incompatibility | Explicit annotations, automated spec tests |

### Junior -> FAANG: Incident Reports as a Study Tool

Each pitfall in this section is framed as an incident report: a real-sounding failure with a time to detect (TTD) and a root cause. Reading incident reports is one of the most effective study habits for junior engineers because it shows what production failures actually look like, not just what the correct code looks like.

The path collision incident (two hours to detect) is a reminder that incorrect behavior is often harder to catch than errors. The endpoint returned a response, just the wrong one. Monitoring for error rates would not have caught this. The correct detection mechanism is an integration test that exercises the `/users/search` path specifically and asserts the response matches the search schema, not the get-user schema.

The SSE connection leak incident (one week before detection) illustrates why resource accounting is a first-class concern. Goroutines and file descriptors are invisible unless you export metrics for them. Add `runtime.NumGoroutine()` and a file descriptor count to your process metrics from day one. Set an alert when goroutine count exceeds 2x the expected steady-state count. A slow leak like this one is only detectable through trending, not through a threshold alert.

The WebSocket timeout incident (works in development, fails in production) is the most common "environment difference" failure class. The rule: always test your streaming endpoints through the production-equivalent infrastructure (load balancer, service mesh) before shipping. A staging environment that bypasses the load balancer is not a staging environment for this class of bug.

The OpenAPI divergence incident shows what happens when the spec and the implementation disagree silently. CI should catch this. If your generated SDK generates a method that calls `/users/123` as a query parameter instead of a path parameter, that is a code generation bug that should fail a contract test, not a bug that reaches partner developers.

First-job practice: for each pitfall, write a one-sentence detection rule: "We detect this by..." and a one-sentence prevention rule: "We prevent this by..." These rules become the basis for your team's gateway checklist.

### Senior @ FAANG: Pitfall Prevention as a Platform Investment

Each pitfall in this section represents a failure mode that recurs across teams unless the platform makes the correct behavior the default. A staff-level engineer's job is to find the platform investment that prevents the recurrence.

**Path collision prevention at the platform level.** The `validatePathPatterns` function in the example is a good start, but it runs only if someone calls it. A better placement is as a startup-time check that runs before the gateway begins serving traffic. The `runtime.ServeMux` returns an error from `Handle` if a pattern conflicts with an existing one. Wrap this in a test that registers all patterns and fails fast if any conflict is detected. The ultimate prevention is a `buf lint` rule that detects ambiguous pattern pairs statically, before any Go code is compiled.

**SSE connection leak prevention and the connection lifecycle protocol.** The connection tracker in the example is correct but reactive: it cleans up stale connections after the fact. A proactive approach is to use a connection registry with a maximum connection count per client identity (user ID or API key) and reject new connections when the limit is reached. This bounds the per-client resource usage and prevents a single misbehaving client from exhausting the gateway's connection pool. The registry also provides an administrative API: "how many SSE connections does user X currently have?" is answerable without scraping process-level metrics.

**Error code loss and the "error taxonomy" investment.** The correct long-term fix is an error taxonomy: a documented mapping from every business error condition to a specific gRPC status code, status message format, and set of error details. This taxonomy is a shared library that both the gRPC handlers and the gateway error handler use. When a new error condition is added, it goes through the taxonomy review, which includes: is the status code correct, does the message reveal internal information, and is the error detail type appropriate? The review catches the `codes.Internal` + internal message combination before it reaches the error handler.

**Header propagation and the distributed tracing mandate.** At a FAANG company, distributed tracing is not optional. The W3C `traceparent` header (or B3 headers if you are on an older stack) must be forwarded by every service that participates in the tracing infrastructure. The platform team should enforce this by providing a middleware that auto-injects and forwards the tracing headers, and by failing the deployment pipeline if a service does not include this middleware. The header propagation pitfall becomes impossible when the correct behavior is part of the deployment checklist.

**WebSocket timeout and the infrastructure contract.** The load balancer timeout that caused the production failure is a configuration fact about the infrastructure, not just a timeout to tune. The platform team should document the active load balancer timeout as an infrastructure constraint that all services must design against. Any streaming endpoint that expects connections to live longer than the load balancer's idle timeout must implement ping/pong. This constraint should appear in the gateway onboarding guide and the streaming design checklist, not be discovered by each team independently through a production incident.

**OpenAPI divergence and the spec-as-truth inversion.** Most teams treat the implementation as the truth and the spec as a derived artifact. The OpenAPI divergence pitfall suggests inverting this: make the spec the truth and generate integration tests from it. If the spec says `/v1/users/{user_id}` returns a 200 with a `User` schema, a generated contract test verifies this against the live gateway. When the implementation drifts from the spec, the contract test fails before the change reaches production. This inversion requires tooling investment (contract test generation from OpenAPI) but eliminates the entire class of spec-implementation divergence bugs.

---
