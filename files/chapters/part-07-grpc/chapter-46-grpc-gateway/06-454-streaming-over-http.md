## 46.4 Streaming Over HTTP

### Server-Sent Events (SSE)

When a gRPC-Gateway route maps to a server-streaming RPC, the gateway can forward responses as Server-Sent Events by setting `Content-Type: text/event-stream` and flushing each `data:` line as the gRPC stream delivers messages. This allows browser clients using the `EventSource` API to receive real-time updates from a gRPC server-streaming endpoint without any WebSocket negotiation.

```go
package gateway

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"

    "google.golang.org/grpc"

    streamv1 "github.com/myapp/gen/stream/v1"
)

// SSEHandler wraps a server streaming RPC as SSE
func SSEHandler(client streamv1.StreamServiceClient) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Set SSE headers
        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")
        w.Header().Set("Access-Control-Allow-Origin", "*")
        // Tell Nginx not to buffer the response, otherwise events are held
        // in the proxy buffer instead of reaching the browser immediately.
        w.Header().Set("X-Accel-Buffering", "no")

        // Get flusher
        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "SSE not supported", http.StatusInternalServerError)
            return
        }

        // Create stream
        ctx := r.Context()
        stream, err := client.WatchEvents(ctx, &streamv1.WatchEventsRequest{
            EventTypes: r.URL.Query()["type"],
        })
        if err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }

        // Stream events
        for {
            event, err := stream.Recv()
            if err == io.EOF {
                break
            }
            if err != nil {
                // Send error event
                fmt.Fprintf(w, "event: error\ndata: %s\n\n", err.Error())
                flusher.Flush()
                return
            }

            // Serialize event
            data, err := json.Marshal(event)
            if err != nil {
                continue
            }

            // Send SSE event
            fmt.Fprintf(w, "id: %s\n", event.GetId())
            fmt.Fprintf(w, "event: %s\n", event.GetType())
            fmt.Fprintf(w, "data: %s\n\n", data)
            flusher.Flush()
        }
    }
}

// Usage
func setupSSERoutes(mux *http.ServeMux, grpcConn *grpc.ClientConn) {
    client := streamv1.NewStreamServiceClient(grpcConn)
    mux.HandleFunc("/api/v1/events/stream", SSEHandler(client))
}
```

### WebSocket Bridge

A WebSocket bridge upgrades an incoming HTTP connection to WebSocket, opens a gRPC bidirectional stream to the backend, and then relays messages in both directions between the two connections in separate goroutines. This pattern allows browser clients that cannot use gRPC directly to participate in bidirectional streaming RPCs through a standard WebSocket connection.

```go
package gateway

import (
    "encoding/json"
    "io"
    "log"
    "net/http"

    "github.com/gorilla/websocket"

    streamv1 "github.com/myapp/gen/stream/v1"
)

var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool {
        return true // Configure for production
    },
}

// WebSocketHandler bridges WebSocket to bidirectional gRPC stream
func WebSocketHandler(client streamv1.StreamServiceClient) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Upgrade to WebSocket
        conn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
            log.Printf("upgrade error: %v", err)
            return
        }
        defer conn.Close()

        ctx := r.Context()

        // Create gRPC stream
        stream, err := client.Chat(ctx)
        if err != nil {
            conn.WriteJSON(map[string]string{"error": err.Error()})
            return
        }

        // Handle incoming WebSocket messages
        go func() {
            for {
                _, message, err := conn.ReadMessage()
                if err != nil {
                    if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                        log.Printf("read error: %v", err)
                    }
                    stream.CloseSend()
                    return
                }

                // Parse and forward to gRPC
                var msg streamv1.ChatMessage
                if err := json.Unmarshal(message, &msg); err != nil {
                    log.Printf("unmarshal error: %v", err)
                    continue
                }

                if err := stream.Send(&msg); err != nil {
                    log.Printf("send error: %v", err)
                    return
                }
            }
        }()

        // Handle incoming gRPC messages
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                break
            }
            if err != nil {
                log.Printf("recv error: %v", err)
                break
            }

            // Forward to WebSocket
            if err := conn.WriteJSON(msg); err != nil {
                log.Printf("write error: %v", err)
                break
            }
        }
    }
}
```

### Junior -> FAANG: SSE vs WebSocket, and Knowing Which to Reach For

The section shows two streaming bridge patterns: SSE and WebSocket. Understanding when to use each is a common interview question and a practical decision you will make on your first or second streaming feature.

SSE (Server-Sent Events) is unidirectional: the server pushes events to the browser over a regular HTTP connection. The browser's `EventSource` API handles reconnection automatically when the connection drops. SSE works through any reverse proxy that does not buffer responses (Nginx with `proxy_buffering off`, CloudFront with streaming enabled). Use SSE when the browser only needs to receive events: notifications, live dashboards, progress updates.

WebSocket is bidirectional: both sides can send at any time. It requires a protocol upgrade (`101 Switching Protocols`) that some corporate firewalls and HTTP/1.1 proxies do not support. Use WebSocket when the browser needs to send messages interactively: chat, collaborative editing, live form submission with server feedback.

The `X-Accel-Buffering: no` header in the SSE handler is easy to miss. Nginx by default buffers upstream responses and flushes them in chunks. For SSE, this means events are held in Nginx's buffer instead of being immediately forwarded to the browser. Setting `X-Accel-Buffering: no` tells Nginx to flush immediately, which is required for real-time SSE to work.

The `flusher.Flush()` call after each SSE event is also required. Go's `net/http` response writer buffers output by default. Without the flush, events accumulate in the buffer and are sent in bursts rather than as they arrive from the gRPC stream.

First-job habit: test SSE through a reverse proxy (Nginx or Caddy) in your local Docker Compose environment, not just via direct HTTP. The behavior through a proxy differs from direct connection in ways that matter in production.

### Senior @ FAANG: Streaming at Scale, Connection Management, and Load Balancer Compatibility

The SSE and WebSocket patterns in this section work correctly for a single gateway instance. At scale, the challenges shift to connection management, load balancer compatibility, and resource accounting.

**Connection limits and backpressure.** Each active SSE or WebSocket connection holds a goroutine (at minimum the read loop and the write loop), a file descriptor, and memory for the channel buffer. At 10,000 concurrent SSE connections, a gateway process holds 10,000 goroutines and 10,000 file descriptors. This is within Go's goroutine model, but the file descriptor limit (`ulimit -n`) on most Linux systems defaults to 1,024. Production SSE gateways must set `ulimit -n` to at least 65,536 and monitor the current file descriptor count as a health metric.

**Load balancer sticky sessions for WebSocket.** WebSocket is a stateful connection. Once the upgrade handshake completes, subsequent frames must go to the same gateway instance. Most load balancers support WebSocket by default, but they require the gateway to respond to the `Upgrade: websocket` header before the connection becomes sticky. If the gateway is behind an HTTP/1.1-only load balancer (some older AWS ELB configurations), WebSocket upgrades fail because the load balancer rewrites the `Upgrade` header. Verify WebSocket compatibility with the specific load balancer type before committing to the pattern.

**SSE fan-out and the broadcaster pattern.** The exercise in this chapter implements an `SSEBroadcaster` that holds an in-process channel map. This works for a single gateway instance. When you scale to multiple gateway instances, each instance has its own in-process broadcaster and clients connected to different instances see different event sets. The fix is a shared pub/sub backend (Redis pub/sub, Kafka, or a gRPC bidirectional stream to a stateful aggregator service). The `SSEBroadcaster` becomes an adapter that subscribes to the shared backend and fans out to its local clients. Designing this correctly requires thinking about what happens when the shared backend is unavailable: should the SSE connection stay open (client sees silence) or close immediately (client reconnects and may reconnect to a healthier instance)?

**gRPC streaming deadline propagation.** When the gateway calls `client.WatchEvents(ctx, ...)`, the `ctx` is derived from the HTTP request's context. If the HTTP connection has a write timeout (set via `http.Server.WriteTimeout`), the context deadline is set to match. When the deadline is reached, the gRPC stream is canceled and `stream.Recv()` returns a deadline-exceeded error. For long-lived SSE connections, you must either extend the deadline (use a context without a deadline, managing the connection lifetime via `ctx.Done()`) or reset the deadline after each successful event. Mixing `WriteTimeout` with SSE handlers is a common source of mysterious disconnections at exactly the timeout interval.

**Bar-raiser question:** "You have 50,000 SSE connections through three gateway instances. The upstream gRPC stream reconnects and replays the last 1,000 events. How do you prevent 50,000 browsers from receiving duplicate events?" Expected answer: use event IDs in the SSE stream (`id: <event-id>`). The browser sends `Last-Event-ID` on reconnection. The gateway passes this to the gRPC stream via metadata, and the backend seeks forward past the already-delivered ID. This requires the gRPC backend to support cursor-based replay, not just streaming from the current position.

---
