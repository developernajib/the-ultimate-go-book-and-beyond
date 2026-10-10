## Distributed Transactions

A distributed transaction spans multiple shards or services and must commit atomically: either all participants apply, or none. Five protocols dominate the production landscape: 2PC, 3PC, Saga, Percolator, and Calvin. Each has a regime where it is the right answer.

### Two-Phase Commit (2PC)

The textbook protocol. A coordinator orchestrates participants through prepare and commit phases.

**Phase 1 (Prepare)**. Coordinator sends `Prepare` to all participants. Each participant durably records the intent and replies `Yes` or `No`.

**Phase 2 (Commit/Abort)**. If all replies are Yes, coordinator durably records `Commit` and tells all participants to commit. Otherwise it tells them to abort.

```cpp
class Coordinator {
public:
    absl::Status Commit(TxnId tx, const std::vector<Participant*>& parts) {
        // Phase 1.
        std::vector<bool> votes(parts.size(), false);
        for (size_t i = 0; i < parts.size(); ++i) {
            auto v = parts[i]->Prepare(tx);
            if (!v.ok() || !v.value()) {
                AbortAll(tx, parts);
                return absl::AbortedError("vote failed");
            }
            votes[i] = true;
        }
        // Decision point: durably record COMMIT before notifying.
        log_->WriteCommit(tx);

        // Phase 2.
        for (auto* p : parts) p->Commit(tx);
        return absl::OkStatus();
    }
};
```

#### The 2PC Hang

If the coordinator crashes after recording `Commit` but before notifying participants, participants are stuck *prepared*. They cannot abort (the coordinator decided to commit) and cannot commit (they have not been told). They wait, holding locks, until the coordinator recovers.

This is the canonical reason 2PC has a bad reputation: a crashed coordinator can stall the participants indefinitely, sometimes called the *blocking problem*.

The standard mitigation is to make the coordinator itself replicated (Raft-replicated coordinator log), so a coordinator failure produces a successor that can recover the transaction. Spanner does exactly this: its commit coordinators are Paxos groups.

### Three-Phase Commit (3PC)

3PC adds a third phase to break the blocking property: a `PreCommit` phase between Prepare and Commit. The intuition is that participants can then time out and proceed safely. Theoretically, 3PC is non-blocking under fail-stop assumptions.

In practice, 3PC is rarely used. The non-blocking guarantee assumes a synchronous network (bounded delay). Real networks violate this, and 3PC's added round trip costs more than its theoretical benefit. Replicated-coordinator 2PC is the production answer.

### The Saga Pattern

A Saga is a sequence of local transactions, each with a *compensating action* that undoes its effect. If any step fails, previously-completed steps are rolled back by running their compensations in reverse order.

```cpp
struct SagaStep {
    std::function<absl::Status()> action;
    std::function<absl::Status()> compensation;
    std::string name;
};

absl::Status RunSaga(const std::vector<SagaStep>& steps) {
    std::vector<size_t> completed;
    for (size_t i = 0; i < steps.size(); ++i) {
        auto s = steps[i].action();
        if (!s.ok()) {
            for (auto it = completed.rbegin(); it != completed.rend(); ++it) {
                steps[*it].compensation();
            }
            return s;
        }
        completed.push_back(i);
    }
    return absl::OkStatus();
}
```

Sagas are not transactions in the ACID sense. There is a window where the system is in a partially-committed state. Other observers can see it. The compensation runs *after* the failure, not atomically with it.

When to choose Saga:
- Long-running workflows (booking flight + hotel + car).
- Cross-service operations where 2PC is impractical (different organizations, different stacks).
- Eventually consistent business processes where the partial state is tolerable.

When not to choose Saga:
- Workflows where the partial state is unsafe (a transfer where money has left the source but not arrived at the destination).

For unsafe partial states, either use 2PC or design the operation to be one-sided (transfer is two operations: debit-source, credit-destination, with a reconciliation job).

### Percolator: Bigtable's Transactional Layer

Google's Percolator (Peng & Dabek, 2010) provides snapshot-isolation transactions on top of Bigtable. It uses optimistic concurrency control with timestamps from a Timestamp Oracle.

Each row has additional columns: `lock`, `write`, `data`. A transaction:

1. Picks a start timestamp `ts_start` from the Oracle.
2. For each write, locks the row at `ts_start` and stages the new value.
3. Picks a commit timestamp `ts_commit` from the Oracle (after all locks acquired).
4. For one designated *primary* row, atomically replaces the lock with a write record at `ts_commit` (using Bigtable's row-level atomicity).
5. For each secondary row, asynchronously replaces lock with write.

The atomicity at step 4 is the magic. The primary's lock-to-write transition is the commit point. Secondary rows can be committed lazily, and a reader that finds an orphaned lock can resolve it by checking the primary's state.

```cpp
class PercolatorTxn {
public:
    void Set(Key k, Value v) { writes_[k] = v; }

    absl::Status Commit() {
        auto ts_start = oracle_->Now();
        // Prewrite phase: acquire locks on all rows.
        Key primary = writes_.begin()->first;
        for (const auto& [k, v] : writes_) {
            if (!Prewrite(k, v, ts_start, primary)) {
                Rollback(ts_start);
                return absl::AbortedError("conflict");
            }
        }

        auto ts_commit = oracle_->Now();
        // Commit primary atomically.
        if (!CommitRow(primary, ts_start, ts_commit, /*primary=*/true)) {
            Rollback(ts_start);
            return absl::AbortedError("primary commit failed");
        }
        // Commit secondaries asynchronously.
        for (const auto& [k, v] : writes_) {
            if (k == primary) continue;
            CommitRow(k, ts_start, ts_commit, /*primary=*/false);
        }
        return absl::OkStatus();
    }
};
```

TiKV's transaction layer is a faithful Percolator port to C++ via Rust. The Percolator design lets you build a transactional database on top of a non-transactional one (Bigtable), trading higher latency (multiple Bigtable round trips per transaction) for the simplicity of using an existing storage layer.

### Calvin: Deterministic Transactions

Calvin (Thomson et al., 2012) replaces concurrency control with *determinism*. The core idea: have all replicas agree on the order of transactions ahead of time, then deterministically execute them. No locks, no rollback.

The architecture:

1. **Sequencer** layer batches incoming transactions and runs Paxos to agree on the global order.
2. **Scheduler** layer reads the order, dispatches each transaction to the worker that owns the data.
3. **Workers** execute deterministically. Because the order is fixed, two replicas executing the same batch produce identical state.

Calvin shines when transactions are short and known in advance (i.e., the read/write set is determined before execution). It struggles with interactive transactions where the next operation depends on the previous result.

FaunaDB is a commercial implementation. The original Calvin codebase is a research artifact in C++.

### Choosing a Protocol

| Workload | Choose |
|----------|--------|
| Cross-shard ACID, willing to pay locks + RTTs | 2PC with replicated coordinator |
| Long-running, cross-service workflow | Saga |
| OCC over an existing K/V store | Percolator |
| Short, predictable, throughput-bound | Calvin |
| Short-circuit single shard | Single-shard transaction (no protocol) |

The senior-engineer rule: avoid distributed transactions if you can. Single-shard transactions are 10-100x cheaper. Many systems achieve this by partitioning user data so all related operations land on the same shard (per-account sharding for billing, per-conversation sharding for messaging).

When a distributed transaction is unavoidable, prefer 2PC with a replicated coordinator and a strict per-transaction deadline. Add a background recovery job that resolves stuck transactions whose coordinator died.

### Spanner's Approach

Spanner combines several of these. Single-shard transactions use Paxos for replication and lock-based concurrency control within a tablet. Cross-shard transactions use 2PC across the tablet leaders, with the coordinator log itself replicated by Paxos. TrueTime provides external consistency: every transaction is assigned a commit timestamp, and the commit-wait ensures the timestamps respect real time order.

The result is the strongest consistency model offered at scale (external consistency), with a latency cost: cross-region commits take a TrueTime uncertainty interval (often 5-15 ms) plus the consensus round trips.

### Junior at FAANG: The Distributed Transaction Question

When asked "how would you transfer money between two accounts on different shards?", do not say "use a distributed transaction." Say: "If both accounts are within a single Raft group, single-shard transaction. If they span shards, 2PC with a Raft-replicated coordinator log so a coordinator crash does not hang participants. If 2PC's latency is unacceptable, a Saga with a debit followed by a credit, plus a reconciliation job that detects orphaned debits. The choice depends on consistency tolerance and tail latency budget."

That answer demonstrates you have thought about the operational consequences of each choice.

---
