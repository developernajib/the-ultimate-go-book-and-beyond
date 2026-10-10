## 102H.14 Advanced Interview Questions: Scaling, Reconnections & Backpressure

---

**Q4: How do you scale WebSocket servers horizontally without sticky sessions?**

The key is externalizing connection state so any node can route to any connection. Use Redis pub/sub: when a client on node A sends a message to a room, node A publishes to Redis. All nodes (including node B where the recipient is connected) subscribe to room channels and deliver to their local clients. This makes nodes stateless with respect to message routing - only the WebSocket TCP connections themselves are node-local. For presence (knowing which users are online), use Redis sorted sets or Redis hashes with a heartbeat-based TTL. The tradeoff: every message now makes a Redis round-trip (~0.5-1ms), which is acceptable for most use cases but not for ultra-low-latency gaming servers.

---

**Q5: When would you choose SSE over WebSocket, and what are the proxy compatibility tradeoffs?**

Choose SSE when communication is server-to-client only and you need broad proxy compatibility. SSE travels over standard HTTP - it works through HTTP-only corporate proxies, Cloudflare, AWS CloudFront, and nginx without special configuration (except `X-Accel-Buffering: no` for nginx). WebSocket requires protocol upgrade (`Upgrade: websocket`) which some proxies block or fail to handle. SSE also benefits from the browser's built-in `EventSource` reconnection with `Last-Event-ID` for event replay - no client-side retry logic needed. Choose WebSocket when the client also sends data (chat, collaboration, gaming) because SSE is strictly unidirectional. Or when you need binary frames. Or when you need sub-5ms round-trips since SSE's chunked-encoding overhead adds a few milliseconds.

---

**Q6: How do you implement WebSocket reconnection with message replay on the client side?**

The client must track the last received message ID and send it on reconnect. On the server: maintain a bounded ring buffer of recent messages per channel (e.g., last 1,000 messages with IDs, stored in Redis as a sorted set or Redis Stream). On reconnect: client sends `?last_id=<id>` in the WebSocket URL. Server replays all messages with ID greater than `last_id` before entering live-delivery mode. Using Redis Streams: `XREAD COUNT 100 STREAMS room:general <last_id>` fetches all messages since the client's last-seen ID. This solves the "coordination omission" problem where a client misses events during a disconnect. Bounded buffer means events older than the buffer window cannot be replayed - clients disconnected for too long must fall back to a full-state refresh (re-fetch the current state instead of event replay).

---

**Q7: How do you handle backpressure in a WebSocket server?**

Backpressure occurs when the server produces messages faster than a slow client can consume them. Without handling: the send buffer fills up, goroutines block, memory grows unbounded. Three strategies: (1) **Drop and disconnect** - if the client's send channel is full, close the connection. This is the simplest and most common approach. Signal the client that it fell too far behind. It should reconnect and re-sync state. (2) **Drop with notification** - send a special "you are behind, fetch current state" message and continue the connection with only fresh events. (3) **Apply backpressure upstream** - block the publisher goroutine when the client is slow. Only viable when there is a single slow consumer and blocking the publisher is acceptable. For WebSocket notification systems: option 1 (drop + disconnect) is standard. For collaborative editing where losing events causes inconsistency: option 3 or guaranteed delivery via persistent queue (Kafka/Redis Streams) with client-side sequence tracking.

---

**Q8: What is the thundering herd problem on WebSocket server restart, and how do you prevent it?**

When a WebSocket server restarts, all connected clients simultaneously detect the connection close and attempt to reconnect at the same instant. If there are 100,000 clients, the restarting server (or the new server) receives 100,000 connection requests in the same second - overloading it before it is healthy. Prevention: implement exponential backoff with jitter on the client side. Instead of reconnecting immediately, each client waits a random delay: `baseDelay * (1 + random) * 2^attempt`. This spreads reconnections over 10-30 seconds instead of 1 second. Server-side mitigation: use graceful shutdown (send WebSocket close frames with 1001 "Going Away" before the server stops) so clients know to reconnect rather than experiencing an abrupt TCP close. In Kubernetes: use `preStop` hook to trigger graceful shutdown before the pod receives SIGTERM, and set `terminationGracePeriodSeconds` long enough for drain to complete.

---

**Q9: How does gRPC bidirectional streaming differ from WebSocket for service-to-service communication?**

Both support full-duplex message exchange, but the implementation and operational model differ significantly. gRPC bidirectional streaming: typed messages (Protocol Buffers), code-generated client and server stubs, built-in HTTP/2 flow control for backpressure, native load balancing via gRPC resolvers (no sticky sessions required - HTTP/2 streams are multiplexed over one connection), built-in interceptor chains for auth, logging, metrics, and tracing. WebSocket: untyped binary/text frames, manual framing and parsing, manual backpressure, requires sticky sessions or Redis hub for multi-node routing, no built-in interceptor model. For internal Go microservices: gRPC streaming is strongly preferred - type safety eliminates serialization bugs, generated code reduces boilerplate, and the operational tooling (grpc-prometheus, grpc-opentelemetry) integrates with standard observability stacks. Use WebSocket when the client is a browser (gRPC requires gRPC-Web proxy for browsers) or when you need to support clients in languages without mature gRPC libraries.

---

**Q10: How do you implement per-client rate limiting on a WebSocket server?**

Implement a token bucket per connection in the `readPump`. Each client gets a bucket with capacity C and refill rate R tokens/second. On each received message: attempt to consume one token. If the bucket is empty, the client is exceeding the rate limit - either drop the message or close the connection.

```go
import "golang.org/x/time/rate"

// In Client struct:
// limiter *rate.Limiter

// In NewClient:
// limiter: rate.NewLimiter(rate.Limit(100), 200), // 100 msg/s, burst of 200

// In readPump, after reading a message:
if !c.limiter.Allow() {
    // Rate limit exceeded
    c.hub.logger.Warn("client rate limit exceeded, disconnecting",
        slog.String("userID", c.userID))
    // Send rate-limit close code and disconnect
    c.conn.WriteControl(
        websocket.CloseMessage,
        websocket.FormatCloseMessage(1008, "rate limit exceeded"),
        time.Now().Add(writeWait),
    )
    return // exits readPump, triggers cleanup
}
```

`golang.org/x/time/rate` implements a token bucket that is goroutine-safe, monotonically clock-based (no wall clock drift issues), and has zero-allocation for the hot path. Set limits appropriate to your use case: a chat app might allow 5 messages/second with a burst of 20. A real-time gaming server might allow 60 messages/second (one per frame).

---

**Q11: How do you monitor WebSocket server health in production?**

Key metrics to expose via Prometheus:

```go
var (
    wsConnections = prometheus.NewGauge(prometheus.GaugeOpts{
        Name: "websocket_connections_active",
        Help: "Number of active WebSocket connections",
    })
    wsMsgSent = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "websocket_messages_sent_total",
        Help: "Total WebSocket messages sent by type",
    }, []string{"type"})
    wsMsgRecv = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_received_total",
        Help: "Total WebSocket messages received from clients",
    })
    wsSendLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
        Name:    "websocket_send_latency_seconds",
        Help:    "Latency of WebSocket message delivery",
        Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0},
    })
    wsDropped = prometheus.NewCounter(prometheus.CounterOpts{
        Name: "websocket_messages_dropped_total",
        Help: "Messages dropped due to full send buffer",
    })
)
```

Alerts:
- `websocket_connections_active` growing without bound → connection leak
- `websocket_messages_dropped_total` rate > 0 → slow clients or upstream pressure
- `websocket_send_latency_seconds` p99 > 100ms → hub contention or Redis latency
- Goroutine count (`go_goroutines`) = 2 × connections + hub overhead. Any deviation suggests goroutine leak

### Junior → FAANG: The Metrics That Tell the Story in a WebSocket Postmortem

The two metrics at the end of this section are the most important signals for WebSocket operational health. `websocket_send_latency_seconds` p99 greater than 100ms is the signal that something is blocking the writer goroutine: either the hub goroutine is slow (hub contention) or Redis is slow (network latency, Redis CPU, connection pool exhaustion). Goroutine count diverging from `2 × connections + hub overhead` is the signal for a goroutine leak: either reader or writer goroutines are not being cleaned up when connections close.

Practice being able to explain what each of these metrics means and how to investigate when they deviate. If asked "you are seeing high WebSocket send latency, how do you debug it?", the answer is: check goroutine count for leaks, check Redis latency percentiles, check hub channel buffer utilization, and use `pprof` goroutine dump to identify blocked goroutines. This is the kind of systematic debugging approach FAANG interviews test for.

### Senior @ FAANG: Backpressure as a Contract, Not an Afterthought

Backpressure in WebSocket systems is a delivery contract negotiated at design time. At L6, the question is not "do we have backpressure?" but "what is the explicit backpressure contract, who does it protect, and what is the behavior when the contract is violated?" The contract must specify: what is the maximum send buffer per client, what happens when the buffer is full (drop oldest, drop newest, disconnect the client), and how does the product surface this to the user (silent drop versus "connection is slow" indicator).

Implicit backpressure (allowing buffers to grow unboundedly) is not a contract. It is the absence of one. It leads to two failure modes: the slow consumer causes the hub to block (if the channel is synchronous), or the server runs out of memory buffering messages for all slow consumers (if channels are unbounded). Either failure mode affects all clients, not just the slow one.

At FAANG scale, backpressure policy is part of the platform SLA. The connection tier documents: "messages buffered per client: N messages. Behavior on buffer full: client is disconnected with close code 1008 (Policy Violation)." Product teams building on top of the connection tier know to implement client-side reconnection with exponential backoff. This explicit contract replaces the implicit hope that clients will always keep up with the server.

---
