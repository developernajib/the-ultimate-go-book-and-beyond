## 64G.1 CAP Theorem with Real Trade-off Examples

### The Core Theorem

Brewer's CAP theorem states that a distributed data store can only guarantee two of three properties:
- **C**onsistency: every read receives the most recent write or an error
- **A**vailability: every request receives a (non-error) response, without guarantee of most recent write
- **P**artition tolerance: the system continues to operate despite network partitions

**The critical insight**: network partitions ALWAYS happen in production. You don't choose between P and not-P - you choose how to handle P when it occurs. The real choice is: during a partition, do you sacrifice consistency (AP) or availability (CP)?

```
CAP in practice:
┌────────────────┬────────────────────────────────────────────────────┐
│ System         │ Choice    │ Behavior during partition              │
├────────────────┼───────────┼────────────────────────────────────────┤
│ etcd           │ CP        │ Refuses reads/writes without quorum    │
│ ZooKeeper      │ CP        │ Refuses writes without quorum          │
│ CockroachDB    │ CP        │ Returns error if can't reach quorum    │
│ Cassandra      │ AP        │ Accepts writes, later reconciles       │
│ DynamoDB       │ AP        │ Eventually consistent (default)        │
│ CouchDB        │ AP        │ Multi-master, CRDTs for conflict res   │
│ MySQL (replica)│ CP        │ Read replicas may lag; writes to lead  │
│ Redis Cluster  │ AP (softer)│ Accepts writes, may lose some         │
└────────────────┴───────────┴────────────────────────────────────────┘
```

### Designing for CP: Strong Consistency

CP systems refuse to operate without a quorum of nodes. They're appropriate when incorrect answers are worse than no answers.

```go
package cap

// Example: distributed leader election with etcd (CP system)
// If etcd loses quorum, election fails - better than split-brain

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

type DistributedService struct {
    etcd    *clientv3.Client
    session *concurrency.Session
    mu      *concurrency.Mutex
}

func NewDistributedService(etcdEndpoints []string) (*DistributedService, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   etcdEndpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("connecting to etcd: %w", err)
    }

    // Session with 10-second TTL - lock auto-releases if this node dies
    session, err := concurrency.NewSession(client, concurrency.WithTTL(10))
    if err != nil {
        return nil, fmt.Errorf("creating etcd session: %w", err)
    }

    return &DistributedService{
        etcd:    client,
        session: session,
        mu:      concurrency.NewMutex(session, "/distributed-lock/critical-section"),
    }, nil
}

// AcquireLeadership attempts to become the leader
// Returns error if can't reach etcd quorum (CP behavior: prefer unavailability to split-brain)
func (s *DistributedService) AcquireLeadership(ctx context.Context) error {
    // This will block until we acquire the lock OR context expires OR etcd is unavailable
    if err := s.mu.Lock(ctx); err != nil {
        return fmt.Errorf("acquiring leadership: %w", err)
    }
    return nil
}

func (s *DistributedService) ReleaseLeadership(ctx context.Context) error {
    return s.mu.Unlock(ctx)
}

// CockroachDB CP behavior - returns error during partition, not stale data
func queryCriticalBalance(ctx context.Context, db *sql.DB, accountID string) (int64, error) {
    var balanceCents int64
    // CockroachDB linearizable read - uses distributed transaction
    // During partition: returns error rather than potentially stale value
    err := db.QueryRowContext(ctx,
        "SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE",
        accountID,
    ).Scan(&balanceCents)
    if err != nil {
        return 0, fmt.Errorf("reading balance (may be unavailable during partition): %w", err)
    }
    return balanceCents, nil
}
```

### Designing for AP: High Availability

AP systems continue accepting writes during partitions and reconcile later. Use when availability is more important than consistency, and you can tolerate eventual consistency.

```go
package cap

// Example: Cassandra AP behavior - writes during partition, later reconciles
// Use case: user activity counters, view counts, likes

import (
    "context"

    "github.com/gocql/gocql"
)

type ConsistencyLevel int

const (
    ConsistencyEventual ConsistencyLevel = iota
    ConsistencyStrong
)

type ActivityCounter struct {
    session *gocql.Session
}

// IncrementView uses counter type - Cassandra handles conflict-free increments
// Even during a partition, this write succeeds on reachable nodes
func (c *ActivityCounter) IncrementView(ctx context.Context, postID string) error {
    // Cassandra counter: conflict-free, eventually consistent across replicas
    // During partition: writes to reachable nodes, reconciles when partition heals
    return c.session.Query(
        "UPDATE post_views SET view_count = view_count + 1 WHERE post_id = ?",
        postID,
    ).WithContext(ctx).Exec()
}

// ReadViewCount with explicit consistency level
func (c *ActivityCounter) ReadViewCount(ctx context.Context, postID string, level ConsistencyLevel) (int64, error) {
    var count int64
    // ONE: reads from 1 replica (fast, possibly stale)
    // QUORUM: reads from majority (slower, more consistent)
    // ALL: reads from all replicas (slowest, most consistent)
    q := c.session.Query(
        "SELECT view_count FROM post_views WHERE post_id = ?",
        postID,
    ).WithContext(ctx)

    switch level {
    case ConsistencyEventual:
        q = q.Consistency(gocql.One)
    case ConsistencyStrong:
        q = q.Consistency(gocql.Quorum)
    }

    if err := q.Scan(&count); err != nil {
        return 0, err
    }
    return count, nil
}
```

### PACELC: The Extension of CAP

PACELC extends CAP: "if Partition, choose between Availability and Consistency. Else (no partition), choose between Latency and Consistency."

```
PACELC matrix:
┌────────────────┬──────────────────┬────────────────────────────┐
│ System         │ During Partition │ Normal operation           │
├────────────────┼──────────────────┼────────────────────────────┤
│ DynamoDB       │ PA (available)   │ EL (low latency)           │
│ Cassandra      │ PA               │ EL                         │
│ CockroachDB    │ PC (consistent)  │ EC (higher latency)        │
│ etcd           │ PC               │ EC                         │
│ MongoDB (def.) │ PA               │ EL                         │
│ Spanner        │ PC               │ EC                         │
└────────────────┴──────────────────┴────────────────────────────┘
```

### Junior → FAANG: CAP as a Decision Tool, Not a Trivia Question

Many candidates recite the CAP triangle correctly but cannot apply it. The interview test is not "what is CAP?" but "you are building a distributed inventory system: which consistency model do you choose and why?" The answer must name a specific system, state the trade-off explicitly, and connect it to a user-visible consequence.

A worked example to practice: a shopping cart service. During a network partition between two data centers, should the cart accept writes (AP) or refuse writes to preserve consistency (CP)? Amazon's answer, documented in the Dynamo paper, is AP: a user who cannot add to their cart is worse than a user whose cart briefly shows stale data. That is a business decision translated into a CAP choice.

For the PACELC extension, the key insight to internalize is that the "else" clause is the common case. Partitions are rare. Latency vs consistency trade-offs happen on every request. Candidates who only know CAP are reasoning about 0.1% of requests. Candidates who know PACELC reason about 100%.

First-job entry point: when a team argues about database selection, volunteer to map each candidate database onto the PACELC table. It converts an opaque argument into a structured comparison of documented trade-offs.

### Senior @ FAANG: CAP as an ADR Template and Governance Gate

At L6 scope, CAP and PACELC become the vocabulary for Architecture Decision Records. Every new persistent store adoption should produce an ADR that answers, at minimum: what is the CAP classification of this store, what is the PACELC classification, what data types will be stored here and do their consistency requirements match the store's guarantees, and what is the behavior during a partition for each operation type?

Without this ADR, teams inherit the store's defaults. DynamoDB's default is eventually consistent reads: a new engineer writes a financial balance read against DynamoDB without setting `ConsistentRead: true` because they did not know the default was eventual. The ADR would have caught this at review time.

**Per-data-type consistency matrix as a team artifact.** The consistency matrix in the code example in this section is more valuable as a team document than as a code comment. Staff engineers should push for this matrix to live in the service's design document, reviewed and signed off by the tech lead, so that future engineers who add new data types to the service have an explicit model to fit their data into rather than guessing.

**PACELC and SLO alignment.** The latency column of PACELC has a direct relationship to P99 latency SLOs. A CP system (CockroachDB, Spanner) adds quorum round-trip latency to every write. If your P99 write latency SLO is 50ms and the inter-datacenter round trip is 40ms, a CP system cannot meet your SLO. This is a concrete constraint that should appear in capacity planning documents and design reviews, not just in distributed systems theory textbooks. Staff engineers are expected to quantify this relationship, not just cite it qualitatively.

**Bar-raiser signal on CAP questions.** In L6/L7 interview loops, a candidate who only answers "etcd is CP because it refuses writes without quorum" is giving an L4 answer. The L6 answer adds: "and the implication for our service is that if etcd loses quorum, our leader election fails, which means our payment processor stops accepting new work, which means we need a fallback path to a degraded but available mode, and that fallback needs to be tested quarterly." Connecting the database's consistency guarantee all the way to user-visible behavior and tested fallback paths is the bar-raiser signal.

---
