## Interview Questions

### Question 1: How would you implement field-level authorization in GraphQL?

**What FAANG expects:** Three approaches with trade-offs: schema directives (visible in schema, enforced before resolver), resolver-level checks (finest control, supports masking), and field-permission middleware (decoupled rules). Call out the common mistake of returning errors instead of `null` for unauthorized fields, which leaks existence. Bonus for naming OAuth scopes vs attribute-based access control (ABAC) and for mentioning `gqlgen`'s directive hook model specifically.

**Answer:** There are three main approaches, each with different tradeoffs. Schema directives make the authorization model visible in the schema itself and enforce it before the resolver runs. Resolver-level checks give you finer control for cases like returning masked data instead of an error. Field-level permission maps decouple the authorization rules from both the schema and the resolver code. In practice, most production systems combine directives for coarse-grained access control with resolver-level checks for field masking.

```go
// Field-level authorization can be implemented using directives or resolver middleware

// Approach 1: Schema Directives
// schema.graphqls
/*
directive @auth(requires: Role = USER) on FIELD_DEFINITION

enum Role {
  USER
  ADMIN
  SUPER_ADMIN
}

type User {
  id: ID!
  email: String!
  name: String!
  # Only admins can see this
  internalNotes: String @auth(requires: ADMIN)
  # Only the user themselves or admins
  ssn: String @auth(requires: SELF_OR_ADMIN)
}

type Query {
  users: [User!]! @auth(requires: ADMIN)
  me: User @auth(requires: USER)
}
*/

// directive.go
package graph

import (
    "context"
    "fmt"

    "github.com/99designs/gqlgen/graphql"
)

func AuthDirective(ctx context.Context, obj any, next graphql.Resolver, requires Role) (any, error) {
    user := auth.UserFromContext(ctx)

    if user == nil {
        return nil, fmt.Errorf("not authenticated")
    }

    switch requires {
    case RoleUser:
        // Any authenticated user can access
        return next(ctx)

    case RoleAdmin:
        if user.Role != "admin" && user.Role != "super_admin" {
            return nil, fmt.Errorf("requires admin access")
        }
        return next(ctx)

    case RoleSuperAdmin:
        if user.Role != "super_admin" {
            return nil, fmt.Errorf("requires super admin access")
        }
        return next(ctx)

    case RoleSelfOrAdmin:
        // Check if accessing own resource
        if parent, ok := obj.(*model.User); ok {
            if parent.ID == user.ID || user.Role == "admin" {
                return next(ctx)
            }
        }
        return nil, fmt.Errorf("access denied")
    }

    return nil, fmt.Errorf("unknown role requirement")
}

// Approach 2: Resolver-level with field masking
func (r *userResolver) SSN(ctx context.Context, obj *model.User) (*string, error) {
    currentUser := auth.UserFromContext(ctx)

    // Only allow if:
    // 1. User is viewing their own SSN
    // 2. User is an admin
    if currentUser == nil {
        return nil, nil // Return nil, not error, for unauthorized
    }

    if currentUser.ID != obj.ID && currentUser.Role != "admin" {
        // Return masked version
        if obj.SSN != nil {
            masked := "***-**-" + (*obj.SSN)[7:]
            return &masked, nil
        }
        return nil, nil
    }

    return obj.SSN, nil
}

// Approach 3: Field-level permissions with context
type FieldPermissions struct {
    permissions map[string][]string // field -> required permissions
}

func (fp *FieldPermissions) Check(ctx context.Context, field string) bool {
    user := auth.UserFromContext(ctx)
    if user == nil {
        return false
    }

    required, exists := fp.permissions[field]
    if !exists {
        return true // No restrictions
    }

    for _, perm := range required {
        if !user.HasPermission(perm) {
            return false
        }
    }
    return true
}

// Use as middleware
func FieldAuthMiddleware(fp *FieldPermissions) graphql.FieldMiddleware {
    return func(ctx context.Context, next graphql.Resolver) (any, error) {
        fc := graphql.GetFieldContext(ctx)
        field := fc.Object + "." + fc.Field.Name

        if !fp.Check(ctx, field) {
            return nil, nil // Return nil for unauthorized fields
        }

        return next(ctx)
    }
}
```

**Follow-ups:**
- *Why return `null` instead of an error for forbidden fields?* Errors leak the field's existence and can be probed to map the permission model. `null` plus an optional error in the `errors[]` array is the idiomatic GraphQL pattern.
- *How do directives compose with DataLoaders?* The directive runs per field, but DataLoader batches across fields. Authorize before the loader call. A denied user should not cause a backend fetch at all.
- *When do you outgrow directive-based auth?* When policies are dynamic (attribute-based, e.g., "manager of this user's team"). Move to an external policy engine (OpenFGA, Oso, Cerbos) that the resolver queries per field.

### Question 2: Explain the tradeoffs between GraphQL and REST. When would you choose one over the other?

**What FAANG expects:** Honest decision rubric. REST wins for public APIs, HTTP caching, file transfer, and simple CRUD. GraphQL wins for multi-client diverse-shape data, aggregating microservices, and eliminating N+1 round trips. Bonus for calling out GraphQL's caching weakness (POST bodies need Apollo-style persisted queries or automatic persisted queries + CDN, or a relay cache on the client) and for recognizing that gRPC often beats both when consumers are internal services.

**Answer:** The choice depends on client diversity, caching requirements, and team structure. REST wins when resources map cleanly to HTTP verbs, HTTP-level caching is important, or the API is public-facing with many diverse consumers who expect standard tooling. GraphQL wins when multiple clients need different data shapes from the same backend, when mobile bandwidth matters, or when frontend teams need to iterate without waiting for backend endpoint changes. Many production systems use both: REST for simple CRUD and file handling, GraphQL for complex queries and subscriptions.

```go
/*
REST vs GraphQL Decision Framework:

┌─────────────────────────────────────────────────────────────────────┐
│                    CHOOSE REST WHEN:                                │
├─────────────────────────────────────────────────────────────────────┤
│ 1. Simple CRUD operations                                           │
│    - Resources map cleanly to HTTP methods                          │
│    - Standard REST semantics work well                              │
│                                                                     │
│ 2. HTTP caching is critical                                         │
│    - GET requests are cacheable by default                          │
│    - CDN integration is straightforward                             │
│    - GraphQL POST requests don't cache easily                       │
│                                                                     │
│ 3. Public API with diverse consumers                                │
│    - REST is universally understood                                 │
│    - No GraphQL knowledge required                                  │
│    - Better tooling ecosystem for public APIs                       │
│                                                                     │
│ 4. File uploads/downloads are primary use case                      │
│    - REST handles binary data naturally                             │
│    - GraphQL file uploads require workarounds                       │
│                                                                     │
│ 5. Team has REST expertise but not GraphQL                          │
│    - Learning curve matters for delivery speed                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    CHOOSE GRAPHQL WHEN:                             │
├─────────────────────────────────────────────────────────────────────┤
│ 1. Multiple clients with different data needs                       │
│    - Mobile needs minimal data (bandwidth)                          │
│    - Web needs rich data                                            │
│    - Admin needs everything                                         │
│                                                                     │
│ 2. Complex entity relationships                                     │
│    - Deeply nested data requirements                                │
│    - REST would require many round trips                            │
│                                                                     │
│ 3. Frontend teams want independence                                 │
│    - Schema defines contract                                        │
│    - Frontend can iterate without backend changes                   │
│                                                                     │
│ 4. Aggregating multiple backend services                            │
│    - GraphQL as API gateway                                         │
│    - Single endpoint for multiple services                          │
│                                                                     │
│ 5. Real-time requirements                                           │
│    - Subscriptions built into spec                                  │
│    - Consistent real-time pattern                                   │
│                                                                     │
│ 6. Strong typing is valuable                                        │
│    - Schema is self-documenting                                     │
│    - Type safety across client/server                               │
└─────────────────────────────────────────────────────────────────────┘

HYBRID APPROACH (Common in Production):
*/

// Example: REST for simple operations, GraphQL for complex queries
type APIRouter struct {
    restHandler    http.Handler
    graphqlHandler http.Handler
}

func (r *APIRouter) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    // Use REST for:
    // - File uploads: POST /api/files
    // - Webhooks: POST /api/webhooks/*
    // - Health checks: GET /api/health
    // - Simple CRUD: GET/POST/PUT/DELETE /api/v1/*

    // Use GraphQL for:
    // - Complex queries: POST /graphql
    // - Subscriptions: WS /graphql

    if strings.HasPrefix(req.URL.Path, "/graphql") {
        r.graphqlHandler.ServeHTTP(w, req)
        return
    }

    r.restHandler.ServeHTTP(w, req)
}

/*
Performance Comparison:

REST (Dashboard loading):
1. GET /api/users/me           → 50ms
2. GET /api/orders?limit=10    → 80ms
3. GET /api/products/featured  → 60ms
4. GET /api/notifications      → 40ms
Total: 4 requests, ~230ms (parallel) or ~230ms (sequential)
Data transferred: ~50KB (includes unused fields)

GraphQL (Same dashboard):
1. POST /graphql
   query {
     me { name avatar }
     orders(first: 10) { id status }
     featuredProducts { id name price }
     notifications { message }
   }
Total: 1 request, ~100ms
Data transferred: ~15KB (only requested fields)

TRADEOFFS:
- GraphQL: More complex server implementation
- GraphQL: Harder to cache (POST requests)
- GraphQL: Potential for expensive queries
- REST: More network round trips
- REST: Overfetching/underfetching
- REST: API versioning complexity
*/
```

**Follow-ups:**
- *How do you make GraphQL cacheable at the CDN layer?* Automatic Persisted Queries (APQ): client sends a hash, server maps it to a known query. CDN caches by GET `?queryHash=…&variables=…`. Apollo and urql both support it.
- *Is GraphQL Federation a real alternative to API gateways?* Yes, Apollo Federation / GraphQL Federation v2 lets subgraphs own their types. Trade-off: operational complexity and schema governance. Netflix, Airbnb, GitHub run it at scale.
- *What is the GraphQL N+1 problem's equivalent in REST?* REST forces the N+1 at the network level. GraphQL makes it invisible unless you use DataLoader. REST at least surfaces the problem.

### Question 3: How would you handle real-time updates for thousands of concurrent subscription clients?

**What FAANG expects:** Sticky-session load balancing, a shared bus (Redis Pub/Sub, NATS) for cross-instance fanout, per-topic connection pools, backpressure via bounded channels with drop-or-disconnect policy, and ping/pong health checks to reap stale connections. Bonus for noting that `graphql-ws` is the current subscription protocol (successor to deprecated `subscriptions-transport-ws`), and for calling out that Apollo Router and Hasura both push subscriptions through a shared event bus rather than per-query state.

**Answer:** Scaling subscriptions requires three things: cross-instance message delivery (typically Redis Pub/Sub), per-topic connection pooling with fan-out to subscribers, and backpressure handling for slow consumers. Each GraphQL server instance maintains its own set of WebSocket connections. When a mutation publishes an event, it goes to Redis, which broadcasts to all instances, and each instance fans out to its local subscribers. Stale connections (from network drops or browser crashes) must be detected and cleaned up via periodic health checks, since the WebSocket close frame is not always delivered.

```go
// Scaling GraphQL subscriptions requires careful architecture

package subscription

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "github.com/google/uuid"
    "github.com/redis/go-redis/v9"
)

// SubscriptionManager handles high-scale subscriptions
type SubscriptionManager struct {
    redis       *redis.Client
    connections map[string]*ConnectionPool // topic -> pool
    mu          sync.RWMutex
    metrics     *SubscriptionMetrics
}

// ConnectionPool manages subscribers for a topic
type ConnectionPool struct {
    mu          sync.RWMutex
    subscribers map[string]*Subscriber
    broadcast   chan []byte
    done        chan struct{}
}

type Subscriber struct {
    ID       string
    UserID   string
    Channel  chan []byte
    LastPing time.Time
}

func NewSubscriptionManager(redis *redis.Client) *SubscriptionManager {
    sm := &SubscriptionManager{
        redis:       redis,
        connections: make(map[string]*ConnectionPool),
        metrics:     NewSubscriptionMetrics(),
    }

    // Start health check
    go sm.healthCheck()

    return sm
}

// Subscribe adds a client to a topic
func (sm *SubscriptionManager) Subscribe(
    ctx context.Context,
    topic string,
    subscriber *Subscriber,
) error {
    sm.mu.Lock()
    pool, exists := sm.connections[topic]
    if !exists {
        pool = sm.createPool(topic)
        sm.connections[topic] = pool
    }
    sm.mu.Unlock()

    pool.mu.Lock()
    pool.subscribers[subscriber.ID] = subscriber
    pool.mu.Unlock()

    sm.metrics.SubscribersGauge.Inc()

    return nil
}

// Unsubscribe removes a client
func (sm *SubscriptionManager) Unsubscribe(topic string, subscriberID string) {
    sm.mu.RLock()
    pool, exists := sm.connections[topic]
    sm.mu.RUnlock()

    if !exists {
        return
    }

    pool.mu.Lock()
    if sub, ok := pool.subscribers[subscriberID]; ok {
        close(sub.Channel)
        delete(pool.subscribers, subscriberID)
    }
    pool.mu.Unlock()

    sm.metrics.SubscribersGauge.Dec()
}

// createPool creates a new connection pool with Redis pub/sub
func (sm *SubscriptionManager) createPool(topic string) *ConnectionPool {
    pool := &ConnectionPool{
        subscribers: make(map[string]*Subscriber),
        broadcast:   make(chan []byte, 1000),
        done:        make(chan struct{}),
    }

    // Subscribe to Redis for cross-instance broadcasting
    go func() {
        pubsub := sm.redis.Subscribe(context.Background(), "graphql:"+topic)
        defer pubsub.Close()

        ch := pubsub.Channel()

        for {
            select {
            case msg := <-ch:
                pool.broadcast <- []byte(msg.Payload)
            case <-pool.done:
                return
            }
        }
    }()

    // Fan-out to subscribers
    go func() {
        for {
            select {
            case data := <-pool.broadcast:
                pool.fanOut(data)
            case <-pool.done:
                return
            }
        }
    }()

    return pool
}

// fanOut distributes message to all subscribers efficiently
func (p *ConnectionPool) fanOut(data []byte) {
    p.mu.RLock()
    subscribers := make([]*Subscriber, 0, len(p.subscribers))
    for _, sub := range p.subscribers {
        subscribers = append(subscribers, sub)
    }
    p.mu.RUnlock()

    // Use worker pool for fan-out
    const workers = 10
    jobs := make(chan *Subscriber, len(subscribers))

    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for sub := range jobs {
                select {
                case sub.Channel <- data:
                    // Sent successfully
                default:
                    // Channel full - subscriber too slow
                    // Could disconnect or skip
                }
            }
        }()
    }

    for _, sub := range subscribers {
        jobs <- sub
    }
    close(jobs)
    wg.Wait()
}

// Publish sends a message to all subscribers across instances
func (sm *SubscriptionManager) Publish(ctx context.Context, topic string, data any) error {
    bytes, err := json.Marshal(data)
    if err != nil {
        return err
    }

    // Publish to Redis for cross-instance delivery
    return sm.redis.Publish(ctx, "graphql:"+topic, bytes).Err()
}

// healthCheck removes stale connections
func (sm *SubscriptionManager) healthCheck() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        sm.mu.RLock()
        pools := make([]*ConnectionPool, 0, len(sm.connections))
        for _, pool := range sm.connections {
            pools = append(pools, pool)
        }
        sm.mu.RUnlock()

        for _, pool := range pools {
            pool.mu.Lock()
            for id, sub := range pool.subscribers {
                if time.Since(sub.LastPing) > 2*time.Minute {
                    close(sub.Channel)
                    delete(pool.subscribers, id)
                    sm.metrics.SubscribersGauge.Dec()
                }
            }
            pool.mu.Unlock()
        }
    }
}

// Integration with GraphQL resolver
func (r *subscriptionResolver) OrderStatusChanged(
    ctx context.Context,
    orderID string,
) (<-chan *model.Order, error) {
    user := auth.UserFromContext(ctx)
    if user == nil {
        return nil, fmt.Errorf("unauthorized")
    }

    // Verify access to this order
    order, err := r.OrderService.GetByID(ctx, orderID)
    if err != nil {
        return nil, err
    }
    if order.UserID != user.ID && user.Role != "admin" {
        return nil, fmt.Errorf("access denied")
    }

    // Create subscription
    subscriberID := uuid.New().String()
    ch := make(chan []byte, 10)

    subscriber := &Subscriber{
        ID:       subscriberID,
        UserID:   user.ID,
        Channel:  ch,
        LastPing: time.Now(),
    }

    topic := fmt.Sprintf("order:%s", orderID)
    if err := r.SubManager.Subscribe(ctx, topic, subscriber); err != nil {
        return nil, err
    }

    // Transform byte channel to Order channel
    orderCh := make(chan *model.Order, 10)

    go func() {
        defer close(orderCh)
        defer r.SubManager.Unsubscribe(topic, subscriberID)

        for {
            select {
            case <-ctx.Done():
                return
            case data, ok := <-ch:
                if !ok {
                    return
                }
                var order model.Order
                if err := json.Unmarshal(data, &order); err != nil {
                    continue
                }
                select {
                case orderCh <- &order:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return orderCh, nil
}

/*
Architecture for 100K+ concurrent subscriptions:

┌──────────────────────────────────────────────────────────┐
│                    Load Balancer                         │
│              (WebSocket sticky sessions)                 │
└──────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  GraphQL #1   │  │  GraphQL #2   │  │  GraphQL #3   │
│   (25K subs)  │  │   (25K subs)  │  │   (25K subs)  │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                  ┌─────────────────┐
                  │  Redis Pub/Sub  │
                  │  (Cross-instance│
                  │   broadcast)    │
                  └─────────────────┘

Key considerations:
1. WebSocket sticky sessions for connection persistence
2. Redis Pub/Sub for cross-instance message delivery
3. Connection pooling per topic
4. Health checks to remove stale connections
5. Backpressure handling for slow consumers
6. Metrics for monitoring subscription health
*/
```

**Follow-ups:**
- *What is `graphql-ws` and why does it matter?* The successor subscription protocol to `subscriptions-transport-ws` (abandoned). gqlgen supports both. Always pick `graphql-ws` for new work. Spec also supports multiplexing multiple subscriptions on one connection.
- *Backpressure policy, drop or disconnect?* For observability dashboards, drop silently and emit a metric. For financial tickers, disconnect so the client reconnects clean. Never block the publisher, a single slow client should not stall the fanout.
- *Sticky sessions fail when a pod dies. What happens?* All that pod's subscribers reconnect. Some will land on new pods and re-establish. Some will hit the bus before the new pod has subscribed their topic. Solution: replay the last N events from a bounded buffer (Redis Stream or Kafka) on reconnect.

### Junior -> FAANG: How to Prepare for These Questions Without Memorizing Answers

The three questions in this file cover the three domains that FAANG interviews probe for GraphQL roles: authorization design, protocol selection, and scalability. The questions are not trivia. They test your design reasoning.

For authorization (question 1): before your interview, draw the three approaches (directives, resolver-level, field-permission middleware) on a whiteboard and explain when each is appropriate. The answer is not "use directives always" or "use resolver-level always." The answer depends on whether the authorization rule is role-based and static (directives), involves data from the resolved object (resolver-level), or needs to be managed by a non-engineering team (external policy engine).

For REST vs GraphQL (question 2): prepare a real example from a project you have worked on. "I chose GraphQL because..." or "I would not choose GraphQL here because..." is much stronger than reciting the bullet points from this section.

For subscriptions at scale (question 3): the key concepts to have ready are Redis Pub/Sub for cross-instance fan-out, sticky sessions, buffered channels with non-blocking sends, and context cancellation for cleanup. You do not need to have implemented all of these. You need to be able to reason about why each is necessary.

### Senior @ FAANG: What Bar Raisers Look for Beyond the Correct Answer

Bar raisers at FAANG listen for evidence of production experience and platform thinking, not just correct mechanism descriptions.

For question 1 (field-level authorization): the bar raiser wants to hear you spontaneously mention the tradeoff that directives cannot see resolved field values, which limits them to static role checks. They want to hear you name an external policy engine (OpenFGA, Oso, Cerbos) and describe when you would introduce one (when authorization rules reference data, when audit trails are a compliance requirement, when non-engineers need to manage policies). They want to hear about the authorization audit log as a compliance artifact, not just a debugging tool.

For question 2 (REST vs GraphQL): the bar raiser wants to hear you challenge the question. "It depends" is the beginning of the answer, not an evasion. They want a concrete decision framework: client diversity, caching requirements, team structure, operational maturity. They want to hear the APQ + CDN caching solution for the GraphQL cacheability problem, because this is a real technical limitation that many engineers who "know GraphQL" cannot articulate.

For question 3 (subscriptions at scale): the bar raiser wants to hear about the reconnect and replay problem. Sticky sessions solve per-connection state, but not durability. If a pod dies and clients reconnect to a different pod, they miss events published during the gap. Redis Streams or Kafka solves this. The bar raiser is listening for whether you have actually thought about this failure mode or are reciting the happy path. Naming a specific technology (Redis Streams with consumer groups, Kafka with a compacted topic) and explaining why it fits signals genuine production experience.

---
