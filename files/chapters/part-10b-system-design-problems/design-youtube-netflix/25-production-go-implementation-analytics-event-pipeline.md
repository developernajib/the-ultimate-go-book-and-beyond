## Production Go Implementation: Analytics Event Pipeline

Every user action, watching, liking, sharing, searching, clicking a thumbnail, produces an analytics event feeding several downstream systems. This pipeline publishes to Kafka topics keyed by user ID, so all events from one user land on one partition and are consumed in order. Consumers include the view counter, the watch history writer, the recommendation trainer, real-time dashboards, and ad impression tracking.

Two things to get right here, one of them a genuine trap.

**The event ID must actually be unique, and it must come from the caller.** A stubbed `generateEventID` returning `""` is not a placeholder, it is a live outage waiting for the first consumer that deduplicates. Every event carries the same ID, that consumer treats a million events as one, and it discards the rest without a single error anywhere. Delivery succeeds. Kafka is healthy. Lag is zero. The data is simply gone. Beyond being non-empty, the ID should be supplied by the producer of the action rather than minted inside `Ingest`, because at-least-once delivery means retries, and a retry that mints a fresh ID is a duplicate the deduplicator cannot catch. The ID is what makes a retry idempotent, so generating it at the point of retry defeats its only purpose.

**Events carry personal data.** `ClientIP` and `UserAgent` are personal data under GDPR and similar regimes, and Kafka topics are usually retained for days and fanned out to every team's consumer. Deletion requests then mean rewriting a log designed to be immutable. Decide deliberately: truncate the IP at ingest if you only need coarse geography, keep the raw value only where you can justify it, and set retention accordingly. This is much cheaper to get right on day one than to retrofit onto six consumers and a data lake.

```go
package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"time"

	"github.com/google/uuid"
)

// AnalyticsEvent represents any trackable user action
type AnalyticsEvent struct {
	// EventID makes the event idempotent under Kafka's at-least-once delivery.
	// The caller sets it once, at the moment the action happened, and reuses it
	// on every retry of that same action. Minting it inside Ingest would give
	// each retry a fresh identity and make deduplication impossible.
	EventID   string         `json:"event_id"`
	EventType string         `json:"event_type"` // "view", "like", "share", "search", "click"
	UserID    string         `json:"user_id"`
	VideoID   string         `json:"video_id,omitempty"`
	SessionID string         `json:"session_id"`
	Metadata  map[string]any `json:"metadata"`
	Timestamp time.Time      `json:"timestamp"`
	// ClientIP is truncated at ingest: /24 for IPv4, /48 for IPv6. That is
	// enough for geography and abuse heuristics and is far less of a liability
	// than a full address replicated across every consumer for a 7-day
	// retention window.
	ClientIP  string `json:"client_ip"`
	UserAgent string `json:"user_agent"`
	Country   string `json:"country"`
	Device    string `json:"device"` // "mobile", "desktop", "tv", "tablet"
}

// AnalyticsPipeline ingests events to Kafka for downstream processing
type AnalyticsPipeline struct {
	producer KafkaProducer
	topics   map[string]string // event_type -> topic name
}

func NewAnalyticsPipeline(producer KafkaProducer) *AnalyticsPipeline {
	return &AnalyticsPipeline{
		producer: producer,
		topics: map[string]string{
			"view":   "analytics-views",
			"like":   "analytics-engagements",
			"share":  "analytics-engagements",
			"search": "analytics-search",
			"click":  "analytics-clicks",
		},
	}
}

// NewEventID mints an identifier for a user action, at the point the action
// occurs. Retries of that action must reuse the value, never call this again.
func NewEventID() string { return uuid.NewString() }

// Ingest publishes an analytics event to the appropriate Kafka topic.
func (p *AnalyticsPipeline) Ingest(ctx context.Context, event AnalyticsEvent) error {
	if event.EventID == "" {
		// Refuse rather than paper over it. An event with no ID cannot be
		// deduplicated, and silently assigning one here would hide the caller's
		// bug until a retry storm double-counted a viral video.
		return fmt.Errorf("event_id is required for %s events", event.EventType)
	}
	if event.UserID == "" {
		// UserID is the partition key. Empty means every anonymous event lands
		// on one partition, and that partition becomes the bottleneck for the
		// entire topic.
		return fmt.Errorf("user_id is required as the partition key")
	}

	topic, ok := p.topics[event.EventType]
	if !ok {
		topic = "analytics-other"
	}

	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}
	event.ClientIP = truncateIP(event.ClientIP)

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Partition by user_id for per-user ordering guarantees.
	return p.producer.Publish(ctx, topic, event.UserID, data)
}

// truncateIP drops the host portion so the stored value identifies a network
// rather than a person. Returns "" for anything unparseable: a malformed
// address is not worth storing and may be an injection attempt.
func truncateIP(s string) string {
	if s == "" {
		return ""
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.Mask(net.CIDRMask(24, 32)).String()
	}
	return ip.Mask(net.CIDRMask(48, 128)).String()
}

// Downstream consumers:
// 1. View counter (30-second flush to MySQL), dedupes on event_id
// 2. Watch history writer (Cassandra)
// 3. Recommendation model trainer (batch, hourly)
// 4. Real-time dashboard (Flink -> ClickHouse)
// 5. Ad impression tracker
// 6. A/B test event logger
//
// Every one of these is at-least-once. Each must be idempotent on event_id,
// which is exactly why that field is the caller's responsibility and why an
// empty one is rejected above rather than tolerated.
```

---
