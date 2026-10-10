## 60.6 Analytics and Click Tracking

Click tracking must be asynchronous so it never adds latency to the redirect response. The user should receive their `302` redirect in under a millisecond even when analytics processing takes longer. The tracker extracts click metadata (IP, user agent, referer, timestamp) from the HTTP request and publishes it to a Kafka topic, where downstream consumers can aggregate it into per-URL statistics at their own pace. IP geolocation is performed at consumption time rather than at request time to avoid blocking the redirect path on an external API call.

```go
// analytics/tracker.go
package analytics

import (
    "context"
    "encoding/json"
    "log"
    "net"
    "net/http"
    "strings"
    "time"

    "github.com/oschwald/geoip2-golang"
    "github.com/segmentio/kafka-go"
)

// ClickEvent represents a URL click event
type ClickEvent struct {
    ShortID   string    `json:"short_id"`
    Timestamp time.Time `json:"timestamp"`
    IPAddress string    `json:"ip_address"`
    UserAgent string    `json:"user_agent"`
    Referer   string    `json:"referer"`
    Country   string    `json:"country"`
    City      string    `json:"city"`
}

// ClickTracker tracks URL clicks
type ClickTracker struct {
    writer   *kafka.Writer
    geoDB    *geoip2.Reader
    eventsCh chan ClickEvent
}

// NewClickTracker creates a new click tracker
func NewClickTracker(kafkaBrokers []string, topic string, geoDBPath string) (*ClickTracker, error) {
    writer := &kafka.Writer{
        Addr:         kafka.TCP(kafkaBrokers...),
        Topic:        topic,
        Balancer:     &kafka.LeastBytes{},
        BatchSize:    100,
        BatchTimeout: 10 * time.Millisecond,
        RequiredAcks: kafka.RequireOne,
    }

    var geoDB *geoip2.Reader
    if geoDBPath != "" {
        var err error
        geoDB, err = geoip2.Open(geoDBPath)
        if err != nil {
            return nil, err
        }
    }

    tracker := &ClickTracker{
        writer:   writer,
        geoDB:    geoDB,
        eventsCh: make(chan ClickEvent, 10000),
    }

    // Start background processor
    go tracker.processEvents()

    return tracker, nil
}

// Track records a click event
func (t *ClickTracker) Track(ctx context.Context, shortID string, r *http.Request) {
    event := ClickEvent{
        ShortID:   shortID,
        Timestamp: time.Now().UTC(),
        IPAddress: extractIP(r),
        UserAgent: r.UserAgent(),
        Referer:   r.Referer(),
    }

    // Add geo information
    if t.geoDB != nil && event.IPAddress != "" {
        ip := net.ParseIP(event.IPAddress)
        if ip != nil {
            record, err := t.geoDB.City(ip)
            if err == nil {
                event.Country = record.Country.IsoCode
                event.City = record.City.Names["en"]
            }
        }
    }

    // Non-blocking send to channel
    select {
    case t.eventsCh <- event:
    default:
        // Channel full, log and drop
        log.Printf("Click tracker channel full, dropping event for %s", shortID)
    }
}

// processEvents batches and sends events to Kafka
func (t *ClickTracker) processEvents() {
    batch := make([]kafka.Message, 0, 100)
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case event, ok := <-t.eventsCh:
            if !ok {
                // Close() closed the channel: flush the remainder and
                // exit. Without the ok check, a closed channel yields
                // zero-value events in a tight loop forever.
                if len(batch) > 0 {
                    t.flush(batch)
                }
                return
            }

            data, err := json.Marshal(event)
            if err != nil {
                continue
            }

            batch = append(batch, kafka.Message{
                Key:   []byte(event.ShortID),
                Value: data,
            })

            if len(batch) >= 100 {
                t.flush(batch)
                batch = batch[:0]
            }

        case <-ticker.C:
            if len(batch) > 0 {
                t.flush(batch)
                batch = batch[:0]
            }
        }
    }
}

func (t *ClickTracker) flush(batch []kafka.Message) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := t.writer.WriteMessages(ctx, batch...); err != nil {
        log.Printf("Failed to write click events: %v", err)
    }
}

// Close closes the tracker
func (t *ClickTracker) Close() error {
    close(t.eventsCh)
    if t.geoDB != nil {
        t.geoDB.Close()
    }
    return t.writer.Close()
}

func extractIP(r *http.Request) string {
    // Check X-Forwarded-For header first
    xff := r.Header.Get("X-Forwarded-For")
    if xff != "" {
        // Take the first IP (client IP)
        ips := strings.Split(xff, ",")
        return strings.TrimSpace(ips[0])
    }

    // Check X-Real-IP
    xri := r.Header.Get("X-Real-IP")
    if xri != "" {
        return xri
    }

    // Fall back to RemoteAddr
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    return ip
}
```

### Analytics Aggregation

The aggregator queries the `click_events` table directly rather than maintaining a separate pre-aggregated summary, which keeps the write path simple at the cost of heavier read queries. Reading `click_count` from the `urls` table for total clicks avoids a full `COUNT(*)` scan over the partitioned events table, relying on the atomically incremented counter maintained during redirect processing. The 30-day window on unique IP and country queries limits how many partitions PostgreSQL must scan, balancing query cost against analytical completeness.

```go
// analytics/aggregator.go
package analytics

import (
    "context"
    "database/sql"
    "time"
)

// ClickAggregator aggregates click data
type ClickAggregator struct {
    db *sql.DB
}

// NewClickAggregator creates a new aggregator
func NewClickAggregator(db *sql.DB) *ClickAggregator {
    return &ClickAggregator{db: db}
}

// GetStats retrieves URL statistics
func (a *ClickAggregator) GetStats(ctx context.Context, shortID string) (*URLStats, error) {
    stats := &URLStats{ShortID: shortID}

    // Get total clicks
    err := a.db.QueryRowContext(ctx, `
        SELECT click_count FROM urls WHERE short_id = $1
    `, shortID).Scan(&stats.TotalClicks)
    if err != nil {
        return nil, err
    }

    // Get unique IPs (last 30 days)
    err = a.db.QueryRowContext(ctx, `
        SELECT COUNT(DISTINCT ip_address)
        FROM click_events
        WHERE short_id = $1 AND clicked_at > NOW() - INTERVAL '30 days'
    `, shortID).Scan(&stats.UniqueIPs)
    if err != nil && err != sql.ErrNoRows {
        return nil, err
    }

    // Get last access time. MAX() returns NULL for a URL with no
    // clicks, and scanning NULL into a time.Time errors, so go
    // through sql.NullTime.
    var lastAccess sql.NullTime
    err = a.db.QueryRowContext(ctx, `
        SELECT MAX(clicked_at)
        FROM click_events
        WHERE short_id = $1
    `, shortID).Scan(&lastAccess)
    if err != nil && err != sql.ErrNoRows {
        return nil, err
    }
    if lastAccess.Valid {
        stats.LastAccess = lastAccess.Time
    }

    // Get top countries
    rows, err := a.db.QueryContext(ctx, `
        SELECT country, COUNT(*) as clicks
        FROM click_events
        WHERE short_id = $1 AND clicked_at > NOW() - INTERVAL '30 days'
        GROUP BY country
        ORDER BY clicks DESC
        LIMIT 10
    `, shortID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        var cs CountryStats
        if err := rows.Scan(&cs.Country, &cs.Clicks); err != nil {
            continue
        }
        stats.TopCountries = append(stats.TopCountries, cs)
    }

    // Get clicks by day (last 7 days)
    rows, err = a.db.QueryContext(ctx, `
        SELECT DATE(clicked_at) as day, COUNT(*) as clicks
        FROM click_events
        WHERE short_id = $1 AND clicked_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(clicked_at)
        ORDER BY day
    `, shortID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        var ds DayStats
        var day time.Time
        if err := rows.Scan(&day, &ds.Clicks); err != nil {
            continue
        }
        ds.Date = day.Format("2006-01-02")
        stats.ClicksByDay = append(stats.ClicksByDay, ds)
    }

    return stats, nil
}
```

---

### Junior → FAANG: Async Analytics and the Non-Blocking Pattern

Analytics is a canonical example of a secondary concern that must never block a primary operation. The redirect response must be fast. Analytics processing can be slow. The solution is decoupling via an asynchronous pipeline.

**Understand the channel-based buffering pattern.** The `ClickTracker` in this section uses a buffered channel of size 10,000. When a click arrives, it is sent to the channel with a non-blocking `select` (if the channel is full, the event is dropped). A background goroutine drains the channel and batches events for Kafka. This pattern is correct for analytics because a small percentage of dropped events under peak load is acceptable. It would be wrong for billing (where zero loss is required). Know when "drop on overflow" is acceptable and when it is not.

**Batch writes are dramatically more efficient than individual writes.** The `flush` method sends a batch of 100 Kafka messages in a single `WriteMessages` call rather than one message per call. Kafka's throughput advantage over a database comes from batching: the broker amortizes network round trips, disk flushes, and metadata operations across many messages. A naive implementation that calls `WriteMessages` with one message per click would saturate Kafka's per-partition write path at a fraction of the achievable throughput. Know the batch-size vs latency trade-off: larger batches are more efficient but add buffering latency. The 100ms ticker in the processor guarantees that even a batch of one message is flushed within 100ms.

**IP geolocation belongs in the consumer, not the producer.** The `Track` method in this section calls `t.geoDB.City(ip)` synchronously for each click before sending to the channel. This is a blocking local file lookup (MaxMind databases are in-process), which is fast. But if geolocation required an external API call, it would need to be moved to the Kafka consumer, not the redirect handler. The principle: anything that could block for more than a few microseconds on the redirect path should be deferred to the consumer side.

---

### Senior @ FAANG: Event Schema Contracts, Data Governance, and Pipeline Reliability

At L6/L7, the analytics pipeline is a platform product with consumers, contracts, and SLOs of its own. The event schema is as important as the API schema.

**The click event schema is a versioned contract.** The `ClickEvent` struct in this section has fields for `ShortID`, `Timestamp`, `IPAddress`, `UserAgent`, `Referer`, `Country`, and `City`. Every field is a commitment to every downstream consumer (analytics dashboards, billing, fraud detection, GDPR compliance). Adding a field is safe. Removing a field or changing its type breaks consumers. At L6+, you establish a schema versioning policy: all event types include a `SchemaVersion` field, consumers declare which versions they support, and the producer publishes to a versioned topic (e.g., `click-events.v2`) during schema migrations. The old topic is drained and decommissioned on a documented deprecation timeline.

**PII fields require a data classification and handling policy.** `IPAddress` and `UserAgent` are PII under GDPR and CCPA. The pipeline must address: (1) who has read access to raw events (engineering only, not analytics), (2) how long raw events with IP addresses are retained (typically 90 days), (3) how to fulfill a right-to-erasure request (delete or hash all events for a given IP, which requires the IP to be indexable in the Kafka-backed store), and (4) what the anonymized form of an IP address is (masking the last octet: `192.168.1.x`). Documenting these answers is not optional at FAANG scale. It is required for compliance audits.

**Kafka producer reliability requires explicit ack configuration.** The `ClickTracker` in this section sets `RequiredAcks: kafka.RequireOne`, which means the broker acknowledges after writing to the leader partition. This risks data loss if the leader fails before replication. For analytics where some loss is acceptable, `RequireOne` is correct. For billing-critical events, `RequireAll` (wait for all in-sync replicas to acknowledge) is required. Know the trade-off: `RequireAll` increases write latency (waiting for replica replication) and reduces throughput. Also know that `BatchSize` and `BatchTimeout` are tuning knobs with direct impact on both latency and throughput. The values in the code (100 messages, 10ms timeout) are starting points that require load testing against the target Kafka cluster to validate.

**The analytics aggregator's query cost grows with data volume.** The `GetStats` function queries `click_events` directly for unique IPs and country breakdowns. As the partitioned table accumulates data, queries that span multiple partitions become slower. At FAANG scale, the aggregation layer should be a pre-computed materialized view, maintained by a streaming job (Flink, Spark Streaming, or a custom Kafka consumer) that writes per-URL-per-day aggregate rows to a separate `url_daily_stats` table. The `GetStats` endpoint then reads from the aggregated table rather than the raw events table, giving constant-time query performance regardless of total click volume. This shift from query-time aggregation to write-time aggregation is a core design principle in high-scale analytics systems.
