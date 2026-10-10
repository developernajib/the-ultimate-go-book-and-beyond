## Section 12: Production Checklist and Common Mistakes

### 12.1 gRPC Production Checklist

Shipping a gRPC service to production without this checklist applied is the fastest way to accumulate hard-to-debug incidents. The four categories reflect the order in which problems surface: schema compatibility issues break deployments during rollout, missing TLS and auth create security vulnerabilities that are silent until exploited, reliability gaps (no deadlines, no keepalive) cause cascading timeouts under load, and absent observability means you cannot diagnose any of the above after the fact.

```
┌────────────────────────────────────────────────────────────────────┐
│                    gRPC Production Checklist                       │
│                                                                    │
│  Schema & Compatibility                                            │
│  □ Use buf lint and buf breaking for schema validation             │
│  □ Reserve deleted field numbers and names                         │
│  □ Version packages (order.v1, order.v2, not just order)           │
│  □ Use field masks for partial updates                             │
│                                                                    │
│  Security                                                          │
│  □ TLS on all connections (mTLS for internal service-to-service)   │
│  □ JWT or mTLS authentication in interceptors                      │
│  □ Disable gRPC reflection in production                           │
│  □ Validate all incoming fields before processing                  │
│                                                                    │
│  Reliability                                                       │
│  □ Always set deadlines on client calls (never omit)               │
│  □ Implement retry with exponential backoff via service config     │
│  □ Add keepalive parameters to prevent dead connection pooling     │
│  □ Implement health checking (grpc-health-probe compatible)        │
│  □ Graceful shutdown: NOT_SERVING → GracefulStop                   │
│                                                                    │
│  Observability                                                     │
│  □ Unary and stream interceptors for logging and tracing           │
│  □ Export gRPC metrics (latency, error rate, active streams)       │
│  □ Structured error responses with codes, not just strings         │
│  □ Use status.Details() for machine-readable error fields          │
│                                                                    │
│  Performance                                                       │
│  □ Enable message compression for payloads > 1KB                   │
│  □ Use grpc.WithDefaultServiceConfig for load balancing policy     │
│  □ Tune MaxRecvMsgSize and MaxSendMsgSize for your payload sizes   │
│  □ Profile serialization with pprof before optimizing              │
└────────────────────────────────────────────────────────────────────┘
```

### 12.2 Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| No gRPC interceptors | No observability, no auth | Add logging + auth interceptors from day 1 |
| Forgetting `defer conn.Close()` | Connection leak | Always close gRPC client connections |
| GraphQL N+1 queries | Each resolver queries DB | Use DataLoader pattern to batch queries |
| No deadlines on gRPC calls | Calls hang forever | Always set context deadline on client calls |
| Streaming without backpressure | Client overwhelmed | Use bounded channels in streaming handlers |
| Ignoring gRPC status codes | Wrong error handling | Map domain errors to appropriate gRPC codes |
| Returning `codes.Internal` for everything | Clients can't distinguish errors | Use specific codes: NotFound, InvalidArgument, etc. |
| Reflection enabled in production | Exposes full service schema | Restrict to internal networks or disable entirely |
| No keepalive configuration | Dead connections not detected | Configure both server and client keepalive |
| Missing `reserved` on deleted fields | Field number reuse breaks old clients | Always reserve deleted field numbers and names |
| `oneof` switching via nil check | Misses zero-value cases | Use type switch on the generated interface |
| Not draining before shutdown | In-flight RPCs dropped | Set NOT_SERVING, then GracefulStop |

---

### Junior → FAANG: Using the Checklist as a Code Review Tool

A production checklist is only useful if it is applied systematically. Printing it and forgetting it is the normal failure mode. The effective first-job habit is to use the checklist as part of your PR review process: before you merge a new gRPC service or a significant change to an existing one, walk through each item and confirm it is addressed or has a documented reason for exclusion.

The four categories in the checklist reflect the four most common sources of gRPC incidents in production:

Schema compatibility issues surface during deployments when a new server version and old client version coexist. `buf breaking` in CI prevents this. Without it, a field number change or message type rename deploys silently and causes data corruption that is difficult to trace back to the schema change.

Security gaps from disabled TLS or missing auth interceptors are silent until exploited. They are not visible in monitoring or logs. They are discovered by a security audit or by an incident. Adding TLS and auth from the first deployment is categorically less expensive than retrofitting them later.

Reliability gaps from missing deadlines and keepalive cause cascading timeout failures under load. A service that works fine at 100 RPS may exhibit cascading timeouts at 10,000 RPS when connection pools exhaust and deadline-less calls queue indefinitely. These failures are not predictable from low-traffic testing.

Observability gaps mean you cannot diagnose any of the above in production. Unstructured logs, missing traces, and no gRPC method-level metrics are all observability gaps.

### Senior @ FAANG: Embedding the Checklist in Platform Tooling and Maturity Assessment

At staff level, the production checklist becomes an organizational artifact rather than a personal checklist. The goal is to make compliance automatic rather than relying on individual engineers to remember and apply each item.

Each checklist item maps to a specific enforcement mechanism. Schema compatibility: `buf breaking` runs in CI on every PR that touches `.proto` files, blocking merge on violations. Security: a custom `golangci-lint` rule or a `buf lint` plugin checks that every gRPC server instantiation uses `grpc.Creds(...)` rather than `insecure.NewCredentials()` (except in test files). Auth interceptor: a platform-provided server constructor requires auth configuration and panics at startup if none is provided, making the insecure-by-default pattern impossible. Deadlines: a client-side linter checks for `grpc.NewClient` calls that omit a timeout from their context, flagging them as warnings in CI.

Observability has the clearest platform enforcement path. If the platform-provided shared interceptor library handles logging, tracing, and metrics emission, and if the approved server constructor requires that interceptor chain, then observability is opt-out rather than opt-in. Any service that does not use the platform constructor must file an exception with justification, which creates a visible gap in the audit trail.

The maturity model for a gRPC service fleet has five levels. Level 1: services run without TLS, no interceptors, no health checking. Level 2: TLS and auth are present but applied inconsistently. Level 3: full checklist compliance for new services, old services migrating on a tracked roadmap. Level 4: compliance enforced by platform tooling and CI gates, with zero manual checklist review needed. Level 5: security posture actively monitored, schema registry automated, and compliance metrics reported to engineering leadership. Most FAANG internal platforms operate at level 4, with aspirations toward level 5 on the security axis.
