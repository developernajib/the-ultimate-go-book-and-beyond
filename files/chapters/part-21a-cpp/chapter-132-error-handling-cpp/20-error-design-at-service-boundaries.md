## Error Design at Service Boundaries

A service boundary is anywhere two independently versioned, independently failing systems meet. HTTP, gRPC, message queues, IPC, plugin interfaces. The error model at a service boundary is not the same as the error model inside a process. Inside, you have full type information and shared memory. At the boundary, you have a wire format, a status code, and (if you are lucky) a textual reason.

### The Three Concerns

Every error at a service boundary must answer:

1. **Is it retryable?** Should the caller try again, possibly with backoff, possibly to a different replica?
2. **Whose fault is it?** Client (4xx in HTTP) or server (5xx)? This affects logging, alerting, and SLO accounting.
3. **What is the structured detail?** Codes and human strings are not enough for a non-trivial system. The wire format must carry typed payloads.

Error models that get this right include gRPC status codes plus `google.rpc.Status` details, HTTP plus RFC 7807 problem-details, Twirp errors. Models that get it wrong include "always 200, with a JSON body containing `error: ...`" because they collapse all three concerns into the body and break HTTP-aware infrastructure.

### HTTP

HTTP status codes are the first level of structure. The categories:

| Code class | Meaning | Retryable? | Whose fault |
|---|---|---|---|
| 2xx | Success | n/a | n/a |
| 3xx | Redirect | follow | n/a |
| 4xx | Client error | usually no | client |
| 408, 429 | Timeout, rate-limited | yes, with backoff | client |
| 5xx | Server error | usually yes | server |
| 501, 505 | Not implemented, version unsupported | no | server |

The 4xx vs 5xx split aligns SLO accounting: 5xx counts against availability, 4xx does not.

For structured detail, RFC 7807 (problem details for HTTP APIs) is the standard:

```json
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "https://example.com/probs/validation",
  "title": "Validation failed",
  "status": 422,
  "detail": "Field 'port' must be in [1, 65535]; got 70000",
  "instance": "/v1/configs/9c4a",
  "violations": [
    {"field": "port", "rule": "range", "min": 1, "max": 65535}
  ]
}
```

The `type` field is a stable identifier (a URI, but not necessarily resolvable) the client can switch on. `title` and `detail` are human-readable, `violations` is the typed payload. Clients should code against `type`, not parsed messages.

### gRPC and `google.rpc.Status`

gRPC has 17 canonical status codes ([grpc.io/docs/guides/status-codes/]):

```
OK, CANCELED, UNKNOWN, INVALID_ARGUMENT, DEADLINE_EXCEEDED,
NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, UNAUTHENTICATED,
RESOURCE_EXHAUSTED, FAILED_PRECONDITION, ABORTED, OUT_OF_RANGE,
UNIMPLEMENTED, INTERNAL, UNAVAILABLE, DATA_LOSS
```

The retryability map:

- Retryable, often automatically: `UNAVAILABLE`, `DEADLINE_EXCEEDED` (with care).
- Retryable, with caller logic: `ABORTED`, `RESOURCE_EXHAUSTED` (after backoff).
- Not retryable: `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `UNAUTHENTICATED`, `FAILED_PRECONDITION`, `UNIMPLEMENTED`, `OUT_OF_RANGE`, `ALREADY_EXISTS`.
- Caller decides: `INTERNAL`, `UNKNOWN`, `DATA_LOSS`.

`google.rpc.Status` carries `code`, `message`, and `details` (a list of `google.protobuf.Any`). Standard `details` types include `RetryInfo` (server-suggested backoff), `DebugInfo` (stack), `QuotaFailure`, `ErrorInfo` (typed reason and domain), `BadRequest` (per-field violations), `PreconditionFailure`, `Help`, `LocalizedMessage`. Use `ErrorInfo` for domain-specific machine-readable detail:

```proto
message ErrorInfo {
  string reason   = 1;   // e.g. "INVALID_PORT"
  string domain   = 2;   // e.g. "configservice.example.com"
  map<string, string> metadata = 3;
}
```

`reason` is stable, code-friendly, language-agnostic. Clients switch on it. `metadata` carries the variable parts.

### Mapping `absl::Status` to gRPC

`absl::Status` was designed to align with gRPC's status codes (same enum values, same names). The mapping is essentially `static_cast`. The `absl::Status` payload map carries the equivalent of `google.rpc.Status::details`. A typical service implementation:

```cpp
absl::Status DoWork(const Request& req) {
    if (!IsValid(req)) {
        absl::Status s(absl::StatusCode::kInvalidArgument, "port out of range");
        s.SetPayload("type.googleapis.com/google.rpc.ErrorInfo",
                     SerializeErrorInfo("INVALID_PORT", "configservice", req.port()));
        return s;
    }
    // ...
    return absl::OkStatus();
}

grpc::Status ToGrpc(const absl::Status& s) {
    if (s.ok()) return grpc::Status::OK;
    grpc::Status out(static_cast<grpc::StatusCode>(s.code()), std::string(s.message()));
    s.ForEachPayload([&](absl::string_view url, const absl::Cord& payload) {
        // attach to trailing metadata or ::google::rpc::Status
    });
    return out;
}
```

The pattern lets domain code use `absl::Status` everywhere and translate at the gRPC boundary.

## Timeouts and Deadlines

A timeout is not a generic error. It deserves its own class:

- The caller can retry, but only after evaluating whether the deadline has propagated. Retrying a request whose deadline already expired wastes resources.
- The caller's metrics distinguish "service was slow" from "service returned an error". Bad SLO accounting if you collapse them.
- Cancellation propagation through the call graph requires distinguishing "I was asked to stop" from "I tried and failed".

gRPC encodes this as `DEADLINE_EXCEEDED` (server hit the deadline) vs `CANCELED` (caller canceled). HTTP encodes it as 408 (request timeout) or 504 (gateway timeout). Treat both as their own retry class.

A request deadline should propagate down the call chain. A handler that takes 10 seconds because it called four downstream services with 30-second deadlines is wrong: it should pass its own deadline (decremented by elapsed time) to each downstream. gRPC's `ClientContext::set_deadline` is the standard way. HTTP requires explicit headers (`Deadline:` in some Google services, custom `X-Request-Timeout` elsewhere).

## Retry Classification

The client-side decision tree:

```cpp
RetryDecision Classify(const Status& s, const Context& ctx) {
    if (s.ok())                       return RetryDecision::Done;
    if (s.IsCanceled())              return RetryDecision::Stop;
    if (ctx.deadline_passed())        return RetryDecision::Stop;

    switch (s.code()) {
        case kUnavailable:
            return ctx.attempt < kMaxRetries ? RetryDecision::RetryAfterBackoff
                                             : RetryDecision::Stop;
        case kDeadlineExceeded:
            return ctx.this_attempt_deadline_was_full
                       ? RetryDecision::Stop                  // global deadline up
                       : RetryDecision::RetryAfterBackoff;
        case kResourceExhausted: {
            auto retry_info = ExtractRetryInfo(s);
            return retry_info ? RetryDecision::RetryAfterDelay(retry_info->delay)
                              : RetryDecision::Stop;
        }
        case kAborted:                return RetryDecision::RetryAfterBackoff;
        default:                      return RetryDecision::Stop;
    }
}
```

Retry budgets exist to avoid retry storms. A per-client budget caps the total retries per second across all calls, even if individual calls would retry. Google's gRPC retry policy supports this via `retryThrottling` in service config.

Idempotency matters. Retrying a non-idempotent call (POST that creates a row, no idempotency key) duplicates. Use idempotency keys (a UUID per logical operation, server deduplicates) for any retryable mutation.

## Error Codes That Are Wrong

**`INTERNAL` for everything.** Loses all signal. The caller cannot tell if it is retryable, the alert pipeline cannot distinguish bugs from infra. Use specific codes.

**`UNKNOWN` because the caller did not feel like deciding.** Same problem. Pick a code or fix the cause.

**4xx for server bugs.** "It's the client's fault that they sent a request my buggy code cannot parse." This breaks SLO accounting and hides the bug.

**5xx for client errors.** Equivalent breakage in the other direction.

**HTTP 200 with `{"success": false, "error": "..."}` in the body.** Caches, load balancers, retry middleware all see 200 and treat as success. The error is invisible to infrastructure.

## Testing Error Paths

Error paths are the least-tested code in most services. They are also the code that runs when something is already wrong. Test:

- Each error code path with a real request that triggers it.
- Each retry decision (timeout mid-call, server returns `UNAVAILABLE`, etc.).
- Deadline propagation: child service is called with a deadline shorter than its own.
- Idempotency: same request twice produces the same outcome.
- Error payload schema: the `ErrorInfo` is parseable, the type field is stable.

Chaos tests (kill a backend mid-request, drop packets, inject latency) catch what unit tests miss.

## Versioning

Error codes and types are part of the API. Adding a new code is a breaking change for clients that switch on enums (default branch may not handle it). Removing one is always breaking. Treat the error vocabulary as carefully as the success vocabulary.

`ErrorInfo.reason` is meant to be stable. Adding new reasons is non-breaking if clients use a default. Renaming or removing is breaking. Document the table.

### FAANG Bar

A senior engineer should:

- Map service errors to retryable, fault-attribution, and structured-detail buckets.
- Use canonical gRPC codes or RFC 7807 rather than ad-hoc shapes.
- Translate `absl::Status` to wire format at the boundary.
- Distinguish timeout, cancel, and generic error in API and metrics.
- Implement client-side retry with per-error decisions and a budget.
- Enforce idempotency for mutations that may be retried.
- Treat the error vocabulary as part of the API contract.
