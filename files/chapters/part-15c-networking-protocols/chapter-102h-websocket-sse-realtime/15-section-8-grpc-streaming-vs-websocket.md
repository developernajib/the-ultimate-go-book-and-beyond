## 102H.13 gRPC Bidirectional Streaming vs WebSocket

For internal service-to-service real-time communication, gRPC streaming is often a better fit than WebSocket. This section compares both and shows a Go gRPC streaming server that replaces WebSocket for service-to-service real-time data.

### When to Use gRPC Streaming vs WebSocket

| Dimension | gRPC Streaming | WebSocket |
|---|---|---|
| **Primary audience** | Internal services (service-to-service) | Browsers and mobile clients |
| **Protocol** | HTTP/2 with Protocol Buffers | HTTP upgrade + framing |
| **Type safety** | Strong (protobuf schema) | None (raw bytes) |
| **Code generation** | Client + server stubs auto-generated | Manual |
| **Browser support** | No (gRPC-Web required) | Native |
| **Load balancing** | gRPC-aware LB (Envoy, grpc-go resolver) | Sticky sessions or Redis hub |
| **Observability** | Built-in interceptors, grpc-prometheus | Manual |
| **Backpressure** | HTTP/2 flow control (built-in) | Manual implementation |
| **Streaming types** | Server, client, bidirectional | Bidirectional only |

### gRPC Server Streaming for Real-Time Events

Server streaming (server sends multiple responses to one client request) replaces WebSocket for service-to-service event delivery:

```protobuf
// notifications.proto
syntax = "proto3";
package notifications.v1;
option go_package = "github.com/org/app/gen/notifications/v1;notificationsv1";

import "google/protobuf/timestamp.proto";

service NotificationService {
    // SubscribeNotifications opens a server stream.
    // Client sends one request (with user_id), server streams notifications indefinitely.
    rpc SubscribeNotifications(SubscribeRequest) returns (stream NotificationEvent);

    // BidirectionalStream demonstrates bidirectional streaming
    // for cases where client also sends data (collaborative sessions).
    rpc CollaborateOnDocument(stream DocumentChange) returns (stream DocumentChange);
}

message SubscribeRequest {
    string user_id   = 1;
    repeated string channels = 2;
}

message NotificationEvent {
    string id         = 1;
    string user_id    = 2;
    string type       = 3;
    string message    = 4;
    google.protobuf.Timestamp created_at = 5;
}

message DocumentChange {
    string document_id = 1;
    string user_id     = 2;
    string operation   = 3; // JSON-encoded operational transform
    int64  sequence    = 4;
}
```

```go
package grpcserver

import (
    "sync"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/types/known/timestamppb"

    notificationsv1 "github.com/org/app/gen/notifications/v1"
)

// NotificationServer implements the gRPC NotificationService.
type NotificationServer struct {
    notificationsv1.UnimplementedNotificationServiceServer
    mu          sync.RWMutex
    subscribers map[string][]chan *notificationsv1.NotificationEvent // userID -> channels
    docSubs     map[string]map[string]chan *notificationsv1.DocumentChange // docID -> userID -> channel
}

func NewNotificationServer() *NotificationServer {
    return &NotificationServer{
        subscribers: make(map[string][]chan *notificationsv1.NotificationEvent),
        docSubs:     make(map[string]map[string]chan *notificationsv1.DocumentChange),
    }
}

// SubscribeNotifications implements server-side streaming.
// The method blocks until the client disconnects or context is canceled.
func (s *NotificationServer) SubscribeNotifications(
    req *notificationsv1.SubscribeRequest,
    stream notificationsv1.NotificationService_SubscribeNotificationsServer,
) error {
    if req.UserId == "" {
        return status.Error(codes.InvalidArgument, "user_id is required")
    }

    ch := make(chan *notificationsv1.NotificationEvent, 32)

    s.mu.Lock()
    s.subscribers[req.UserId] = append(s.subscribers[req.UserId], ch)
    s.mu.Unlock()

    defer func() {
        s.mu.Lock()
        defer s.mu.Unlock()
        subs := s.subscribers[req.UserId]
        for i, c := range subs {
            if c == ch {
                s.subscribers[req.UserId] = append(subs[:i], subs[i+1:]...)
                close(ch)
                break
            }
        }
    }()

    // Keep-alive ticker - send a heartbeat event periodically so the stream
    // doesn't time out on long-lived connections with no activity.
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case event, ok := <-ch:
            if !ok {
                return nil
            }
            if err := stream.Send(event); err != nil {
                // Client disconnected
                return status.Errorf(codes.Unavailable, "stream send: %v", err)
            }

        case <-ticker.C:
            // Heartbeat - empty event with type "heartbeat"
            heartbeat := &notificationsv1.NotificationEvent{
                Id:        "heartbeat",
                Type:      "heartbeat",
                CreatedAt: timestamppb.Now(),
            }
            if err := stream.Send(heartbeat); err != nil {
                return status.Errorf(codes.Unavailable, "heartbeat send: %v", err)
            }

        case <-stream.Context().Done():
            return stream.Context().Err()
        }
    }
}

// Publish sends an event to all gRPC subscribers of userID.
func (s *NotificationServer) Publish(userID string, event *notificationsv1.NotificationEvent) {
    s.mu.RLock()
    subs := s.subscribers[userID]
    s.mu.RUnlock()

    for _, ch := range subs {
        select {
        case ch <- event:
        default:
            // Subscriber backpressure - buffer full, drop event
            // In production: track dropped events as a metric
        }
    }
}

// CollaborateOnDocument implements bidirectional streaming for collaborative editing.
// Each connected client sends document changes - the server broadcasts them to all
// other clients on the same document.
func (s *NotificationServer) CollaborateOnDocument(
    stream notificationsv1.NotificationService_CollaborateOnDocumentServer,
) error {
    ctx := stream.Context()

    // Read the first message to identify the document session
    firstMsg, err := stream.Recv()
    if err != nil {
        return status.Errorf(codes.InvalidArgument, "first message required: %v", err)
    }

    docID := firstMsg.DocumentId
    userID := firstMsg.UserId

    // Subscribe to document changes from other clients
    ch := make(chan *notificationsv1.DocumentChange, 32)
    s.subscribeToDocument(docID, userID, ch)
    defer s.unsubscribeFromDocument(docID, userID, ch)

    // Broadcast the first message to other clients on this document
    s.broadcastDocumentChange(docID, userID, firstMsg)

    // Start receiving changes from this client in a goroutine
    recvErr := make(chan error, 1)
    go func() {
        for {
            change, err := stream.Recv()
            if err != nil {
                recvErr <- err
                return
            }
            s.broadcastDocumentChange(docID, userID, change)
        }
    }()

    // Send changes from other clients to this client
    for {
        select {
        case change := <-ch:
            if err := stream.Send(change); err != nil {
                return status.Errorf(codes.Unavailable, "send to client: %v", err)
            }
        case err := <-recvErr:
            return err
        case <-ctx.Done():
            return ctx.Err()
        }
    }
}

func (s *NotificationServer) subscribeToDocument(docID, userID string, ch chan *notificationsv1.DocumentChange) {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.docSubs[docID] == nil {
        s.docSubs[docID] = make(map[string]chan *notificationsv1.DocumentChange)
    }
    s.docSubs[docID][userID] = ch
}

func (s *NotificationServer) unsubscribeFromDocument(docID, userID string, ch chan *notificationsv1.DocumentChange) {
    s.mu.Lock()
    defer s.mu.Unlock()
    if s.docSubs[docID] != nil {
        delete(s.docSubs[docID], userID)
        if len(s.docSubs[docID]) == 0 {
            delete(s.docSubs, docID)
        }
    }
    close(ch)
}

func (s *NotificationServer) broadcastDocumentChange(docID, originUserID string, change *notificationsv1.DocumentChange) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    for uid, ch := range s.docSubs[docID] {
        if uid != originUserID {
            select {
            case ch <- change:
            default:
            }
        }
    }
}

// GRPCServerOptions returns recommended server options for production gRPC streaming.
func GRPCServerOptions() []grpc.ServerOption {
    return []grpc.ServerOption{
        grpc.KeepaliveParams(keepalive.ServerParameters{
            // Send keepalive ping if client is idle for 30s (prevents proxy timeout)
            Time:    30 * time.Second,
            Timeout: 10 * time.Second,
            // Allow clients to send keepalive even when no RPCs are active
            MaxConnectionIdle: 5 * time.Minute,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             10 * time.Second,
            PermitWithoutStream: true,
        }),
        grpc.MaxRecvMsgSize(4 * 1024 * 1024),  // 4MB max receive message
        grpc.MaxSendMsgSize(4 * 1024 * 1024),  // 4MB max send message
    }
}
```

### gRPC Client for Streaming

A gRPC streaming client must handle two failure modes that do not exist with a simple unary call: the stream can be interrupted mid-flight by a network partition, and the server may close the stream intentionally (e.g., during a rolling restart). The `ConnectAndSubscribe` function below wraps the inner `subscribe` loop with an outer reconnect loop that uses exponential backoff to avoid thundering-herd reconnects after a server restart. The `keepalive.ClientParameters` configuration sends periodic HTTP/2 PING frames so that idle streams are not silently dropped by intermediate load balancers or NAT gateways that have short TCP idle timeouts.

```go
package grpcclient

import (
    "context"
    "fmt"
    "io"
    "log/slog"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/backoff"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"

    notificationsv1 "github.com/org/app/gen/notifications/v1"
)

func ConnectAndSubscribe(ctx context.Context, addr, userID string, logger *slog.Logger) error {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()), // Use TLS in production
        grpc.WithConnectParams(grpc.ConnectParams{
            Backoff: backoff.Config{
                BaseDelay:  1 * time.Second,
                Multiplier: 1.6,
                MaxDelay:   30 * time.Second,
            },
            MinConnectTimeout: 5 * time.Second,
        }),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                30 * time.Second,
            Timeout:             10 * time.Second,
            PermitWithoutStream: true,
        }),
    )
    if err != nil {
        return fmt.Errorf("dial: %w", err)
    }
    defer conn.Close()

    client := notificationsv1.NewNotificationServiceClient(conn)

    for {
        if err := subscribe(ctx, client, userID, logger); err != nil {
            if ctx.Err() != nil {
                return ctx.Err() // Context canceled, stop retrying
            }
            logger.Warn("subscription ended, reconnecting",
                slog.String("error", err.Error()))
            // Backoff before reconnect - prevents hammering a restarting server
            select {
            case <-time.After(2 * time.Second):
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}

func subscribe(ctx context.Context, client notificationsv1.NotificationServiceClient, userID string, logger *slog.Logger) error {
    stream, err := client.SubscribeNotifications(ctx, &notificationsv1.SubscribeRequest{
        UserId:   userID,
        Channels: []string{"general", "personal:" + userID},
    })
    if err != nil {
        return fmt.Errorf("open stream: %w", err)
    }

    for {
        event, err := stream.Recv()
        if err == io.EOF {
            return nil // Server closed stream cleanly
        }
        if err != nil {
            return fmt.Errorf("recv: %w", err)
        }
        if event.Type == "heartbeat" {
            continue // Ignore keep-alive events
        }
        logger.Info("received notification",
            slog.String("id", event.Id),
            slog.String("type", event.Type),
            slog.String("message", event.Message))
    }
}
```

### Junior → FAANG: When to Reach for gRPC Streaming Over WebSocket

The clearest signal that gRPC streaming is the right choice over WebSocket is when both ends of the connection are Go (or other non-browser) services. gRPC streaming provides strongly-typed messages via Protobuf, built-in flow control and backpressure, load balancer compatibility via HTTP/2, and deadline/cancellation propagation via context. WebSocket provides none of these for free.

The practical habit: when designing a service-to-service real-time communication, check whether gRPC streaming covers the use case before reaching for WebSocket. Bidirectional streaming in gRPC (`BidiStream`) covers the full-duplex case. Server-side streaming covers the server-push case. Client-side streaming covers the client-push case. Only reach for WebSocket when browsers are involved or when an existing WebSocket ecosystem (library, proxy, CDN) makes it the path of least resistance.

Interview entry point: describe the key differences as Protobuf typing and deadline propagation (gRPC advantages) versus browser compatibility and established ecosystem (WebSocket advantages). For internal services, gRPC almost always wins.

### Senior @ FAANG: gRPC Streaming in Microservice Meshes and Its Operational Complexity

gRPC streaming over HTTP/2 has a subtle operational challenge in service meshes: HTTP/2 connection multiplexing means that a single TCP connection carries many concurrent streams. Load balancers that operate at the TCP level (L4) cannot distribute gRPC streams across multiple backends because all streams on one connection go to the same backend. This requires HTTP/2-aware (L7) load balancing, which is what service meshes like Istio and Envoy provide via connection-level load balancing.

In a FAANG microservice environment, gRPC streaming is typically deployed behind a service mesh proxy (Envoy sidecar) that handles L7 load balancing, retries, circuit breaking, and observability. The application code sees a simple gRPC connection. The mesh handles the routing complexity. This is the correct architecture for large-scale gRPC streaming, but it requires the team to understand what the mesh is doing and to have runbooks for mesh-level failures.

The L6 concern: gRPC streaming connections are long-lived. A streaming RPC that runs for hours holds a goroutine and connection state for that duration. Memory profiling for gRPC streaming services must account for the "goroutine per stream" model and ensure that stream cleanup on disconnection is correct. Leaked streaming goroutines are a common source of memory growth in gRPC services that handle many concurrent long-lived streams.

---
