## Part 6: Analytics Event Ingestion

Analytics events are ingested via a fire-and-forget HTTP endpoint that writes events to a Kafka topic, decoupling ingestion throughput from downstream processing latency. The ingestion handler validates only the event schema (required fields, type constraints) and enqueues immediately rather than persisting to the database synchronously, keeping the median response time under 5ms even at high event rates. Events carry a client-generated idempotency key derived from device ID and a monotonic sequence number, allowing the consumer to deduplicate retried events before writing to the analytics warehouse.

```go
package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// MobileEvent represents a client-side analytics event
type MobileEvent struct {
	EventID     string                 `json:"event_id"`
	EventType   string                 `json:"event_type"` // "screen_view", "click", "purchase", etc.
	UserID      string                 `json:"user_id,omitempty"`
	SessionID   string                 `json:"session_id"`
	DeviceID    string                 `json:"device_id"`
	Platform    string                 `json:"platform"`
	AppVersion  string                 `json:"app_version"`
	OSVersion   string                 `json:"os_version"`
	Properties  map[string]any `json:"properties"`
	Timestamp   time.Time              `json:"timestamp"`
	ReceivedAt  time.Time              `json:"received_at,omitempty"` // set by server
}

// BatchRequest is sent by mobile clients (batch to reduce network calls)
type BatchRequest struct {
	Events []MobileEvent `json:"events"`
}

// BatchResponse is the server's response
type BatchResponse struct {
	Received  int      `json:"received"`
	Failed    int      `json:"failed"`
	FailedIDs []string `json:"failed_ids,omitempty"`
}

// EventProcessor validates, enriches, and stores events
type EventProcessor struct {
	validator  EventValidator
	enricher   EventEnricher
	pipeline   EventPipeline
	batchSize  int
	mu         sync.Mutex
	buffer     []MobileEvent
	flushTimer *time.Timer
}

type EventValidator interface {
	Validate(event MobileEvent) error
}

type EventEnricher interface {
	Enrich(event *MobileEvent, r *http.Request)
}

type EventPipeline interface {
	SendBatch(ctx context.Context, events []MobileEvent) error
}

func NewEventProcessor(validator EventValidator, enricher EventEnricher, pipeline EventPipeline) *EventProcessor {
	return &EventProcessor{
		validator: validator,
		enricher:  enricher,
		pipeline:  pipeline,
		batchSize: 1000,
		buffer:    make([]MobileEvent, 0, 1000),
	}
}

// HandleBatch processes a batch of events from a mobile client
func (p *EventProcessor) HandleBatch(w http.ResponseWriter, r *http.Request) {
	var req BatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if len(req.Events) == 0 {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(BatchResponse{})
		return
	}

	// Limit batch size from clients
	if len(req.Events) > 500 {
		req.Events = req.Events[:500]
	}

	serverTime := time.Now().UTC()
	var validEvents []MobileEvent
	var failedIDs []string

	for i := range req.Events {
		event := &req.Events[i]

		// Server-side enrichment
		event.ReceivedAt = serverTime
		p.enricher.Enrich(event, r)

		// Validation
		if err := p.validator.Validate(*event); err != nil {
			failedIDs = append(failedIDs, event.EventID)
			continue
		}

		validEvents = append(validEvents, *event)
	}

	// Buffer events for batch processing
	p.mu.Lock()
	p.buffer = append(p.buffer, validEvents...)
	shouldFlush := len(p.buffer) >= p.batchSize
	p.mu.Unlock()

	if shouldFlush {
		go p.flush()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(BatchResponse{
		Received:  len(validEvents),
		Failed:    len(failedIDs),
		FailedIDs: failedIDs,
	})
}

func (p *EventProcessor) flush() {
	p.mu.Lock()
	if len(p.buffer) == 0 {
		p.mu.Unlock()
		return
	}
	batch := make([]MobileEvent, len(p.buffer))
	copy(batch, p.buffer)
	p.buffer = p.buffer[:0]
	p.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := p.pipeline.SendBatch(ctx, batch); err != nil {
		fmt.Printf("flush error: %v\n", err)
	}
}

// DefaultEnricher adds server-side metadata to events
type DefaultEnricher struct{}

func (e *DefaultEnricher) Enrich(event *MobileEvent, r *http.Request) {
	if event.ReceivedAt.IsZero() {
		event.ReceivedAt = time.Now().UTC()
	}

	if event.Properties == nil {
		event.Properties = make(map[string]any)
	}

	// Add server-side properties
	event.Properties["server_received_at"] = event.ReceivedAt
	event.Properties["client_ip"] = getClientIP(r)
	event.Properties["user_agent"] = r.UserAgent()
}

func getClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.Split(xff, ",")[0]
	}
	return r.RemoteAddr
}
```

### Junior → FAANG: Analytics Is A Data-Engineering Problem In A Backend Disguise

An analytics endpoint looks like a simple POST handler. It is not. It is the mouth of a data pipeline that will feed business decisions, product experimentation, regulatory reporting, and sometimes user-facing features like "your year in review." Every event you accept is a commitment. The handler above is the thinnest possible first layer. The senior mental model is: the handler's job is to never lose an event, never block the user, and never accept malformed data that corrupts downstream. Everything else is the pipeline's problem.

Worked example of the PII mistake. A junior engineer adds a `search_query` event that captures what users typed in the search box. Six months later a regulator asks for a GDPR right-to-delete run on a user, and you discover that the search queries contain the user's email addresses, phone numbers, and one unfortunate case of a credit card number. Now you must scrub not just the user's row in the users table but every event they ever emitted, across the Kafka topic (already consumed), the object store (Parquet files, immutable), and the warehouse (partitioned by day, can be rewritten). The correct move was to scrub PII at ingest: the handler should have stripped or hashed anything that matched PII patterns before the event hit Kafka. This is the single most expensive mistake to correct after the fact in a data pipeline.

Interview framing. If asked "design mobile analytics ingestion," the senior-track answer names the four layers: ingest API (Go, thin, validate schema, write to queue), queue (Kafka or equivalent, bounded retention, compacted or time-based), sink (stream processor that writes to cold storage and warehouse), and warehouse (BigQuery, Snowflake, ClickHouse, or an Iceberg-on-object-store lakehouse). It also names the cross-cutting concerns: schema registry, PII scrubbing at ingest, idempotency with client-generated event IDs, at-least-once delivery with downstream deduplication, and GDPR right-to-delete as a first-class operation, not an afterthought.

First-job context. Your first analytics task is often "add a new event type." Do not just add it. Add it through the schema registry: register the event name, the required properties, the PII classification for each property, the retention policy, and the owner team. Submit the PR with the registry entry before the client-side code. This discipline, instilled at the junior level, is what separates a sustainable analytics pipeline from the tire fire most companies accumulate over five years.

### Senior @ FAANG: Event Ingest At Billions-Per-Day Scale And The Privacy-Regulated Era

The handler shown is the shape of an ingest API. The staff-level problem is scaling it to billions of events per day, across dozens of event types, with schemas that evolve weekly, under a regulatory regime that includes GDPR, CCPA, iOS ATT, and the EU Digital Markets Act. Every one of those constraints shapes the architecture.

Scale first. At a billion events per day the ingest API is running on hundreds of pods behind a global load balancer. The queue is a Kafka cluster with hundreds of partitions, sized for the peak-hour traffic plus headroom for the recovery-from-outage backfill. The partitioning key is usually `device_id` hashed, so events for a single device stay ordered within a partition, which matters for session reconstruction downstream. Events are serialized with a schema format (Protobuf, Avro, or Thrift) registered in a schema registry (Confluent Schema Registry, AWS Glue Schema Registry, or an internal equivalent). JSON at this scale is a tax you cannot afford: the schema registry plus binary format gets you 5-10x ingest cost savings and forward/backward compatibility guarantees.

The warehouse tier is where the 2024-2026 shift is most visible. The old answer was "dump everything into BigQuery or Snowflake." The emerging answer is an open lakehouse: Parquet files on object storage (S3, GCS) organized by Apache Iceberg or Delta Lake table format, queried by multiple engines (Trino, Spark, DuckDB, Snowflake external tables, BigQuery external tables). The advantages for analytics at scale: storage cost is a fraction of warehouse-native storage, you avoid vendor lock-in on the data itself, you can process the same data from batch and stream engines without duplication, and you can implement right-to-delete as a table-format operation (Iceberg v3 supports row-level deletes) rather than a full rewrite. The staff-level ADR names the choice between warehouse-native (lower ops cost, higher storage cost, vendor lock-in) and lakehouse (higher ops cost, lower storage cost, vendor choice) and justifies it with numbers specific to your scale.

PII scrubbing at ingest is the architectural control that must exist. The handler sees the event first, and it is the cheapest place to strip or hash PII before the event fans out to multiple sinks. Patterns to apply: drop fields flagged as `pii: always_drop` in the schema registry, hash fields flagged as `pii: hash_with_user_salt` (so analytics can still count distinct users without identifying them), and tokenize fields flagged as `pii: tokenize` (replace with a stable pseudonym that can be reversed only by a secure service with audit logging). Implementing this requires the schema registry to be authoritative and the ingest API to reject events whose schema is not registered. The anti-pattern is relying on downstream ETL jobs to scrub, because by the time the event is in Parquet files it has already been copied to logs, metrics, and potentially replicated cross-region, and you can no longer guarantee scrubbing.

GDPR right-to-delete on event pipelines is a staff-level design problem. When a user exercises their right, you must delete all events attributable to them. Three patterns work. First, store a user_id on every event and delete by user_id (straightforward, requires every event type to have a user_id, which is not always true for anonymous pre-login events). Second, store a device_id or session_id mapping to user_id in a linkage table and delete both (handles anonymous events but requires the linkage table to be durable across the retention window). Third, encrypt PII fields per user with a per-user key stored in a separate store and perform crypto-shredding (delete the key, the ciphertext is unrecoverable). Crypto-shredding is the elegant solution for immutable storage like Parquet files but requires getting the key management right, which is its own project. Whichever approach you pick, the SLA for the deletion must be documented (commonly 30 days from request), the audit trail must be complete, and the deletion must propagate to every downstream consumer that copied the data.

iOS ATT and the DMA compliance reality in 2026. Apple's App Tracking Transparency forced a permission prompt on any cross-app tracking identifier starting iOS 14.5 and has severely dampened IDFA availability. Mature mobile analytics in 2026 assume IDFA is mostly unavailable and design around first-party identifiers with user consent captured in-app. The DMA, enforced in the EU since 2024, adds requirements around data portability, interoperability for gatekeepers, and restrictions on combining data across services without explicit consent. The staff-level ADR names which event categories require which consent state, how consent is captured, propagated to the ingest pipeline (as a field on every event), and enforced at the processor tier (events without the required consent state are dropped or routed to a restricted sink). The anti-pattern is collecting everything and filtering at query time, because a breach or subpoena exposes the raw collection regardless of how your queries filter it.

Schema evolution governance at staff level is non-negotiable. The registry must enforce compatibility (forward, backward, full) appropriate to each event type, must review PR-style additions with a human approval step, and must track usage per field so deprecations can be driven by data, not by the event-definer's guess. A pipeline without schema governance accumulates fields faster than it removes them, and within two years you have a data model that nobody understands and that nobody can safely change. The governance discipline is boring. It is also what separates a pipeline that survives three years of product evolution from one that is replaced every 18 months.

Operational concerns at this scale include thundering-herd on app launch (all users receive a push at 9am local time, their apps launch, and flush their analytics buffer at the same time, hitting the ingest API with a spike that dwarfs average load), time-skew on client clocks (events arriving with timestamps far in the past or future, often from devices that restored from backup or were offline for weeks), and adversarial clients (malformed events, forged user IDs, amplification attacks). The ingest API must be hardened against each: request smoothing via jitter and client-side backoff, server-side timestamp bounds with rejection or correction, and rate limiting per device_id with strict auth gating on any event that claims a user_id. Each of these is a staff-level design element that the handler above does not yet implement and that a production deployment must add.

---
