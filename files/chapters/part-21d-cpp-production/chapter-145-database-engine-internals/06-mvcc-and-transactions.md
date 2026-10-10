## MVCC and Transaction Management

Multi-Version Concurrency Control (MVCC) is the answer to the oldest concurrency problem in databases: how do you let readers and writers operate simultaneously without one blocking the other? The naive solution, exclusive locks for both reads and writes, means a long-running report query blocks every concurrent UPDATE. MVCC solves this by keeping multiple versions of each row. Readers see a consistent snapshot of the database from the moment their transaction started. Writers create new versions rather than modifying existing ones. Neither blocks the other.

PostgreSQL, MySQL InnoDB, Oracle, SQL Server Snapshot Isolation, CockroachDB, TiKV, all use MVCC.

### Version Storage Strategies

**Append-only storage (PostgreSQL)**: New tuple versions are appended to the same heap page as old versions. Each tuple has `xmin` (the transaction ID that created it) and `xmax` (the transaction ID that deleted/updated it, or 0 if still live). A read must check visibility rules to find the correct version.

**Delta storage (InnoDB)**: The main record holds the latest version. A separate "undo log" segment stores the delta needed to reconstruct older versions. Reads that need older versions walk the undo chain. This is faster for current-version reads but adds overhead for historical reads.

### Transaction Metadata

Each transaction in this MVCC implementation carries a `txn_id`, `start_ts` (the timestamp at which it began), and sets for rows it has written, used by the conflict detection logic to identify write-write conflicts at commit time. The global `active_transactions` map, protected by a shared mutex, lets any transaction determine whether another transaction was in progress at its start time, which is the core visibility check for snapshot isolation.
```cpp
#include <atomic>
#include <cassert>
#include <cstdint>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using txn_id_t   = uint64_t;
using timestamp_t = uint64_t;

enum class IsolationLevel {
    READ_COMMITTED,
    REPEATABLE_READ,
    SERIALIZABLE,
};

struct TxnMeta {
    txn_id_t       txn_id;
    timestamp_t    start_ts;       // snapshot timestamp
    timestamp_t    commit_ts = 0;  // set on commit, 0 = not committed
    IsolationLevel iso;
    bool           aborted = false;

    // For SSI: track read/write sets for conflict detection
    std::unordered_set<uint64_t> read_set;   // row IDs read
    std::unordered_set<uint64_t> write_set;  // row IDs written
};
```

### Tuple Version Chain

`TupleVersion` models a row version with `created_by` (xmin) and `deleted_by` (xmax) transaction IDs. A reader walks the version chain from newest to oldest looking for the first version where `created_by` committed before the reader's snapshot and `deleted_by` is either zero or committed after the snapshot. This linked-list version chain is the same structure used by PostgreSQL's heap pages, where VACUUM's job is to prune versions that no active transaction can ever see.
```cpp
struct TupleVersion {
    uint64_t           row_id;
    txn_id_t           created_by;   // xmin: transaction that created this version
    txn_id_t           deleted_by;   // xmax: transaction that deleted it (0 = live)
    std::vector<int64_t> data;
    TupleVersion*      next_version = nullptr;  // older version chain
};

// The row_map holds the head of each row's version chain (newest first)
std::unordered_map<uint64_t, TupleVersion*> row_map;
```

### Visibility Rules

The core of MVCC is the visibility function: given a tuple version and an active transaction, is this version visible?

```cpp
class MVCCManager {
    std::atomic<timestamp_t>                      global_ts_{1};
    std::unordered_map<txn_id_t, TxnMeta>         active_txns_;
    mutable std::shared_mutex                     mu_;

public:
    TxnMeta& begin_txn(txn_id_t txn_id, IsolationLevel iso) {
        std::unique_lock lock(mu_);
        auto& meta       = active_txns_[txn_id];
        meta.txn_id      = txn_id;
        meta.start_ts    = global_ts_.fetch_add(1);
        meta.iso         = iso;
        meta.aborted     = false;
        return meta;
    }

    // Is this tuple version visible to 'reader'?
    // PostgreSQL uses nearly this exact logic in HeapTupleSatisfiesMVCC().
    bool is_visible(const TupleVersion& ver, const TxnMeta& reader) const {
        std::shared_lock lock(mu_);

        // The version must have been committed before the reader's snapshot.
        // For READ COMMITTED: before the current statement's snapshot.
        // For REPEATABLE READ / SERIALIZABLE: before the transaction's start_ts.
        timestamp_t snapshot = reader.start_ts;

        // Check creator: version is visible only if its creator committed
        // before our snapshot.
        auto it = active_txns_.find(ver.created_by);
        bool creator_committed = false;
        timestamp_t creator_commit_ts = 0;

        if (it != active_txns_.end()) {
            creator_committed  = (it->second.commit_ts != 0);
            creator_commit_ts  = it->second.commit_ts;
        } else {
            // Transaction no longer in active list: it committed long ago.
            creator_committed  = true;
            creator_commit_ts  = 0;  // unknown; treat as very old
        }

        if (!creator_committed) {
            // Version created by an uncommitted transaction: not visible,
            // UNLESS it's our own transaction (we can see our own writes).
            return ver.created_by == reader.txn_id;
        }

        if (creator_commit_ts > snapshot) {
            return false;  // created after our snapshot
        }

        // Check deleter: if xmax is set and committed before our snapshot,
        // this version has been superseded, not visible.
        if (ver.deleted_by != 0) {
            auto del_it = active_txns_.find(ver.deleted_by);
            bool deleter_committed = (del_it == active_txns_.end()) ||
                                     (del_it->second.commit_ts != 0);
            timestamp_t del_commit_ts = (del_it != active_txns_.end())
                                      ? del_it->second.commit_ts : 0;

            if (deleter_committed && del_commit_ts <= snapshot) {
                return false;  // deleted before our snapshot
            }
            // Deleted by our own transaction: not visible either
            if (ver.deleted_by == reader.txn_id) return false;
        }

        return true;
    }

    // Read: find the visible version of row_id for this transaction
    std::optional<std::vector<int64_t>> read(
        uint64_t row_id, const TxnMeta& reader,
        const std::unordered_map<uint64_t, TupleVersion*>& rows) const
    {
        auto it = rows.find(row_id);
        if (it == rows.end()) return std::nullopt;

        // Walk version chain from newest to oldest
        for (TupleVersion* ver = it->second; ver; ver = ver->next_version) {
            if (is_visible(*ver, reader)) {
                return ver->data;
            }
        }
        return std::nullopt;
    }

    void commit_txn(txn_id_t txn_id) {
        std::unique_lock lock(mu_);
        auto it = active_txns_.find(txn_id);
        if (it == active_txns_.end()) return;
        it->second.commit_ts = global_ts_.fetch_add(1);
    }

    void abort_txn(txn_id_t txn_id) {
        std::unique_lock lock(mu_);
        auto it = active_txns_.find(txn_id);
        if (it == active_txns_.end()) return;
        it->second.aborted = true;
    }
};
```

### 2PL and Deadlock Detection

Two-Phase Locking (2PL) is the classical alternative/complement to MVCC. Under 2PL, a transaction acquires all its locks before releasing any (growing phase), then releases them (shrinking phase). This guarantees serializability but requires deadlock detection.

Deadlock detection uses a "waits-for" graph: node per transaction, directed edge from T1 to T2 when T1 is waiting for a lock held by T2. A cycle in this graph means deadlock.

```cpp
class DeadlockDetector {
    // waits_for_[T] = set of transactions T is waiting for
    std::unordered_map<txn_id_t, std::unordered_set<txn_id_t>> waits_for_;
    std::mutex mu_;

    // DFS cycle detection
    bool has_cycle_dfs(txn_id_t node,
                       std::unordered_set<txn_id_t>& visited,
                       std::unordered_set<txn_id_t>& in_stack) const
    {
        visited.insert(node);
        in_stack.insert(node);

        auto it = waits_for_.find(node);
        if (it != waits_for_.end()) {
            for (txn_id_t neighbor : it->second) {
                if (!visited.count(neighbor)) {
                    if (has_cycle_dfs(neighbor, visited, in_stack))
                        return true;
                } else if (in_stack.count(neighbor)) {
                    return true;  // back edge → cycle
                }
            }
        }
        in_stack.erase(node);
        return false;
    }

public:
    void add_wait(txn_id_t waiter, txn_id_t holder) {
        std::lock_guard lock(mu_);
        waits_for_[waiter].insert(holder);
    }

    void remove_wait(txn_id_t waiter, txn_id_t holder) {
        std::lock_guard lock(mu_);
        waits_for_[waiter].erase(holder);
    }

    // Returns the transaction to abort to break a deadlock, or 0 if none.
    txn_id_t detect_deadlock() {
        std::lock_guard lock(mu_);
        std::unordered_set<txn_id_t> visited, in_stack;
        for (auto& [txn, _] : waits_for_) {
            if (!visited.count(txn)) {
                if (has_cycle_dfs(txn, visited, in_stack)) {
                    // Victim selection: abort the youngest transaction (simple)
                    return txn;
                }
            }
        }
        return 0;
    }
};
```

### Isolation Levels and Anomalies

| Isolation Level | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| Read Uncommitted | possible | possible | possible |
| Read Committed | prevented | possible | possible |
| Repeatable Read | prevented | prevented | possible (MySQL) / prevented (PG) |
| Serializable | prevented | prevented | prevented |

PostgreSQL's MVCC prevents phantom reads even at Repeatable Read because it uses snapshot isolation, you see the state of the database as of your transaction start, and no concurrent inserts are visible. MySQL InnoDB's Repeatable Read has weaker guarantees under some conditions.

**Serializable Snapshot Isolation (SSI)**, implemented in PostgreSQL 9.1+ and CockroachDB, adds conflict detection on top of MVCC snapshot isolation. It tracks read/write dependencies between transactions (anti-dependency edges) and aborts transactions when a dangerous cycle forms. This achieves true serializability with significantly less blocking than 2PL.

### Garbage Collection

MVCC keeps old versions of rows around for active readers. These old versions must eventually be reclaimed. PostgreSQL calls this process VACUUM. InnoDB has a background purge thread.

VACUUM scans heap pages looking for tuple versions where `xmax` is committed and no active transaction has a start_ts older than that commit. Such versions are dead and can be reclaimed. This is why long-running transactions cause "table bloat" in PostgreSQL, they hold back the visibility horizon, preventing VACUUM from reclaiming dead versions.

### Go Comparison

CockroachDB implements a full MVCC storage layer in Go, layered on top of RocksDB (C++) via CGO. Each key is stored with a timestamp suffix, `key@timestamp`, enabling MVCC reads at any historical point. The visibility logic mirrors what we showed above. TiDB similarly implements MVCC in Go over a RocksDB-based storage engine (TiKV, written in Rust). The Go layer handles transaction coordination. The storage engines handle version storage.

---
