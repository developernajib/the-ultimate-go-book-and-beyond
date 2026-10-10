## 43.5 Error Handling

### gRPC Status Codes

gRPC errors are represented as `status.Status` values carrying a `codes.Code` (e.g., `NotFound`, `InvalidArgument`, `Internal`) and a human-readable message. Callers extract the status with `status.FromError(err)` and switch on the code to decide retry vs. user-visible error vs. log-and-abort, replacing the HTTP status code pattern from REST APIs.

```go
package errors

import (
    "context"
    "errors"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

/*
gRPC Status Codes:

OK (0)              - Success
CANCELED (1)       - Operation canceled
UNKNOWN (2)         - Unknown error
INVALID_ARGUMENT (3) - Invalid argument from client
DEADLINE_EXCEEDED (4) - Timeout
NOT_FOUND (5)        - Resource not found
ALREADY_EXISTS (6)   - Resource already exists
PERMISSION_DENIED (7) - No permission for operation
RESOURCE_EXHAUSTED (8) - Rate limited
FAILED_PRECONDITION (9) - Precondition failed
ABORTED (10)         - Operation aborted
OUT_OF_RANGE (11)    - Value out of range
UNIMPLEMENTED (12)   - Method not implemented
INTERNAL (13)        - Internal server error
UNAVAILABLE (14)     - Service unavailable (retry)
DATA_LOSS (15)       - Unrecoverable data loss
UNAUTHENTICATED (16) - Not authenticated
*/

// Custom error types with gRPC status
type NotFoundError struct {
    Resource string
    ID       string
}

func (e *NotFoundError) Error() string {
    return e.Resource + " " + e.ID + " not found"
}

func (e *NotFoundError) GRPCStatus() *status.Status {
    return status.Newf(codes.NotFound, "%s %s not found", e.Resource, e.ID)
}

type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return e.Field + ": " + e.Message
}

func (e *ValidationError) GRPCStatus() *status.Status {
    return status.Newf(codes.InvalidArgument, "%s: %s", e.Field, e.Message)
}

// Convert domain errors to gRPC status
func ToGRPCError(err error) error {
    if err == nil {
        return nil
    }

    // Check for errors with GRPCStatus method
    if se, ok := err.(interface{ GRPCStatus() *status.Status }); ok {
        return se.GRPCStatus().Err()
    }

    // Map common errors
    switch {
    case errors.Is(err, ErrNotFound):
        return status.Error(codes.NotFound, err.Error())
    case errors.Is(err, ErrDuplicate):
        return status.Error(codes.AlreadyExists, err.Error())
    case errors.Is(err, ErrUnauthorized):
        return status.Error(codes.Unauthenticated, err.Error())
    case errors.Is(err, ErrForbidden):
        return status.Error(codes.PermissionDenied, err.Error())
    case errors.Is(err, context.Canceled):
        return status.Error(codes.Canceled, "operation canceled")
    case errors.Is(err, context.DeadlineExceeded):
        return status.Error(codes.DeadlineExceeded, "deadline exceeded")
    default:
        return status.Errorf(codes.Internal, "internal error: %v", err)
    }
}
```

### Rich Error Details

A status code and message string are often insufficient for the client to take corrective action. The `google.golang.org/grpc/status` package allows attaching structured `proto.Message` details to a gRPC error via `status.WithDetails`. The client extracts them with `st.Details()` and type-asserts to the expected proto type. Common detail types include `errdetails.BadRequest` for field-level validation errors, `errdetails.QuotaFailure` for rate-limit specifics, and `errdetails.RetryInfo` for backoff hints.

```go
package errors

import (
    "fmt"
    "time"

    "google.golang.org/genproto/googleapis/rpc/errdetails"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/durationpb"
)

// ValidationErrors creates a status with field violations
func ValidationErrors(violations map[string]string) error {
    st := status.New(codes.InvalidArgument, "validation failed")

    var fieldViolations []*errdetails.BadRequest_FieldViolation
    for field, description := range violations {
        fieldViolations = append(fieldViolations, &errdetails.BadRequest_FieldViolation{
            Field:       field,
            Description: description,
        })
    }

    br := &errdetails.BadRequest{
        FieldViolations: fieldViolations,
    }

    st, _ = st.WithDetails(br)
    return st.Err()
}

// QuotaExceededError creates a quota exceeded error
func QuotaExceededError(subject string, limit int64) error {
    st := status.New(codes.ResourceExhausted, "quota exceeded")

    qi := &errdetails.QuotaFailure{
        Violations: []*errdetails.QuotaFailure_Violation{
            {
                Subject:     subject,
                Description: fmt.Sprintf("limit of %d exceeded", limit),
            },
        },
    }

    st, _ = st.WithDetails(qi)
    return st.Err()
}

// RetryableError creates an error with retry info
func RetryableError(delay time.Duration, message string) error {
    st := status.New(codes.Unavailable, message)

    ri := &errdetails.RetryInfo{
        RetryDelay: durationpb.New(delay),
    }

    st, _ = st.WithDetails(ri)
    return st.Err()
}

// Extract error details on client side
func ExtractValidationErrors(err error) map[string]string {
    st, ok := status.FromError(err)
    if !ok {
        return nil
    }

    violations := make(map[string]string)
    for _, detail := range st.Details() {
        switch d := detail.(type) {
        case *errdetails.BadRequest:
            for _, v := range d.GetFieldViolations() {
                violations[v.GetField()] = v.GetDescription()
            }
        }
    }

    return violations
}
```

### Junior → FAANG: Building the Error Handling Mental Model

gRPC error handling has three layers. Juniors who understand all three pass the interview. Those who know only the first layer do not.

**Layer 1: Status codes.** Every gRPC error is a `codes.Code` plus a string message. The code determines what the client does next (retry, surface to user, log and abort). The message is for humans, not machines. Never put structured data in the message string that you expect client code to parse.

**Layer 2: Rich error details.** `status.WithDetails` attaches typed proto messages to an error. `errdetails.BadRequest` carries field-level violations. `errdetails.RetryInfo` carries a `retry_delay` for rate-limit responses. `errdetails.PreconditionFailure` describes why a precondition failed. The client extracts these with `st.Details()` and type-asserts. This is how you communicate machine-readable context without encoding it in the message string.

**Layer 3: Domain-to-gRPC mapping.** The `ToGRPCError` function shown above is the boundary between your domain model and the gRPC protocol. Your domain errors (`ErrNotFound`, `ErrDuplicate`) should not import gRPC packages. The mapping function converts them at the handler boundary. This keeps your domain logic testable without a gRPC dependency.

First-job habit: write a single `ToGRPCError` function for your service, put it in a shared package, and call it in every handler. Never call `status.Error` directly in business logic code. When you need to add a new error type, you update one function.

Interview trap: "What status code do you return when a user's session has expired?" Many candidates say `NOT_FOUND` (the session is not found) or `PERMISSION_DENIED` (they cannot access the resource). The correct answer is `UNAUTHENTICATED`: the caller's identity cannot be verified. `PERMISSION_DENIED` means the caller is authenticated but lacks the required permission. `UNAUTHENTICATED` means you do not know who they are. Getting this wrong in an interview signals weak security thinking.

### Senior @ FAANG: Error Design as an Observability and SLO Concern

**Error mapping as a reliability signal.** At scale, the distribution of status codes across your service is your error budget. An SLO of "99.9% of requests succeed" requires agreement on what counts as "success." If your service returns `codes.Internal` for both "database query timeout" (a transient failure the client can retry) and "configuration file not found at startup" (a permanent failure that requires human intervention), the SLO dashboard cannot distinguish between a transient outage and a broken deployment. Separate error categories require separate status codes and separate alerting policies.

**Error interceptor as a fleet-wide security control.** The `ErrorInterceptor` shown in the common mistakes file sanitizes errors before they reach the client. This is not optional. Any handler that returns a raw database error exposes schema information, query structure, and potentially data values to the caller. At the platform level, the error sanitization interceptor is part of the standard interceptor chain provided by the platform team. It converts any error that is not a recognized `*status.Status` to `codes.Internal` with a generic message, logs the full error internally with the trace ID, and records the sanitization event as a metric (so you can detect handlers that leak internal errors). This is a defense-in-depth measure: even if a handler forgets to wrap an error, the interceptor catches it.

**Rich error details and client SLA commitments.** When you publish a gRPC service, the error details you return in `WithDetails` are part of your API contract. If you commit to returning `errdetails.RetryInfo` with a `retry_delay` on `RESOURCE_EXHAUSTED` responses, client teams can implement correct backoff without guessing. If you commit to returning `errdetails.BadRequest` with field violations on `INVALID_ARGUMENT` responses, clients can surface field-level error messages in UIs without parsing the message string. Document these commitments in your proto file as comments on the relevant RPC, and treat removing them as a breaking API change that requires a versioned migration window.

**Error budget and error taxonomy.** At the L6 level you own the error taxonomy for your service or platform. That means: (a) defining which error codes count against the error budget (typically all non-`OK` responses except `INVALID_ARGUMENT` and `NOT_FOUND`, which are client mistakes), (b) defining which errors are retryable by default (platform-level service config that clients inherit), and (c) ensuring the error interceptor populates a `grpc.code` label on your Prometheus metrics so your error budget burn alerts trigger correctly. Without the `grpc.code` label, a sudden spike in `codes.Internal` is invisible in aggregated error rate metrics.

---
