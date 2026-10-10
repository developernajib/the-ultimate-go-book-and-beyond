## 42D.4 Webhook Infrastructure at Scale

### Queue-Backed Delivery Architecture

Queue-backed delivery decouples the event producer from delivery attempts, allowing retries and fan-out to proceed independently of the original request. The architecture diagram below shows how events flow from the application through the queue to delivery workers and monitoring.

```
Business Event (order.created)
        ↓
   Events Table  ←── stored in same DB transaction
        ↓
  Webhook Router  ←── which subscriptions listen to this event?
        ↓
  Delivery Records  ←── one per subscribed endpoint
        ↓
  Delivery Worker Pool (20 concurrent workers)
        ↓
  Customer Endpoint (POST https://customer.com/hooks)
  ↙               ↘
Success           Failure
  ↓                 ↓
Mark done      Schedule retry (exponential backoff)
                    ↓
            After N attempts → Dead Letter Queue
```

```go
// WebhookService orchestrates subscriptions and event routing
type WebhookService struct {
	db         *sql.DB
	sender     *WebhookSender
	policy     RetryPolicy
	logger     *slog.Logger
	mu         sync.RWMutex
	subsByType map[string][]*WebhookSubscription // event type → subscriptions
}

func NewWebhookService(db *sql.DB, workers int) *WebhookService {
	return &WebhookService{
		db:         db,
		policy:     DefaultRetryPolicy(),
		logger:     slog.Default(),
		subsByType: make(map[string][]*WebhookSubscription),
	}
}

// Emit routes an event to all subscribed endpoints atomically
func (s *WebhookService) Emit(ctx context.Context, eventType string, data any) error {
	s.mu.RLock()
	subs := s.subsByType[eventType]
	s.mu.RUnlock()

	if len(subs) == 0 {
		return nil
	}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshaling event data: %w", err)
	}

	payload := WebhookPayload{
		ID:         newID(),
		Type:       eventType,
		CreatedAt:  time.Now().UTC(),
		APIVersion: "2026-01-01",
		Data:       dataBytes,
	}

	// Store event + delivery records in one transaction (outbox pattern)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	if err := s.storeEvent(ctx, tx, payload); err != nil {
		return fmt.Errorf("storing event: %w", err)
	}

	for _, sub := range subs {
		delivery := &WebhookDelivery{
			ID:        newID(),
			WebhookID: sub.ID,
			EventID:   payload.ID,
			Endpoint:  sub.Endpoint,
			Status:    "pending",
		}
		if err := s.storeDelivery(ctx, tx, delivery); err != nil {
			return fmt.Errorf("storing delivery for sub %s: %w", sub.ID, err)
		}
	}

	return tx.Commit()
}

// DB schema for webhook infrastructure
const webhookSchema = `
CREATE TABLE webhook_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL,
    endpoint    TEXT NOT NULL,
    events      JSONB NOT NULL DEFAULT '[]',
    signing_key BYTEA NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_events (
    id          UUID PRIMARY KEY,
    type        TEXT NOT NULL,
    api_version TEXT NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id),
    event_id        UUID NOT NULL REFERENCES webhook_events(id),
    endpoint        TEXT NOT NULL,
    attempt         INT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    status_code     INT,
    error_message   TEXT,
    next_retry_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_pending ON webhook_deliveries (status, next_retry_at)
    WHERE status IN ('pending', 'retrying');

CREATE TABLE webhook_dead_letters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id     UUID NOT NULL,
    subscription_id UUID NOT NULL,
    event_id        UUID NOT NULL,
    endpoint        TEXT NOT NULL,
    final_error     TEXT NOT NULL,
    attempts        INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
```

---

### Junior → FAANG: Understanding Webhook Delivery Guarantees

The hardest part of webhooks for early-career engineers is accepting that delivery is inherently unreliable and building the system around that fact rather than pretending the problem away.

**Why the outbox pattern exists.** Without it, an event can be lost between the point your business logic commits and the moment you try to enqueue the delivery job. The outbox writes the event and delivery records in the same database transaction as the business operation, so either both happen or neither does. No events are silently dropped.

**Exponential backoff is not optional.** A customer's endpoint going down for 30 minutes should not cause 30 minutes of 1-second hammering. Start at 30 seconds, double each attempt, cap at a few hours, and add jitter so a fleet of retrying workers does not synchronize into a thundering herd. The formula `delay = min(cap, base * 2^attempt) + random(0, jitter)` covers 95% of cases.

**Dead letter queues are observability surfaces.** A delivery reaching the DLQ is an alert that deserves a Slack notification or PagerDuty page, not silent disposal. Customers who subscribed to your webhook assume delivery. The DLQ is where you find out who to contact.

**Interview entry point.** If asked "how would you build a webhook system," cover: transactional outbox, delivery workers with bounded concurrency, exponential backoff with jitter, dead letter handling, and HMAC signature verification. These five points distinguish a production-oriented answer from "just POST to their URL."

**First-job habits.** Always index `(status, next_retry_at)` on the deliveries table with a partial index filtered to pending/retrying rows. Full-table scans on this table at scale will become your on-call nightmare. Use `SELECT ... FOR UPDATE SKIP LOCKED` when multiple worker instances poll the same table to avoid duplicate delivery.

---

### Senior @ FAANG: Webhook Infrastructure as a Platform Capability

At FAANG scale, webhook delivery is not a feature bolted onto a service. It is a platform capability owned by a dedicated team, versioned independently, and operated against SLOs that external customers hold you accountable to.

**Architectural Decision Record: single-table outbox vs. dedicated message bus.**
Teams frequently debate whether the outbox should drain into an internal Kafka topic before fanning out to delivery workers. The arguments for Kafka: delivery workers become stateless consumers that auto-scale with consumer group lag, replay is trivial (seek to an offset), and you decouple delivery throughput from the OLTP database. The arguments against: Kafka is another operational dependency, the outbox-to-Kafka relay is itself a source of ordering and duplication complexity, and for most workloads below 50k events/minute the database-backed outbox with `SKIP LOCKED` is simpler and fast enough. Make this decision based on measured throughput, not anticipated throughput.

**Delivery rate limiting at the subscription level.** A single high-volume customer subscription should not starve other customers' deliveries. At scale you need per-subscription rate limiting in the delivery worker: track tokens per endpoint URL and delay workers that exceed the configured ceiling. Stripe uses per-customer delivery buckets. Without this, one misbehaving integration degrades the product for everyone.

**Adaptive retry policies.** A static exponential backoff does not distinguish between a temporary 503 and a permanent DNS resolution failure. Senior engineers implement adaptive policies: if an endpoint has not returned 2xx in 72 hours, pause deliveries and alert the customer via email (separate from the delivery path) rather than burning retry budget indefinitely. The `webhook_subscriptions` table should carry a `paused_at` column and a `pause_reason` enum.

**Observability at L6/L7 bar.** The delivery worker must emit structured metrics for: delivery latency per endpoint domain, retry attempt distribution (p50/p95/p99), DLQ ingestion rate by customer, and in-flight delivery count per worker. You need dashboards that let you answer "which customers are experiencing degraded delivery right now" without writing ad-hoc SQL.

**Multi-region delivery topology.** When your platform serves customers across regions, deliver from the region closest to the customer's endpoint to minimize latency and avoid cross-region egress costs. This requires a subscription to carry a preferred delivery region and delivery workers to be deployed per-region, pulling only their regional slice of pending records. The outbox and delivery tables can be replicated, but write ownership must stay in the origin region to avoid distributed transaction complexity.

**Staff-level concern: tenant isolation in the delivery layer.** If a malicious or misconfigured customer registers a webhook endpoint pointing at an internal RFC-1918 address or a cloud metadata service (169.254.169.254), your delivery worker becomes a server-side request forgery (SSRF) vector. Implement an IP allowlist/blocklist that resolves the endpoint hostname before each delivery attempt and refuses delivery to private, loopback, and link-local ranges. This check belongs in the HTTP client dialer, not in the registration validation, because DNS rebinding can change the resolved IP between registration and delivery time.
