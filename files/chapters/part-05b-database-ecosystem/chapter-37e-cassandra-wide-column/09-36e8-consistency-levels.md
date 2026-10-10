## 37E.8 Consistency Levels

### Tuning for Different Workloads

Cassandra's consistency level is set per-query, not per-cluster, so you can mix strong and eventual consistency within the same application. A financial balance check uses `QUORUM` (reads from a majority of replicas), while an analytics dashboard uses `LOCAL_ONE` (nearest replica, fastest response, possibly stale). The examples below show when to pick each level and how to apply them with `gocql`.

```go
package cassandra

import (
	"context"
	"github.com/gocql/gocql"
)

// ConsistencyExamples demonstrates when to use each consistency level
type ConsistencyExamples struct {
	session *gocql.Session
}

// StrongRead - QUORUM ensures latest data (RF=3: reads from 2 nodes)
// Use for: financial data, inventory, critical state
func (e *ConsistencyExamples) StrongRead(ctx context.Context, key string) (string, error) {
	var value string
	err := e.session.Query(`SELECT value FROM store WHERE key = ?`, key).
		WithContext(ctx).
		Consistency(gocql.Quorum). // reads from ⌈RF/2⌉ + 1 = 2 nodes
		Scan(&value)
	return value, err
}

// EventualRead - ONE or LOCAL_ONE: fastest, may return stale data
// Use for: analytics, recommendations, non-critical reads
func (e *ConsistencyExamples) EventualRead(ctx context.Context, key string) (string, error) {
	var value string
	err := e.session.Query(`SELECT value FROM store WHERE key = ?`, key).
		WithContext(ctx).
		Consistency(gocql.LocalOne). // reads from nearest available replica
		Scan(&value)
	return value, err
}

// LocalDCWrite - LOCAL_QUORUM: quorum within local DC only (no cross-DC latency)
// Use for: 99% of production writes - best durability/latency balance
func (e *ConsistencyExamples) LocalWrite(ctx context.Context, key, value string) error {
	return e.session.Query(`INSERT INTO store (key, value) VALUES (?, ?)`, key, value).
		WithContext(ctx).
		Consistency(gocql.LocalQuorum).
		Exec()
}

// SerialConsistency for LWT
func (e *ConsistencyExamples) ConditionalWrite(ctx context.Context, key, value string) (bool, error) {
	var currentValue string
	applied, err := e.session.Query(
		`INSERT INTO store (key, value) VALUES (?, ?) IF NOT EXISTS`,
		key, value,
	).
		WithContext(ctx).
		Consistency(gocql.LocalQuorum). // for the read phase
		SerialConsistency(gocql.LocalSerial). // Paxos phase (local DC)
		ScanCAS(&currentValue)
	return applied, err
}

// ConsistencyMatrix shows the trade-offs:
// Level          | Nodes Read | Nodes Write | Latency | Consistency
// --------------|------------|-------------|---------|-------------
// ONE/LOCAL_ONE  | 1          | 1           | Lowest  | Eventual
// TWO            | 2          | 2           | Low     | Better
// QUORUM         | ⌈RF/2⌉+1  | ⌈RF/2⌉+1   | Medium  | Strong
// LOCAL_QUORUM   | ⌈RF/2⌉+1  | ⌈RF/2⌉+1   | Medium  | Strong (local DC)
// EACH_QUORUM    | QUORUM     | QUORUM each | High    | Strong all DCs
// ALL            | RF         | RF          | Highest | Linearizable

// Strong consistency formula: W + R > RF
// QUORUM + QUORUM (2+2) > 3 → strong consistency
// ONE + ONE (1+1) ≯ 3 → eventual consistency
```

### Junior to FAANG: the R+W greater than N rule

Before you touch a consistency knob in production, drill the R+W greater than N rule until it is muscle memory. With replication factor RF, a read consistency of R replicas and a write consistency of W replicas gives linearizable visibility of the last acknowledged write if and only if R plus W is strictly greater than RF. For RF=3 the working pairs are QUORUM (2) plus QUORUM (2), ONE (1) plus ALL (3), or ALL (3) plus ONE (1). The first is the production default because it tolerates one replica down on each side. The second and third are almost never correct because ALL has zero tolerance for a down replica. A first-job worked example: if your on-call pager fires with `UnavailableException: Cannot achieve consistency level QUORUM`, one replica is down in a three-replica DC, which is survivable only if you drop the failing side to ONE temporarily and accept the staleness risk. Interview entry point: be able to compute, for RF=3 and RF=5, which pairs satisfy R+W greater than N and which do not, and be ready to explain why LOCAL_QUORUM is the right default in a multi-DC deployment.

### Senior at FAANG: tunable consistency ADRs, session defaults, and read repair

Staff review of consistency begins with governance. A well-run Cassandra platform has an ADR (Architecture Decision Record) that defines the default session-level consistency and lists the specific per-query overrides permitted. The typical policy is: session default `LOCAL_QUORUM` for both reads and writes, override to `LOCAL_ONE` for analytics and cache warming with explicit code review, override to `LOCAL_SERIAL` plus `LOCAL_QUORUM` for LWT, and forbid `EACH_QUORUM` outside a small allowlist of cross-DC critical paths because its latency equals the slowest WAN link. The `gocql` session-level default is set on `ClusterConfig.Consistency` and should be set explicitly rather than relying on the library default of QUORUM, which in a multi-DC topology silently pulls a replica from a remote DC and doubles tail latency. Per-query overrides are always a deviation, which means they must carry a comment explaining the trade, ideally pointing at the ADR section.

Multi-DC mechanics are where most incidents start. `QUORUM` at RF=3 plus RF=3 (two DCs) requires 4 of 6 replicas, which means at least one replica in each DC and therefore synchronous cross-DC traffic on every query. `LOCAL_QUORUM` scopes the quorum to the local DC so the coordinator only waits on local replicas, and the remote DC converges via hinted handoff and read repair. The gotcha is that `LOCAL_QUORUM` in DC-A plus `LOCAL_QUORUM` in DC-B does not give linearizability across DCs. A write in DC-A is not visible to a reader in DC-B until replication catches up, typically in the low hundreds of milliseconds but unbounded during network partitions. For any data that must be linearizable across DCs (for example the uniqueness check in a globally distributed signup flow), you must use LWT with `SERIAL` consistency or route all writes for that data domain to a primary DC.

Read repair and hinted handoff are the background processes that make eventual consistency converge. Cassandra 5.0 deprecated `read_repair_chance` and `dclocal_read_repair_chance` in favor of the blocking read repair path driven by the query's consistency level. At `QUORUM` the coordinator compares digests from all responding replicas and, on mismatch, issues a blocking repair before returning the row. This turns a mismatched read into a synchronous multi-replica write, which shows up as a latency cliff under high mutation churn. Mitigation is twofold: keep your clocks tight with NTP or PTP (Cassandra resolves conflicts by client-supplied timestamp, so clock skew directly causes read-repair storms), and run `nodetool repair -pr` on a rolling schedule so anti-entropy stays bounded. Hinted handoff holds mutations for a down replica up to `max_hint_window_in_ms` (default 3 hours in 5.0). After that window, only a full repair will converge the missing data, which is why operations teams page on node-down events that exceed two hours.

Scylla 6.0 differs in two meaningful ways. First, Scylla's lightweight transactions use a Raft-backed implementation that accepts `LOCAL_SERIAL` with significantly lower latency than classic Paxos, which changes the economics of using LWT for cross-region coordination. Second, Scylla's `tablets` feature (default in 6.0) dynamically balances data and replicas, so consistency behavior under topology change is more predictable during scale-out. Staff-level interview signal: draw a two-DC diagram with RF=3 per DC, trace a `LOCAL_QUORUM` read and a `QUORUM` read on the same diagram, identify the blocking read repair path, and explain when you would accept `EACH_QUORUM` despite its latency (answer: global inventory where over-selling is unacceptable, and you have already exhausted LWT as an option because the write rate exceeds Paxos capacity).

---
