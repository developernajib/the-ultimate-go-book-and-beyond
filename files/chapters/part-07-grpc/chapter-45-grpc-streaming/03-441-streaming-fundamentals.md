## 45.1 Streaming Fundamentals

### Streaming Patterns

gRPC streaming is multiplexed over a single HTTP/2 connection. Each stream is an independent `STREAM_ID` frame sequence, and backpressure is enforced by HTTP/2 flow control windows at both the connection and per-stream level (default 64 KB per stream, tunable via `grpc.InitialWindowSize` and `grpc.InitialConnWindowSize`). The three streaming patterns (server-streaming, client-streaming, and bidirectional) differ in which side(s) send multiple messages. The `stream` keyword in the proto definition controls this. Place it before the return type for server streaming, before the parameter type for client streaming, or before both for bidirectional.

Protoc-gen-go generates typed stream objects with three primary methods: `Send(msg)` to transmit, `Recv()` to receive (blocking until a message, `io.EOF`, or error), and `CloseSend()` on the client side to half-close the send direction. Under the covers these wrap the lower-level `SendMsg`/`RecvMsg` on `grpc.ClientStream`/`grpc.ServerStream`. In 2026, clients are created with `grpc.NewClient` rather than the deprecated `grpc.Dial`, and the resulting `ClientConn` is lazy: the TCP and HTTP/2 handshake happens on the first RPC.

> **Senior track**: It is safe to call `SendMsg` in one goroutine and `RecvMsg` in another on the same stream, but calling `RecvMsg` from multiple goroutines on the same stream is unsafe. The stream owns a single receive cursor, and concurrent `Recv` races the transport read loop.

```go
package main

/*
gRPC Streaming Patterns:

1. Server Streaming (1:N)
   - Client sends one request
   - Server sends stream of responses
   - Use cases: List operations, live feeds, file downloads

2. Client Streaming (N:1)
   - Client sends stream of requests
   - Server sends one response
   - Use cases: File uploads, batch operations, aggregations

3. Bidirectional Streaming (N:M)
   - Both client and server send streams
   - Independent of each other
   - Use cases: Chat, gaming, real-time collaboration
*/

// Proto definitions for streaming
/*
service StreamService {
    // Server streaming
    rpc ListItems(ListItemsRequest) returns (stream Item);

    // Client streaming
    rpc UploadFile(stream FileChunk) returns (UploadResponse);

    // Bidirectional streaming
    rpc Chat(stream ChatMessage) returns (stream ChatMessage);
}
*/
```

### Stream Lifecycle

A gRPC stream has a well-defined lifecycle. The client opens the stream with the initial RPC call, messages flow in the direction(s) defined by the proto, and the stream closes when either side returns an error or the sender calls the half-close (`CloseSend` on the client, returning from the handler on the server). Context cancellation or deadline expiry terminates the stream from either side and surfaces as `context.Canceled` or `context.DeadlineExceeded` on the next `Recv`.

> **Senior track**: Always drain `Recv` until it returns a non-nil error, or cancel the context. Dropping a stream reference without either action leaks the HTTP/2 stream, the receive goroutine, and flow control budget on both ends. In long-running services this manifests as slow memory growth and eventual connection exhaustion.

```go
package streaming

import (
    "context"
    "errors"
    "io"
)

/*
Server Streaming Lifecycle:
1. Client calls RPC with request
2. Server receives request
3. Server sends multiple responses via stream.Send()
4. Server returns nil (success) or error
5. Client receives io.EOF when stream ends

Client Streaming Lifecycle:
1. Client opens stream
2. Client sends multiple requests via stream.Send()
3. Client calls stream.CloseAndRecv() when done
4. Server receives io.EOF when client finishes
5. Server sends response via return

Bidirectional Lifecycle:
1. Both sides can send/receive independently
2. Either side can close their send direction
3. Stream ends when both sides are done
*/

// Example of handling stream termination
func handleStreamTermination(err error) string {
    switch {
    case err == nil:
        return "success"
    case err == io.EOF:
        return "stream completed"
    case errors.Is(err, context.Canceled):
        return "client canceled"
    case errors.Is(err, context.DeadlineExceeded):
        return "deadline exceeded"
    default:
        return "error: " + err.Error()
    }
}
```

### Junior -> FAANG: Internalizing the Stream Lifecycle

The lifecycle state machine is the foundation of every streaming bug you will ever debug. There are two transitions that trip up beginners consistently.

First: the server-streaming handler returning `nil` is not the same as the client receiving `io.EOF`. The `nil` return causes the gRPC runtime to send a `DATA` frame with end-of-stream set plus a `HEADERS` frame carrying the trailing metadata and status code. The client's `Recv` call returns `io.EOF` only after it processes both frames. If the client's context is already canceled before the `io.EOF` arrives, the client sees `context.Canceled` instead. This is not a bug. The stream completed correctly on the server side. Always check whether `err == io.EOF` before treating an error as a failure.

Second: calling `RecvMsg` from two goroutines on the same stream is a data race. The senior track note in the original text states this, but the consequence is worth elaborating. The underlying transport has a single read cursor and a single receive buffer. Two goroutines racing on `Recv` can both read partial frames, interleave their reads, and produce corrupted messages. The race detector catches this, but only if you write tests that exercise concurrent reads. Write those tests.

The `handleStreamTermination` function above is the pattern to reproduce verbatim in any streaming handler. Map the four error cases in every code review and every design document. Teams that do not establish this convention end up with handlers that return raw transport errors to callers, making it impossible to distinguish "client left intentionally" from "network died" in metrics.

### Senior @ FAANG: Lifecycle Correctness Under Failure Modes

The stream lifecycle described in this section assumes cooperative shutdown: the client completes sending, the server processes, the server returns, the client reads `io.EOF`. Production systems encounter non-cooperative shutdown constantly, and the lifecycle must remain correct under each failure mode.

**Server crash mid-stream.** The client's `Recv` returns a transport-level error, typically with code `Unavailable`. The stream's flow control budget is released by the HTTP/2 connection teardown. The client must detect this, record the last successfully processed sequence number, and reconnect to a different backend. If the server was mid-send (a `Send` call was in progress when the process exited), the client may have received a partial message. gRPC does not guarantee atomic message delivery on crash. Design your message schema so that partial receipt is detectable: include a checksum or a length prefix field that the client can validate before processing.

**Client disappears without closing.** The server's `Recv` blocks. TCP keepalives eventually detect the dead connection (default: hours on Linux without tuning), but gRPC-level keepalives detect it in seconds if configured. The senior track note in this section recommends `keepalive.ClientParameters`. The server side needs `keepalive.EnforcementPolicy` to prevent clients from disabling keepalives. Without enforcement policy, a client that never sends keepalives is indistinguishable from a client that is processing a large message. The server cannot tell them apart without an application-level heartbeat timeout on top of the transport keepalive.

**Drain during rolling restart.** The server must send a `GOAWAY` frame with a grace period to allow in-flight streams to complete before the process exits. grpc-go's `GracefulStop()` handles this for new connections but does not force existing streams to terminate. Long-lived streams (hours) block `GracefulStop` for their full duration. The production pattern is: set a max stream age (via a server-side interceptor that cancels streams older than N minutes), combined with `GracefulStop` with a timeout, combined with client-side detection of `GOAWAY` to trigger reconnection. Document the expected reconnection window in your service's runbook.

**Observability for lifecycle events.** Instrument four counters per streaming RPC: streams started, streams completed cleanly (received `io.EOF` or handler returned nil), streams terminated by error (non-OK status), and streams terminated by context cancellation. The ratio of cancellations to completions tracks client behavior changes. A sudden spike in cancellations without a corresponding spike in errors usually means a client-side code change increased timeout pressure or a new proxy with a shorter idle timeout was inserted in front of the service.

---
