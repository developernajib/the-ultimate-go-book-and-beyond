## Validation Architecture Overview

The validation architecture separates syntactic validation (type and format checking) from semantic validation (business rule enforcement) and applies them at different layers. Syntactic checks fail fast at the HTTP boundary, and semantic checks occur in the service layer where domain context is available.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      VALIDATION & ERROR HANDLING FLOW                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        VALIDATION LAYERS                               │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Request ──► Layer 1: Transport ──► Layer 2: Format ──► Layer 3: Rules │  │
│  │                                                                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │  │
│  │  │ Transport       │  │ Format          │  │ Business Rules          │ │  │
│  │  │                 │  │                 │  │                         │ │  │
│  │  │ • Content-Type  │  │ • JSON syntax   │  │ • Uniqueness checks     │ │  │
│  │  │ • Body size     │  │ • Type coercion │  │ • Foreign key exists    │ │  │
│  │  │ • Encoding      │  │ • Required      │  │ • Balance sufficient    │ │  │
│  │  │                 │  │ • Min/Max       │  │ • Rate limits           │ │  │
│  │  │ Status: 400/415 │  │ Status: 400/422 │  │ Status: 409/422/429     │ │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     ERROR RESPONSE STRUCTURE                           │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  {                                                                     │  │
│  │    "status": 422,                        // HTTP status code           │  │
│  │    "code": "VALIDATION_ERROR",           // Machine-readable code      │  │
│  │    "message": "Validation failed",       // Human-readable summary     │  │
│  │    "request_id": "req_abc123",           // For support/debugging      │  │
│  │    "timestamp": "2024-01-15T10:30:00Z",  // When error occurred        │  │
│  │    "details": [                          // Field-level errors         │  │
│  │      {                                                                 │  │
│  │        "field": "email",                                               │  │
│  │        "code": "INVALID_EMAIL",                                        │  │
│  │        "message": "must be a valid email address",                     │  │
│  │        "value": "not-an-email",          // Echo only if non-sensitive │  │
│  │        "location": "body"                // body, query, header, path  │  │
│  │      },                                                                │  │
│  │      {                                                                 │  │
│  │        "field": "age",                                                 │  │
│  │        "code": "TOO_SMALL",                                            │  │
│  │        "message": "must be at least 18",                               │  │
│  │        "value": 15                                                     │  │
│  │      }                                                                 │  │
│  │    ],                                                                  │  │
│  │    "help_url": "https://docs.api.com/errors/VALIDATION_ERROR"          │  │
│  │  }                                                                     │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                      STATUS CODE MAPPING                               │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Domain Error          │ HTTP Status │ Error Code                      │  │
│  │  ──────────────────────┼─────────────┼───────────────────────────────  │  │
│  │  Malformed JSON        │ 400         │ INVALID_JSON                    │  │
│  │  Wrong Content-Type    │ 415         │ UNSUPPORTED_MEDIA_TYPE          │  │
│  │  Field validation      │ 422         │ VALIDATION_ERROR                │  │
│  │  Business rule fail    │ 422         │ VALIDATION_ERROR                │  │
│  │  Resource not found    │ 404         │ NOT_FOUND                       │  │
│  │  Duplicate resource    │ 409         │ ALREADY_EXISTS                  │  │
│  │  Concurrent update     │ 409         │ CONFLICT                        │  │
│  │  Rate limited          │ 429         │ RATE_LIMITED                    │  │
│  │  Auth required         │ 401         │ UNAUTHORIZED                    │  │
│  │  Permission denied     │ 403         │ FORBIDDEN                       │  │
│  │  Internal error        │ 500         │ INTERNAL_ERROR                  │  │
│  │  Upstream timeout      │ 504         │ GATEWAY_TIMEOUT                 │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    VALIDATION FLOW IN HANDLER                          │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  func CreateUser(w, r) error {                                         │  │
│  │      │                                                                 │  │
│  │      ▼                                                                 │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Decode JSON     │──── Error? ──► 400 INVALID_JSON                   │  │
│  │  └─────────────────┘                                                   │  │
│  │      │                                                                 │  │
│  │      ▼                                                                 │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Struct Tags     │──── Error? ──► 422 VALIDATION_ERROR + details     │  │
│  │  │ (go-validator)  │                                                   │  │
│  │  └─────────────────┘                                                   │  │
│  │      │                                                                 │  │
│  │      ▼                                                                 │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Business Rules  │──── Error? ──► 422/409 + specific error code      │  │
│  │  │ (DB checks)     │                                                   │  │
│  │  └─────────────────┘                                                   │  │
│  │      │                                                                 │  │
│  │      ▼                                                                 │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Create Resource │──── Error? ──► 500/409 mapped from domain error   │  │
│  │  └─────────────────┘                                                   │  │
│  │      │                                                                 │  │
│  │      ▼                                                                 │  │
│  │  ┌─────────────────┐                                                   │  │
│  │  │ Return 201      │                                                   │  │
│  │  └─────────────────┘                                                   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: reading the diagram like an engineer, not a student

The three-layer diagram is not decoration. It is a decision tree you will reproduce in every code review. When a bug report arrives saying "creating a user returned 500," the first question is "which layer raised it." If it was transport, the body was malformed and your middleware should have caught it as 400. If it was format, your struct tags missed a rule and the bug is a one-line tag addition. If it was business rules, the fix is in the service layer and probably involves a database check. Juniors who can name the layer from the stack trace in the first thirty seconds of triage get promoted. A worked example: a user reports that signing up with email `"  alice@example.com  "` (leading whitespace) sometimes succeeds and sometimes fails. The answer is that trimming happens at transport if you wrote it, at format if you used a `trim` tag, or not at all if you forgot, and the bug report is really asking "where does normalization live in our stack." The correct answer in most codebases is "in a dedicated normalization step between transport and format, before any validation runs." Memorize the diagram and you will answer this question consistently.

### Senior @ FAANG: why this diagram is incomplete and what to add

The diagram shown here is the right starting point for a single service with a synchronous HTTP boundary. At staff level you must extend it in three directions. First, add the contract layer above transport. Before a single byte of the body is read, the request has already passed through an OpenAPI or protobuf contract check, either at the gateway (Envoy with an ext_authz filter, Kong with a plugin, or a sidecar) or in a generated server stub (oapi-codegen, huma, connect-go with protovalidate). This is where you reject requests whose shape cannot possibly be valid, before they touch application code. The benefit is that a schema change is a single artifact that updates clients, servers, mocks, and tests atomically. The cost is schema-first discipline, which many teams resist until the third time they ship a breaking change by accident.

Second, add the domain layer below business rules. Business rules like "email must be unique" are stateful and depend on the database. Domain invariants like "a `Money` value has a non-negative amount and a valid ISO 4217 currency" are stateless and depend only on the type. Smart constructors live here. The test for whether a check belongs in domain or business is whether you could write a property-based test for it without any fakes or mocks. If yes, it is a domain invariant and belongs in a constructor that returns an error. If no, it is a business rule and belongs in a service method that takes a repository.

Third, add the async boundary. For event consumers and job workers, there is no 422 to return. Validation failures become dead-letter queue entries, and the contract for what counts as "valid enough to process" must be explicit and versioned. Schema registries (Confluent Schema Registry for Avro, buf Schema Registry for protobuf) become the source of truth, and your validators must tolerate schema evolution rules (forward-compatible, backward-compatible, full). This is where protovalidate earns its keep because the same CEL expression runs on the producer, the consumer, and the schema registry's linter.

The status code mapping table deserves scrutiny too. The 400-versus-422 debate has religious adherents on both sides. The pragmatic rule most large teams converge on is: 400 for wire-format problems (malformed JSON, wrong content type, unparseable), 422 for semantic problems (fields parsed correctly but violate rules). RFC 9457 does not prescribe either. What matters is internal consistency across your platform and clear documentation in your error catalog. The 409 versus 422 debate for "resource already exists" is similar. 409 is appropriate when the conflict is with current server state, 422 when the request itself is internally inconsistent. Be consistent across services and document the rule.

One subtle architectural trap: never let the validator allocate your domain types. If `validator.Struct(&req)` passes on a `CreateUserRequest`, you still need to construct a `User` domain object from it, and that constructor can fail for reasons the validator could not see. Conflating the two (making the request struct and the domain struct the same type) is the mistake that kills refactorability in year two of a codebase. Keep request DTOs separate from domain entities, always.

---
