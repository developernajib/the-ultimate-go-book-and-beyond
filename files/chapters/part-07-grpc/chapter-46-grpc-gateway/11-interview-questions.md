## 46.9 Interview Questions

### Question 1: When would you choose gRPC-Gateway over a separate REST implementation?

**Answer:**

gRPC-Gateway is preferred when:

1. **Internal services use gRPC** - You already have gRPC services and need REST for external clients
2. **API consistency is critical** - Single proto definition ensures REST and gRPC behave identically
3. **Automatic documentation** - OpenAPI specs generated from protos stay in sync
4. **Gradual migration** - Transitioning from REST to gRPC while maintaining backward compatibility
5. **Browser clients need support** - gRPC-Web has limitations, so REST via gateway is simpler

Choose separate REST implementation when:
- REST API has different semantics than gRPC (e.g., HATEOAS)
- Performance is critical (gateway adds latency)
- You need REST-specific features not expressible in proto annotations

```go
// Decision framework
func shouldUseGateway() bool {
    hasGRPCServices := true
    needsRESTForExternalClients := true
    apiSemanticsIdentical := true // REST maps 1:1 to gRPC
    acceptableLatency := 5 * time.Millisecond // Gateway adds ~1-2ms

    return hasGRPCServices &&
           needsRESTForExternalClients &&
           apiSemanticsIdentical
}
```

**What FAANG expects:** A senior answer frames this as a build-vs-adopt decision that names the alternatives explicitly. In 2026 the realistic options for a Go codebase are grpc-gateway v2, Connect-Go with Vanguard (same handler serves gRPC and REST from one binary, no transpilation), and Envoy's gRPC-JSON transcoder (done at the mesh, zero Go changes). Strong candidates also surface the hidden costs: who owns the OpenAPI spec, how errors are mapped, what happens to streaming, and whether clients actually benefit from gRPC at all, if 100% of callers are browsers, a plain REST/JSON service is simpler than two layers.

**Follow-ups the interviewer will ask:**
- "Your team ships a new greenfield service with mostly browser clients, do you still reach for grpc-gateway?" (Expected: no. Connect-Go is designed for that case.)
- "Your platform team wants to centralize transcoding at the ingress. What are the trade-offs versus in-process grpc-gateway?" (Expected: Envoy filter means one config surface and no per-service binary, but you lose Go-level custom marshalers, response options, and interceptor-driven header shaping.)
- "How do you keep the OpenAPI spec honest once you have both REST and gRPC clients?" (Expected: generate it from the same `.proto` via `protoc-gen-openapiv2`, fail CI on drift, publish the spec artifact alongside the binary.)

### Question 2: How do you handle authentication across REST and gRPC in a gateway?

**Answer:**

The key is maintaining consistent auth context across the protocol boundary:

```go
// Authentication middleware that works for both HTTP and gRPC
package auth

import (
    "context"
    "net/http"
    "strings"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc/metadata"
)

type contextKey string

const UserContextKey contextKey = "user"

type User struct {
    ID    string
    Email string
    Roles []string
}

// HTTP middleware extracts and validates token
func HTTPAuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := extractToken(r)
        if token == "" {
            http.Error(w, "unauthorized", http.StatusUnauthorized)
            return
        }

        user, err := validateToken(token)
        if err != nil {
            http.Error(w, "invalid token", http.StatusUnauthorized)
            return
        }

        // Add user to context for downstream handlers
        ctx := context.WithValue(r.Context(), UserContextKey, user)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Configure gateway to forward auth metadata
func AuthMetadataAnnotator(ctx context.Context, r *http.Request) metadata.MD {
    md := metadata.MD{}

    // Forward original token
    if auth := r.Header.Get("Authorization"); auth != "" {
        md.Set("authorization", auth)
    }

    // Forward validated user info (optional, avoids re-validation)
    if user, ok := ctx.Value(UserContextKey).(*User); ok {
        md.Set("x-user-id", user.ID)
        md.Set("x-user-email", user.Email)
        md.Set("x-user-roles", strings.Join(user.Roles, ","))
    }

    return md
}

// gRPC interceptor trusts forwarded metadata from gateway
func GRPCAuthInterceptor(ctx context.Context, req any,
    info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {

    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return nil, status.Error(codes.Unauthenticated, "missing metadata")
    }

    // Check for pre-validated user info from gateway
    if userIDs := md.Get("x-user-id"); len(userIDs) > 0 {
        // Trust gateway's validation (internal traffic only!)
        user := &User{ID: userIDs[0]}
        if emails := md.Get("x-user-email"); len(emails) > 0 {
            user.Email = emails[0]
        }
        ctx = context.WithValue(ctx, UserContextKey, user)
        return handler(ctx, req)
    }

    // Fallback: Validate token directly (for direct gRPC clients)
    tokens := md.Get("authorization")
    if len(tokens) == 0 {
        return nil, status.Error(codes.Unauthenticated, "missing token")
    }

    user, err := validateToken(strings.TrimPrefix(tokens[0], "Bearer "))
    if err != nil {
        return nil, status.Error(codes.Unauthenticated, "invalid token")
    }

    ctx = context.WithValue(ctx, UserContextKey, user)
    return handler(ctx, req)
}

func extractToken(r *http.Request) string {
    // Check Authorization header
    auth := r.Header.Get("Authorization")
    if strings.HasPrefix(auth, "Bearer ") {
        return strings.TrimPrefix(auth, "Bearer ")
    }

    // Check query parameter (for SSE/WebSocket)
    return r.URL.Query().Get("token")
}
```

**What FAANG expects:** Validate once, trust-but-verify downstream, and name your trust boundary explicitly. The gateway terminates TLS and validates the token, then propagates the verified principal as signed metadata (or at minimum over a network the gRPC backend trusts, mTLS-authenticated pod-to-pod or a private mesh). Re-validating JWTs on every gRPC hop is wasted CPU. blindly trusting headers from the internet is a CVE. Interviewers also listen for: how do you handle token rotation, how does a direct gRPC client (non-browser) authenticate, and how do you revoke access before the JWT expires.

**Follow-ups the interviewer will ask:**
- "The gateway sits behind a public load balancer and the gRPC backend is on the same VPC. How do you make sure a compromised service in the VPC can't spoof `x-user-id`?" (Expected: mTLS between gateway and backend, signed internal tokens, or the backend re-validates the original JWT, never trust plain metadata crossing a trust boundary.)
- "How would you implement per-method authorization (RBAC) without duplicating the rules between REST and gRPC?" (Expected: declare roles in the proto via custom options or policy-as-code (OPA), enforce once in the gRPC interceptor, the gateway becomes dumb.)
- "A WebSocket or SSE connection lives for an hour. The JWT expires in 15 minutes. What happens?" (Expected: either refresh via a sidechannel and re-validate periodically inside the handler, or disconnect on expiry, never let a long-lived stream outlive its credentials silently.)

### Question 3: How would you implement API versioning with gRPC-Gateway?

**Answer:**

There are three common approaches:

```go
// Approach 1: URL-based versioning (most common)
// /api/v1/users → user.v1.UserService
// /api/v2/users → user.v2.UserService

// Proto files:
// user/v1/user.proto → package user.v1;
// user/v2/user.proto → package user.v2;

func registerVersionedServices(ctx context.Context, mux *runtime.ServeMux) error {
    // Register v1
    if err := userv1.RegisterUserServiceHandlerFromEndpoint(
        ctx, mux, "user-service-v1:50051", opts); err != nil {
        return err
    }

    // Register v2 (can point to same or different service)
    if err := userv2.RegisterUserServiceHandlerFromEndpoint(
        ctx, mux, "user-service-v2:50051", opts); err != nil {
        return err
    }

    return nil
}

// Approach 2: Header-based versioning
// API-Version: 2023-01-15

func VersionHeaderMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := r.Header.Get("API-Version")
        if version == "" {
            version = "2023-01-15" // Default to stable version
        }

        // Route to appropriate backend based on version
        ctx := context.WithValue(r.Context(), "api-version", version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Approach 3: Accept header (content negotiation)
// Accept: application/vnd.api+json;version=2

func ContentNegotiationMiddleware(versions map[string]http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        accept := r.Header.Get("Accept")
        version := extractVersionFromAccept(accept)

        handler, ok := versions[version]
        if !ok {
            handler = versions["v1"] // Default
        }

        handler.ServeHTTP(w, r)
    })
}

// Best practice: Combine URL versioning with sunset headers
func AddVersionHeaders(next http.Handler, currentVersion, minVersion string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract version from URL
        pathVersion := extractPathVersion(r.URL.Path)

        w.Header().Set("X-API-Version", pathVersion)

        // Warn about deprecated versions
        if isDeprecated(pathVersion) {
            w.Header().Set("Deprecation", "true")
            w.Header().Set("Sunset", "2027-06-01")
            w.Header().Set("Link",
                fmt.Sprintf("</api/%s>; rel=\"successor-version\"", currentVersion))
        }

        next.ServeHTTP(w, r)
    })
}
```

**What FAANG expects:** Versioning is a proto/package discipline problem before it is an HTTP routing problem. Put the version in the proto package (`user.v1`, `user.v2`) so the generated Go types, gateway paths, and OpenAPI spec line up automatically, and keep v1 and v2 backends runnable side-by-side until traffic drains. Use the `Deprecation` and `Sunset` headers (RFC 8594) so clients find out before they break. Avoid custom header versioning unless you have a specific reason, it makes URLs non-cacheable and hides versioning from browser DevTools and curl.

**Follow-ups the interviewer will ask:**
- "You need to add a required field to `CreateUserRequest`. Do you bump to v2?" (Expected: no, additions are backward compatible in proto3. Only removals, renumbering, or semantic changes to an existing field require a new version.)
- "How do you prevent v1 and v2 implementations from drifting when both are active?" (Expected: share the business logic layer. Only the gRPC handler and proto types are versioned. Or implement v1 as a thin translator that calls into v2.)
- "A major customer is pinned to v1 six months past sunset. What does your rollout actually look like?" (Expected: structured deprecation, increasing log signals, reach out with usage dashboards, hard-deprecate with HTTP 410 on a date, never silently break.)

### Question 4: What are the performance implications of using gRPC-Gateway?

**Answer:**

gRPC-Gateway adds overhead in several areas:

```go
// Overhead sources and mitigation strategies

// 1. JSON ↔ Protobuf transcoding (biggest overhead)
// Mitigation: Reuse marshalers, use proto3 (smaller messages)

var jsonMarshaler = &runtime.JSONPb{
    MarshalOptions: protojson.MarshalOptions{
        UseProtoNames: true,
    },
}

// Pre-allocate for hot paths
var messagePool = sync.Pool{
    New: func() any {
        return new(pb.Request)
    },
}

// 2. HTTP/1.1 → HTTP/2 protocol conversion
// Mitigation: Keep gateway close to gRPC server (same pod/host)

// 3. Additional network hop
// Mitigation: Use in-process gateway for single-service deployments

func InProcessGateway() {
    // gRPC server on local Unix socket
    lis, _ := net.Listen("unix", "/tmp/grpc.sock")
    go grpcServer.Serve(lis)

    // Gateway connects locally
    conn, _ := grpc.NewClient("unix:///tmp/grpc.sock",
        grpc.WithTransportCredentials(insecure.NewCredentials()))
}

// 4. Connection pooling
// Mitigation: Use persistent connections, tune pool size

func OptimizedDialOptions() []grpc.DialOption {
    return []grpc.DialOption{
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second, // Ping interval
            Timeout:             3 * time.Second,  // Ping timeout
            PermitWithoutStream: true,             // Ping even without RPCs
        }),
        grpc.WithInitialWindowSize(1 << 20),     // 1MB
        grpc.WithInitialConnWindowSize(1 << 20), // 1MB
    }
}

// Benchmark results (typical):
// Direct gRPC:      0.5ms p50, 2ms p99
// Via Gateway:      2ms p50, 8ms p99
// Overhead:         ~1.5ms (transcoding + hop)

// When gateway overhead is acceptable:
// - External API traffic (latency dominated by network)
// - Non-latency-critical paths
// - Browser clients (can't use gRPC directly)

// When to avoid gateway:
// - Service-to-service calls (use gRPC directly)
// - Sub-millisecond latency requirements
// - High-throughput internal APIs
```

**What FAANG expects:** Numbers, not adjectives. A senior candidate states where the overhead actually comes from (JSON↔proto marshaling dominates. The localhost hop is negligible if colocated), quotes a realistic budget (low-single-digit ms p50, ~5-10ms p99 added), and explains how they would measure it (pprof the gateway process, track `grpc_server_handled_total` vs. gateway-seen latency, alert on the delta). They also flag GC pressure from JSON marshaling at high QPS and know the mitigations: sync.Pool for response buffers, `UseProtoNames`, and moving hot endpoints off the gateway if needed.

**Follow-ups the interviewer will ask:**
- "Your p99 latency through the gateway jumped from 10ms to 80ms at peak. Walk me through how you debug this." (Expected: check upstream gRPC p99 first, then gateway GC pause (`GODEBUG=gctrace=1`), then connection pool saturation, then TLS handshake storm, not "scale horizontally" as step one.)
- "You're hitting 50k QPS through the gateway and allocations dominate the profile. What do you change?" (Expected: pool marshal buffers, reduce message size via field_mask or paginated responses, consider moving high-QPS paths to Connect-Go or direct gRPC.)
- "Does it ever make sense to colocate the gateway as a sidecar vs. embed it in the gRPC process?" (Expected: embed for single-service deployments (one process, one port range, shared memory, simpler ops), and sidecar when the gateway is shared across multiple backends or when you want independent scaling of the REST surface.)

### Question 5: How do you handle file uploads through gRPC-Gateway?

**Answer:**

File uploads require special handling since gRPC-Gateway doesn't natively support multipart forms:

```go
// Option 1: Bypass gateway for uploads (recommended for large files)
func SetupRoutes(gatewayMux *runtime.ServeMux, uploadHandler http.Handler) http.Handler {
    mux := http.NewServeMux()

    // Direct upload handler (not through gateway)
    mux.Handle("/api/v1/upload", uploadHandler)

    // Gateway handles other routes
    mux.Handle("/", gatewayMux)

    return mux
}

// Direct upload handler with streaming to gRPC
func UploadHandler(client pb.FileServiceClient) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodPost {
            http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
            return
        }

        // Parse multipart form (32MB max in memory)
        if err := r.ParseMultipartForm(32 << 20); err != nil {
            http.Error(w, "parse form: "+err.Error(), http.StatusBadRequest)
            return
        }

        file, header, err := r.FormFile("file")
        if err != nil {
            http.Error(w, "get file: "+err.Error(), http.StatusBadRequest)
            return
        }
        defer file.Close()

        // Create gRPC stream
        stream, err := client.Upload(r.Context())
        if err != nil {
            http.Error(w, "create stream: "+err.Error(), http.StatusInternalServerError)
            return
        }

        // Send metadata first
        if err := stream.Send(&pb.UploadRequest{
            Data: &pb.UploadRequest_Metadata{
                Metadata: &pb.FileMetadata{
                    Filename:    header.Filename,
                    ContentType: header.Header.Get("Content-Type"),
                    Size:        header.Size,
                },
            },
        }); err != nil {
            http.Error(w, "send metadata: "+err.Error(), http.StatusInternalServerError)
            return
        }

        // Stream file chunks
        buf := make([]byte, 64*1024) // 64KB chunks
        for {
            n, err := file.Read(buf)
            if err == io.EOF {
                break
            }
            if err != nil {
                http.Error(w, "read file: "+err.Error(), http.StatusInternalServerError)
                return
            }

            if err := stream.Send(&pb.UploadRequest{
                Data: &pb.UploadRequest_Chunk{
                    Chunk: buf[:n],
                },
            }); err != nil {
                http.Error(w, "send chunk: "+err.Error(), http.StatusInternalServerError)
                return
            }
        }

        // Complete upload
        resp, err := stream.CloseAndRecv()
        if err != nil {
            http.Error(w, "close stream: "+err.Error(), http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(resp)
    }
}

// Option 2: Base64-encoded body through gateway (small files only)
// Proto definition:
// message UploadFileRequest {
//     string filename = 1;
//     string content_type = 2;
//     bytes data = 3; // Base64-encoded in JSON
// }

// Option 3: HttpBody for raw binary (no JSON transcoding)
// Proto:
// import "google/api/httpbody.proto" - //
// rpc UploadRaw(google.api.HttpBody) returns (UploadResponse) {
//     option (google.api.http) = {
//         post: "/api/v1/upload/raw"
//         body: "*"
//     };
// }

func HttpBodyHandler() runtime.ServeMuxOption {
    return runtime.WithMarshalerOption("application/octet-stream",
        &runtime.HTTPBodyMarshaler{
            Marshaler: &runtime.JSONPb{},
        },
    )
}
```

**What FAANG expects:** Recognize that file upload is the case where grpc-gateway's strength (proto-as-source-of-truth) becomes a liability, multipart/form-data doesn't map cleanly to proto, and wrapping a 4GB file as base64 inside JSON is indefensible. A senior answer picks the right door for the file size: `google.api.HttpBody` or a bypass handler that streams chunks into a client-streaming gRPC RPC for anything non-trivial, and presigned S3/GCS URLs for production-scale uploads where you don't want bytes flowing through your service at all.

**Follow-ups the interviewer will ask:**
- "Your users want to upload 5GB video files. Do you stream through gRPC at all?" (Expected: no, issue a presigned URL, let the client upload directly to object storage, and then call a gRPC RPC to register the resulting object. The gateway never sees the bytes.)
- "How do you handle resumable uploads?" (Expected: tus.io protocol, or S3 multipart with upload IDs, not a custom gRPC streaming protocol, because mobile clients will drop connections.)
- "How do you enforce a 10MB body limit so a malicious client can't OOM your gateway?" (Expected: `http.MaxBytesReader` on the request body, `MaxRecvMsgSize` on the gRPC server, and a reverse-proxy-level cap as defense in depth.)

### Junior -> FAANG: Using These Questions to Build Your Mental Model

The five interview questions in this section cover the most common gRPC-Gateway topics in FAANG system design and technical screens. Use them as a self-assessment: can you answer each question without looking at the provided answer?

For Question 1 (when to use gRPC-Gateway), practice the decision framework aloud. State the alternatives (Connect-Go, Envoy, plain REST) before naming gRPC-Gateway. Interviewers are testing whether you know the landscape, not just one tool.

For Question 2 (authentication), the critical concept to practice is the trust boundary. Draw where auth validation happens (gateway), what gets forwarded (enriched metadata, not raw tokens for internal-only traffic), and how a direct gRPC client (not via the gateway) authenticates (the backend must also validate directly).

For Question 3 (API versioning), the key insight to practice is that versioning starts in the proto package, not in the gateway routing. Say "I put the version in the package name `user.v1`" before you explain how the gateway routes to different backends.

For Question 4 (performance), have numbers ready. The typical gateway overhead is 1-3 ms p50 for JSON transcoding on moderately sized messages. Say the number. Saying "there is some overhead" without a magnitude is not a senior answer.

For Question 5 (file uploads), the presigned URL answer is the senior differentiator. Many candidates will describe streaming through the gateway. The better answer is "for anything over a few MB, issue a presigned URL and never let the bytes touch the gateway."

Preparation habit: record yourself answering each question for 90 seconds. Listen back. Are you leading with the tradeoffs, or are you starting from implementation details? Interviewers want tradeoffs first.

### Senior @ FAANG: What Bar-Raisers Actually Listen For

A bar-raiser at a FAANG company listens for two things that most candidates miss: scope awareness and risk articulation.

**Scope awareness** means the candidate understands that the question is not just about the technical mechanism but about where it fits in a larger system. When asked "how do you handle authentication across REST and gRPC," a scope-aware answer includes: who owns the token validation logic (a shared auth library or a dedicated auth service), how token rotation affects long-lived connections, and what the fallback is when the auth service is temporarily unavailable. A scope-unaware answer describes JWT validation code without addressing any of those concerns.

**Risk articulation** means the candidate names what can go wrong, not just what should happen. For every design choice, there is a failure mode. For the idempotency pattern: what happens when the idempotency store is unavailable? (Fail open and allow non-idempotent behavior, or fail closed and return 503? The business context determines the answer.) For the versioning pattern: what happens when v1 and v2 are running simultaneously and a shared database schema change is needed? (This is the hard part of versioning. Most candidates skip it.)

**L6/L7 bar-raiser signals:**
- The candidate volunteers information about operational concerns (deployment, monitoring, alerting) without being asked.
- The candidate has an opinion about organizational patterns (who owns the shared gateway, how teams onboard) not just technical patterns.
- The candidate thinks about the lifecycle of the design (how does this deprecate, what triggers a redesign) not just the initial implementation.
- The candidate corrects or refines the question: "That's the right question for a public API, but for an internal API the more interesting question is..."
- The candidate names the failure modes of their own proposed solution before the interviewer asks.

For gRPC-Gateway specifically, the bar-raiser question that most separates L5 from L6 is: "Your organization has 50 Go services using grpc-gateway. How do you upgrade the grpc-gateway library version across all of them without breaking any clients?" The expected answer involves: a shared `tools.go` with a pinned version managed by the platform team, a migration guide for breaking changes, a canary deployment that tests the new version against production traffic before rolling out, and a rollback plan. An L5 answer describes how to update one service. An L6 answer describes how to coordinate the update across 50 services and maintain API compatibility throughout.

---
