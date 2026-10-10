## 63.5 Data Replication

Cache replication propagates writes from a primary node to replica nodes, providing read scalability and fault tolerance when the primary is unavailable. The replication log captures every write operation with a monotonically increasing offset, enabling replicas to request only the entries they haven't yet applied when reconnecting after a network partition. Asynchronous replication keeps the primary write path fast but allows replicas to serve slightly stale data. Synchronous replication ensures consistency at the cost of higher write latency.

```go
// replication/replication.go
package replication

import (
    "context"
    "sync"
    "time"
)

// ReplicationLog stores replication entries
type ReplicationLog struct {
    entries  []ReplicationEntry
    mu       sync.RWMutex
    maxSize  int
    sequence uint64
}

// ReplicationEntry represents a single replication entry
type ReplicationEntry struct {
    Sequence  uint64
    Operation string // "SET", "DELETE"
    Key       string
    Value     []byte
    TTL       time.Duration
    Timestamp time.Time
}

// NewReplicationLog creates a new replication log
func NewReplicationLog(maxSize int) *ReplicationLog {
    return &ReplicationLog{
        entries: make([]ReplicationEntry, 0, maxSize),
        maxSize: maxSize,
    }
}

// Append adds an entry to the log
func (l *ReplicationLog) Append(op, key string, value []byte, ttl time.Duration) uint64 {
    l.mu.Lock()
    defer l.mu.Unlock()

    l.sequence++
    entry := ReplicationEntry{
        Sequence:  l.sequence,
        Operation: op,
        Key:       key,
        Value:     value,
        TTL:       ttl,
        Timestamp: time.Now(),
    }

    l.entries = append(l.entries, entry)

    // Trim if too large
    if len(l.entries) > l.maxSize {
        l.entries = l.entries[len(l.entries)-l.maxSize:]
    }

    return l.sequence
}

// GetEntriesSince returns entries after a sequence number
func (l *ReplicationLog) GetEntriesSince(sequence uint64) []ReplicationEntry {
    l.mu.RLock()
    defer l.mu.RUnlock()

    result := make([]ReplicationEntry, 0)
    for _, entry := range l.entries {
        if entry.Sequence > sequence {
            result = append(result, entry)
        }
    }
    return result
}

// Replicator handles cache replication
type Replicator struct {
    primary  *CacheNode
    replicas []*CacheNode
    log      *ReplicationLog
    quit     chan struct{}
}

// NewReplicator creates a new replicator
func NewReplicator(primary *CacheNode, replicas []*CacheNode) *Replicator {
    r := &Replicator{
        primary:  primary,
        replicas: replicas,
        log:      NewReplicationLog(100000),
        quit:     make(chan struct{}),
    }

    go r.replicationLoop()

    return r
}

// ReplicateSet replicates a SET operation
func (r *Replicator) ReplicateSet(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    // Append to log
    seq := r.log.Append("SET", key, value, ttl)

    // Async replicate to followers
    go r.replicateToFollowers(seq)

    return nil
}

// ReplicateDelete replicates a DELETE operation
func (r *Replicator) ReplicateDelete(ctx context.Context, key string) error {
    seq := r.log.Append("DELETE", key, nil, 0)
    go r.replicateToFollowers(seq)
    return nil
}

func (r *Replicator) replicateToFollowers(upToSeq uint64) {
    var wg sync.WaitGroup

    for _, replica := range r.replicas {
        wg.Add(1)
        go func(node *CacheNode) {
            defer wg.Done()
            r.syncReplica(context.Background(), node, upToSeq)
        }(replica)
    }

    wg.Wait()
}

func (r *Replicator) syncReplica(ctx context.Context, replica *CacheNode, upToSeq uint64) {
    // Get replica's last known sequence
    lastSeq := replica.GetLastSequence()

    // Get entries to replicate
    entries := r.log.GetEntriesSince(lastSeq)

    for _, entry := range entries {
        if entry.Sequence > upToSeq {
            break
        }

        switch entry.Operation {
        case "SET":
            replica.Client.Set(ctx, entry.Key, entry.Value, entry.TTL)
        case "DELETE":
            replica.Client.Delete(ctx, entry.Key)
        }

        replica.SetLastSequence(entry.Sequence)
    }
}

func (r *Replicator) replicationLoop() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            // Periodic sync check. Snapshot the sequence under the
            // log's lock, reading it bare here would race with Append.
            r.log.mu.RLock()
            seq := r.log.sequence
            r.log.mu.RUnlock()

            for _, replica := range r.replicas {
                go r.syncReplica(context.Background(), replica, seq)
            }
        case <-r.quit:
            return
        }
    }
}

// Close stops the replicator
func (r *Replicator) Close() {
    close(r.quit)
}
```

### Junior -> FAANG: Replication Log as a Reliability Pattern

The replication log (sequence-numbered entries that replicas request since their last known sequence) is the same pattern used in database replication (MySQL binlog, Postgres WAL), message queues (Kafka consumer offsets), and distributed consensus (Raft log). Understanding this pattern once lets you reason about all of these systems with the same mental model.

The key property of the replication log is that it enables partial catch-up: a replica that was disconnected for 10 seconds does not need a full data transfer. It only needs the entries appended to the log during the 10-second gap. The `GetEntriesSince(sequence uint64)` method implements this: give the replica's last known sequence, get back only the delta.

The `maxSize` limit on the replication log (100,000 entries in the implementation) creates a gap condition: if a replica is disconnected longer than the time it takes to fill 100,000 log entries, it cannot catch up via the log and needs a full data snapshot instead. Know this limitation and the recovery path: a replica that detects it has fallen behind the log's retention window must request a full snapshot and restart from sequence 0.

The `replicationLoop` goroutine that ticks every second is a heartbeat-based catch-up mechanism. For replicas that are mostly caught up, this tick does nothing (no new entries since the last tick). For replicas that are catching up after a disconnect, this tick processes one batch of entries per second. If the replication rate is limited by this tick rate, increase the tick frequency or trigger replication immediately on each new log entry (event-driven rather than time-driven catch-up).

### Senior @ FAANG: Replication as an Operational and Consistency Concern

**Asynchronous vs synchronous replication is a durability trade-off**

The `ReplicateSet` method in the implementation is asynchronous: it appends to the log and returns immediately, then replicates to replicas in a background goroutine. This means the caller's write is acknowledged before the replicas have applied it. If the primary fails immediately after acknowledging the write but before the replica has applied it, the write is lost. For cache workloads, this is typically acceptable (the cache can be repopulated from the database). For any workload where cache loss means data loss (write-behind with no database backup), synchronous replication to at least one replica is required.

**Replica reads and the stale read window**

With asynchronous replication, reads from a replica return data that may be up to the replication lag behind the primary. At a typical LAN replication lag of 1-10ms, this is imperceptible. But under high write load or network congestion, replication lag can grow to seconds. Applications that read from replicas must document and accept the staleness they are tolerating, or use primary reads for data that must be fresh.

**The sequence counter is a single point of contention**

The `l.sequence++` increment in `Append` is protected by `l.mu` (the replication log's mutex). In a high-throughput cache, every write acquires this mutex, making the sequence counter a serialization point for all writes. An alternative is to use per-node sequence counters and a vector clock for ordering, which allows parallel writes to different key ranges without a global lock. This is more complex but eliminates the sequence counter bottleneck at extreme write throughput.

**Observing replication lag as a production metric**

The gap between `l.sequence` (the primary's current sequence) and each replica's `GetLastSequence()` is the replication lag in events. A production monitoring system tracks this gap as a metric and alerts when it exceeds a threshold (for example, more than 10,000 events behind, or more than 5 seconds of events based on the event creation timestamps). When the gap grows, it may indicate: network congestion between primary and replica, a replica that is CPU-bound (applying entries slower than they are appended), or a primary that is generating entries faster than the replica can consume. Each cause has a different remediation, and the replication lag metric is the starting point for diagnosis.

---
