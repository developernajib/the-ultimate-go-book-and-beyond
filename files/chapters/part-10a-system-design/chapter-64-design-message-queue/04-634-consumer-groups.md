## 64.4 Consumer Groups

Consumer groups allow multiple consumers to cooperatively process a topic's partitions, with each partition assigned exclusively to one consumer in the group at a time. When consumers join or leave the group, the coordinator triggers a rebalance that redistributes partition assignments, ensuring all partitions remain covered without duplicate processing. The group coordinator tracks each consumer's committed offset so that after a rebalance or consumer restart, the new assignee resumes from the last committed position rather than reprocessing from the beginning.

```go
// consumer/group.go
package consumer

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "time"
)

var (
    ErrUnknownGroup      = errors.New("unknown group")
    ErrUnknownMember     = errors.New("unknown member")
    ErrIllegalGeneration = errors.New("illegal generation")
)

type JoinGroupRequest struct {
    GroupID        string
    MemberID       string
    ClientID       string
    Metadata       []byte
    SessionTimeout time.Duration
    Topics         []string
}

type JoinGroupResponse struct {
    Generation int32
    Protocol   string
    LeaderID   string
    MemberID   string
    Members    []GroupMember
}

type SyncGroupRequest struct {
    GroupID     string
    MemberID    string
    Assignments map[string][]TopicPartition
}

type SyncGroupResponse struct {
    Assignment []TopicPartition
}

type HeartbeatRequest struct {
    GroupID    string
    MemberID   string
    Generation int32
}

type LeaveGroupRequest struct {
    GroupID  string
    MemberID string
}

func generateMemberID(clientID string) string {
    return fmt.Sprintf("%s-%d", clientID, time.Now().UnixNano())
}

// ConsumerGroup manages a group of consumers
type ConsumerGroup struct {
    mu             sync.RWMutex
    GroupID        string
    Members        map[string]*GroupMember
    Leader         string
    Generation     int32
    ProtocolType   string
    Protocol       string
    Coordinator    *Coordinator
    Assignor       PartitionAssignor
    SessionTimeout time.Duration
}

// GroupMember represents a member of the consumer group
type GroupMember struct {
    MemberID     string
    ClientID     string
    Metadata     []byte
    Assignment   []TopicPartition
    LastHeartbeat time.Time
}

// Coordinator manages consumer group coordination
type Coordinator struct {
    mu           sync.RWMutex
    groups       map[string]*ConsumerGroup
    offsetStore  OffsetStore
}

// NewCoordinator creates a new coordinator
func NewCoordinator(offsetStore OffsetStore) *Coordinator {
    return &Coordinator{
        groups:      make(map[string]*ConsumerGroup),
        offsetStore: offsetStore,
    }
}

// JoinGroup handles a consumer joining a group
func (c *Coordinator) JoinGroup(ctx context.Context, req *JoinGroupRequest) (*JoinGroupResponse, error) {
    c.mu.Lock()
    defer c.mu.Unlock()

    group, ok := c.groups[req.GroupID]
    if !ok {
        group = &ConsumerGroup{
            GroupID:        req.GroupID,
            Members:        make(map[string]*GroupMember),
            SessionTimeout: req.SessionTimeout,
            Assignor:       &RangeAssignor{},
        }
        c.groups[req.GroupID] = group
    }

    // Generate member ID if not provided
    memberID := req.MemberID
    if memberID == "" {
        memberID = generateMemberID(req.ClientID)
    }

    // Add member
    member := &GroupMember{
        MemberID:      memberID,
        ClientID:      req.ClientID,
        Metadata:      req.Metadata,
        LastHeartbeat: time.Now(),
    }
    group.Members[memberID] = member

    // Elect leader if needed
    if group.Leader == "" || group.Members[group.Leader] == nil {
        group.Leader = memberID
    }

    group.Generation++

    return &JoinGroupResponse{
        Generation:  group.Generation,
        Protocol:    group.Protocol,
        LeaderID:    group.Leader,
        MemberID:    memberID,
        Members:     c.getMemberList(group),
    }, nil
}

// SyncGroup handles partition assignment sync
func (c *Coordinator) SyncGroup(ctx context.Context, req *SyncGroupRequest) (*SyncGroupResponse, error) {
    c.mu.Lock()
    defer c.mu.Unlock()

    group, ok := c.groups[req.GroupID]
    if !ok {
        return nil, ErrUnknownGroup
    }

    // If this is the leader, store assignments
    if req.MemberID == group.Leader {
        for memberID, assignment := range req.Assignments {
            if member, ok := group.Members[memberID]; ok {
                member.Assignment = assignment
            }
        }
    }

    // Return this member's assignment
    member := group.Members[req.MemberID]
    if member == nil {
        return nil, ErrUnknownMember
    }

    return &SyncGroupResponse{
        Assignment: member.Assignment,
    }, nil
}

// Heartbeat handles consumer heartbeat
func (c *Coordinator) Heartbeat(ctx context.Context, req *HeartbeatRequest) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    group, ok := c.groups[req.GroupID]
    if !ok {
        return ErrUnknownGroup
    }

    member, ok := group.Members[req.MemberID]
    if !ok {
        return ErrUnknownMember
    }

    if req.Generation != group.Generation {
        return ErrIllegalGeneration
    }

    member.LastHeartbeat = time.Now()
    return nil
}

// LeaveGroup handles a consumer leaving
func (c *Coordinator) LeaveGroup(ctx context.Context, req *LeaveGroupRequest) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    group, ok := c.groups[req.GroupID]
    if !ok {
        return nil
    }

    delete(group.Members, req.MemberID)

    // Trigger rebalance
    if len(group.Members) > 0 {
        group.Generation++
    } else {
        delete(c.groups, req.GroupID)
    }

    return nil
}

// CommitOffset commits an offset for a consumer group
func (c *Coordinator) CommitOffset(ctx context.Context, groupID string, tp TopicPartition, offset int64) error {
    return c.offsetStore.Commit(ctx, groupID, tp, offset)
}

// FetchOffset fetches the committed offset
func (c *Coordinator) FetchOffset(ctx context.Context, groupID string, tp TopicPartition) (int64, error) {
    return c.offsetStore.Fetch(ctx, groupID, tp)
}

func (c *Coordinator) getMemberList(group *ConsumerGroup) []GroupMember {
    members := make([]GroupMember, 0, len(group.Members))
    for _, m := range group.Members {
        members = append(members, *m)
    }
    return members
}
```

### Offset Management

Offset management is what transforms a message queue into a fault-tolerant processing pipeline: by persisting the last-processed offset per group and partition, a consumer can resume exactly where it left off after a crash or rebalance rather than reprocessing from the beginning. The `RedisOffsetStore` encodes each committed offset as a JSON blob keyed by `{prefix}:{groupID}:{topic}:{partition}`, making it fast to fetch a single partition's position during rebalance assignment and scannable via pattern matching when auditing an entire group's lag. Storing the commit timestamp alongside the offset enables lag monitoring, comparing `time.Now()` against the `Timestamp` field reveals how far behind a consumer group has fallen without needing to query the broker's head offset.

```go
// consumer/offset.go
package consumer

import (
    "context"
    "encoding/json"
    "fmt"
    "strconv"
    "strings"
    "time"

    "github.com/redis/go-redis/v9"
)

// OffsetStore stores consumer offsets
type OffsetStore interface {
    Commit(ctx context.Context, groupID string, tp TopicPartition, offset int64) error
    Fetch(ctx context.Context, groupID string, tp TopicPartition) (int64, error)
    FetchAll(ctx context.Context, groupID string) (map[TopicPartition]int64, error)
}

// RedisOffsetStore stores offsets in Redis
type RedisOffsetStore struct {
    client *redis.Client
    prefix string
}

// NewRedisOffsetStore creates a Redis offset store
func NewRedisOffsetStore(client *redis.Client, prefix string) *RedisOffsetStore {
    return &RedisOffsetStore{
        client: client,
        prefix: prefix,
    }
}

func (s *RedisOffsetStore) key(groupID string, tp TopicPartition) string {
    return fmt.Sprintf("%s:%s:%s:%d", s.prefix, groupID, tp.Topic, tp.Partition)
}

// Commit commits an offset
func (s *RedisOffsetStore) Commit(ctx context.Context, groupID string, tp TopicPartition, offset int64) error {
    key := s.key(groupID, tp)

    data := OffsetCommit{
        Offset:    offset,
        Timestamp: time.Now(),
    }

    jsonData, err := json.Marshal(data)
    if err != nil {
        return err
    }

    return s.client.Set(ctx, key, jsonData, 0).Err()
}

// Fetch fetches a committed offset
func (s *RedisOffsetStore) Fetch(ctx context.Context, groupID string, tp TopicPartition) (int64, error) {
    key := s.key(groupID, tp)

    jsonData, err := s.client.Get(ctx, key).Bytes()
    if err == redis.Nil {
        return -1, nil // No committed offset
    }
    if err != nil {
        return 0, err
    }

    var data OffsetCommit
    if err := json.Unmarshal(jsonData, &data); err != nil {
        return 0, err
    }

    return data.Offset, nil
}

// FetchAll fetches all committed offsets for a group
func (s *RedisOffsetStore) FetchAll(ctx context.Context, groupID string) (map[TopicPartition]int64, error) {
    pattern := fmt.Sprintf("%s:%s:*", s.prefix, groupID)
    keys, err := s.client.Keys(ctx, pattern).Result()
    if err != nil {
        return nil, err
    }

    offsets := make(map[TopicPartition]int64)

    for _, key := range keys {
        jsonData, err := s.client.Get(ctx, key).Bytes()
        if err != nil {
            continue
        }

        var data OffsetCommit
        if err := json.Unmarshal(jsonData, &data); err != nil {
            continue
        }

        // Parse topic and partition from the key
        // {prefix}:{groupID}:{topic}:{partition}. Sscanf with %s does
        // NOT work here: %s matches all non-whitespace greedily and
        // would swallow the colon-separated remainder in one token.
        parts := strings.Split(key, ":")
        if len(parts) < 4 {
            continue
        }
        topic := parts[len(parts)-2]
        partition, err := strconv.Atoi(parts[len(parts)-1])
        if err != nil {
            continue
        }

        offsets[TopicPartition{Topic: topic, Partition: int32(partition)}] = data.Offset
    }

    return offsets, nil
}

// OffsetCommit represents a committed offset
type OffsetCommit struct {
    Offset    int64     `json:"offset"`
    Timestamp time.Time `json:"timestamp"`
    Metadata  string    `json:"metadata,omitempty"`
}
```

---

### Junior -> FAANG: Consumer Group Coordination and Why It Matters

Consumer groups are Kafka's solution to the competing-consumers pattern. Each partition is owned exclusively by one consumer in the group at a time. This exclusive ownership is what prevents duplicate processing during normal operation. The coordinator tracks generation numbers to detect stale consumers: if a consumer sends a heartbeat with an old generation number, the coordinator rejects it with `ErrIllegalGeneration`, signaling that a rebalance occurred and the consumer must rejoin.

The offset commit is where most junior errors happen. Auto-commit commits the last-fetched offset on a timer, regardless of whether that message was successfully processed. If the timer fires after the message was fetched but before it was processed, the offset is committed and the message is effectively dropped on crash. The safe pattern is always to disable auto-commit, process the message, and only then commit the offset manually. This gives at-least-once delivery: if the process crashes after processing but before committing, the message will be redelivered on restart.

Interview framing: "What happens when a consumer crashes?" The coordinator detects the missed heartbeat after `session.timeout.ms`. It removes the consumer from the group, increments the generation, and triggers a rebalance. The remaining consumers request new assignments. After the rebalance, each consumer fetches the committed offset for its newly assigned partitions and resumes from there. The window between the last commit and the crash results in reprocessing of those messages, which is why idempotent consumers are required.

### Senior @ FAANG: Coordinator Design and Rebalance Storm Mitigation

The group coordinator as implemented here uses a global mutex that serializes all JoinGroup, SyncGroup, and Heartbeat operations. At small scale this is fine. At large scale (consumer groups with hundreds of members), contention on this mutex becomes the bottleneck. Kafka's production coordinator shards groups across multiple broker instances using consistent hashing on the group ID, so each coordinator owns a disjoint subset of groups and there is no cross-group contention.

Rebalance storms are the most operationally painful failure mode in large consumer groups. A storm occurs when consumers join and leave the group faster than each rebalance can complete. Common triggers: rolling deployments that cycle consumers one at a time (each restart triggers a rebalance before the previous one completes), high GC pause times that cause heartbeat timeouts, and network partition events that disconnect multiple consumers simultaneously. The mitigations are incremental cooperative rebalancing (introduced in Kafka 2.4), which allows consumers to continue processing unrevoked partitions during a rebalance rather than stopping all processing until the new assignment is confirmed, and `max.poll.interval.ms` tuning to allow longer processing windows before a consumer is considered dead.

The offset store is a subtle governance point. Storing offsets in Redis (as shown here) is fast but introduces a dependency: if Redis is unavailable, consumers cannot commit or fetch offsets, effectively halting all consumer group coordination. Kafka's internal `__consumer_offsets` topic is a more durable choice because it has the same availability guarantees as the Kafka cluster itself and does not require an external dependency. Redis offset storage is appropriate for high-performance scenarios where Redis is already a critical dependency and the offset commit rate would saturate Kafka's internal topic. Document the trade-off in an ADR so the team that inherits this system understands why the dependency exists.