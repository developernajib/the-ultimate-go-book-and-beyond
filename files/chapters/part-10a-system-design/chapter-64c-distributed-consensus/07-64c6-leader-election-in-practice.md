## 64C.6 Leader Election in Practice

### Using etcd for Leader Election in Go

etcd's `concurrency` package provides a high-level leader election abstraction built on top of distributed leases: a candidate acquires a lease, campaigns for leadership by creating an ephemeral key, and holds leadership for as long as the lease is renewed. When the leader process dies or loses connectivity, the lease expires and etcd automatically deletes the leader key, triggering a new election among the remaining candidates. This pattern is used by Kubernetes controllers, distributed schedulers, and any Go service where exactly one instance must perform a coordinating role at a time.

```go
// election/leader_election.go
package election

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// LeaderElector manages leader election for a distributed service.
type LeaderElector struct {
	client       *clientv3.Client
	electionName string // etcd key prefix for this election
	nodeID       string // unique identifier for this node
	ttlSeconds   int    // session TTL

	mu       sync.RWMutex
	isLeader bool
	session  *concurrency.Session
	election *concurrency.Election

	onBecomeLeader   func()
	onBecomeFollower func()
}

// Config holds configuration for the leader elector.
type Config struct {
	ElectionName     string
	NodeID           string
	TTLSeconds       int
	OnBecomeLeader   func()
	OnBecomeFollower func()
}

// NewLeaderElector creates a new leader elector.
func NewLeaderElector(client *clientv3.Client, cfg Config) *LeaderElector {
	if cfg.TTLSeconds <= 0 {
		cfg.TTLSeconds = 15
	}
	return &LeaderElector{
		client:           client,
		electionName:     cfg.ElectionName,
		nodeID:           cfg.NodeID,
		ttlSeconds:       cfg.TTLSeconds,
		onBecomeLeader:   cfg.OnBecomeLeader,
		onBecomeFollower: cfg.OnBecomeFollower,
	}
}

// Run starts the leader election loop. Blocks until ctx is canceled.
// The node will continuously try to acquire and hold leadership.
func (le *LeaderElector) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		if err := le.runOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Printf("[%s] election error: %v, retrying in 5s", le.nodeID, err)
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

// runOnce executes one round of leader election: campaign, hold leadership,
// then release (either through failure or context cancellation).
func (le *LeaderElector) runOnce(ctx context.Context) error {
	// Create a new session (holds a lease - automatically renewed)
	session, err := concurrency.NewSession(le.client,
		concurrency.WithTTL(le.ttlSeconds),
		concurrency.WithContext(ctx),
	)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	defer session.Close()

	le.mu.Lock()
	le.session = session
	le.election = concurrency.NewElection(session, "/"+le.electionName+"/leader")
	le.mu.Unlock()

	log.Printf("[%s] campaigning for leadership...", le.nodeID)

	// Campaign blocks until this node becomes leader OR ctx is canceled.
	// The value stored is our nodeID - others can observe who the leader is.
	if err := le.election.Campaign(ctx, le.nodeID); err != nil {
		return fmt.Errorf("campaign: %w", err)
	}

	// We are now the leader
	le.mu.Lock()
	le.isLeader = true
	le.mu.Unlock()

	log.Printf("[%s] BECAME LEADER", le.nodeID)
	if le.onBecomeLeader != nil {
		le.onBecomeLeader()
	}

	// Hold leadership until session expires or ctx is canceled
	select {
	case <-ctx.Done():
		log.Printf("[%s] context canceled, resigning leadership", le.nodeID)
	case <-session.Done():
		log.Printf("[%s] session expired, lost leadership", le.nodeID)
	}

	le.mu.Lock()
	le.isLeader = false
	le.mu.Unlock()

	if le.onBecomeFollower != nil {
		le.onBecomeFollower()
	}

	// Resign (delete the leader key) so the next candidate can proceed faster
	resignCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := le.election.Resign(resignCtx); err != nil {
		log.Printf("[%s] resign error: %v", le.nodeID, err)
	}

	return nil
}


// IsLeader returns true if this node is currently the leader.
func (le *LeaderElector) IsLeader() bool {
	le.mu.RLock()
	defer le.mu.RUnlock()
	return le.isLeader
}

// FencingToken returns the monotonically increasing token for this
// leadership term: the etcd revision at which this node's leader key
// was created. Pass it with every write to an external system so that
// system can reject a stale leader whose token has been superseded.
func (le *LeaderElector) FencingToken(ctx context.Context) (int64, error) {
	le.mu.RLock()
	election := le.election
	le.mu.RUnlock()
	if election == nil {
		return 0, fmt.Errorf("no active election")
	}
	resp, err := election.Leader(ctx)
	if err != nil {
		return 0, fmt.Errorf("get leader: %w", err)
	}
	if len(resp.Kvs) == 0 {
		return 0, fmt.Errorf("no leader elected")
	}
	// CreateRevision is unique and increasing across the whole store,
	// so a newer acquisition always outranks an older one.
	return resp.Kvs[0].CreateRevision, nil
}

// GetLeader returns the current leader's nodeID.
func (le *LeaderElector) GetLeader(ctx context.Context) (string, error) {
	le.mu.RLock()
	election := le.election
	le.mu.RUnlock()

	if election == nil {
		return "", fmt.Errorf("no active election")
	}

	resp, err := election.Leader(ctx)
	if err != nil {
		return "", fmt.Errorf("get leader: %w", err)
	}
	if len(resp.Kvs) == 0 {
		return "", fmt.Errorf("no leader elected")
	}
	return string(resp.Kvs[0].Value), nil
}

// ObserveLeader returns a channel that emits the leader nodeID whenever
// leadership changes.
func (le *LeaderElector) ObserveLeader(ctx context.Context) <-chan string {
	out := make(chan string, 1)
	go func() {
		defer close(out)
		le.mu.RLock()
		election := le.election
		le.mu.RUnlock()
		if election == nil {
			return
		}
		for resp := range election.Observe(ctx) {
			if len(resp.Kvs) > 0 {
				out <- string(resp.Kvs[0].Value)
			}
		}
	}()
	return out
}
```

**Usage example:**

```go
func main() {
	client, err := clientv3.New(clientv3.Config{
		Endpoints:   []string{"localhost:2379"},
		DialTimeout: 5 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	elector := election.NewLeaderElector(client, election.Config{
		ElectionName: "my-service",
		NodeID:       "node-1",
		TTLSeconds:   15,
		OnBecomeLeader: func() {
			log.Println("I am now the leader - starting singleton work")
			// Start background jobs, claim shared resources, etc.
		},
		OnBecomeFollower: func() {
			log.Println("I lost leadership - stopping singleton work")
			// Stop background jobs, release shared resources
		},
	})

	if err := elector.Run(ctx); err != nil && err != context.Canceled {
		log.Fatalf("leader election failed: %v", err)
	}
}
```

### Fencing Tokens - Preventing Split-Brain Actions

The problem: a node believes it is the leader, but its lease has expired (due to a slow network, GC pause, etc.). Another node has already become the new leader. If the old leader issues writes to external systems (a database, a storage service), those writes may conflict with writes from the new leader. This is **split-brain**.

The solution: **fencing tokens**.

```
Without fencing tokens (UNSAFE):

 Time ─────────────────────────────────────────────────────→

 Old Leader:  [holds lease] ...[GC pause 20s]... [resumes]
                                                    ↓
                                         still thinks it's leader!
                                         writes to storage service
                                                    ↓
 New Leader:  ..........[elected].......[writes to storage service]

 RESULT: Two "leaders" writing to storage simultaneously → data corruption!

With fencing tokens (SAFE):

 Every write to external storage includes a monotonically increasing
 fencing token (the etcd lease revision or Raft term+index).

 Storage service REJECTS any write with a token <= highest seen token.

 Old Leader (token=5): PUT /data/x "old" with fencing-token=5
                                        ↓
 New Leader (token=6): PUT /data/x "new" with fencing-token=6
                                        ↓ (succeeds)

 Old Leader resumes: PUT /data/x "old" with fencing-token=5
                                        ↓ REJECTED (5 < 6)
```

**Implementing fencing token validation in a storage service:**

```go
// fencing/storage.go
package fencing

import (
	"fmt"
	"sync"
)

// FencedStorage is a storage service that enforces fencing tokens.
// Writes with a token <= the highest seen token are rejected.
type FencedStorage struct {
	mu            sync.Mutex
	data          map[string]string
	highestToken  int64
}

func NewFencedStorage() *FencedStorage {
	return &FencedStorage{data: make(map[string]string)}
}

// Write stores a value only if the fencing token is higher than any seen before.
func (s *FencedStorage) Write(key, value string, fencingToken int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if fencingToken <= s.highestToken {
		return fmt.Errorf("fencing token %d rejected: highest seen is %d (stale leader?)",
			fencingToken, s.highestToken)
	}

	s.highestToken = fencingToken
	s.data[key] = value
	return nil
}

func (s *FencedStorage) Read(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}
```

---

### Junior → FAANG: Leader Election as an Interview Pattern

Leader election with etcd appears in system design interviews as the coordination primitive for singleton workers: exactly one instance of a service should perform a task (sending scheduled notifications, running a distributed cron job, acting as a shard coordinator). Know the pattern cold.

**The campaign-hold-resign cycle.** `Campaign` blocks until this instance becomes leader. While holding leadership, the service performs its singleton work. When the context is canceled or the session expires, the service resigns and releases the leader key. This three-phase cycle is the correct pattern. A common junior mistake is to not resign explicitly on graceful shutdown: without a resign call, the next candidate must wait for the lease TTL to expire before it can campaign, adding up to `ttlSeconds` of unavailability for the singleton role.

**OnBecomeLeader and OnBecomeFollower are critical hooks.** The `LeaderElector` in this section takes callback functions for both transitions. The `OnBecomeLeader` callback should start the singleton work in a goroutine with a cancellable context. The `OnBecomeFollower` callback should cancel that context and wait for the work goroutine to stop. If the work goroutine is not stopped on leadership loss, two instances will be performing the singleton work simultaneously during the window between one session expiring and the work goroutine stopping.

**TTL selection for leader election.** The TTL controls how quickly a failed leader is replaced. A 15-second TTL means: if the leader crashes, it takes up to 15 seconds for the next candidate to become leader. A 5-second TTL means faster recovery but higher risk of spurious failovers if the leader's network is briefly congested. For most singleton workers, 15 seconds is the right default. For time-sensitive coordinators (e.g., a shard router that must respond to node failures quickly), 10 seconds with a smaller heartbeat interval may be appropriate.

**Fencing token derivation.** The fencing token in this section is derived from `CreateRevision`, the etcd revision at which the lock key was first created. This revision is monotonically increasing across all etcd operations, so it is guaranteed to be larger for a newer lock acquisition than for an older one. When passing this token to an external storage system, the storage system must compare it against the highest previously seen token and reject writes with a lower value. This is the only mechanism that provides safety against split-brain writes.

### Senior @ FAANG: Leader Election at Platform Scale

**ADR: session TTL vs. singleton work duration.** The session TTL is a safety net, not a budget. The singleton work should complete or checkpoint well within the TTL. If the work takes 60 seconds and the TTL is 30 seconds, the leader will lose its lease mid-work, the next candidate will become leader and start the work again, and two instances will be running concurrently. The ADR for any singleton worker must specify: maximum work duration, TTL value (minimum 3x maximum work duration), checkpoint strategy for long-running work, and what happens if the work is interrupted mid-way (idempotent retry? rollback? partial completion?).

**Governance: singleton worker inventory.** In a microservices organization with dozens of services, the set of singleton workers is not always well-documented. Staff engineers maintain an inventory of all etcd-backed leader elections in the organization: service name, election key prefix, TTL, what work the leader performs, and the consequence of the singleton role being unavailable for 30 seconds. This inventory is essential for understanding the blast radius of an etcd cluster outage and for prioritizing the services that need the most resilient fallback behavior.

**Fencing tokens require end-to-end enforcement.** Implementing fencing tokens in the lock client is necessary but not sufficient. The storage system that receives fenced writes must also enforce the token. A staff engineer drives the end-to-end contract: the lock client sends the token as a request header (or includes it in the write payload), the storage service validates the token against its persisted maximum, and the validation is covered by integration tests that simulate a stale leader resuming writes. Without the storage-side enforcement, fencing tokens provide false safety.

**Platform concern: observability for leader elections.** Every leadership transition should emit a metric: `leader_election_transitions_total{service="payment-coordinator", result="became_leader"}`. Every leadership loss (whether by session expiry, explicit resign, or context cancellation) should similarly be metered and the reason recorded. This allows the on-call engineer to correlate leadership instability with network events, GC pressure, or disk I/O spikes. Without this observability, debugging a singleton worker that is "not running" requires log archaeology across multiple instances.

**L6/L7 concern: leader election and distributed system correctness proofs.** The `Campaign` call in etcd's concurrency package blocks until this instance writes its nodeID to the election key under the session lease. From that point, the instance is the leader in etcd's view. But "leader in etcd's view" and "leader in the external system's view" are different things if the external system uses a separate mechanism to track leadership. Staff engineers ensure that the source of truth for leadership is a single system (etcd), that the external system always defers to etcd's view, and that there is no code path where a local in-memory variable overrides etcd's leadership decision. This is a correctness invariant that must be maintained as the system evolves.

---
