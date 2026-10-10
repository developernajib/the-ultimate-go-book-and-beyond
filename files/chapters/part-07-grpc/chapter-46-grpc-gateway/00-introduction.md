# Chapter 46: gRPC-Gateway & REST Transcoding

Adopting gRPC for internal service communication is a clear win for performance and type safety, but it introduces an immediate practical problem: browsers cannot speak gRPC natively, most third-party tooling expects REST and JSON, and partner integrations almost universally require HTTP/1.1. Building and maintaining two separate API surfaces, one in gRPC and one in REST, doubles the surface area for bugs, documentation drift, and schema inconsistencies. Engineering teams that have tried this approach consistently report that the two surfaces diverge over time in ways that are expensive to detect and fix.

gRPC-Gateway solves this by generating a reverse proxy that translates RESTful HTTP/JSON requests into gRPC calls - in both directions - from annotations in your `.proto` file. The mapping lives in the source of truth alongside the service definition, so it cannot drift. A single annotated `.proto` becomes the basis for a gRPC server, a REST/JSON gateway, an OpenAPI specification, and auto-generated client SDKs simultaneously. Google Cloud APIs use this exact approach: every public Google API is defined in proto, served over gRPC internally, and exposed via a generated HTTP/JSON transcoding layer to external clients.

This chapter walks through the full gRPC-Gateway setup: annotating proto files with `google.api.http` options, generating the gateway mux, running gRPC and HTTP servers on the same process, and customizing error marshaling, request/response transformation, and header forwarding. It also covers the harder edge cases: streaming RPCs bridged to Server-Sent Events, custom marshalers for legacy JSON shapes, and generating production-ready OpenAPI docs with Swagger UI.

**What you'll learn:**
- How gRPC-Gateway's transcoding layer maps HTTP verbs, URL paths, query params, and JSON bodies to proto messages
- Annotating `.proto` files with `google.api.http` options for RESTful endpoint mapping
- Generating the gateway mux with `protoc-gen-grpc-gateway` and wiring it alongside the gRPC server
- Customizing JSON marshaling with `jsonpb` options for field naming, enums, and null handling
- Implementing custom error handlers that translate gRPC status codes to appropriate HTTP status codes
- Bridging server streaming RPCs to Server-Sent Events for browser-compatible real-time feeds
- Generating OpenAPI v2 specifications with `protoc-gen-openapiv2` and serving interactive Swagger UI
- Forwarding incoming HTTP headers as gRPC metadata and reflecting response metadata back as HTTP headers

**Why this matters at scale:**
Google's public Cloud APIs are the proof at scale: they are defined in proto and exposed through exactly this HTTP/gRPC transcoding mechanism (the `google.api.http` annotation gRPC-Gateway reads is Google's own). A single service definition powers both internal gRPC calls and the developer-facing REST API, keeping thousands of endpoints consistent without a dedicated translation team.

**Prerequisites:** Chapters 43-45 (gRPC series), Chapter 29 (HTTP servers), Chapter 38 (REST API design)

### Junior -> FAANG: Why gRPC-Gateway Exists and What You Must Understand First

If you come from a background where you only built REST APIs, the motivation for gRPC-Gateway is not immediately obvious. The core tension is this: gRPC is excellent for internal service-to-service calls because it is typed, compact, and fast, but browsers cannot speak gRPC natively, and most external tooling (curl, Postman, partner SDKs, API gateways) expects HTTP/1.1 with JSON bodies.

The naive fix is to build two handlers for every operation: one gRPC handler and one REST handler. Teams that do this quickly discover that the two surfaces drift. The REST handler grows extra fields, the gRPC handler uses slightly different validation, and eventually a bug exists in one but not the other.

gRPC-Gateway solves the drift problem by making the `.proto` file the single source of truth. The gateway mux is generated, not hand-written. Any mismatch between REST and gRPC behavior is a code-generation bug, not a human oversight.

First-job habits to build now:

- Always pin your `protoc-gen-grpc-gateway` version in `tools.go` alongside your Go module. Floating `@latest` breaks team members on different machines.
- Understand the difference between `body: "*"` (the full request message is read from the HTTP body) and `body: "user"` (only the nested `user` field is read from the body, the rest comes from path or query). Getting this wrong produces silent 400 errors with no obvious cause.
- Run `buf lint` and `buf breaking` in CI from day one. The breaking change detector tells you when a proto change would break existing REST or gRPC clients before it reaches production.
- Read the error response you get from the gateway before assuming the backend is broken. A 400 from the gateway means the JSON body did not unmarshal into the proto message. A 404 with a routing-error body means the URL pattern did not match.

Entry-level interview framing: when asked "how do you expose a gRPC service to external clients," the answer is not "rewrite it in REST." The answer names gRPC-Gateway (or Connect-Go for greenfield), explains the annotation mechanism, and mentions that OpenAPI docs fall out of the same build step.

### Senior @ FAANG: Platform Thinking and the Gateway as an Organizational Boundary

At the L6/L7 level, the interesting question about gRPC-Gateway is not how to configure it but where it belongs in the platform and who owns it. Three models exist in large organizations, each with different governance implications.

**Embedded gateway per service.** Each service binary exposes both a gRPC port and an HTTP/JSON port. The team that owns the service owns the gateway config. This maximizes autonomy and allows per-service customization (custom marshalers, service-specific error shapes), but it means HTTP surface area grows with every new service, CORS config is duplicated, and there is no central place to enforce API governance policies (rate limiting, auth, versioning standards).

**Shared gateway as a platform product.** A platform team runs a gateway fleet that all backend services register with. Backend teams annotate their protos, and the platform team runs the gateway. This centralizes CORS, auth enforcement, rate limiting, and OpenAPI publishing, but it introduces a deployment coupling and a blast radius: a bug in the shared gateway can take down all REST clients simultaneously.

**Mesh-layer transcoding via Envoy.** The gRPC-JSON transcoder runs as an Envoy filter at the ingress or as a sidecar. No Go code is involved on the application side, because the proto descriptor set is loaded at runtime. This is the right choice when your organization already runs Istio or Envoy and wants transcoding to be an infrastructure concern, not a per-service engineering task. The trade-off is that per-service response customization (wrapping envelopes, custom error bodies, response header shaping) requires Lua or WASM filters instead of Go code, which most teams find harder to maintain.

**ADR content for this choice:** the architecture decision record should capture the client mix (what fraction of callers are browsers, external partners, internal services), the team structure (do you have a platform team to own a shared gateway), the observability requirements (do you need per-route latency at the gateway level), and the versioning model (will you run v1 and v2 simultaneously, and how does the gateway routing handle that).

**Bar-raiser interview signals at L6:**
- Can the candidate explain when NOT to use gRPC-Gateway? (Connect-Go owns the greenfield Go case, Envoy owns the polyglot mesh case, and plain REST owns the case where 100% of clients are browsers and gRPC provides no benefit.)
- Does the candidate think about the OpenAPI spec as a product artifact, not just a debug tool? At scale, the spec is used to generate partner SDKs, populate API catalogs, and drive contract tests.
- Does the candidate have an opinion on the trust boundary between the gateway and the backend? The gateway validates auth tokens, and the backend receives enriched metadata. The design must survive a compromised sidecar or a misconfigured internal service.
- Can the candidate explain the deprecation lifecycle end-to-end: `Deprecation` and `Sunset` headers, traffic dashboards showing v1 vs v2 usage, the rollout plan for HTTP 410, and how to handle the one customer who never migrates?

**Maturity model for gRPC-Gateway deployments:**
- Level 1: Gateway generates a working REST proxy. OpenAPI spec is served.
- Level 2: Custom error handler returns a consistent envelope. CORS is explicit. Header propagation is audited.
- Level 3: The spec is a CI artifact. Breaking changes are detected automatically. Client SDKs are generated from the spec.
- Level 4: The gateway enforces per-method rate limits and auth policies centrally. Metrics (p50/p99 per route) flow to dashboards. On-call runbooks reference gateway error codes.
- Level 5: Deprecation is automated. Traffic dashboards drive migration conversations. The gateway config is as reviewed as application code.

---
