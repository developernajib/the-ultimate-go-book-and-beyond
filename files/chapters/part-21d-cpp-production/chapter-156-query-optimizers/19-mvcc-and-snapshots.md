## MVCC and Snapshots

Multi-version concurrency control lets readers see a consistent snapshot of the database while writers concurrently update it. For a query engine, MVCC is the discipline that makes long-running analytical queries safe in the presence of OLTP traffic. Every modern database (Postgres, CockroachDB, Spanner, Aurora, Hekaton, DuckDB) uses some form of MVCC.

This chapter covers the C++ patterns for snapshot reads, version chain management, and garbage collection.

### The MVCC Visibility Function

A row in MVCC is not a single value. It is a chain of versions, each tagged with `(creator_txn, deleter_txn)` or `(begin_ts, end_ts)`. A reader at snapshot timestamp T sees the version V such that `V.begin_ts <= T < V.end_ts`.

```cpp
#include <cstdint>
#include <atomic>
#include <vector>

namespace mvcc {

using TxnId = uint64_t;
using Timestamp = uint64_t;

constexpr TxnId kInvalidTxn = 0;
constexpr Timestamp kInfTime = ~Timestamp{0};

struct RowVersion {
    Timestamp begin_ts;
    Timestamp end_ts;     // kInfTime if still alive
    int64_t value;
    RowVersion* prev;     // older version chain pointer
};

class Row {
    std::atomic<RowVersion*> head_;

public:
    // Reader: find the version visible at snapshot ts.
    const RowVersion* Visible(Timestamp ts) const {
        RowVersion* v = head_.load(std::memory_order_acquire);
        while (v) {
            if (v->begin_ts <= ts && ts < v->end_ts) return v;
            v = v->prev;
        }
        return nullptr;  // no version visible (row did not exist yet)
    }

    // Writer: append a new version.
    void Insert(RowVersion* nv) {
        RowVersion* prev = head_.load(std::memory_order_acquire);
        do {
            nv->prev = prev;
        } while (!head_.compare_exchange_weak(prev, nv,
                                              std::memory_order_release,
                                              std::memory_order_acquire));
    }
};

}  // namespace mvcc
```

Two design choices in this skeleton matter.

**Atomic head pointer.** Multiple writers can append concurrently. The CAS loop ensures the version chain is correctly linked.

**Reader does not lock.** A reader walks the chain reading immutable fields. No mutex, no ref count. This is the central performance benefit of MVCC over locking.

### Transaction IDs vs Timestamps

Two flavors of MVCC.

**Transaction-ID-based** (Postgres). Each transaction gets a unique 32-bit XID. A version is visible to a snapshot if the version's creator XID is committed *and* the snapshot was taken *after* the creator's commit. The check requires a "snapshot" structure (`xmin`, `xmax`, list of in-progress XIDs at snapshot time).

**Timestamp-based** (CockroachDB, Spanner, Hekaton, DuckDB). Each version has a commit timestamp. A reader at timestamp T sees the version with the largest commit_ts <= T. No snapshot list, just timestamp comparison.

Timestamp-based is simpler and cleaner. Postgres uses XIDs for historical reasons (the format predates clean timestamp ordering). For new engines in 2026, use timestamps.

The challenge of timestamps: getting a global monotonic clock. Spanner uses TrueTime (atomic clocks + GPS). CockroachDB uses HLC (hybrid logical clocks). Hekaton uses a single 64-bit counter on each node (it is single-machine).

### Snapshot Isolation

A reader takes a snapshot at the start of its transaction or query. It sees all writes committed before the snapshot timestamp, none after. Within the snapshot, the database is logically immutable.

This is **snapshot isolation** (SI), and it is the strongest isolation level that does not block readers. SI has known anomalies (write skew, read skew across snapshots), and serializable SI (SSI, used by Postgres and CockroachDB) extends SI with conflict detection to prevent them.

For a query engine, the relevant guarantee is: long-running analytical queries see a consistent point-in-time view of the data, no matter how many concurrent OLTP transactions commit.

```cpp
namespace mvcc {

class Snapshot {
    Timestamp ts_;

public:
    explicit Snapshot(Timestamp t) : ts_(t) {}

    template <typename Iter>
    int64_t Sum(Iter begin, Iter end) const {
        int64_t s = 0;
        for (auto it = begin; it != end; ++it) {
            const RowVersion* v = it->Visible(ts_);
            if (v) s += v->value;
        }
        return s;
    }
};

}  // namespace mvcc
```

The sum operator runs over the chain following the visibility predicate. Concurrent writers can append new versions without interfering.

### Garbage Collection

Old versions accumulate. Eventually the version chain becomes long and reads slow down. The GC removes versions that no active snapshot can see.

```cpp
namespace mvcc {

class GarbageCollector {
    std::atomic<Timestamp> oldest_active_snapshot_{kInfTime};

public:
    void RegisterSnapshot(Timestamp ts) {
        Timestamp cur = oldest_active_snapshot_.load();
        while (ts < cur) {
            if (oldest_active_snapshot_.compare_exchange_weak(cur, ts)) break;
        }
    }

    // Returns true if v can be garbage collected.
    bool CanCollect(const RowVersion* v) const {
        return v->end_ts < oldest_active_snapshot_.load();
    }

    void Collect(Row* row) {
        // Walk chain, splice out collectible versions.
        RowVersion* prev = nullptr;
        RowVersion* cur = row->head_.load();
        while (cur) {
            if (CanCollect(cur)) {
                if (prev) prev->prev = cur->prev;
                else row->head_.store(cur->prev);
                Free(cur);
            } else {
                prev = cur;
            }
            cur = cur->prev;
        }
    }

    void Free(RowVersion*);
};

}  // namespace mvcc
```

Postgres has VACUUM (sometimes auto, sometimes manual). MySQL has the rollback segment. CockroachDB has the GC queue (per range). Spanner has automated GC tied to the snapshot resolution time.

For analytical engines that snapshot at the start of a query, the GC can be very aggressive: only the oldest active query holds versions. For OLTP, longer transactions hold versions longer.

### Hekaton: In-Memory MVCC

Microsoft Hekaton (Diaconu et al., 2013) is the canonical reference for high-performance in-memory MVCC. The design choices:

- **Latch-free.** No locks or mutexes anywhere. Atomic CAS for all updates.
- **Versions allocated from per-thread arenas.** Avoids global allocator contention.
- **Read-only transactions take a single timestamp.** No snapshot structure.
- **Optimistic concurrency control.** Writers check at commit that no conflicting versions exist. If a conflict is found, the transaction aborts.
- **No write locks.** Two writers to the same row create two versions, the second one fails commit if it conflicts.

Hekaton's throughput is in the millions of transactions per second on a single server. The design has influenced every modern in-memory engine.

### Optimistic Concurrency Control

OCC has three phases:

1. **Read phase.** Transaction reads, computes, but does not write to the global state.
2. **Validation phase.** Check that the read set has not been modified since the snapshot.
3. **Write phase.** Apply writes if validation passed, abort otherwise.

```cpp
namespace mvcc {

class OccTransaction {
    Timestamp snapshot_ts_;
    std::vector<std::pair<const Row*, const RowVersion*>> read_set_;
    std::vector<std::pair<Row*, int64_t>> writes_;

public:
    explicit OccTransaction(Timestamp ts) : snapshot_ts_(ts) {}

    int64_t Read(const Row& r) {
        auto v = r.Visible(snapshot_ts_);
        read_set_.emplace_back(&r, v);
        return v ? v->value : 0;
    }

    void Write(Row& r, int64_t value) {
        writes_.emplace_back(&r, value);
    }

    bool TryCommit(Timestamp commit_ts) {
        // Validate.
        for (auto& [row, version] : read_set_) {
            auto current = row->Visible(commit_ts);
            if (current != version) return false;  // changed under us
        }
        // Apply writes.
        for (auto& [row, value] : writes_) {
            auto* nv = new RowVersion{commit_ts, kInfTime, value, nullptr};
            row->Insert(nv);
        }
        return true;
    }
};

}  // namespace mvcc
```

For an analytical query that does not write, the validation phase is trivial. The read snapshot is the only mechanism needed.

### CockroachDB MVCC

CockroachDB stores rows in RocksDB (now Pebble) with composite keys `(table_id, primary_key, mvcc_timestamp)`. A scan iterates by key, and for each row primary key, it picks the latest version with timestamp <= snapshot_ts.

The implementation in `pkg/storage/mvcc.go` (Go, but the concepts apply) has interesting tricks:

- **MVCC sentinel keys.** A "live" version of a row is stored at timestamp 0, older versions are stored at their commit timestamps. Single-version reads (no historical scan) are one key lookup.
- **Garbage collection threshold.** Per-table TTL controls how long old versions are kept. For OLTP-heavy tables, 25 hours by default.
- **Range-level GC.** Each range tracks the oldest needed version, the GC queue removes older.

### Spanner MVCC

Spanner uses TrueTime to assign timestamps. A reader at timestamp T waits if T is in the "uncertainty interval" of the local clock (the window where TrueTime cannot guarantee monotonicity). This ensures linearizability across the cluster.

For analytical queries, Spanner offers "stale reads" with a user-specified bound (read 5 seconds in the past). Stale reads do not need to coordinate with the leader and run on any replica. F1 Query uses this for analytical workloads.

### DuckDB MVCC

DuckDB has in-memory MVCC for transactional consistency. The `RowGroup` structure (DuckDB's storage block) has an array of "version pointers" per row, pointing to chains of pre-update values. Reads pre-date their snapshot ts walk the chain.

DuckDB's MVCC is single-process (no distributed clock). Timestamps are local 64-bit counters. The simplicity is appropriate for an embedded analytical engine.

### What This Means for Query Engines

For a query engine sitting on top of MVCC storage:

1. **Snapshots are the integration point.** The engine takes a snapshot timestamp at query start and passes it to every scan operator.
2. **Scans must filter by visibility.** The scan operator iterates rows, applies visibility, emits visible rows.
3. **Statistics must respect snapshots.** Cardinality estimates are usually from a recent snapshot, but bounds (zone maps, histograms) might include uncommitted data. Be conservative.
4. **GC interacts with long queries.** A 1-hour analytical query can prevent GC of any version newer than 1 hour. This is a common cause of bloat in mixed OLTP/OLAP systems.

The next chapter covers how queries that exceed memory survive: spilling to disk.

---
