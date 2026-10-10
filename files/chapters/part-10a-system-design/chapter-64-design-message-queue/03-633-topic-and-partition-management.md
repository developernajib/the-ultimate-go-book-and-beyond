## 64.3 Topic and Partition Management

Topics are the logical unit of message organization in a message queue, partitioned into segments that can be distributed across broker nodes to enable parallel consumption and horizontal throughput scaling. Each partition is an append-only log stored on disk, providing durability and enabling consumers to replay messages from any offset. The partition count determines the maximum consumer parallelism within a consumer group, a topic with 8 partitions can be consumed by at most 8 consumers simultaneously, each processing an exclusive subset of partitions.

```go
// topic/topic.go
package topic

import (
    "context"
    "fmt"
    "path/filepath"
    "sync"

    "yourproject/message"
    "yourproject/storage"
)

// Topic represents a message topic
type Topic struct {
    Name       string
    Partitions []*Partition
    Config     TopicConfig
}

// TopicConfig holds topic configuration
type TopicConfig struct {
    NumPartitions     int
    ReplicationFactor int
    RetentionMs       int64
    RetentionBytes    int64
    SegmentBytes      int64
}

// Partition represents a topic partition
type Partition struct {
    mu           sync.RWMutex
    Topic        string
    ID           int32
    Log          *storage.Log
    Leader       string // Node ID of leader
    Replicas     []string
    ISR          []string // In-Sync Replicas
    HighWatermark int64   // Committed offset
}

// NewPartition creates a new partition
func NewPartition(dir string, topic string, id int32, config TopicConfig) (*Partition, error) {
    partitionDir := filepath.Join(dir, topic, fmt.Sprintf("%d", id))

    log, err := storage.NewLog(partitionDir, config.SegmentBytes)
    if err != nil {
        return nil, err
    }

    return &Partition{
        Topic: topic,
        ID:    id,
        Log:   log,
    }, nil
}

// Append appends messages to the partition
func (p *Partition) Append(ctx context.Context, messages []*message.Message) ([]int64, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    offsets := make([]int64, len(messages))
    for i, msg := range messages {
        msg.Partition = p.ID
        offset, err := p.Log.Append(msg)
        if err != nil {
            return nil, err
        }
        offsets[i] = offset
    }

    return offsets, nil
}

// Fetch fetches messages from the partition
func (p *Partition) Fetch(ctx context.Context, offset int64, maxCount int, maxBytes int64) ([]*message.Message, error) {
    p.mu.RLock()
    defer p.mu.RUnlock()

    return p.Log.ReadBatch(offset, maxCount, maxBytes)
}

// GetHighWatermark returns the high watermark
func (p *Partition) GetHighWatermark() int64 {
    p.mu.RLock()
    defer p.mu.RUnlock()
    return p.HighWatermark
}

// SetHighWatermark updates the high watermark
func (p *Partition) SetHighWatermark(offset int64) {
    p.mu.Lock()
    defer p.mu.Unlock()
    if offset > p.HighWatermark {
        p.HighWatermark = offset
    }
}
```

### Partition Assignment

When consumers join or leave a consumer group, the broker must rebalance which consumer owns which partitions, a process called group rebalance. The three strategies here trade off between simplicity and stability: `RangeAssignor` gives contiguous partition blocks to each consumer (predictable but can be uneven across topics), `RoundRobinAssignor` distributes partitions uniformly one-by-one (balanced but causes full reassignment on membership change), and `StickyAssignor` minimizes partition movement during rebalances by preserving existing assignments and only redistributing orphaned partitions to the least-loaded consumer. The sticky strategy dramatically reduces rebalance overhead at scale because consumers do not need to rebuild local state (caches, offsets) for partitions they already held.

```go
// consumer/assignment.go
package consumer

import (
    "slices"
	"sort"
)

// PartitionAssignor assigns partitions to consumers
type PartitionAssignor interface {
    Assign(members []string, partitions []TopicPartition) map[string][]TopicPartition
}

// TopicPartition identifies a partition
type TopicPartition struct {
    Topic     string
    Partition int32
}

// RangeAssignor assigns partitions using range strategy
type RangeAssignor struct{}

func (r *RangeAssignor) Assign(members []string, partitions []TopicPartition) map[string][]TopicPartition {
    // Sort members and partitions
    slices.Sort(members)
    sort.Slice(partitions, func(i, j int) bool {
        if partitions[i].Topic != partitions[j].Topic {
            return partitions[i].Topic < partitions[j].Topic
        }
        return partitions[i].Partition < partitions[j].Partition
    })

    assignment := make(map[string][]TopicPartition)
    for _, member := range members {
        assignment[member] = make([]TopicPartition, 0)
    }

    // Group partitions by topic
    topicPartitions := make(map[string][]TopicPartition)
    for _, tp := range partitions {
        topicPartitions[tp.Topic] = append(topicPartitions[tp.Topic], tp)
    }

    // Assign each topic's partitions
    for _, tps := range topicPartitions {
        numPartitions := len(tps)
        numMembers := len(members)

        partitionsPerMember := numPartitions / numMembers
        extra := numPartitions % numMembers

        start := 0
        for i, member := range members {
            count := partitionsPerMember
            if i < extra {
                count++
            }
            assignment[member] = append(assignment[member], tps[start:start+count]...)
            start += count
        }
    }

    return assignment
}

// RoundRobinAssignor assigns partitions using round-robin
type RoundRobinAssignor struct{}

func (r *RoundRobinAssignor) Assign(members []string, partitions []TopicPartition) map[string][]TopicPartition {
    slices.Sort(members)
    sort.Slice(partitions, func(i, j int) bool {
        if partitions[i].Topic != partitions[j].Topic {
            return partitions[i].Topic < partitions[j].Topic
        }
        return partitions[i].Partition < partitions[j].Partition
    })

    assignment := make(map[string][]TopicPartition)
    for _, member := range members {
        assignment[member] = make([]TopicPartition, 0)
    }

    for i, tp := range partitions {
        member := members[i%len(members)]
        assignment[member] = append(assignment[member], tp)
    }

    return assignment
}

// StickyAssignor tries to maintain existing assignments
type StickyAssignor struct {
    previousAssignment map[string][]TopicPartition
}

func (s *StickyAssignor) Assign(members []string, partitions []TopicPartition) map[string][]TopicPartition {
    assignment := make(map[string][]TopicPartition)
    assigned := make(map[TopicPartition]bool)

    // Keep existing assignments where possible
    for member, tps := range s.previousAssignment {
        if !slices.Contains(members, member) {
            continue
        }
        for _, tp := range tps {
            if slices.Contains(partitions, tp) && !assigned[tp] {
                assignment[member] = append(assignment[member], tp)
                assigned[tp] = true
            }
        }
    }

    // Assign remaining partitions
    unassigned := make([]TopicPartition, 0)
    for _, tp := range partitions {
        if !assigned[tp] {
            unassigned = append(unassigned, tp)
        }
    }

    // Balance: assign to members with fewest partitions
    for _, tp := range unassigned {
        minMember := ""
        minCount := int(^uint(0) >> 1)
        for _, member := range members {
            if len(assignment[member]) < minCount {
                minCount = len(assignment[member])
                minMember = member
            }
        }
        assignment[minMember] = append(assignment[minMember], tp)
    }

    s.previousAssignment = assignment
    return assignment
}
```

---

### Junior -> FAANG: Partition Count and Consumer Parallelism

The single most important fact about partitions for an interview: the number of partitions is the upper bound on consumer parallelism within a consumer group. If a topic has 8 partitions and you start 16 consumers in the same group, 8 consumers will be idle. You cannot scale a consumer group beyond the partition count without changing the topic configuration.

The three assignment strategies are frequently tested. Range assigns contiguous partition blocks. If a topic has 10 partitions and 3 consumers, consumer A gets 0-3, B gets 4-6, C gets 7-9. Round-robin interleaves: A gets 0, 3, 6, 9, B gets 1, 4, 7, and C gets 2, 5, 8. Sticky is round-robin with memory: on rebalance, it preserves existing assignments and only moves orphaned partitions. The sticky strategy is preferred when consumers maintain local state (caches, open file handles) because it avoids rebuilding that state after every rebalance.

First-job habit: when creating a Kafka topic, default to more partitions than you think you need. Adding partitions later is a disruptive operation (it reshuffles the key-to-partition mapping, breaking per-key ordering for keys that hash to different partitions after the change). A good rule of thumb is to start with 2-4x the expected peak consumer count.

### Senior @ FAANG: Partition Assignment as a Rebalance Cost Optimization Problem

The StickyAssignor exists because rebalances are expensive at scale. When a consumer group has 50 consumers and 200 partitions, a round-robin rebalance during a rolling deployment moves nearly every partition to a new consumer. If each consumer maintains a local Bloom filter or LRU cache per partition, each partition move forces a cold-start rebuild that temporarily degrades throughput. The sticky assignor limits partition movement to only the partitions that were held by the consumer that left, typically 4 out of 200 in a rolling restart scenario.

The in-sync replica (ISR) set is the production concern that the code sketch above leaves blank. The `ISR []string` field on the Partition struct represents the set of follower replicas that are fully caught up with the leader. The leader only acknowledges a write to the producer after all ISR members confirm they have replicated it. When a replica falls behind (network partition, disk slowdown), it is removed from the ISR set, and the leader can continue acknowledging writes to the smaller ISR. The minimum ISR size (`min.insync.replicas`) is the floor: if the ISR shrinks below this value, the partition becomes read-only to prevent data loss.

Staff-level governance: partition count growth must be governed because increasing partition count on a live topic requires a coordinated migration. The platform team should define a maximum partition count per topic (128 or 256 is a common limit) and a process for requesting exceptions. Topics that approach this limit are candidates for topic sharding (splitting one logical topic into multiple physical topics with a routing layer) or compaction (removing duplicate keys to reduce retention). Both solutions require coordination between the platform team and the consuming service teams, making partition count a shared governance concern rather than a per-team implementation detail.