## 52F.7 Advanced Topics

### Compacted Topics

Log compaction is Kafka's mechanism for retaining only the **latest value for each key** within a topic. Unlike time-based or size-based retention where old segments are deleted entirely, compaction selectively removes older records while preserving the most recent record for every key.

```
Before Compaction:
┌────────────────────────────────────────────────────┐
│  Offset: 0   1   2   3   4   5   6   7   8   9     │
│  Key:    A   B   A   C   B   A   D   C   A   B     │
│  Value:  v1  v1  v2  v1  v2  v3  v1  v2  v4  v3    │
└────────────────────────────────────────────────────┘

After Compaction:
┌────────────────────────────────────────┐
│  Offset: 6   7   8   9                 │
│  Key:    D   C   A   B                 │
│  Value:  v1  v2  v4  v3                │
│                                        │
│  Only the LATEST value per key         │
│  is retained. Offsets are preserved.   │
└────────────────────────────────────────┘
```

**Key concepts:**

- **Tombstone records**: A record with a `null` value tells the compactor to eventually remove all records for that key. After a configurable `delete.retention.ms` period, the tombstone itself is also removed.
- **Dirty ratio**: The `min.cleanable.dirty.ratio` setting controls how aggressively compaction runs. A value of `0.5` means compaction triggers when 50% of the log is "dirty" (not yet compacted).
- **`__consumer_offsets`**: This internal topic uses compaction to store consumer group offsets. Each key encodes the group, topic, and partition. The latest value holds the committed offset.

```
__consumer_offsets topic (compacted):

Key: {group="order-svc", topic="orders", partition=0}  → Offset: 12345
Key: {group="order-svc", topic="orders", partition=1}  → Offset: 67890
Key: {group="analytics",  topic="orders", partition=0}  → Offset: 11111
Key: {group="analytics",  topic="orders", partition=1}  → Offset: 22222
```

### Retention Policies

Kafka supports two retention strategies that can be used independently or combined:

```
┌───────────────────────────────────────────────────────────┐
│              Retention Policy Comparison                  │
│                                                           │
│  Time-Based (retention.ms)                                │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐              │
│  │ Seg1 │ Seg2 │ Seg3 │ Seg4 │ Seg5 │ Seg6 │              │
│  │ OLD  │ OLD  │      │      │      │ NEW  │              │
│  │DELETE│DELETE│ KEEP │ KEEP │ KEEP │ KEEP │              │
│  └──────┴──────┴──────┴──────┴──────┴──────┘              │
│  ◄─── beyond retention.ms ───►                            │
│                                                           │
│  Size-Based (retention.bytes)                             │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐              │
│  │ Seg1 │ Seg2 │ Seg3 │ Seg4 │ Seg5 │ Seg6 │              │
│  │DELETE│DELETE│ KEEP │ KEEP │ KEEP │ KEEP │              │
│  └──────┴──────┴──────┴──────┴──────┴──────┘              │
│  Total size of KEEP segments ≤ retention.bytes            │
│                                                           │
│  Compact (cleanup.policy=compact)                         │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐              │
│  │ Seg1 │ Seg2 │ Seg3 │ Seg4 │ Seg5 │ Seg6 │              │
│  │COMPCT│COMPCT│COMPCT│ DIRTY│ DIRTY│ DIRTY│              │
│  └──────┴──────┴──────┴──────┴──────┴──────┘              │
│  ◄── clean (compacted) ──►◄── dirty (not yet) ──►         │
│                                                           │
│  Compact + Delete (cleanup.policy=compact,delete)         │
│  Compaction runs AND old segments are deleted by time     │
└───────────────────────────────────────────────────────────┘
```

| Configuration | Default | Description |
|---------------|---------|-------------|
| `retention.ms` | 604800000 (7 days) | How long to retain messages by time |
| `retention.bytes` | -1 (unlimited) | Maximum partition size before deletion |
| `cleanup.policy` | `delete` | `delete`, `compact`, or `compact,delete` |
| `segment.ms` | 604800000 (7 days) | Time before a new segment is rolled |
| `segment.bytes` | 1073741824 (1 GB) | Size before a new segment is rolled |
| `min.cleanable.dirty.ratio` | 0.5 | Minimum dirty ratio to trigger compaction |
| `delete.retention.ms` | 86400000 (24 hours) | How long tombstones are retained |

### ISR (In-Sync Replicas)

The In-Sync Replica set is central to Kafka's durability and availability guarantees:

```
┌──────────────────────────────────────────────────────────────┐
│                 ISR Mechanism                                │
│                                                              │
│  Topic: orders, Partition: 0, Replication Factor: 3          │
│                                                              │
│  ┌──────────────┐  Replicate  ┌──────────────┐               │
│  │   Broker 1   │ ──────────► │   Broker 2   │               │
│  │   (Leader)   │             │  (Follower)  │               │
│  │              │             │              │               │
│  │  Offset: 100 │             │  Offset: 99  │               │
│  │  HW: 98      │             │  HW: 98      │               │
│  └──────┬───────┘             └──────────────┘               │
│         │                                                    │
│         │ Replicate  ┌──────────────┐                        │
│         └──────────► │   Broker 3   │                        │
│                      │  (Follower)  │                        │
│                      │              │                        │
│                      │  Offset: 98  │                        │
│                      │  HW: 98      │                        │
│                      └──────────────┘                        │
│                                                              │
│  ISR = {Broker 1, Broker 2, Broker 3}                        │
│  HW (High Watermark) = 98 (min offset across ISR)            │
│  LEO (Log End Offset) = 100 (leader's latest)                │
│                                                              │
│  Consumers can only read up to HW (offset 98).               │
│  Offsets 99-100 are "uncommitted" until all ISR catch up.    │
└──────────────────────────────────────────────────────────────┘
```

**`min.insync.replicas`** defines the minimum number of replicas that must acknowledge a write for it to be considered successful (when `acks=all`):

```
Scenario: replication.factor=3, min.insync.replicas=2, acks=all

Case 1: All brokers healthy
  ISR = {B1, B2, B3}  →  Writes succeed (3 ≥ 2) ✓

Case 2: One broker fails
  ISR = {B1, B2}      →  Writes succeed (2 ≥ 2) ✓

Case 3: Two brokers fail
  ISR = {B1}           →  Writes FAIL (1 < 2) ✗
                           NotEnoughReplicasException

This guarantees data survives at least one broker failure.
```

### Leader Election and Preferred Replica

Each partition has a **preferred leader** - typically the first broker in the replica list. Kafka can automatically rebalance leadership to preferred replicas:

```
Before broker failure:
  Partition 0: Leader=B1, Replicas=[B1, B2, B3], ISR=[B1, B2, B3]
  Partition 1: Leader=B2, Replicas=[B2, B3, B1], ISR=[B2, B3, B1]
  Partition 2: Leader=B3, Replicas=[B3, B1, B2], ISR=[B3, B1, B2]

Broker 2 fails:
  Partition 0: Leader=B1, Replicas=[B1, B2, B3], ISR=[B1, B3]
  Partition 1: Leader=B3, Replicas=[B2, B3, B1], ISR=[B3, B1]      ← B3 elected
  Partition 2: Leader=B3, Replicas=[B3, B1, B2], ISR=[B3, B1]

Broker 2 recovers:
  Partition 1: Leader=B3, Replicas=[B2, B3, B1], ISR=[B2, B3, B1]  ← B2 rejoins ISR

Preferred leader election triggers:
  Partition 1: Leader=B2, Replicas=[B2, B3, B1], ISR=[B2, B3, B1]  ← B2 regains leadership
```

Configuration: `auto.leader.rebalance.enable=true` (default) triggers periodic checks via `leader.imbalance.check.interval.seconds` (default 300).

### Rack-Aware Replication

Rack awareness ensures replicas are distributed across failure domains (racks, availability zones, or data centers):

```
┌───────────────────────────────────────────────────────────┐
│              Rack-Aware Replication                       │
│                                                           │
│  Rack A (AZ us-east-1a)    Rack B (AZ us-east-1b)         │
│  ┌─────────┐ ┌─────────┐   ┌─────────┐ ┌─────────┐        │
│  │Broker 1 │ │Broker 2 │   │Broker 3 │ │Broker 4 │        │
│  │         │ │         │   │         │ │         │        │
│  │ P0(L)   │ │ P1(F)   │   │ P0(F)   │ │ P1(L)   │        │
│  │ P2(F)   │ │ P3(L)   │   │ P2(L)   │ │ P3(F)   │        │
│  └─────────┘ └─────────┘   └─────────┘ └─────────┘        │
│                                                           │
│  Each partition has replicas in BOTH racks.               │
│  If Rack A fails entirely, all data is still available.   │
└───────────────────────────────────────────────────────────┘

Broker configuration:
  broker.rack=us-east-1a    (for Brokers 1, 2)
  broker.rack=us-east-1b    (for Brokers 3, 4)
```

### Quotas and Throttling

Kafka quotas prevent a single client from overwhelming the cluster:

| Quota Type | Scope | Configuration |
|------------|-------|---------------|
| Produce rate | Per client-id or per user | `producer_byte_rate` |
| Consume rate | Per client-id or per user | `consumer_byte_rate` |
| Request rate | Per client-id or per user | `request_percentage` |
| Partition mutation | Per broker | `controller_mutation_rate` |

```bash
# Set a produce quota of 10 MB/s for a specific client
kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --add-config 'producer_byte_rate=10485760' \
  --entity-type clients --entity-name order-producer

# Set a consume quota of 20 MB/s for a specific client
kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --add-config 'consumer_byte_rate=20971520' \
  --entity-type clients --entity-name analytics-consumer

# Set quotas per user (requires SASL authentication)
kafka-configs.sh --bootstrap-server localhost:9092 \
  --alter --add-config 'producer_byte_rate=5242880,consumer_byte_rate=10485760' \
  --entity-type users --entity-name service-account-orders
```

### Go Code: Working with Compacted Topics

Log-compacted topics retain only the latest value per key, making them ideal for change-data-capture snapshots and configuration propagation. The compacted-topic producer encodes the entity ID as the message key so Kafka's log cleaner can identify and discard all but the most recent value per entity. A tombstone (nil-value message) with the same key signals the cleaner to delete the key entirely from the compacted log.

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

// UserProfile represents a user profile stored in a compacted topic.
type UserProfile struct {
	UserID    string    `json:"user_id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Tier      string    `json:"tier"`
	UpdatedAt time.Time `json:"updated_at"`
}

// CompactedTopicManager manages operations on compacted topics.
type CompactedTopicManager struct {
	admin    sarama.ClusterAdmin
	producer sarama.SyncProducer
	logger   *slog.Logger
}

// NewCompactedTopicManager creates a new manager for compacted topic operations.
func NewCompactedTopicManager(brokers []string, logger *slog.Logger) (*CompactedTopicManager, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Producer.Return.Successes = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Idempotent = true
	config.Producer.Retry.Max = 5
	config.Net.MaxOpenRequests = 1

	admin, err := sarama.NewClusterAdmin(brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating admin client: %w", err)
	}

	producer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		admin.Close()
		return nil, fmt.Errorf("creating producer: %w", err)
	}

	return &CompactedTopicManager{
		admin:    admin,
		producer: producer,
		logger:   logger,
	}, nil
}

// CreateCompactedTopic creates a topic with compaction enabled.
func (m *CompactedTopicManager) CreateCompactedTopic(
	topic string,
	partitions int32,
	replicationFactor int16,
) error {
	topicDetail := &sarama.TopicDetail{
		NumPartitions:     partitions,
		ReplicationFactor: replicationFactor,
		ConfigEntries: map[string]*string{
			"cleanup.policy":              strPtr("compact"),
			"min.cleanable.dirty.ratio":   strPtr("0.1"),
			"segment.ms":                  strPtr("3600000"),     // 1 hour segments
			"delete.retention.ms":         strPtr("86400000"),    // 24h tombstone retention
			"min.compaction.lag.ms":        strPtr("60000"),      // 1 min before compaction
			"max.compaction.lag.ms":        strPtr("604800000"),  // 7 days max
		},
	}

	err := m.admin.CreateTopic(topic, topicDetail, false)
	if err != nil {
		return fmt.Errorf("creating compacted topic: %w", err)
	}

	m.logger.Info("compacted topic created",
		"topic", topic,
		"partitions", partitions,
		"replication_factor", replicationFactor,
	)
	return nil
}

// UpsertProfile writes a user profile to the compacted topic.
// The user ID is the message key, so compaction retains only the latest profile.
func (m *CompactedTopicManager) UpsertProfile(topic string, profile UserProfile) error {
	profile.UpdatedAt = time.Now()

	value, err := json.Marshal(profile)
	if err != nil {
		return fmt.Errorf("marshaling profile: %w", err)
	}

	msg := &sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(profile.UserID),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{
				Key:   []byte("event_type"),
				Value: []byte("profile_upsert"),
			},
		},
	}

	partition, offset, err := m.producer.SendMessage(msg)
	if err != nil {
		return fmt.Errorf("sending profile: %w", err)
	}

	m.logger.Info("profile upserted",
		"user_id", profile.UserID,
		"partition", partition,
		"offset", offset,
	)
	return nil
}

// DeleteProfile sends a tombstone record to delete a user profile.
// After compaction, all records for this key will be removed.
func (m *CompactedTopicManager) DeleteProfile(topic, userID string) error {
	msg := &sarama.ProducerMessage{
		Topic: topic,
		Key:   sarama.StringEncoder(userID),
		Value: nil, // nil value = tombstone
		Headers: []sarama.RecordHeader{
			{
				Key:   []byte("event_type"),
				Value: []byte("profile_delete"),
			},
		},
	}

	partition, offset, err := m.producer.SendMessage(msg)
	if err != nil {
		return fmt.Errorf("sending tombstone: %w", err)
	}

	m.logger.Info("tombstone sent for profile deletion",
		"user_id", userID,
		"partition", partition,
		"offset", offset,
	)
	return nil
}

// BuildStateFromCompactedTopic reads the entire compacted topic to
// reconstruct the current state as a materialized view.
func (m *CompactedTopicManager) BuildStateFromCompactedTopic(
	ctx context.Context,
	brokers []string,
	topic string,
) (map[string]UserProfile, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Consumer.Offsets.Initial = sarama.OffsetOldest

	consumer, err := sarama.NewConsumer(brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating consumer: %w", err)
	}
	defer consumer.Close()

	partitions, err := consumer.Partitions(topic)
	if err != nil {
		return nil, fmt.Errorf("getting partitions: %w", err)
	}

	state := make(map[string]UserProfile)

	for _, partition := range partitions {
		pc, err := consumer.ConsumePartition(topic, partition, sarama.OffsetOldest)
		if err != nil {
			return nil, fmt.Errorf("consuming partition %d: %w", partition, err)
		}

		// Get the high watermark to know when we have caught up.
		highWatermark := pc.HighWaterMarkOffset()

		if highWatermark == 0 {
			pc.Close()
			continue
		}

		for msg := range pc.Messages() {
			key := string(msg.Key)

			if msg.Value == nil {
				// Tombstone: remove from state.
				delete(state, key)
				m.logger.Debug("tombstone applied", "key", key)
			} else {
				var profile UserProfile
				if err := json.Unmarshal(msg.Value, &profile); err != nil {
					m.logger.Error("failed to unmarshal profile",
						"key", key,
						"error", err,
					)
					continue
				}
				state[key] = profile
			}

			// Check if we have reached the end of the partition.
			if msg.Offset >= highWatermark-1 {
				break
			}
		}
		pc.Close()
	}

	m.logger.Info("state rebuilt from compacted topic",
		"topic", topic,
		"entries", len(state),
	)
	return state, nil
}

// Close releases all resources held by the manager.
func (m *CompactedTopicManager) Close() error {
	m.producer.Close()
	return m.admin.Close()
}

func strPtr(s string) *string {
	return &s
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelDebug,
	}))

	brokers := []string{"localhost:9092"}
	topic := "user-profiles"

	manager, err := NewCompactedTopicManager(brokers, logger)
	if err != nil {
		logger.Error("failed to create manager", "error", err)
		os.Exit(1)
	}
	defer manager.Close()

	// Create the compacted topic.
	if err := manager.CreateCompactedTopic(topic, 6, 3); err != nil {
		logger.Warn("topic creation (may already exist)", "error", err)
	}

	// Upsert some profiles.
	profiles := []UserProfile{
		{UserID: "user-001", Email: "alice@example.com", Name: "Alice Smith", Tier: "gold"},
		{UserID: "user-002", Email: "bob@example.com", Name: "Bob Johnson", Tier: "silver"},
		{UserID: "user-003", Email: "carol@example.com", Name: "Carol Davis", Tier: "bronze"},
	}

	for _, p := range profiles {
		if err := manager.UpsertProfile(topic, p); err != nil {
			logger.Error("failed to upsert profile", "error", err, "user_id", p.UserID)
		}
	}

	// Update Alice's tier.
	profiles[0].Tier = "platinum"
	profiles[0].Email = "alice.smith@example.com"
	if err := manager.UpsertProfile(topic, profiles[0]); err != nil {
		logger.Error("failed to update profile", "error", err)
	}

	// Delete Bob's profile with a tombstone.
	if err := manager.DeleteProfile(topic, "user-002"); err != nil {
		logger.Error("failed to delete profile", "error", err)
	}

	// Build materialized state from the compacted topic.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	time.Sleep(2 * time.Second) // Allow messages to be written.

	state, err := manager.BuildStateFromCompactedTopic(ctx, brokers, topic)
	if err != nil {
		logger.Error("failed to build state", "error", err)
		os.Exit(1)
	}

	// Display the current state.
	for userID, profile := range state {
		logger.Info("current profile state",
			"user_id", userID,
			"name", profile.Name,
			"email", profile.Email,
			"tier", profile.Tier,
		)
	}
}
```

> **Compacted Topics in Practice**: The `__consumer_offsets` topic is the most critical compacted topic in any Kafka cluster. It stores every consumer group's committed offsets. When this topic has issues - such as under-replication or excessive growth - consumer groups lose their position and reprocess data. At LinkedIn, this topic is configured with `replication.factor=3`, `min.insync.replicas=2`, and aggressive compaction (`min.cleanable.dirty.ratio=0.01`). Monitor this topic's size and partition health as closely as you monitor your business topics.

### Junior -> FAANG: Knowing Which Advanced Feature to Reach For

The advanced topics in this section (compaction, retention policies, ISR mechanics, rack awareness, quotas) are not features you configure randomly. Each solves a specific production problem. Build a mental map of problem to solution:

**"I need to keep only the latest state per entity, not the full history."** Compacted topic. Use the entity ID as the message key. To delete an entity, send a tombstone (null value). The `BuildStateFromCompactedTopic` function shows the startup pattern: read the entire compacted topic to bootstrap in-memory state, then tail the topic for incremental updates.

**"My broker disk is filling up and I need to control retention."** `retention.ms` plus `retention.bytes` are independent controls. Set both to create a compound limit. If you also need compaction (keep latest per key), use `cleanup.policy=compact,delete` which applies both strategies.

**"My cluster is losing leadership to unhealthy replicas after a broker restart."** `unclean.leader.election.enable=false` (the production default) prevents this. An out-of-sync replica will never become leader, so no data loss occurs. If you need faster recovery at the cost of potential data loss, `unclean.leader.election.enable=true` is the lever, but document the tradeoff clearly.

**"My producer is being throttled by the broker."** Quotas are enforced per client-id or per user. Check the quota configuration with `kafka-configs.sh --describe --entity-type clients`. If you see throttle time in producer metrics, your client is hitting a quota. Request a quota increase or reduce producer throughput.

For first-job interviews, compaction is frequently asked in the context of event sourcing: "how would you implement a read model that always shows current state?" The correct answer involves a compacted topic as the source of truth for current state, with consumers bootstrapping from the beginning of the topic on startup.

### Senior @ FAANG: ISR Health as a Cluster Stability Indicator

At the senior level, ISR mechanics are not just a durability feature. They are the primary cluster health signal. An ISR shrink event is a leading indicator of a problem on a follower broker, and a pattern of ISR shrinks is a signal that the cluster is approaching its throughput or I/O limits.

**ISR shrink root causes and remediation.** When a follower falls out of the ISR, the cause is almost always one of: (a) disk I/O saturation on the follower broker (check `iostat`, look for `%util` above 80%), (b) network saturation between leader and follower (check `nethogs` or per-interface throughput), (c) JVM GC pause on the follower (check GC logs for stop-the-world pauses above `replica.lag.time.max.ms`), or (d) clock skew between brokers causing the lag calculation to be incorrect. Instrument each broker with `node_exporter` disk I/O and network metrics in Prometheus and build an alert that fires when ISR shrink rate exceeds 0 for more than 5 minutes.

**`min.insync.replicas` as a tradeoff dial.** Setting `min.insync.replicas=3` on a `replication.factor=3` cluster means any single broker failure blocks all writes until the failed broker recovers or is replaced. This is the right choice for financial data where data loss is unacceptable and a brief write outage is acceptable. Setting `min.insync.replicas=2` tolerates one broker failure while continuing to accept writes. Most production clusters use RF=3, min ISR=2 as the balanced default.

**Rack-aware replication as a datacenter failure requirement.** The `broker.rack` configuration is not optional for clusters in cloud environments. Without rack awareness, Kafka may place both replicas of a partition on brokers in the same availability zone. A zone failure then takes a partition offline even though the cluster has brokers in other zones. Set `broker.rack` to the availability zone for every broker at cluster creation. Changing rack assignments after cluster creation requires a partition reassignment operation.

**Quota enforcement as a platform safety valve.** At the platform level, quotas prevent a single service from monopolizing cluster throughput and causing cascading delays for other services. The platform team should set per-client-id quotas at onboarding time based on the service's declared throughput requirements. Services that exceed their quota get throttled (the broker adds artificial delay). Services that need higher throughput submit a quota increase request with a capacity justification. This creates a governance mechanism that prevents cluster saturation from uncontrolled growth.

---
