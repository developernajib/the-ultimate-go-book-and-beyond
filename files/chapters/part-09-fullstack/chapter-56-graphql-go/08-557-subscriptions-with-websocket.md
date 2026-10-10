## 56.7 Subscriptions with WebSocket

GraphQL subscriptions extend the query/mutation model with a persistent event stream, delivered over WebSocket, that the client initiates with a subscription operation and the server pushes updates to as underlying data changes. Unlike REST webhooks, subscriptions are initiated by the client and use the same GraphQL type system for event payloads, making them trivially type-safe on both sides. The implementation below uses gqlgen's built-in subscription support backed by a channel-per-subscriber model that integrates with the service's event bus.

```go
// graph/subscription.resolvers.go
package graph

import (
    "context"
    "encoding/json"
    "fmt"

    "graphql-api/graph/model"
    "graphql-api/internal/auth"
)

func (r *subscriptionResolver) OrderStatusChanged(
    ctx context.Context,
    orderID string,
) (<-chan *model.Order, error) {
    // Verify user has access to this order
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("unauthorized")
    }

    order, err := r.OrderService.GetByID(ctx, orderID)
    if err != nil {
        return nil, err
    }

    // Only order owner or admin can subscribe
    if order.UserID != user.ID && user.Role != model.UserRoleAdmin {
        return nil, fmt.Errorf("access denied")
    }

    // Create channel for updates
    ch := make(chan *model.Order, 1)

    // Subscribe to order updates
    go func() {
        defer close(ch)

        // Subscribe to Redis pub/sub or similar
        sub := r.PubSub.Subscribe(ctx, fmt.Sprintf("order:%s", orderID))
        defer sub.Close()

        for {
            select {
            case <-ctx.Done():
                return
            case msg := <-sub.Channel():
                var order model.Order
                if err := json.Unmarshal([]byte(msg.Payload), &order); err != nil {
                    continue
                }
                select {
                case ch <- &order:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return ch, nil
}

func (r *subscriptionResolver) NewOrder(ctx context.Context) (<-chan *model.Order, error) {
    // Only admins can subscribe to all new orders
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("unauthorized")
    }

    if user.Role != model.UserRoleAdmin {
        return nil, fmt.Errorf("access denied: admin only")
    }

    ch := make(chan *model.Order, 10)

    go func() {
        defer close(ch)

        sub := r.PubSub.Subscribe(ctx, "orders:new")
        defer sub.Close()

        for {
            select {
            case <-ctx.Done():
                return
            case msg := <-sub.Channel():
                var order model.Order
                if err := json.Unmarshal([]byte(msg.Payload), &order); err != nil {
                    continue
                }
                select {
                case ch <- &order:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return ch, nil
}
```

### Server Setup with Subscriptions

Enabling subscriptions requires replacing the default HTTP handler with gqlgen's WebSocket-capable transport, which negotiates the `graphql-ws` or legacy `subscriptions-transport-ws` protocol during the upgrade handshake. The server setup below configures allowed origins for the WebSocket upgrade, sets per-connection keep-alive intervals, and wires the subscription transport alongside the standard query/mutation handler on the same HTTP mux.

```go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/99designs/gqlgen/graphql/handler"
    "github.com/99designs/gqlgen/graphql/handler/extension"
    "github.com/99designs/gqlgen/graphql/handler/lru"
    "github.com/99designs/gqlgen/graphql/handler/transport"
    "github.com/99designs/gqlgen/graphql/playground"
    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
    "github.com/gorilla/websocket"

    "graphql-api/graph"
    "graphql-api/internal/auth"
    "graphql-api/internal/dataloader"
    "graphql-api/internal/repository"
    "graphql-api/internal/service"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    slog.SetDefault(logger)

    // Initialize dependencies
    db := setupDatabase()
    repos := repository.NewRepositories(db)
    services := service.NewServices(repos)
    authService := auth.NewService(repos.User, os.Getenv("JWT_SECRET"))

    // Create resolver
    resolver := graph.NewResolver(
        services.User,
        services.Product,
        services.Order,
        services.Review,
        authService,
    )

    // Create GraphQL server
    srv := handler.New(graph.NewExecutableSchema(graph.Config{
        Resolvers: resolver,
        Directives: graph.DirectiveRoot{},
    }))

    // Add transports
    srv.AddTransport(transport.Websocket{
        Upgrader: websocket.Upgrader{
            CheckOrigin: func(r *http.Request) bool {
                return true // Configure properly in production
            },
            ReadBufferSize:  1024,
            WriteBufferSize: 1024,
        },
        KeepAlivePingInterval: 10 * time.Second,
        InitFunc: func(ctx context.Context, initPayload transport.InitPayload) (context.Context, error) {
            // Handle authentication for WebSocket connections
            token := initPayload.GetString("Authorization")
            if token != "" {
                user, err := authService.ValidateToken(ctx, token)
                if err == nil {
                    ctx = auth.WithUser(ctx, user)
                }
            }
            return ctx, nil
        },
    })
    srv.AddTransport(transport.Options{})
    srv.AddTransport(transport.GET{})
    srv.AddTransport(transport.POST{})
    srv.AddTransport(transport.MultipartForm{})

    // Add extensions
    srv.SetQueryCache(lru.New(1000))
    srv.Use(extension.Introspection{})
    srv.Use(extension.AutomaticPersistedQuery{
        Cache: lru.New(100),
    })

    // Add complexity limit
    srv.Use(extension.FixedComplexityLimit(300))

    // Setup router
    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Timeout(30 * time.Second))

    // Add auth middleware
    r.Use(auth.Middleware(authService))

    // Add dataloader middleware
    r.Use(dataloader.Middleware(repos))

    // Routes
    r.Handle("/", playground.Handler("GraphQL Playground", "/query"))
    r.Handle("/query", srv)

    // Start server
    server := &http.Server{
        Addr:         ":8080",
        Handler:      r,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    go func() {
        slog.Info("starting GraphQL server", "addr", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            slog.Error("server error", "error", err)
            os.Exit(1)
        }
    }()

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    slog.Info("shutting down server...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        slog.Error("server shutdown error", "error", err)
    }
    slog.Info("server stopped")
}
```

### Junior -> FAANG: Subscription Mechanics to Understand Before Writing One

Subscriptions are the most operationally complex part of GraphQL. Before writing a subscription resolver, understand the lifecycle: the client sends a subscription operation over WebSocket, the server starts a goroutine that produces a channel, gqlgen reads from that channel and serializes each value as a WebSocket message, and the goroutine runs until the channel is closed or the client disconnects (which cancels the context).

The two most important implementation rules:

First, always watch `ctx.Done()` in your subscription goroutine. When the client disconnects (browser tab closed, network drop, graceful unsubscribe), gqlgen cancels the request context. If your goroutine does not check `ctx.Done()`, it runs forever, leaking memory and a goroutine for each abandoned client. The `select` with `case <-ctx.Done(): return` pattern shown in this file is the correct idiom.

Second, use a buffered channel for the subscription output. An unbuffered channel blocks the sender until the receiver is ready. If gqlgen's send loop is briefly blocked (by slow JSON serialization, a slow WebSocket flush, or a slow client), a blocking send stalls your event source goroutine. A buffer of 1 to 10 is usually sufficient. Larger buffers may hide slow-consumer issues rather than surfacing them.

Interview preparation: be able to describe the channel-based subscription model and why it is goroutine-per-subscriber. Describe what happens when a client disconnects unexpectedly (context is canceled, `ctx.Done()` fires, goroutine returns, channel is closed). Describe the difference between the `graphql-ws` and `subscriptions-transport-ws` protocols (the latter is deprecated, always use the former for new work).

### Senior @ FAANG: Subscription Infrastructure at Thousands of Concurrent Clients

Single-server subscription implementations collapse when you need horizontal scaling. At FAANG, subscriptions require a shared message bus because each server instance only holds connections for a fraction of all subscribers, but any instance might process a mutation that needs to notify subscribers on all other instances.

**The Redis Pub/Sub fan-out architecture.** When a mutation changes an order's status, the mutation resolver publishes to a Redis channel (`order:{id}`). Every GraphQL server instance has a Redis subscriber goroutine for each active topic. When the message arrives, each instance fans out to its locally connected WebSocket clients for that topic. This requires that WebSocket connections are sticky to a server instance (the load balancer must use consistent hashing or cookie-based routing), so that all of a client's subscription messages arrive on the instance that holds their connection.

**The scaling ceiling of Redis Pub/Sub.** Redis Pub/Sub processes subscriptions in a single thread per channel on the server side. At extreme scale (millions of messages per second, thousands of channels), Redis Pub/Sub becomes a bottleneck. The alternative is NATS (horizontally scalable message routing), Kafka (durable, replayable event log), or a purpose-built subscription platform like Ably or Pusher. The decision involves: do you need message durability (replay on reconnect), do you need at-least-once delivery guarantees, and what is the maximum message throughput per topic?

**Reconnect and replay semantics.** The WebSocket protocol does not guarantee delivery. If a client's connection drops and they reconnect, they missed events during the outage. For some subscriptions (live cursors, presence indicators), missing events is acceptable. For others (order status updates, financial transactions), clients need to know what they missed. The production solution is a bounded event buffer (Redis Stream, Kafka topic with a retention window) that allows reconnecting clients to request events since their last received sequence number. The `graphql-ws` protocol supports this via the connection payload, where clients can send a `lastEventId`.

**Subscription authorization is connection-scoped.** The `InitFunc` in the WebSocket transport runs once at connection establishment. The authorization decision made there persists for the connection lifetime. This creates a subtle issue: a user's permissions may change during a long-lived subscription. An admin who is demoted while subscribed continues to receive admin-only subscription events until they reconnect. The mitigation is periodic re-authorization: the subscription goroutine re-checks the user's current permissions every N minutes (by querying the auth service with the user ID from the connection context) and closes the channel if the user no longer has permission.

**Backpressure policy decisions.** When a slow consumer's channel buffer is full, you have three choices: drop the message (acceptable for live data like cursor positions), disconnect the client (appropriate for financial feeds where the client must reconnect clean and replay), or apply TCP backpressure by blocking the send until the client drains (wrong: this stalls the entire fan-out goroutine and affects all subscribers). The choice must be documented as a platform policy and enforced consistently across all subscription resolvers.

---
