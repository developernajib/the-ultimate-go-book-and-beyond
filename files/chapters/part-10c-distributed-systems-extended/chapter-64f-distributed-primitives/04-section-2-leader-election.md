## Section 2: Leader Election

### 2.1 etcd-Based Leader Election

Leader election built on etcd uses compare-and-swap and lease primitives to provide campaign, observe, and resign semantics that map cleanly to the leader lifecycle in long-running Go services. The following implementation uses the official etcd `concurrency` package to participate in an election, react to leadership changes, and cleanly resign before shutdown.

```go
package election

import (
	"context"
	"fmt"
	"net/http"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// LeaderElection provides distributed leader election backed by etcd.
// Only one node at a time can be the leader.
// When the leader dies (or its session expires), another node takes over.
type LeaderElection struct {
	client   *clientv3.Client
	session  *concurrency.Session
	election *concurrency.Election
	nodeID   string
	prefix   string

	// Callbacks.
	onLeadershipGained func(ctx context.Context) error
	onLeadershipLost   func()
}

// Config holds leader election configuration.
type Config struct {
	NodeID             string
	Prefix             string // etcd key prefix, e.g., "/elections/my-service"
	SessionTTL         int    // Lease TTL in seconds.
	OnLeadershipGained func(ctx context.Context) error
	OnLeadershipLost   func()
}

func New(client *clientv3.Client, cfg Config) (*LeaderElection, error) {
	session, err := concurrency.NewSession(client, concurrency.WithTTL(cfg.SessionTTL))
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	election := concurrency.NewElection(session, cfg.Prefix)

	return &LeaderElection{
		client:             client,
		session:            session,
		election:           election,
		nodeID:             cfg.NodeID,
		prefix:             cfg.Prefix,
		onLeadershipGained: cfg.OnLeadershipGained,
		onLeadershipLost:   cfg.OnLeadershipLost,
	}, nil
}

// Run campaigns for leadership and runs the leadership loop.
// Blocks until ctx is canceled.
func (le *LeaderElection) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Campaign for leadership - blocks until this node becomes leader.
		if err := le.campaign(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// Campaign failed - wait before retrying.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(5 * time.Second):
			}
			continue
		}

		// Won leadership.
		leaderCtx, cancelLeader := context.WithCancel(ctx)

		// Watch for session expiry.
		go func() {
			select {
			case <-le.session.Done():
				cancelLeader()
			case <-leaderCtx.Done():
			}
		}()

		// Run leader duties.
		if le.onLeadershipGained != nil {
			if err := le.onLeadershipGained(leaderCtx); err != nil && ctx.Err() == nil {
				// Leadership work failed - resign.
				_ = le.election.Resign(ctx)
			}
		}

		cancelLeader()

		if le.onLeadershipLost != nil {
			le.onLeadershipLost()
		}
	}
}

func (le *LeaderElection) campaign(ctx context.Context) error {
	return le.election.Campaign(ctx, le.nodeID)
}

// Resign voluntarily gives up leadership.
func (le *LeaderElection) Resign(ctx context.Context) error {
	return le.election.Resign(ctx)
}

// GetLeader returns the current leader's node ID, or "" if no leader.
func (le *LeaderElection) GetLeader(ctx context.Context) (string, error) {
	resp, err := le.election.Leader(ctx)
	if err != nil {
		if err == concurrency.ErrElectionNoLeader {
			return "", nil
		}
		return "", fmt.Errorf("get leader: %w", err)
	}
	if len(resp.Kvs) == 0 {
		return "", nil
	}
	return string(resp.Kvs[0].Value), nil
}

// IsLeader returns true if this node is the current leader.
func (le *LeaderElection) IsLeader(ctx context.Context) (bool, error) {
	leader, err := le.GetLeader(ctx)
	if err != nil {
		return false, err
	}
	return leader == le.nodeID, nil
}

// WatchLeader returns a channel that receives the leader ID whenever it changes.
func (le *LeaderElection) WatchLeader(ctx context.Context) <-chan string {
	ch := make(chan string, 1)

	go func() {
		defer close(ch)
		observeCh := le.election.Observe(ctx)
		for resp := range observeCh {
			if len(resp.Kvs) > 0 {
				ch <- string(resp.Kvs[0].Value)
			}
		}
	}()
	return ch
}

// Close releases the session and lease.
func (le *LeaderElection) Close() error {
	return le.session.Close()
}

// LeaderProxy routes requests to the current leader.
// Non-leaders forward requests to the leader via HTTP.
type LeaderProxy struct {
	election *LeaderElection
	selfAddr string
	getAddr  func(nodeID string) string // Maps nodeID → address.
}

func NewLeaderProxy(election *LeaderElection, selfAddr string, getAddr func(string) string) *LeaderProxy {
	return &LeaderProxy{
		election: election,
		selfAddr: selfAddr,
		getAddr:  getAddr,
	}
}

// ServeHTTP routes requests to the leader.
func (lp *LeaderProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	leader, err := lp.election.GetLeader(r.Context())
	if err != nil {
		http.Error(w, "leader unknown", http.StatusServiceUnavailable)
		return
	}

	leaderAddr := lp.getAddr(leader)
	if leaderAddr == lp.selfAddr {
		// This node IS the leader - handle the request.
		w.Write([]byte("handled by leader: " + lp.selfAddr))
		return
	}

	// Forward to leader.
	http.Redirect(w, r, "http://"+leaderAddr+r.RequestURI, http.StatusTemporaryRedirect)
}
```

### Junior → FAANG: Leader Election Lifecycle and Its Failure Windows

The `LeaderElection.Run` function encodes the complete leader lifecycle: campaign (block until elected), gain leadership (run work), detect session expiry (cancel leader context), resign or lose leadership, and restart the campaign loop. Understanding this lifecycle is essential for reasoning about the failure windows where two nodes might both believe they are the leader.

The critical failure window is between session expiry and the new leader's campaign succeeding. During this window, the cluster has no leader. Writes that require a leader (anything that goes through the LeaderProxy) will return 503 to clients. The duration of this window is bounded by etcd's lease TTL (5 seconds in the Config example). After the expired leader's session key is automatically deleted by etcd (because the lease expired), the next node in line wins the campaign.

What can go wrong: if the current leader is alive but network-partitioned from etcd, its session will expire after TTL seconds, etcd will delete the session key, and a new leader will be elected. The old leader is still running and may continue to execute "leader work" for up to TTL seconds after losing the election. The epoch/term number in all leader writes prevents the old leader's stale writes from being accepted.

The `WatchLeader` function is important for non-leader nodes that need to forward requests to the leader. If a non-leader caches the leader address and the leader changes, requests will be forwarded to the wrong node until the cache is refreshed. Using `WatchLeader` with a local cache that is invalidated on every leadership change event is the correct approach.

Interview preparation: draw the timeline of a leader failure and recovery. Mark the points where: the leader crashes, the etcd session expires (TTL seconds later), the new leader wins the campaign, and the first write from the new leader succeeds. The duration of the unavailability window (from crash to first successful write from new leader) is the metric to quote in system design discussions.

### Senior @ FAANG: Leader Election for High-Availability Services

The etcd-based leader election in this section has a fixed availability cost: every leader failure causes approximately TTL seconds of unavailability for operations that require a leader. For a 5-second TTL, this means 5 seconds of write unavailability per leader failure. For a service with an SLO of 99.99% availability (4.38 minutes of downtime per month), a single unplanned leader change per day would consume the entire error budget.

Reducing the election TTL: setting the TTL to 1 second reduces the downtime window from 5 seconds to 1 second, but creates a new problem. etcd's keep-alive interval is typically TTL/3. If a keep-alive packet is delayed by more than TTL seconds (possible under network congestion or CPU starvation on the leader), the session expires and an unnecessary leader election occurs. Production tuning requires measuring the worst-case keep-alive latency in your environment and setting TTL to at least 3x that value with margin.

Leader lease and follower reads: for read-heavy workloads, a leader that must service all reads is a throughput bottleneck. The solution is leader leases: the leader periodically renews a bounded-duration lease and allows followers to serve reads during the lease validity period, since the leader is guaranteed to be the only leader for the lease duration. etcd itself uses leader leases for linearizable reads on followers. Implementing this in an application-level election requires careful coordination to ensure the lease duration is conservative relative to the clock skew bounds.

Multi-region leader election adds a new constraint: the election must complete within the cross-region RTT budget. With an etcd cluster spanning three regions, an election requires a majority (2 of 3 nodes) to exchange election messages. If two nodes are in region A and one is in region B, elections between the two region-A nodes complete at intra-region latency (1-5ms) while elections that require the region-B node take cross-region latency (50-200ms). Placement of the tie-breaking node determines the worst-case election latency.

ADR consideration for leader election: explicitly document the maximum acceptable leader election time (in SLO terms), the TTL setting and its rationale (minimum TTL > 3x max keep-alive latency with margin), the epoch number scheme for staleness detection, and the graceful resignation protocol for planned maintenance (the `Resign` call before shutdown, reducing unavailability from TTL to near-zero).

---
