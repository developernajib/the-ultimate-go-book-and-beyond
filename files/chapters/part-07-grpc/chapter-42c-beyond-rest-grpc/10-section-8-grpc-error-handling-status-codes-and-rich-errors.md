## Section 8: gRPC Error Handling - Status Codes and Rich Errors

### 8.1 Status Code Mapping

Every domain error must map to a specific gRPC status code. Mapping to `codes.Internal` for everything is the gRPC equivalent of always returning HTTP 500.

```go
package grpcerrors

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"
)

// Domain errors - defined in your business logic layer.
var (
	ErrNotFound       = errors.New("not found")
	ErrAlreadyExists  = errors.New("already exists")
	ErrInvalidInput   = errors.New("invalid input")
	ErrUnauthorized   = errors.New("unauthorized")
	ErrForbidden      = errors.New("forbidden")
	ErrUnavailable    = errors.New("service unavailable")
	ErrQuotaExceeded  = errors.New("quota exceeded")
)

// ToGRPCStatus maps domain errors to the correct gRPC status code.
// This belongs in your adapter layer between gRPC handlers and business logic.
func ToGRPCStatus(err error) error {
	if err == nil {
		return nil
	}

	switch {
	case errors.Is(err, ErrNotFound):
		return status.Errorf(codes.NotFound, "%v", err)

	case errors.Is(err, ErrAlreadyExists):
		return status.Errorf(codes.AlreadyExists, "%v", err)

	case errors.Is(err, ErrInvalidInput):
		return status.Errorf(codes.InvalidArgument, "%v", err)

	case errors.Is(err, ErrUnauthorized):
		return status.Errorf(codes.Unauthenticated, "%v", err)

	case errors.Is(err, ErrForbidden):
		return status.Errorf(codes.PermissionDenied, "%v", err)

	case errors.Is(err, ErrUnavailable):
		return status.Errorf(codes.Unavailable, "%v", err)

	case errors.Is(err, ErrQuotaExceeded):
		return status.Errorf(codes.ResourceExhausted, "%v", err)

	case errors.Is(err, context.DeadlineExceeded):
		return status.Errorf(codes.DeadlineExceeded, "%v", err)

	case errors.Is(err, context.Canceled):
		return status.Errorf(codes.Canceled, "%v", err)

	default:
		// Never expose internal error details to callers.
		return status.Errorf(codes.Internal, "internal server error")
	}
}
```

### 8.2 Rich Error Details

gRPC supports structured error details via `google.rpc.Status`. This lets you attach machine-readable field violations, retry hints, and resource information to errors.

```go
// RichValidationError builds a gRPC status with structured field violations.
// The client can inspect these without parsing error strings.
func RichValidationError(violations map[string]string) error {
	st := status.New(codes.InvalidArgument, "request validation failed")

	br := &errdetails.BadRequest{}
	for field, desc := range violations {
		br.FieldViolations = append(br.FieldViolations, &errdetails.BadRequest_FieldViolation{
			Field:       field,
			Description: desc,
		})
	}

	st, err := st.WithDetails(br)
	if err != nil {
		// WithDetails only fails if the detail proto can't be marshaled - programmer error.
		panic(fmt.Sprintf("attach error details: %v", err))
	}

	return st.Err()
}

// RichRetryError builds an error with retry information.
// The client can read RetryInfo.RetryDelay to implement backoff correctly.
func RichRetryError(msg string, retryDelay time.Duration) error {
	st := status.New(codes.Unavailable, msg)

	ri := &errdetails.RetryInfo{
		RetryDelay: durationpb.New(retryDelay),
	}

	st, err := st.WithDetails(ri)
	if err != nil {
		panic(fmt.Sprintf("attach retry info: %v", err))
	}

	return st.Err()
}

// ExtractFieldViolations reads BadRequest details on the client side.
func ExtractFieldViolations(err error) map[string]string {
	st, ok := status.FromError(err)
	if !ok {
		return nil
	}

	violations := make(map[string]string)
	for _, detail := range st.Details() {
		if br, ok := detail.(*errdetails.BadRequest); ok {
			for _, v := range br.FieldViolations {
				violations[v.Field] = v.Description
			}
		}
	}
	return violations
}
```

Client-side usage:

```go
func createOrderWithRichErrors(client orderv1.OrderServiceClient, req *orderv1.CreateOrderRequest) error {
	_, err := client.CreateOrder(context.Background(), req)
	if err == nil {
		return nil
	}

	st := status.Convert(err)
	switch st.Code() {
	case codes.InvalidArgument:
		// Extract and display field-level violations.
		violations := ExtractFieldViolations(err)
		for field, msg := range violations {
			fmt.Printf("  Field %q: %s\n", field, msg)
		}
		return fmt.Errorf("validation failed: %v", violations)

	case codes.Unavailable:
		// Read retry delay from error details.
		for _, d := range st.Details() {
			if ri, ok := d.(*errdetails.RetryInfo); ok {
				fmt.Printf("retry after: %v\n", ri.RetryDelay.AsDuration())
			}
		}
		return fmt.Errorf("service unavailable, see retry info")

	case codes.NotFound:
		return fmt.Errorf("order not found")

	default:
		return fmt.Errorf("unexpected error: %v", st.Message())
	}
}
```

---

### Junior → FAANG: Status Code Semantics and the Cost of Getting Them Wrong

Returning the wrong gRPC status code is not just an aesthetic mistake. It has concrete operational consequences because callers make decisions based on the code. If you return `codes.Internal` for a "product not found" error, the caller cannot distinguish "server is broken" from "that product does not exist" and will either retry unnecessarily (amplifying load on a broken downstream) or fail immediately when it should retry.

The most important codes to understand for interviews and first-job work:

`codes.InvalidArgument` is for client mistakes: malformed input, missing required fields, invalid UUID format. The caller should fix its request, not retry.

`codes.NotFound` is for resources that do not exist. Retrying will not help.

`codes.Unavailable` is for transient failures: the downstream database is temporarily unreachable, the service is restarting. The caller should retry with backoff.

`codes.PermissionDenied` is for authenticated callers who lack authorization. Different from `codes.Unauthenticated` which means no valid credential was presented at all.

`codes.ResourceExhausted` is for rate limiting and quota violations. Callers should back off.

The `ToGRPCStatus` mapping function in the example is the correct pattern: define domain errors in your business logic layer and map them to gRPC codes in the adapter (transport) layer. Never put `codes.X` constants in your business logic. They are a transport concern.

### Senior @ FAANG: Error Classification, Retry Safety, and Rich Error Contract Design

At senior level, error handling is a contract between producer and consumer that must be designed deliberately, documented, and tested. The classification of errors into retryable and non-retryable is the most critical axis. Calling a retryable error non-retryable causes unnecessary failures. Calling a non-retryable error retryable causes retry storms that amplify the original failure.

Retry safety classification:

Retryable: `codes.Unavailable` (transient failure), `codes.DeadlineExceeded` with care (only if the operation is idempotent), `codes.ResourceExhausted` when accompanied by `RetryInfo` details that specify the retry delay.

Non-retryable: `codes.InvalidArgument` (client must fix the request), `codes.NotFound` (retrying will not create the resource), `codes.AlreadyExists` (retrying will not un-create it), `codes.PermissionDenied` (retrying will not grant permission), `codes.FailedPrecondition` (server state must change before retry makes sense).

`codes.Internal` is in a gray area: it means the server had an unexpected error, and retry may or may not help depending on the underlying cause. Most retry policies treat it as non-retryable by default because retrying an operation that caused a server panic is more likely to repeat the panic than to succeed.

Rich error details via `google.rpc.Status` deserve a design philosophy. The details should be machine-readable by the direct caller, not human-readable narrative. A `BadRequest` with field violations is correct: it gives the caller structured data to display to the end user without string parsing. A `RetryInfo` with a computed backoff delay is correct: the caller can implement exact backoff from the server's signal rather than guessing. A detail containing the database error string or a stack trace is not correct: it leaks implementation details, may contain sensitive data, and provides no value to callers who cannot act on it.

The API gateway layer adds a complication to rich error details: gRPC errors in trailers may be stripped or transformed when translated to HTTP. A grpc-gateway or Envoy configured for REST transcoding should preserve `google.rpc.Status` details in the HTTP response body. Verify this in your integration tests by asserting that a `BadRequest` detail on a gRPC error appears as a structured JSON body in the transcoded HTTP 400 response. If it does not, clients relying on machine-readable field violations will see an opaque error message instead.
