## 47.3 Service Communication

### Synchronous vs Asynchronous: the real tradeoff

Synchronous communication (gRPC or HTTP/REST) is simple to reason about - the caller blocks, gets a response, and moves on - but it couples the availability and latency of the caller to every downstream service in its call path. Asynchronous communication (events over Kafka, NATS, or a cloud bus) decouples lifecycles: the producer emits an event and forgets, consumers process at their own pace, and a downstream outage merely delays processing rather than failing the user request. The cost is real complexity: at-least-once delivery means consumers must be idempotent, you need a dead-letter queue strategy for poison messages, and debugging an event-driven flow requires distributed tracing spanning producer and consumer. In 2026 the default guidance is *prefer async for cross-service workflows, use sync only for user-waiting reads and tight internal fan-outs of two or three services*. gRPC (HTTP/2, protobuf, streaming, strict contracts via `.proto`) is preferred over REST for internal service-to-service calls. REST/JSON is preferred for external APIs and browser clients. Kafka remains dominant for ordered, partitioned, high-throughput event streams. NATS (and NATS JetStream) is lighter-weight and a better fit for lower-latency, at-most-once, or request-reply-adjacent patterns.

### Synchronous Communication

Both HTTP and gRPC clients here wrap a circuit breaker that trips after five consecutive failures and enters a half-open probe state after 30 seconds, preventing a slow upstream from cascading into the calling service. The HTTP client propagates the caller's `context.Context` so that a canceled request immediately aborts the outbound call rather than waiting for the full 5-second timeout. The gRPC variant maps `codes.NotFound` to a typed sentinel error so callers handle the case without inspecting raw status objects.

Beyond circuit breakers, production synchronous clients need: (1) **timeouts at every layer** - dial, TLS handshake, request, and end-to-end via `context.WithTimeout`, not only the top-level `http.Client.Timeout`. (2) **retries only for idempotent methods** (GET, PUT, DELETE, or POSTs with an `Idempotency-Key` header), with jittered exponential backoff and a hard retry budget to avoid retry storms. (3) **bulkheading** via a bounded connection pool per upstream so one slow dependency cannot exhaust the caller's goroutine pool.

```go
package client

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    userv1 "github.com/example/user/v1"
)

// HTTP Client with circuit breaker
type UserServiceClient struct {
    baseURL    string
    httpClient *http.Client
    cb         *CircuitBreaker
}

func NewUserServiceClient(baseURL string) *UserServiceClient {
    return &UserServiceClient{
        baseURL: baseURL,
        httpClient: &http.Client{
            Timeout: 5 * time.Second,
        },
        cb: NewCircuitBreaker(CircuitBreakerConfig{
            MaxFailures:     5,
            ResetTimeout:    30 * time.Second,
            HalfOpenMaxReqs: 3,
        }),
    }
}

func (c *UserServiceClient) GetUser(ctx context.Context, id string) (*User, error) {
    return c.cb.Execute(func() (*User, error) {
        url := fmt.Sprintf("%s/api/v1/users/%s", c.baseURL, id)

        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return nil, err
        }

        resp, err := c.httpClient.Do(req)
        if err != nil {
            return nil, err
        }
        defer resp.Body.Close()

        if resp.StatusCode == http.StatusNotFound {
            return nil, ErrUserNotFound
        }

        if resp.StatusCode != http.StatusOK {
            return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
        }

        var user User
        if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
            return nil, err
        }

        return &user, nil
    })
}

// gRPC Client
type UserServiceGRPCClient struct {
    client userv1.UserServiceClient
}

func NewUserServiceGRPCClient(conn *grpc.ClientConn) *UserServiceGRPCClient {
    return &UserServiceGRPCClient{
        client: userv1.NewUserServiceClient(conn),
    }
}

func (c *UserServiceGRPCClient) GetUser(ctx context.Context, id string) (*User, error) {
    resp, err := c.client.GetUser(ctx, &userv1.GetUserRequest{Id: id})
    if err != nil {
        if status.Code(err) == codes.NotFound {
            return nil, ErrUserNotFound
        }
        return nil, err
    }

    return fromProtoUser(resp.GetUser()), nil
}
```

### Asynchronous Communication

Asynchronous messaging using Kafka decouples producers from consumers so that the Order service can publish an event and return immediately, without waiting for Inventory or Shipping to process it. The typed `EventType` constants and versioned event envelope ensure consumers can distinguish message kinds and handle schema evolution without breaking existing subscribers. Graceful shutdown via a `context.Context` cancellation signal ensures in-flight messages are committed before the process exits.

Three correctness rules that separate toy event-driven code from production systems. **(1) Idempotent consumers.** Kafka and NATS JetStream both offer at-least-once delivery, which means your handler *will* see duplicate messages during consumer rebalance, retries, or broker failover. Store an `event.ID` dedupe table or use a unique constraint keyed on the event ID so a second delivery is a no-op. **(2) Transactional outbox.** Never publish an event directly from a handler that also writes the database - a crash between the DB write and the publish loses the event. Instead write the event row into an `outbox` table in the same DB transaction as the business state change, and have a separate relay poll/CDC the outbox and publish to the broker. Debezium is the common CDC implementation. **(3) Schema registry and evolution.** Use a published language (CloudEvents envelope plus a protobuf or Avro payload) and a schema registry so producers cannot ship a breaking change without a review. Consumers should tolerate unknown fields and never hard-fail on schema drift.

```go
package messaging

import (
    "context"
    "encoding/json"
    "errors"
    "log"
    "time"

    "github.com/google/uuid"
    "github.com/segmentio/kafka-go"
)

// Event types
type EventType string

const (
    EventUserCreated   EventType = "user.created"
    EventUserUpdated   EventType = "user.updated"
    EventUserDeleted   EventType = "user.deleted"
    EventOrderCreated  EventType = "order.created"
    EventOrderShipped  EventType = "order.shipped"
    EventPaymentReceived EventType = "payment.received"
)

// Event envelope
type Event struct {
    ID        string          `json:"id"`
    Type      EventType       `json:"type"`
    Source    string          `json:"source"`
    Timestamp time.Time       `json:"timestamp"`
    Data      json.RawMessage `json:"data"`
}

// Event publisher
type EventPublisher struct {
    writer *kafka.Writer
    source string
}

func NewEventPublisher(brokers []string, source string) *EventPublisher {
    return &EventPublisher{
        writer: &kafka.Writer{
            Addr:     kafka.TCP(brokers...),
            Balancer: &kafka.LeastBytes{},
        },
        source: source,
    }
}

func (p *EventPublisher) Publish(ctx context.Context, eventType EventType, topic string, key string, data any) error {
    dataBytes, err := json.Marshal(data)
    if err != nil {
        return err
    }

    event := Event{
        ID:        uuid.New().String(),
        Type:      eventType,
        Source:    p.source,
        Timestamp: time.Now(),
        Data:      dataBytes,
    }

    eventBytes, err := json.Marshal(event)
    if err != nil {
        return err
    }

    return p.writer.WriteMessages(ctx, kafka.Message{
        Topic: topic,
        Key:   []byte(key),
        Value: eventBytes,
    })
}

// Event consumer
type EventConsumer struct {
    reader   *kafka.Reader
    handlers map[EventType]EventHandler
}

type EventHandler func(ctx context.Context, event Event) error

func NewEventConsumer(brokers []string, groupID string, topics []string) *EventConsumer {
    return &EventConsumer{
        reader: kafka.NewReader(kafka.ReaderConfig{
            Brokers:     brokers,
            GroupID:     groupID,
            GroupTopics: topics, // kafka-go uses GroupTopics for multi-topic group consumption
        }),
        handlers: make(map[EventType]EventHandler),
    }
}

func (c *EventConsumer) RegisterHandler(eventType EventType, handler EventHandler) {
    c.handlers[eventType] = handler
}

func (c *EventConsumer) Start(ctx context.Context) error {
    for {
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            if errors.Is(err, context.Canceled) {
                return nil
            }
            return err
        }

        var event Event
        if err := json.Unmarshal(msg.Value, &event); err != nil {
            log.Printf("failed to unmarshal event: %v", err)
            continue
        }

        handler, ok := c.handlers[event.Type]
        if !ok {
            log.Printf("no handler for event type: %s", event.Type)
            c.reader.CommitMessages(ctx, msg)
            continue
        }

        if err := handler(ctx, event); err != nil {
            log.Printf("handler error for %s: %v", event.Type, err)
            // Don't commit - will be retried
            continue
        }

        if err := c.reader.CommitMessages(ctx, msg); err != nil {
            log.Printf("failed to commit: %v", err)
        }
    }
}
```

### Junior → FAANG: Sync vs Async as the Core Communication Interview Question

The sync-vs-async decision is the most commonly tested communication concept at entry-level system design interviews. The framing to internalize is: sync couples the caller's latency to the callee's latency, and async decouples them.

Worked example: a user places an order. The checkout page needs an immediate response confirming the order was accepted. Inventory reservation, payment processing, and email confirmation do not need to happen before that response. The correct design: sync validation (is the request well-formed?), sync write to the order database (immediate response), then async events for everything else. This is the pattern in the code above.

Common junior mistakes in interviews:
- Proposing sync calls for every operation because it "seems simpler." Interviewers flag this as not understanding failure coupling.
- Proposing async for everything, including user-facing reads. If the user asks "show me my order list," they need the data now, not eventually.
- Not mentioning idempotency when proposing Kafka consumers. Any interviewer with production experience will ask "what happens when the consumer re-processes a message?" If you have not thought about idempotency, the rest of your async design is unstable.

gRPC vs REST for internal calls: the interview answer is gRPC wins for internal service-to-service because of HTTP/2 multiplexing, protobuf serialization (smaller payload, faster encode/decode), generated client stubs (no hand-written HTTP client), and streaming support. REST wins for external APIs and browser clients because tooling support and human readability matter more than raw performance in those contexts.

Circuit breaker three-state explanation: practice saying this from memory. Closed: requests flow normally, failures are counted. Open: a failure threshold was breached, all requests fail fast without calling the downstream. Half-open: after a cooldown period, one request is allowed through as a probe. If it succeeds, the breaker closes. If it fails, the breaker reopens. This description in 30 seconds signals that you have actually used circuit breakers.

### Senior @ FAANG: Communication Platform Governance and Event Schema Management

At staff level, service communication is a platform problem, not a per-service problem. The decisions made here determine the blast radius of every future incident and the velocity of every future team.

**The transactional outbox as a platform primitive.** The outbox pattern should not be reimplemented by every team. The platform team provides a shared library or sidecar that: wraps a service's database transaction to atomically insert into an `outbox` table, runs a background relay (or integrates Debezium CDC) to publish outbox rows to the broker, handles retry with exponential backoff and dead-letter routing, and exposes metrics (outbox lag, publish errors, dead-letter count). Services import the library rather than re-implementing the correctness invariants. The platform team owns the library's correctness. The application team owns the event payload schema.

**Schema registry governance.** In 2026 the standard is: all Kafka event schemas are registered in Confluent Schema Registry or AWS Glue Schema Registry before the topic is used in production. Compatibility mode is set to `FULL_TRANSITIVE` (new schemas must be forward and backward compatible with all previously registered versions). The CI pipeline for any service that publishes events runs a schema compatibility check as a pre-merge gate. Producers that bypass the registry are blocked at the broker level via a custom Kafka authorizer or a schema validation interceptor. This prevents the silent schema drift that is the leading cause of cross-service data corruption incidents.

**Choreography vs orchestration at scale.** The staff-level judgment: choreography is the right default for simple, linear event flows between two or three services. It favors loose coupling and each service staying ignorant of the overall workflow. Orchestration (Temporal, AWS Step Functions, or a hand-rolled saga state machine) becomes necessary when: the workflow has branching logic that requires understanding the full state, the workflow runs for minutes to days (long-running processes need durable state), you need an auditable history of every step for compliance, or you have more than four or five compensating transactions to manage. The mistake senior engineers make is using choreography for complex workflows because "it's more decoupled," then spending months debugging workflow state from scattered event logs.

**Retry storm prevention at the platform level.** When a downstream service recovers from an outage, the collective retry budget of all upstream services fires simultaneously, potentially re-overloading the recovering service. Platform-level mitigations: jittered exponential backoff is enforced by the shared HTTP/gRPC client library (not left to each team's discretion), the circuit breaker's half-open probe rate is configurable and default-low, and the API gateway enforces a global retry budget per upstream service per time window. Staff engineers design these defaults before services are written, not as a remediation after the first retry storm incident.

---
