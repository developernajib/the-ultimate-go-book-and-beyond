## 52D.9 Snapshots for Performance

An account with 10,000 transactions requires replaying 10,000 events on every load. As the event count grows, aggregate reconstruction becomes the dominant cost in command handling latency. Snapshots solve this by periodically capturing the aggregate's full state at a known version. On subsequent loads, the repository reads the snapshot, then replays only the events recorded after the snapshot version, reducing O(N) replay to O(events since last snapshot).

```go
// internal/domain/account/snapshot.go

package account

import "time"

// Snapshot represents a point-in-time capture of an Account's state.
type Snapshot struct {
    AccountID     AccountID
    OwnerID       CustomerID
    BalanceCents  int64
    Currency      string
    Status        AccountStatus
    StreamVersion int
    SnapshotAt    time.Time
}

// TakeSnapshot captures the current state of the account for snapshotting.
func (a *Account) TakeSnapshot() Snapshot {
    return Snapshot{
        AccountID:     a.id,
        OwnerID:       a.ownerID,
        BalanceCents:  a.balanceCents,
        Currency:      a.currency,
        Status:        a.status,
        StreamVersion: a.version,
        SnapshotAt:    time.Now(),
    }
}

// LoadFromSnapshotAndHistory reconstitutes an Account from a snapshot + recent events.
func LoadFromSnapshotAndHistory(snap *Snapshot, events []DomainEvent) (*Account, error) {
    a := &Account{
        id:           snap.AccountID,
        ownerID:      snap.OwnerID,
        balanceCents: snap.BalanceCents,
        currency:     snap.Currency,
        status:       snap.Status,
        version:      snap.StreamVersion,
    }
    // Apply only the events after the snapshot
    for _, event := range events {
        a.apply(event, false)
        a.version++
    }
    return a, nil
}
```

The snapshotting policy (how often to take a snapshot) is in the infrastructure layer:

```go
// After saving an account, check if a snapshot is due
const snapshotEvery = 50 // Take a snapshot every 50 events

func (r *AccountRepository) SaveWithSnapshot(ctx context.Context, a *account.Account) error {
    if err := r.Save(ctx, a); err != nil {
        return err
    }
    // Take a snapshot every N events
    if a.Version()%snapshotEvery == 0 {
        snapshot := a.TakeSnapshot()
        if err := r.saveSnapshot(ctx, snapshot); err != nil {
            // Log but don't fail, snapshotting is an optimization, not a requirement
            return nil
        }
    }
    return nil
}
```

### Snapshot Schema in Postgres

```sql
CREATE TABLE aggregate_snapshots (
    stream_id       VARCHAR(255) PRIMARY KEY,
    stream_version  INT          NOT NULL,
    aggregate_type  VARCHAR(100) NOT NULL,
    schema_version  INT          NOT NULL,
    state           JSONB        NOT NULL,
    taken_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

One row per aggregate, overwritten on each new snapshot. The `schema_version` column is load-bearing: when the aggregate's serialized shape changes, bump it, and on load reject or discard snapshots with a stale `schema_version` and fall back to full replay. This is how you avoid the classic trap where a snapshot written by v1 code silently produces wrong state after a v2 refactor.

### Picking the Snapshot Interval

The "every N events" rule has two tensions. Too frequent and you waste storage plus write amplification (snapshots are large compared to events). Too infrequent and cold-load latency creeps up. A rough default: pick N so that reloading from the latest snapshot plus tail events takes under ~10ms on your hardware. For typical Go aggregates on Postgres that lands between 50 and 500 events. Measure, do not guess.

Alternative policies worth knowing:

- **Time-based**: snapshot once per day per active aggregate. Simpler for low-traffic aggregates.
- **Load-triggered**: on load, if `tail_events > threshold`, write a snapshot after the command completes. Self-tuning, no scheduler needed.
- **Out-of-band**: a background worker snapshots the top-K hottest streams. Keeps the command path lean.

> **Senior track**: Snapshots are a cache, not a system of record. The event log is still the source of truth. If a snapshot is corrupt, missing, or from an incompatible schema version, the code must fall back to full replay without ceremony. Test this path explicitly, delete every snapshot in staging and verify the system still works, just slower. Teams that skip this test discover in production that a snapshot format change bricked every aggregate load.

### Junior → FAANG: Snapshots as a Performance Cache

The snapshot mental model is: think of a snapshot as a bookmark in a long book. Instead of reading from page 1 every time, you open the book at the bookmark and read from there. The "bookmark" is the serialized aggregate state at version N. On load, the repository reads the bookmark, then reads only the pages (events) after it.

The `TakeSnapshot() Snapshot` method on the aggregate is intentionally simple: it returns a pure data struct with no behavior. The snapshot struct is not an aggregate. It is just a bag of fields. The reason is important: the infrastructure layer decides when to take snapshots and how to serialize them. The domain should not know about JSON, PostgreSQL, or snapshot intervals.

`LoadFromSnapshotAndHistory` is the companion to `LoadFromHistory`. The difference is the starting state: `LoadFromHistory` starts from a zero-value aggregate, while `LoadFromSnapshotAndHistory` starts from the snapshot struct's values. After that, both apply any remaining events the same way.

The `schema_version` column in the snapshot table is your safety net. When you change the `Snapshot` struct (add or remove a field), bump `schema_version` by 1. On load, if the schema version does not match the current code's expected version, discard the snapshot and fall back to full replay. Write a test that creates a snapshot with `schema_version=1`, then loads it with code that expects `schema_version=2`, and verifies the fallback happens without error.

First-job habit: add a metric for "snapshot fallback rate." If it suddenly spikes to 100%, a snapshot format change was deployed without bumping the version. You want to know immediately, not from a support ticket.

### Senior @ FAANG: Snapshot Rollout Safety, Write Amplification, and Alternative Strategies

The "snapshot every N events" policy looks simple but has several production failure modes that require deliberate design.

The first is snapshot write failure in the critical path. The `SaveWithSnapshot` implementation in this section swallows the snapshot write error (`return nil` after logging). This is intentional: snapshotting is an optimization, not a requirement. But it means a persistent snapshot failure (disk full, permission denied, serialization bug) is silent until the aggregate's load latency degrades noticeably. The correct observability pattern is: track snapshot write failures as a metric with an alert threshold, and track aggregate load latency with a histogram that shows when P99 exceeds the baseline. The combination catches silent failures before they become customer-visible.

The second is write amplification. Every N events, you write a snapshot. If N=50 and the average event is 500 bytes, you write a snapshot every 25 KB of events. The snapshot for a complex aggregate might be 5 KB. Write amplification ratio is 5 KB / 25 KB = 20%. Acceptable. If the snapshot is 50 KB (a large aggregate with many fields), the ratio is 200%. You are writing twice as much data for snapshots as for events. Pick N based on measured snapshot size relative to event throughput, not a hardcoded default.

The third is the rolling snapshot migration. When you bump `schema_version` on the snapshot struct, the old snapshots become unusable. Every aggregate load falls back to full replay until a new snapshot is written at the current schema version. For aggregates with millions of events, this means the first load after a snapshot schema change is extremely slow. The migration strategy: after deploying the new code, run a background job that loads every aggregate (triggering full replay once) and writes a new snapshot in the current schema version. This "warms up" the snapshot table with v2 snapshots before load traffic increases. Without this warmup, your first deploy that changes snapshot schema causes a production performance regression.

The "out-of-band background worker" snapshot policy mentioned in this section is the correct design for high-traffic production systems. The command path should be fast and predictable. Writing a snapshot on every 50th command adds a variable latency spike every 50 requests. Moving snapshot writes to a background process (which reads the event store asynchronously and writes snapshots independently of the command path) eliminates this spike. The background worker can use the "load-triggered" policy: when it observes that a stream has more than N unsnapshotted events past the latest snapshot, it writes a new snapshot. This is self-tuning and requires no scheduled cron.

---
