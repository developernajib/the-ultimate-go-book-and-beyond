## Protocol Selection Guide

Choosing the wrong protocol is an architectural mistake that is expensive to fix later, so it pays to reason through the decision systematically. The matrix below distils the key trade-offs: gRPC wins on raw throughput because protobuf binary encoding and HTTP/2 multiplexing eliminate the overhead of JSON parsing and per-request TCP handshakes, making it the default for internal service-to-service calls. GraphQL's query flexibility comes at a CPU cost from schema parsing and resolver fan-out, which is why it fits best at the client-facing BFF layer rather than in the hot path between microservices.

```
┌──────────────────────────────────────────────────────────────────┐
│                    Protocol Decision Tree                        │
│                                                                  │
│  Use Case             Best Choice      Alternative               │
│  ────────             ───────────      ───────────               │
│  Public APIs          REST             GraphQL                   │
│  Internal microsvcs   gRPC             REST                      │
│  Real-time push       WebSocket        SSE (server-only)         │
│  Flexible queries     GraphQL          REST + HATEOAS            │
│  Streaming data       gRPC streaming   WebSocket                 │
│  Browser events       SSE              WebSocket                 │
│  Mobile-first         GraphQL          REST                      │
│  IoT/embedded         gRPC (binary)    MQTT                      │
│                                                                  │
│  Performance: gRPC > WebSocket > REST > GraphQL                  │
│  Flexibility: GraphQL > REST > gRPC                              │
│  Simplicity:  REST > GraphQL > gRPC                              │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Reading the Decision Matrix and Avoiding Common Misapplication

The decision matrix is useful only if you connect each row to a concrete engineering reason. Memorizing "internal microservices use gRPC" without understanding why leads to cargo-culting. The reason gRPC wins for internal microservices is not because it is fashionable: it is because when both caller and callee are services you own and deploy, the overhead of JSON parsing, field-name repetition in every payload, and lack of a shared schema contract all become costs you pay without receiving any benefit. Those costs are zero-value when the caller is also a service you compile.

A common junior mistake is applying the matrix without considering operational readiness. gRPC requires protobuf tooling, a code generation pipeline, and team familiarity with proto syntax. Introducing gRPC into a team that has none of this adds friction that may outweigh the performance benefit for a low-traffic internal API. The correct question is not just "which protocol is fastest" but "which protocol produces the best outcome given our current toolchain, traffic volume, and team experience."

For FAANG interviews, practice talking through the decision for a concrete scenario rather than reciting the matrix. If an interviewer describes a notification system that pushes order updates to a browser, work through it out loud: browser client eliminates gRPC natively, the data flows only server to client, auto-reconnect matters, so SSE is the right answer. That reasoning process is what interviewers are evaluating.

### Senior @ FAANG: Protocol Selection as an ADR and Governance Artifact

At senior and staff level, protocol selection for a new service is not a local decision made by the implementing team. It is an architectural decision that should be captured as an ADR (Architecture Decision Record) and reviewed by platform or API governance, because the choice affects every other team that needs to call that service.

A complete ADR for protocol selection covers: the primary caller audience and their constraints, the performance requirements with measured or modeled traffic, the schema stability requirements and who bears the cost of breaking changes, the existing organizational investment in tooling for each candidate protocol, and the migration cost if the wrong choice is made. Without this framing, protocol decisions get made based on individual preference and are expensive to revisit.

The matrix in this section maps to a maturity model for protocol governance. An organization at maturity level 1 has no protocol standard: teams pick REST, gRPC, or ad-hoc WebSocket independently, and callers must understand multiple protocols. At level 2, REST is the standard for external APIs and gRPC is the standard for internal, with guidance but no enforcement. At level 3, the buf schema registry enforces proto lint and breaking-change checks on CI, a shared interceptor library handles auth and tracing consistently, and protocol deviations require an approved ADR. Level 3 is the target for organizations running more than a dozen microservices.

Bar-raiser signal: candidates who reason about protocol selection in terms of organizational cost, not just technical performance. A staff engineer who says "gRPC is the right default for this service, but given that the team has no proto tooling today, we should invest in a buf-based pipeline first and deploy the REST path in parallel to avoid blocking the product launch" is demonstrating the trade-off reasoning that separates L6 from L5.
