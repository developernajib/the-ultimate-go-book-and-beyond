## Summary

gRPC-Gateway generates an HTTP/JSON reverse proxy from `google.api.http` annotations in your `.proto` files, letting a single service definition serve both gRPC and REST clients without maintaining two separate API surfaces.

Key takeaways from this chapter:

1. **HTTP Annotations** map gRPC methods to REST endpoints using path parameters, query parameters, and body bindings. The `additional_bindings` option exposes the same RPC at multiple HTTP paths when needed.
2. **Gateway Server** configuration controls JSON field naming (`UseProtoNames`), zero-value emission (`EmitUnpopulated`), unknown field handling (`DiscardUnknown`), and header propagation between HTTP and gRPC metadata.
3. **Custom Error Handlers** replace the default error response with a consistent JSON envelope, sanitize internal error messages before exposing them to HTTP clients, and log the full gRPC status server-side.
4. **Streaming Bridges** use Server-Sent Events for server-streaming RPCs and WebSocket upgrades for bidirectional streaming, with keepalive messages to detect dead connections through load balancers.
5. **Request/Response Transformation** includes custom marshalers for legacy JSON shapes, response envelope wrapping, and forwarding gRPC response metadata (like rate-limit headers) back to HTTP clients.
6. **OpenAPI Generation** with `protoc-gen-openapiv2` produces specs that stay synchronized with the proto contract. Embedding the spec via `//go:embed` and serving Swagger UI makes the API self-documenting.
7. **Production Patterns** include aggregated health checks across multiple backends, Consul-based service discovery for dynamic routing, idempotency middleware for safe retries, and URL-based API versioning with sunset headers.

### Junior -> FAANG: Building a Coherent Mental Model from Seven Takeaways

The seven points in this summary represent a progression from annotation mechanics to production operations. A junior engineer who can explain all seven in plain language, with a concrete example for each, is ready for a FAANG technical screen on this topic.

The most important connection to make explicit: takeaways 1 and 2 (annotations and marshaler config) are the source of truth for your REST API contract. Takeaways 3 and 4 (error handlers and streaming bridges) are what make the gateway reliable under failure. Takeaways 5 and 6 (transformation and OpenAPI) are what make the gateway maintainable and discoverable. Takeaway 7 (production patterns) is what makes it production-grade at scale.

Junior engineers often know the first two and skip to the last one. The middle three (error handling, streaming error cases, response transformation) are where production incidents live. Prioritize those in your study plan.

Self-assessment questions before you consider this chapter complete:

- Can you write the `buf.gen.yaml` entry for grpc-gateway from memory?
- Can you explain what `body: "*"` versus `body: "user"` does without looking it up?
- Can you describe what the default header matcher does and does not forward?
- Can you write a custom error handler that correctly sanitizes `codes.Internal` errors?
- Can you explain why SSE requires `flusher.Flush()` and `X-Accel-Buffering: no`?
- Can you name three things the `//go:embed` OpenAPI approach gets right and one thing it gets wrong (the spec must be regenerated before build)?
- Can you name the two things you must check when an authenticated request returns 401 from the backend (not the gateway)?

If you can answer these seven questions without hesitation, you have internalized the chapter. If any answer requires checking the code, that topic needs another pass.

### Senior @ FAANG: Summary as a Governance Checklist

The seven takeaways in this summary map to seven governance areas for a platform team that runs gRPC-Gateway infrastructure.

**HTTP annotation governance:** a `buf lint` ruleset that enforces consistent path naming, required operation annotations (summary, tags, at least one error response), and prohibited patterns (no wildcard paths on public-facing routes, no colliding patterns within a service).

**Marshaler configuration governance:** a platform library that provides a pre-configured `runtime.JSONPb` with the organization's standard settings (`UseProtoNames: true`, `DiscardUnknown: true`). Teams override only with documented justification. Changes to the marshaler config are treated as breaking changes and require a deprecation window.

**Error handler governance:** a shared `ErrorHandler` function in the platform library that enforces the error taxonomy, sanitizes internal messages, and logs the full gRPC status server-side. Individual services cannot override the error handler without platform review, because the error response shape is a public API contract.

**Streaming governance:** a checklist for any streaming endpoint (SSE or WebSocket) that includes: connection limit configured, keepalive interval less than the load balancer timeout, error events sent on backend failure, connection tracking with metrics, and a test that verifies behavior when the backend stream terminates unexpectedly.

**Transformation governance:** a policy that all response transformations must be time-bounded with a documented removal condition and associated metric. Transformations older than 12 months without a removal plan require a platform review to either extend or remove.

**OpenAPI governance:** the spec is published to the API catalog on every deployment. Contract tests are generated from the spec and run in the staging environment. The spec version matches the service version. Breaking changes to the spec are detected in CI and require a versioning decision (bump the major version or provide a compatibility alias).

**Production pattern governance:** service discovery backend is specified in the platform runbook (Consul, Kubernetes DNS, or cloud-native service discovery). Idempotency middleware is required for all mutating public endpoints. API versioning follows the `{package}.v{N}` convention. Sunset headers are required for all deprecated versions and are automatically added by the platform middleware when the version is marked deprecated in the service catalog.

This governance checklist is the difference between a chapter that taught you how to use gRPC-Gateway and an organization that uses gRPC-Gateway correctly at scale.

---
