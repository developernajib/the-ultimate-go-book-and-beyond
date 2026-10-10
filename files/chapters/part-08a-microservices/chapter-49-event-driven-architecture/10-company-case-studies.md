## 49.8 Company Case Studies

### LinkedIn: Kafka at Massive Scale

LinkedIn created Kafka internally before open-sourcing it in 2011 (as documented in LinkedIn Engineering's architectural papers on multi-datacenter streaming), and their clusters process trillions of messages per day across thousands of topics. Two patterns from LinkedIn's architecture are particularly instructive: partitioning by user ID to guarantee per-user ordering (so a user's feed events are always processed sequentially), and using LZ4 compression with batched writes to sustain millions of messages per second without saturating network bandwidth. The code below demonstrates these patterns using the `sarama` client library.

```go
// pkg/events/linkedin/kafka_patterns.go
package linkedin

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/IBM/sarama"
)

/*
LinkedIn Kafka Patterns:
- Partitioned by user ID for ordering guarantees
- Log compaction for maintaining latest state
- Tiered storage for cost-effective retention
- Schema registry for evolution

Key Design Decisions:
1. Key Selection: User ID for feed events (ordering per user)
2. Partition Count: 10x expected peak consumers
3. Replication Factor: 3 for durability
4. Retention: 7 days hot, tiered for cold
*/

// FeedEventProducer produces feed events
type FeedEventProducer struct {
	producer sarama.SyncProducer
	topic    string
	logger   *slog.Logger
}

// FeedEvent represents a LinkedIn feed event
type FeedEvent struct {
	EventID     string    `json:"event_id"`
	EventType   string    `json:"event_type"` // post, like, comment, share
	ActorID     string    `json:"actor_id"`
	TargetID    string    `json:"target_id"`
	ContentID   string    `json:"content_id"`
	Metadata    map[string]any `json:"metadata"`
	Timestamp   time.Time `json:"timestamp"`
	SchemaVersion int     `json:"schema_version"`
}

// NewFeedEventProducer creates a new producer with LinkedIn's config
func NewFeedEventProducer(brokers []string, topic string) (*FeedEventProducer, error) {
	config := sarama.NewConfig()

	// LinkedIn production settings
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Retry.Max = 5
	config.Producer.Retry.Backoff = 100 * time.Millisecond
	config.Producer.Return.Successes = true

	// Compression for throughput
	config.Producer.Compression = sarama.CompressionLZ4

	// Batching for efficiency
	config.Producer.Flush.Frequency = 5 * time.Millisecond
	config.Producer.Flush.Messages = 100
	config.Producer.Flush.MaxMessages = 1000

	// Idempotent producer for exactly-once semantics
	config.Producer.Idempotent = true
	config.Net.MaxOpenRequests = 1

	producer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		return nil, err
	}

	return &FeedEventProducer{
		producer: producer,
		topic:    topic,
		logger:   slog.Default(),
	}, nil
}

// Publish publishes a feed event with proper keying
func (p *FeedEventProducer) Publish(ctx context.Context, event FeedEvent) error {
	// Key by actor ID for per-user ordering
	key := []byte(event.ActorID)

	// Add version and timestamp
	event.SchemaVersion = 2
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now()
	}

	value, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	msg := &sarama.ProducerMessage{
		Topic: p.topic,
		Key:   sarama.ByteEncoder(key),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{Key: []byte("schema-version"), Value: []byte("2")},
			{Key: []byte("event-type"), Value: []byte(event.EventType)},
		},
	}

	partition, offset, err := p.producer.SendMessage(msg)
	if err != nil {
		return fmt.Errorf("send message: %w", err)
	}

	p.logger.Debug("event published",
		"eventId", event.EventID,
		"partition", partition,
		"offset", offset,
	)

	return nil
}

// FeedConsumer consumes feed events with parallel processing
type FeedConsumer struct {
	consumer sarama.ConsumerGroup
	handlers map[string]EventHandler
	logger   *slog.Logger
	wg       sync.WaitGroup
}

type EventHandler func(ctx context.Context, event FeedEvent) error

// ProcessInParallel processes events in parallel while maintaining per-key order
func (c *FeedConsumer) ProcessInParallel(ctx context.Context, events []FeedEvent, workers int) error {
	// Group events by actor ID to maintain ordering
	eventsByActor := make(map[string][]FeedEvent)
	for _, event := range events {
		eventsByActor[event.ActorID] = append(eventsByActor[event.ActorID], event)
	}

	// Process each actor's events in order, but actors in parallel
	sem := make(chan struct{}, workers)
	errChan := make(chan error, len(eventsByActor))

	for actorID, actorEvents := range eventsByActor {
		sem <- struct{}{}
		c.wg.Add(1)

		go func(actor string, events []FeedEvent) {
			defer c.wg.Done()
			defer func() { <-sem }()

			for _, event := range events {
				handler, ok := c.handlers[event.EventType]
				if !ok {
					c.logger.Warn("no handler for event type", "type", event.EventType)
					continue
				}

				if err := handler(ctx, event); err != nil {
					errChan <- fmt.Errorf("handle event %s: %w", event.EventID, err)
					return
				}
			}
		}(actorID, actorEvents)
	}

	c.wg.Wait()
	close(errChan)

	// Collect errors
	var errs []error
	for err := range errChan {
		errs = append(errs, err)
	}

	if len(errs) > 0 {
		return fmt.Errorf("processing errors: %v", errs)
	}

	return nil
}
```

### Netflix: Event Sourcing for Personalization

Netflix captures every user interaction (playback starts, pauses, seeks, searches, and ratings) as immutable events (as published in Netflix TechBlog's analysis of their Keystone real-time stream processing platform), then projects those events into materialized user profiles that drive the recommendation engine. The event-sourced design serves two purposes: real-time stream processing builds profiles for immediate personalization, and the same event log feeds batch jobs for offline model training. The `ViewingSession` aggregate below reconstructs a user's watch session from its constituent events, and the `UserProfileProjection` maintains a denormalized view of genre preferences and watch history.

```go
// pkg/events/netflix/event_sourcing.go
package netflix

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

/*
Netflix Event Sourcing for Personalization:
- Events capture every user interaction
- Stream processing builds real-time profiles
- Batch processing builds offline features
- Events enable A/B testing and experimentation

Event Types:
- ViewingHistory: What users watched
- BrowseHistory: What users browsed
- SearchHistory: What users searched
- RatingHistory: How users rated content
*/

// UserInteractionEvent represents a user interaction
type UserInteractionEvent struct {
	EventID     string                 `json:"event_id"`
	EventType   string                 `json:"event_type"`
	UserID      string                 `json:"user_id"`
	ProfileID   string                 `json:"profile_id"`
	DeviceID    string                 `json:"device_id"`
	ContentID   string                 `json:"content_id,omitempty"`
	SearchQuery string                 `json:"search_query,omitempty"`
	Position    int64                  `json:"position,omitempty"` // Video position in seconds
	Duration    int64                  `json:"duration,omitempty"` // Time spent
	Context     map[string]any `json:"context"`
	Timestamp   time.Time              `json:"timestamp"`
}

// ViewingSession represents a viewing session aggregate
type ViewingSession struct {
	SessionID    string
	UserID       string
	ProfileID    string
	ContentID    string
	StartTime    time.Time
	EndTime      time.Time
	TotalWatched int64 // seconds
	Pauses       int
	Seeks        int
	events       []UserInteractionEvent
}

// Apply applies an event to the viewing session
func (s *ViewingSession) Apply(event UserInteractionEvent) error {
	s.events = append(s.events, event)

	switch event.EventType {
	case "playback_start":
		s.SessionID = event.EventID
		s.UserID = event.UserID
		s.ProfileID = event.ProfileID
		s.ContentID = event.ContentID
		s.StartTime = event.Timestamp

	case "playback_progress":
		s.TotalWatched = event.Position

	case "playback_pause":
		s.Pauses++

	case "playback_seek":
		s.Seeks++

	case "playback_stop":
		s.EndTime = event.Timestamp
	}

	return nil
}

// UserProfileProjection maintains a materialized view of user preferences
type UserProfileProjection struct {
	store    ProjectionStore
	logger   *slog.Logger
}

type ProjectionStore interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte) error
	Increment(ctx context.Context, key string, field string, delta int64) error
}

// UserProfile represents the projected user profile
type UserProfile struct {
	UserID          string             `json:"user_id"`
	GenrePreferences map[string]int64  `json:"genre_preferences"`
	WatchHistory    []WatchedContent   `json:"watch_history"`
	SearchTerms     []string           `json:"search_terms"`
	AverageWatchTime float64           `json:"average_watch_time"`
	PreferredTime   string             `json:"preferred_time"` // morning, afternoon, evening, night
	UpdatedAt       time.Time          `json:"updated_at"`
}

type WatchedContent struct {
	ContentID     string    `json:"content_id"`
	WatchedAt     time.Time `json:"watched_at"`
	WatchPercent  float64   `json:"watch_percent"`
	Rating        *int      `json:"rating,omitempty"`
}

// HandleEvent processes an event and updates the projection
func (p *UserProfileProjection) HandleEvent(ctx context.Context, event UserInteractionEvent) error {
	// Load current profile
	profile, err := p.loadProfile(ctx, event.UserID)
	if err != nil {
		profile = &UserProfile{
			UserID:           event.UserID,
			GenrePreferences: make(map[string]int64),
			WatchHistory:     make([]WatchedContent, 0),
			SearchTerms:      make([]string, 0),
		}
	}

	// Update profile based on event type
	switch event.EventType {
	case "playback_stop":
		// Calculate watch percentage from context
		if totalDuration, ok := event.Context["total_duration"].(float64); ok && totalDuration > 0 {
			watchPercent := float64(event.Position) / totalDuration * 100

			profile.WatchHistory = append([]WatchedContent{{
				ContentID:    event.ContentID,
				WatchedAt:    event.Timestamp,
				WatchPercent: watchPercent,
			}}, profile.WatchHistory...)

			// Keep only last 100 items
			if len(profile.WatchHistory) > 100 {
				profile.WatchHistory = profile.WatchHistory[:100]
			}
		}

	case "search":
		if event.SearchQuery != "" {
			profile.SearchTerms = append([]string{event.SearchQuery}, profile.SearchTerms...)
			if len(profile.SearchTerms) > 50 {
				profile.SearchTerms = profile.SearchTerms[:50]
			}
		}

	case "rate":
		if rating, ok := event.Context["rating"].(int); ok {
			for i := range profile.WatchHistory {
				if profile.WatchHistory[i].ContentID == event.ContentID {
					profile.WatchHistory[i].Rating = &rating
					break
				}
			}
		}

	case "genre_view":
		if genre, ok := event.Context["genre"].(string); ok {
			profile.GenrePreferences[genre]++
		}
	}

	// Update timestamp and save
	profile.UpdatedAt = time.Now()
	return p.saveProfile(ctx, profile)
}

func (p *UserProfileProjection) loadProfile(ctx context.Context, userID string) (*UserProfile, error) {
	data, err := p.store.Get(ctx, fmt.Sprintf("profile:%s", userID))
	if err != nil {
		return nil, err
	}

	var profile UserProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		return nil, err
	}

	return &profile, nil
}

func (p *UserProfileProjection) saveProfile(ctx context.Context, profile *UserProfile) error {
	data, err := json.Marshal(profile)
	if err != nil {
		return err
	}

	return p.store.Set(ctx, fmt.Sprintf("profile:%s", profile.UserID), data)
}
```

### Uber: Multi-Datacenter Event Replication

Uber operates active-active across multiple datacenters (detailed in Uber Engineering's published work on uReplicator and cross-datacenter Kafka replication), which means a ride request in one region must eventually be visible to services in all regions for analytics, billing, and support tooling. Each datacenter runs its own Kafka cluster for low-latency local writes, and a cross-DC replication layer forwards selected events globally. The challenge is conflict resolution when the same ride aggregate is updated concurrently in two datacenters. Uber addresses this with vector clocks and datacenter priority rules. The code below models this pattern with a `CrossDCEventRouter` that writes locally first and replicates globally for events that require cross-region visibility.

```go
// pkg/events/uber/cross_dc.go
package uber

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

/*
Uber Cross-DC Event Replication:
- Active-active in multiple datacenters
- Regional events replicated globally
- Conflict resolution via vector clocks
- Low-latency local writes, async global sync

Architecture:
1. Local Kafka cluster per datacenter
2. MirrorMaker 2 for cross-DC replication
3. Global ordering service for conflict resolution
4. Regional aggregates for eventual consistency
*/

// RideEvent represents a ride lifecycle event
type RideEvent struct {
	EventID       string       `json:"event_id"`
	EventType     string       `json:"event_type"`
	RideID        string       `json:"ride_id"`
	DriverID      string       `json:"driver_id,omitempty"`
	RiderID       string       `json:"rider_id"`
	Datacenter    string       `json:"datacenter"`
	VectorClock   VectorClock  `json:"vector_clock"`
	Location      *GeoPoint    `json:"location,omitempty"`
	Timestamp     time.Time    `json:"timestamp"`
	LocalVersion  int64        `json:"local_version"`
	GlobalVersion int64        `json:"global_version,omitempty"`
}

type VectorClock map[string]int64

type GeoPoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// CrossDCEventRouter handles routing events to appropriate datacenters
type CrossDCEventRouter struct {
	localDC        string
	localProducer  EventProducer
	globalProducer EventProducer
	dcMapping      map[string]EventProducer
	logger         *slog.Logger
	mu             sync.RWMutex
}

type EventProducer interface {
	Publish(ctx context.Context, topic string, key []byte, value []byte) error
}

// RouteEvent routes an event to the appropriate datacenter(s)
func (r *CrossDCEventRouter) RouteEvent(ctx context.Context, event RideEvent) error {
	// Always write to local DC first (low latency)
	event.Datacenter = r.localDC
	event.Timestamp = time.Now()

	// Increment local vector clock
	event.VectorClock[r.localDC]++

	eventData, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Local write
	if err := r.localProducer.Publish(ctx, "rides", []byte(event.RideID), eventData); err != nil {
		return fmt.Errorf("local publish: %w", err)
	}

	r.logger.Debug("event published locally",
		"eventId", event.EventID,
		"rideId", event.RideID,
	)

	// Determine if global replication is needed
	if r.needsGlobalReplication(event) {
		// Async global replication (fire and forget)
		go func() {
			if err := r.globalProducer.Publish(context.Background(), "rides-global", []byte(event.RideID), eventData); err != nil {
				r.logger.Error("global replication failed", "error", err)
			}
		}()
	}

	return nil
}

func (r *CrossDCEventRouter) needsGlobalReplication(event RideEvent) bool {
	// Events that need global visibility
	globalEvents := map[string]bool{
		"ride_completed":  true,
		"payment_charged": true,
		"rider_rated":     true,
		"driver_rated":    true,
	}
	return globalEvents[event.EventType]
}

// ConflictResolver resolves conflicts from concurrent updates
type ConflictResolver struct {
	logger *slog.Logger
}

// ResolveConflict resolves conflicts using vector clocks
func (r *ConflictResolver) ResolveConflict(events []RideEvent) (*RideEvent, error) {
	if len(events) == 0 {
		return nil, fmt.Errorf("no events to resolve")
	}

	if len(events) == 1 {
		return &events[0], nil
	}

	// Find the event with the highest vector clock
	var winner *RideEvent
	for i := range events {
		if winner == nil || r.happensBefore(winner.VectorClock, events[i].VectorClock) {
			winner = &events[i]
		} else if !r.happensBefore(events[i].VectorClock, winner.VectorClock) {
			// Concurrent events - use datacenter priority
			if r.dcPriority(events[i].Datacenter) > r.dcPriority(winner.Datacenter) {
				winner = &events[i]
			}
		}
	}

	r.logger.Info("conflict resolved",
		"winner", winner.EventID,
		"candidates", len(events),
	)

	return winner, nil
}

// happensBefore returns true if vc1 happened before vc2
func (r *ConflictResolver) happensBefore(vc1, vc2 VectorClock) bool {
	for dc, v1 := range vc1 {
		if v2, ok := vc2[dc]; !ok || v1 > v2 {
			return false
		}
	}
	return true
}

// dcPriority returns datacenter priority for conflict resolution
func (r *ConflictResolver) dcPriority(dc string) int {
	// Primary DC has highest priority
	priorities := map[string]int{
		"us-west":  3,
		"us-east":  2,
		"eu-west":  1,
		"ap-south": 0,
	}
	if p, ok := priorities[dc]; ok {
		return p
	}
	return 0
}
```

### Junior → FAANG: Learning From Production Systems Without Access to Their Code

Case studies from LinkedIn, Netflix, and Uber are valuable precisely because they describe constraints and tradeoffs that you will not encounter on a tutorial project. Here is how to extract the transferable lessons.

**LinkedIn: key selection drives architectural properties.** The choice to partition by `actorID` (user ID) is not arbitrary. It guarantees that all events from a single user arrive at a single partition in order. This means a consumer processing feed events can reconstruct a user's activity timeline without needing to sort or buffer across partitions. When you design a Kafka topic, the partition key question is the most important design decision: it determines ordering guarantees, hotspot risk, and how you scale consumers. Always document the partition key for each topic and the ordering guarantee it provides.

**Netflix: event sourcing enables two consumption patterns from one source.** The same viewing event stream feeds real-time stream processing (for immediate personalization) and batch model training (for offline ML). This is one of the most powerful properties of a persistent event log: you can add new consumers without modifying producers, and each consumer reads at its own pace from the same immutable log. A consumer built today can read events from a year ago to bootstrap its model. This "time travel" capability requires a persistent log (Kafka, JetStream with file storage), not a traditional message queue that deletes messages after delivery.

**Uber: active-active multi-datacenter is a hard problem.** The vector clock conflict resolution code in this section is simplified but represents a real pattern. The key insight is that "last write wins" by wall clock time is unreliable in distributed systems because clocks are not perfectly synchronized across datacenters. Vector clocks track causal relationships more accurately. For your first job, the practical takeaway is: designing a multi-datacenter active-active system is significantly more complex than designing a primary-standby system, and the complexity should be justified by concrete availability requirements, not aspirational architecture.

**Interview application.** When an interviewer asks "how would you design a system like LinkedIn's feed," use the partitioning-by-user-ID insight as an early signal. It shows you think about ordering guarantees and partition design, not just "put events on Kafka."

### Senior @ FAANG: Extracting Architectural Patterns From Case Studies

The three case studies encode architectural patterns that apply beyond their specific companies. Here is the pattern extraction and how to apply it at L6/L7.

**LinkedIn's pattern: keying for business-meaningful ordering.** The general principle is that the partition key should be chosen based on the smallest unit for which ordering guarantees are required by the business. For LinkedIn, that unit is the user (per-user feed ordering). For an order management system, it is the order ID (per-order state machine ordering). For a financial ledger, it is the account ID (per-account transaction ordering). Choosing the partition key is a domain modeling decision, not a Kafka configuration decision. It requires understanding the business invariants, not just the technology.

At staff level, you also reason about the cardinality and distribution of the partition key. If 80% of events share 1% of keys (a celebrity user, a viral product), you have a hot partition problem that no Kafka configuration can fix. The solution is either domain-level mitigation (sub-keying, topic splitting) or accepting that ordering for high-cardinality keys is achieved at the application layer, not the broker layer.

**Netflix's pattern: the event log as a shared data product.** Netflix's event sourcing approach treats the event log not as an internal implementation detail but as a first-class data product consumed by multiple teams with different access patterns. This "data mesh" thinking, where event streams are the interface between teams rather than shared databases or synchronous APIs, is the architectural direction most large-scale distributed systems are moving toward in 2026. At staff level, you design the event log with all its consumers in mind, including consumers that do not exist yet, because the log is immutable and the cost of a schema mistake is high.

**Uber's pattern: active-active and the consistency tradeoff.** Uber's cross-DC replication shows the fundamental tradeoff in active-active systems: you can have high availability (writes succeed in any datacenter) or strong consistency (all datacenters agree on the same value), but not both in the presence of network partitions (CAP theorem). Uber's solution is to define a conflict resolution policy (vector clocks plus datacenter priority) and accept that conflicting updates are resolved deterministically rather than prevented. At staff level, the question you ask is: what is the business impact of a conflict, and does the chosen resolution policy produce the correct business outcome? For ride completion events, "last write wins by datacenter priority" may be acceptable. For financial transactions, it is not.

**MirrorMaker 2 and Cluster Linking.** The Uber case study mentions MirrorMaker 2 for cross-DC replication. In 2026, Confluent Cluster Linking is a lower-latency, operationally simpler alternative to MirrorMaker 2 for Confluent-managed Kafka. It replicates topics directly without an intermediate consumer-producer hop, which reduces lag from seconds to milliseconds. If your infrastructure uses Confluent Platform, Cluster Linking is the correct choice over MirrorMaker 2 for active-active replication. If you are on open-source Kafka, MirrorMaker 2 is the correct choice. Document this decision in the ADR for your cross-DC replication architecture.

---
