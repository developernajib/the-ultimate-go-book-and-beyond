## 45.5 Flow Control and Backpressure

### Server-Side Flow Control

HTTP/2 flow control limits how much data a sender can put in flight before the receiver acknowledges it via `WINDOW_UPDATE` frames. Each stream starts with a 64 KB window (controlled by `SETTINGS_INITIAL_WINDOW_SIZE`), and grpc-go applies dynamic BDP tuning by default to match the bandwidth, delay product of the connection. For high-throughput pipelines (log shipping, database replication, bulk export), raise the static window to reduce stall time with `grpc.InitialWindowSize(1<<20)` and `grpc.InitialConnWindowSize(1<<24)` on both server and dial options. If the consumer is slower than the producer, `Send` blocks naturally rather than buffering unboundedly in memory. Adding an explicit sleep or rate limiter in the server's send loop provides application-level backpressure on top of the transport-level flow control window.

> **Senior track**: `stream.Send` returns `nil` when the message is queued into the transport, not when the peer has received it. A "successful" `Send` on a bidi stream can still surface as an error on the next `Recv` if the peer reset the stream. Treat `Send` errors as indicative of stream death, not delivery failure, and use application-level acks if you need end-to-end delivery guarantees.

```go
package server

import (
    "time"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// FlowControlledStream demonstrates flow control
func (s *StreamServer) FlowControlledStream(req *streamv1.StreamRequest, stream streamv1.StreamService_FlowControlledStreamServer) error {
    ctx := stream.Context()

    // Rate limiter for outbound messages
    ticker := time.NewTicker(10 * time.Millisecond)
    defer ticker.Stop()

    items := s.generateItems()

    for _, item := range items {
        // Wait for rate limiter
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        case <-ticker.C:
        }

        // Send item
        // Note: Send() blocks if the client is slow
        if err := stream.Send(item); err != nil {
            return status.Errorf(codes.Internal, "send failed: %v", err)
        }
    }

    return nil
}

// BufferedStream with explicit backpressure handling
func (s *StreamServer) BufferedStream(req *streamv1.StreamRequest, stream streamv1.StreamService_BufferedStreamServer) error {
    ctx := stream.Context()

    // Create buffered channel
    items := make(chan *streamv1.Item, 100)

    // Producer goroutine
    go func() {
        defer close(items)
        for item := range s.generateItems() {
            select {
            case <-ctx.Done():
                return
            case items <- item:
            }
        }
    }()

    // Send items
    for item := range items {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        if err := stream.Send(item); err != nil {
            return status.Errorf(codes.Internal, "send failed: %v", err)
        }
    }

    return nil
}
```

### Client-Side Flow Control

On the client side, flow control means not calling `Recv` faster than the application can process each message. If the client reads messages into an unbounded slice without processing them, it defeats the transport-level flow control and still accumulates unbounded memory. Using a bounded processing channel between the receive loop and the application ensures the stream naturally slows when the consumer is busy. Also size `MaxRecvMsgSize` deliberately. The 4 MB default protects against runaway single messages, but for streaming workloads prefer chunking at 64 KB to 1 MB per message and keeping the limit modest. A high limit combined with an unbounded receive slice is the classic OOM recipe.

> **Senior track**: Keepalive matters for long-lived streams. Without `keepalive.ClientParameters{Time: 30*time.Second, Timeout: 10*time.Second, PermitWithoutStream: false}`, a silent connection drop (NAT rebinding, load balancer idle timeout, cable pulled) leaves the stream hung until TCP itself times out, which can take hours. Pair client keepalive with server `keepalive.EnforcementPolicy` to avoid `ENHANCE_YOUR_CALM` GOAWAY frames.

```go
package client

import (
    "context"
    "io"
    "log"
    "sync"
    "time"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// FlowControlledConsumer handles backpressure
func (c *StreamClient) FlowControlledConsumer(ctx context.Context) error {
    stream, err := c.client.ListItems(ctx, &streamv1.ListItemsRequest{})
    if err != nil {
        return err
    }

    // Process items with rate limiting
    ticker := time.NewTicker(10 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
        }

        item, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        // Process item (potentially slow)
        if err := processItem(item); err != nil {
            log.Printf("processing error: %v", err)
        }
    }
}

// ConcurrentConsumer with worker pool
func (c *StreamClient) ConcurrentConsumer(ctx context.Context, workers int) error {
    stream, err := c.client.ListItems(ctx, &streamv1.ListItemsRequest{})
    if err != nil {
        return err
    }

    // Create worker pool
    items := make(chan *streamv1.Item, workers*2)
    var wg sync.WaitGroup
    defer wg.Wait()
    defer close(items)

    // Start workers
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for item := range items {
                processItem(item)
            }
        }()
    }

    // Receive and distribute items
    for {
        item, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        select {
        case items <- item:
        case <-ctx.Done():
            return ctx.Err()
        }
    }

    return nil
}
```

### Junior -> FAANG: Flow Control Misconceptions to Clear

Two misconceptions about gRPC flow control cause the most beginner bugs.

**Misconception 1: `Send` returning `nil` means the message was delivered.** `Send` returns `nil` when the message is written to the HTTP/2 write buffer. The receiver may not have consumed it yet. The flow control window shrinks to reflect the in-flight data, but the application does not see this directly. If the receiver's window is full, `Send` blocks. It does not return an error. This is correct behavior: the transport is applying backpressure naturally. The bug occurs when you wrap `Send` in a goroutine and forget to wait for it: the goroutine may pile up if the receiver is slow, growing the goroutine count unboundedly.

**Misconception 2: raising `MaxRecvMsgSize` is the fix for large message errors.** If you receive `ResourceExhausted: received message larger than max`, the correct fix is to chunk the data into smaller messages, not to raise the limit. Raising the limit allows single messages to consume more memory on the receiver. A 100 MB single message must be fully buffered before `Recv` returns. Chunked at 1 MB, the receiver processes 100 messages incrementally. For file transfers and large query results, chunking is always correct. `MaxRecvMsgSize` should be set to a safety ceiling (e.g., 8 MB) to prevent accidental large messages, not as a way to accommodate regular large payloads.

For the `ConcurrentConsumer` worker pool pattern: the `items` channel capacity is `workers*2`. This is intentional. Too small and the receive loop blocks when all workers are busy, serializing receive behind processing. Too large and the channel becomes a memory buffer that defeats backpressure. Two times the worker count is a reasonable heuristic for balanced throughput.

### Senior @ FAANG: Flow Control as a System Property

**BDP-based dynamic tuning in grpc-go.** By default, grpc-go measures the bandwidth-delay product (BDP) of each connection and dynamically adjusts window sizes to maximize throughput. This tuning is per-connection and runs continuously, but only while you leave the window unset. Setting the initial window explicitly turns the estimator off: pass `grpc.WithInitialWindowSize` and `grpc.WithInitialConnWindowSize` on the client (or `grpc.InitialWindowSize` and `grpc.InitialConnWindowSize` on the server) with a value above the 64 KB default, and grpc-go uses that static window for the connection instead of estimating. Reach for the static window when you need deterministic behavior, for example in integration tests or when connecting to non-grpc-go peers that do not implement BDP estimation. The trade-off is that a static window tuned for one network path is rarely optimal for another, so prefer the default dynamic tuning in production unless you have measured a reason not to.

**Horizontal scaling and flow control interaction.** Flow control is per-connection, not per-server. When you add a new backend, existing connections stay on their current backends. Only new streams (including reconnects) land on the new backend. During a traffic spike, the correct response is to trigger reconnection of existing long-lived streams so they rebalance. This is non-trivial and usually requires application-level logic: the server sends a hint message ("please reconnect") or the proxy sends `GOAWAY` with a `MAX_STREAM_ID` that causes the client to reconnect to a new backend. Design this reconnection trigger into the system before you need it under load.

**Backpressure as a contract.** The `ConcurrentConsumer` pattern in this section applies backpressure by blocking the `Recv` loop when the `items` channel is full. This is correct within a single process. Across services, backpressure must be an explicit contract in the API design. A consumer service that is overloaded should return `ResourceExhausted` on the initial RPC call, not accept the stream and silently drop messages. Define the admission control policy (reject early vs accept and buffer vs accept and drop) in the service's API contract, and enforce it at the server interceptor layer so individual handlers do not need to implement it.

**Capacity planning for flow-controlled streams.** Model each streaming workload with three numbers: producer rate (messages per second and bytes per second), consumer rate, and the acceptable lag (how many messages can be in flight before the system is considered behind). The product of consumer rate and acceptable lag gives the required buffer size. Compare this against the HTTP/2 window size and the application-level channel capacity. If the required buffer exceeds what HTTP/2 can provide with the default 64 KB window, tune `InitialWindowSize`. If the required buffer exceeds what a single connection can absorb, partition the stream (multiple streams in parallel) or move to a dedicated message queue.

---
