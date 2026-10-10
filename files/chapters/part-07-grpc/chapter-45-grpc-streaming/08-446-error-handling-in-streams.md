## 45.6 Error Handling in Streams

### Graceful Error Recovery

A streaming client must distinguish `io.EOF` (clean end-of-stream) from any other error (network drop, server crash, deadline exceeded) and decide whether to reconnect with the last successfully received cursor or surface the failure to the caller. Using exponential backoff with jitter on reconnection prevents thundering-herd reconnects when a server restarts and all clients attempt to re-establish simultaneously.

On bidirectional streams, an error triggered by a bad `Send` often does not surface on the `Send` call itself. grpc-go buffers the message into the HTTP/2 write loop and returns `nil`, then the peer resets the stream, and the error arrives on the next `Recv`. Always treat `Recv` as the authoritative source of stream-level errors, and close the send side with `CloseSend` before draining `Recv` to `io.EOF` when shutting down cleanly. For abrupt termination, cancel the context. The server handler will observe `ctx.Err() == context.Canceled`, and telemetry will record the cancellation rather than a random transport error.

> **Senior track**: Distinguishing "client canceled" from "network died" on the server is hard because both produce `context.Canceled`. Inspect `peer.FromContext` plus the last observed keepalive to disambiguate, or add an application-level "graceful shutdown" sentinel message that the client sends before calling cancel. This lets the server log clean shutdowns differently from abrupt failures without false positives in SLO dashboards.

```go
package client

import (
    "context"
    "io"
    "log"
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// ResilientStreamConsumer handles errors gracefully
func (c *StreamClient) ResilientStreamConsumer(ctx context.Context, handler func(*streamv1.Item) error) error {
    const maxRetries = 3
    var lastError error

    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            // Exponential backoff
            backoff := time.Duration(1<<uint(attempt)) * time.Second
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(backoff):
            }
        }

        err := c.consumeStream(ctx, handler)
        if err == nil {
            return nil
        }

        lastError = err

        // Check if error is retryable
        st, ok := status.FromError(err)
        if !ok {
            return err
        }

        switch st.Code() {
        case codes.Unavailable, codes.ResourceExhausted:
            // Retryable
            continue
        default:
            // Non-retryable
            return err
        }
    }

    return lastError
}

func (c *StreamClient) consumeStream(ctx context.Context, handler func(*streamv1.Item) error) error {
    stream, err := c.client.ListItems(ctx, &streamv1.ListItemsRequest{})
    if err != nil {
        return err
    }

    for {
        item, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        if err := handler(item); err != nil {
            // Handler error - log but continue
            log.Printf("handler error: %v", err)
        }
    }
}

// PartialFailureHandler handles partial stream failures
type PartialFailureHandler struct {
    successCount int
    failureCount int
    errors       []error
}

func (c *StreamClient) StreamWithPartialFailure(ctx context.Context) (*PartialFailureHandler, error) {
    stream, err := c.client.ListItems(ctx, &streamv1.ListItemsRequest{})
    if err != nil {
        return nil, err
    }

    handler := &PartialFailureHandler{}

    for {
        item, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            handler.failureCount++
            handler.errors = append(handler.errors, err)
            return handler, err // In gRPC, stream-level errors are terminal
        }

        if err := processItem(item); err != nil {
            handler.failureCount++
            handler.errors = append(handler.errors, err)
        } else {
            handler.successCount++
        }
    }

    return handler, nil
}
```

### Junior -> FAANG: Error Handling Patterns to Internalize

The `ResilientStreamConsumer` function above shows exponential backoff with three retries. Three details are worth drilling until they are automatic.

**Jitter on backoff.** The code above uses `1<<uint(attempt)` seconds: 2s, 4s, 8s. In a real system with hundreds of concurrent clients, they all fail at the same time (server restart) and all back off to the same interval. They all retry at the same moment, creating a thundering herd. Add random jitter: `backoff + time.Duration(rand.Int63n(int64(backoff)))`. This spreads retries over a 2x window and smooths the reconnection storm.

**Cursor propagation on retry.** The `consumeStream` function restarts the stream from the beginning on each retry. If the stream delivers ordered items with sequence numbers, the client should record the last successfully processed sequence and pass it to the next attempt. Without this, retries re-process all previously seen items. For idempotent handlers this is safe but wasteful. For non-idempotent handlers it produces duplicate side effects. Always design streaming RPCs with resumption in mind from the start.

**Status code classification.** Know these codes for interview classification: `Unavailable` (retryable: server not ready), `ResourceExhausted` (retryable with backoff: rate limit hit), `DeadlineExceeded` (may retry with fresh deadline), `Unauthenticated` (not retryable: fix credentials), `InvalidArgument` (not retryable: fix the request), `Internal` (depends: transient server error vs persistent bug). A blanket "retry all errors" policy causes infinite loops on `InvalidArgument` and `Unauthenticated`.

### Senior @ FAANG: Error Handling Governance

**Retry budgets.** Individual retry loops with a fixed count (3 retries in the example) are correct at the individual caller level but problematic at the system level. If 10,000 clients each retry 3 times, a server restart triggers 40,000 connection attempts in a tight window. Retry budget limiting at the client library level (shared token bucket per destination, not per stream) bounds the total reconnection rate regardless of how many concurrent streams exist. This is the pattern used by Google's internal RPC library and is the reason gRPC's official retry policy includes `retryPolicy.maxAttempts` in the service config JSON rather than in application code.

**Error taxonomy in the API contract.** Streaming errors fall into two categories that must be distinguished in the proto API: stream-level errors (the stream terminates, all subsequent messages are lost) and message-level errors (this specific message failed, the stream continues). gRPC streaming only supports stream-level errors natively (the `Send` error terminates the stream). Message-level errors require application-level encoding: a response message type with a `oneof { SuccessPayload success = 1; google.rpc.Status error = 2; }` field, delivered over an otherwise healthy stream. Define which errors are stream-level (security violations, authentication failures) and which are message-level (validation errors, item-not-found) in the API documentation and enforce the convention in code review.

**Distinguishing cancellation from failure in SLO dashboards.** The senior track note in this section mentions that `context.Canceled` appears on the server whether the client canceled intentionally or the network died. At the SLO level, intentional cancellations should not count as errors. The standard approach is a `grpc_status_code` label on the error counter metric, with the SLO alert filtering out `CANCELED` codes. A further refinement is an application-level "graceful close" message sent by the client before canceling, which the server records as a clean shutdown in a separate counter. This lets the SLO dashboard separate "client left normally" from "client disappeared" without false positive alerts.

**Partial failure semantics in the API contract.** The `StreamWithPartialFailure` pattern in this section accumulates item-level errors and continues processing. This is correct for batch operations where partial success is useful. The API contract must explicitly define: is partial success a success response (HTTP 200 with error details in the body) or an error response (non-OK gRPC status)? gRPC's `Status` type supports `google.rpc.Status.details` for attaching structured error details to a non-OK status. Use `google.rpc.BadRequest` for validation errors on specific fields. Using rich error details allows clients to parse and display per-item failure reasons without string parsing.

---
