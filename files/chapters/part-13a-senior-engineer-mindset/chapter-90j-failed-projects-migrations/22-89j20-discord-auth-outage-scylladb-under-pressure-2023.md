## 90J.20 Discord Auth Outage: ScyllaDB Under Pressure (2023)

### The Incident

On March 6, 2023, Discord experienced a significant outage lasting approximately 3 hours that affected
authentication, message delivery, and presence (online/offline status) across the platform. The root cause
was a cascade failure in their ScyllaDB clusters that began during a routine infrastructure upgrade.

### What Went Wrong

Discord had migrated from Apache Cassandra to ScyllaDB for better performance and lower latency. ScyllaDB
is a C++ rewrite of Cassandra that promises better hardware utilization and more predictable latency. Discord
ran ScyllaDB on bare-metal servers with NVMe SSDs to minimize latency.

During a planned rolling upgrade of the ScyllaDB cluster, NVMe drives on several nodes began exhibiting
degraded performance. The drives were not failing outright - they were experiencing increased latency on
write operations, going from sub-millisecond to 10-50 milliseconds. This "gray failure" was subtle enough
to pass basic health checks but devastating to tail latency.

The cascade:

1. **T+0**: Rolling upgrade restarted ScyllaDB on first batch of nodes. When nodes restarted, they needed to
   replay their commit logs, which created heavy disk I/O
2. **T+3 minutes**: The commit log replay on nodes with degraded NVMe drives took 5x longer than expected,
   keeping those nodes out of the cluster longer
3. **T+5 minutes**: With multiple nodes simultaneously unavailable (the upgrading batch plus the slow-recovering
   nodes), several token ranges lost quorum
4. **T+6 minutes**: Reads and writes to affected token ranges started timing out. ScyllaDB uses a quorum
   consistency level (requires acknowledgment from a majority of replicas)
5. **T+8 minutes**: The authentication service, which relied on ScyllaDB for session tokens and user lookups,
   began failing. Users could not log in, and existing sessions could not be validated
6. **T+10 minutes**: Message delivery service degraded because it could not verify sender identity
7. **T+15 minutes**: Client applications began aggressive reconnection attempts, multiplying load 10x
8. **T+3 hours**: Full recovery after halting the upgrade, replacing degraded NVMe drives, and waiting for
   cluster to reach full quorum on all token ranges

### Why Quorum Was Lost

In a ScyllaDB/Cassandra cluster with replication factor 3, quorum requires 2 of 3 replicas to respond. The
upgrade took one node down at a time, which should have been safe - 2 of 3 replicas would remain. However,
the degraded NVMe drives created a second failure mode: nodes that were "up" but too slow to respond within
the timeout window. This meant some token ranges effectively had only 1 healthy replica (one intentionally
down for upgrade + one present but too slow), which is below quorum.

### Go Implementation: Quorum-Aware Health Checker

Discord's cascade started with a "gray failure". Nodes were technically reachable but their NVMe write latency had climbed from sub-millisecond to 50ms, enough to exceed ScyllaDB's timeout and effectively remove them from quorum without any binary up/down signal. The `ClusterHealthChecker` below combats this by probing each node with timed reads and writes and classifying any node whose latency exceeds `degradedThreshold` as `NodeDegraded` rather than healthy. When `evaluateQuorum` counts replicas per token range, degraded nodes are treated as unavailable for the quorum calculation, and `IsSafeToUpgrade` blocks the rolling upgrade entirely if taking one more node offline would leave any token range without a spare healthy replica.

```go
package quorum

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Quorum-aware health checking system
// -----------------------------------------------------------------------

// Node represents a database node in the cluster.
type Node struct {
	ID        string
	Address   string
	Datacenter string
	Rack      string
	State     NodeState
	TokenRanges []TokenRange
}

// NodeState represents the health state of a node beyond simple up/down.
type NodeState int

const (
	NodeHealthy NodeState = iota
	NodeDegraded          // up but slow - the gray failure state
	NodeDown
	NodeUpgrading
	NodeRecovering
)

// TokenRange represents a range of the consistent hash ring that a
// node is responsible for.
type TokenRange struct {
	Start int64
	End   int64
}

// HealthProbe contains the results of a health check against a node.
type HealthProbe struct {
	NodeID          string
	Timestamp       time.Time
	Reachable       bool
	ReadLatency     time.Duration
	WriteLatency    time.Duration
	CommitLogReplay bool // true if node is still replaying commit log
	DiskLatency     time.Duration
	CPUPercent      float64
}

// QuorumStatus represents the health of a specific token range.
type QuorumStatus struct {
	TokenRange      TokenRange
	ReplicationFactor int
	HealthyReplicas   int
	DegradedReplicas  int
	DownReplicas      int
	HasQuorum         bool
	SafeToOperate     bool // true only if we can lose one more node
}

// ClusterHealthChecker monitors cluster health at the quorum level,
// detecting both hard failures (node down) and gray failures (node
// degraded) that threaten quorum.
type ClusterHealthChecker struct {
	nodes              []*Node
	replicationFactor  int
	readTimeout        time.Duration
	writeTimeout       time.Duration
	degradedThreshold  time.Duration // latency above this = degraded
	probeInterval      time.Duration
	mu                 sync.RWMutex
	latestProbes       map[string]*HealthProbe
	quorumStatuses     map[string]*QuorumStatus // keyed by token range string
	upgradeBlocker     chan struct{}
	alertCallback      func(alert QuorumAlert)
}

// QuorumAlert is emitted when quorum is threatened or lost.
type QuorumAlert struct {
	Level       AlertLevel
	TokenRange  TokenRange
	Message     string
	Timestamp   time.Time
	Status      *QuorumStatus
}

// AlertLevel indicates the severity of a quorum alert.
type AlertLevel int

const (
	AlertInfo AlertLevel = iota
	AlertWarning  // quorum maintained but no redundancy
	AlertCritical // quorum lost
)

// NewClusterHealthChecker creates a checker configured for the cluster's
// replication factor and latency expectations.
func NewClusterHealthChecker(
	nodes []*Node,
	replicationFactor int,
	degradedThreshold time.Duration,
	alertCallback func(QuorumAlert),
) *ClusterHealthChecker {
	return &ClusterHealthChecker{
		nodes:             nodes,
		replicationFactor: replicationFactor,
		readTimeout:       500 * time.Millisecond,
		writeTimeout:      1 * time.Second,
		degradedThreshold: degradedThreshold,
		probeInterval:     5 * time.Second,
		latestProbes:      make(map[string]*HealthProbe),
		quorumStatuses:    make(map[string]*QuorumStatus),
		upgradeBlocker:    make(chan struct{}, 1),
		alertCallback:     alertCallback,
	}
}

// Monitor runs the continuous health monitoring loop. It probes all
// nodes, calculates quorum status for each token range, and emits
// alerts when quorum is threatened.
func (c *ClusterHealthChecker) Monitor(ctx context.Context) {
	ticker := time.NewTicker(c.probeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.probeAllNodes(ctx)
			c.evaluateQuorum()
		}
	}
}

// probeAllNodes concurrently checks the health of every node.
func (c *ClusterHealthChecker) probeAllNodes(ctx context.Context) {
	var wg sync.WaitGroup
	probes := make(chan *HealthProbe, len(c.nodes))

	for _, node := range c.nodes {
		wg.Add(1)
		go func(n *Node) {
			defer wg.Done()
			probe := c.probeNode(ctx, n)
			probes <- probe
		}(node)
	}

	wg.Wait()
	close(probes)

	c.mu.Lock()
	for probe := range probes {
		c.latestProbes[probe.NodeID] = probe
	}
	c.mu.Unlock()
}

// probeNode performs a deep health check on a single node, measuring
// not just reachability but actual I/O latency to detect gray failures.
func (c *ClusterHealthChecker) probeNode(ctx context.Context, node *Node) *HealthProbe {
	probe := &HealthProbe{
		NodeID:    node.ID,
		Timestamp: time.Now(),
	}

	if node.State == NodeUpgrading || node.State == NodeDown {
		probe.Reachable = false
		return probe
	}

	// Measure read latency with a lightweight query.
	readStart := time.Now()
	readCtx, readCancel := context.WithTimeout(ctx, c.readTimeout)
	err := c.executeProbeRead(readCtx, node)
	readCancel()
	probe.ReadLatency = time.Since(readStart)

	if err != nil {
		probe.Reachable = false
		return probe
	}
	probe.Reachable = true

	// Measure write latency.
	writeStart := time.Now()
	writeCtx, writeCancel := context.WithTimeout(ctx, c.writeTimeout)
	err = c.executeProbeWrite(writeCtx, node)
	writeCancel()
	probe.WriteLatency = time.Since(writeStart)

	// Measure disk latency directly if possible.
	probe.DiskLatency = probe.WriteLatency // approximation

	return probe
}

// executeProbeRead performs a lightweight read against the node.
func (c *ClusterHealthChecker) executeProbeRead(_ context.Context, _ *Node) error {
	// In production, this would execute: SELECT key FROM system.local
	return nil
}

// executeProbeWrite performs a lightweight write against the node.
func (c *ClusterHealthChecker) executeProbeWrite(_ context.Context, _ *Node) error {
	// In production, this would write to a health-check table.
	return nil
}

// evaluateQuorum calculates quorum status for every token range and
// emits alerts when quorum is threatened or lost.
func (c *ClusterHealthChecker) evaluateQuorum() {
	c.mu.RLock()
	probes := make(map[string]*HealthProbe)
	for k, v := range c.latestProbes {
		probes[k] = v
	}
	c.mu.RUnlock()

	// Build a map of token ranges to their replica nodes.
	tokenRangeMap := make(map[string][]string) // range key -> node IDs
	for _, node := range c.nodes {
		for _, tr := range node.TokenRanges {
			key := fmt.Sprintf("%d-%d", tr.Start, tr.End)
			tokenRangeMap[key] = append(tokenRangeMap[key], node.ID)
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	for rangeKey, nodeIDs := range tokenRangeMap {
		status := &QuorumStatus{
			ReplicationFactor: c.replicationFactor,
		}

		for _, nodeID := range nodeIDs {
			probe, exists := probes[nodeID]
			if !exists || !probe.Reachable {
				status.DownReplicas++
				continue
			}

			// Detect gray failure: node is reachable but latency is
			// above the degraded threshold.
			if probe.ReadLatency > c.degradedThreshold ||
				probe.WriteLatency > c.degradedThreshold {
				status.DegradedReplicas++
			} else {
				status.HealthyReplicas++
			}
		}

		quorumRequired := (c.replicationFactor / 2) + 1
		effectiveHealthy := status.HealthyReplicas // degraded nodes might timeout

		status.HasQuorum = effectiveHealthy >= quorumRequired
		// Safe to operate (e.g., upgrade another node) only if we can
		// afford to lose one more healthy node.
		status.SafeToOperate = effectiveHealthy > quorumRequired

		c.quorumStatuses[rangeKey] = status

		// Alert on quorum threats.
		if !status.HasQuorum {
			c.alertCallback(QuorumAlert{
				Level:     AlertCritical,
				Message:   fmt.Sprintf("QUORUM LOST for range %s: %d healthy, %d degraded, %d down", rangeKey, status.HealthyReplicas, status.DegradedReplicas, status.DownReplicas),
				Timestamp: time.Now(),
				Status:    status,
			})
		} else if !status.SafeToOperate {
			c.alertCallback(QuorumAlert{
				Level:     AlertWarning,
				Message:   fmt.Sprintf("QUORUM AT RISK for range %s: no redundancy remaining", rangeKey),
				Timestamp: time.Now(),
				Status:    status,
			})
		}
	}
}

// IsSafeToUpgrade checks whether it is safe to take another node
// offline for upgrade. Returns false if any token range would lose
// quorum or have no redundancy.
func (c *ClusterHealthChecker) IsSafeToUpgrade(nodeID string) (bool, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Find which token ranges this node serves.
	var targetNode *Node
	for _, n := range c.nodes {
		if n.ID == nodeID {
			targetNode = n
			break
		}
	}
	if targetNode == nil {
		return false, fmt.Sprintf("node %s not found", nodeID)
	}

	for _, tr := range targetNode.TokenRanges {
		key := fmt.Sprintf("%d-%d", tr.Start, tr.End)
		status, exists := c.quorumStatuses[key]
		if !exists {
			return false, fmt.Sprintf("no quorum data for range %s", key)
		}

		if !status.SafeToOperate {
			return false, fmt.Sprintf("range %s has only %d healthy replicas (need %d+ for safe upgrade)",
				key, status.HealthyReplicas, (c.replicationFactor/2)+2)
		}
	}

	return true, "all token ranges have sufficient redundancy"
}
```

**The Lesson**: Binary health checks (up/down) are insufficient for distributed databases. Gray failures  - 
where a node is technically responsive but operationally degraded - are the most dangerous failure mode
because they can silently erode quorum without triggering alerts. Health checking must measure actual I/O
latency, not just reachability. Rolling upgrades must verify quorum health at the token-range level before
proceeding with each node, and must account for degraded nodes as effectively unavailable.

---

### Junior → FAANG: Quorum Awareness and Gray Failure Detection as Interview Topics

The Discord ScyllaDB incident is the interview answer to "how do you safely upgrade a distributed database cluster?" A rolling upgrade that proceeded while nodes were degraded eroded quorum until authentication failed for all users. For FAANG interviews, the database upgrade safety answer has three components. First, define and measure quorum health at the token-range level before proceeding with each node in a rolling upgrade. A node that responds to health checks but has elevated I/O latency is effectively unavailable for quorum purposes and should be treated as such before the upgrade proceeds. Second, implement latency-based health checks that measure actual read and write latency to each node, not just TCP reachability. A node whose P99 write latency has increased by 10x is a degraded node, regardless of what the ping check reports. Third, set upgrade rate limits: never upgrade more than one node at a time for a three-node cluster, never reduce the healthy replica count below quorum plus one, and pause the upgrade automatically if any health metric deviates from the pre-upgrade baseline.

### Senior @ FAANG: Database Operational Safety as a Platform Engineering Responsibility

At L6, the Discord incident demonstrates that database operational procedures are a platform engineering concern, not a per-team concern. When each team manages its own database cluster with independently developed operational procedures, the quality of those procedures is limited by the experience of the team members and the time they can invest in operational tooling. The platform engineering investment that prevents the Discord scenario is a shared database operations framework with three properties. First, all rolling upgrades are executed through the shared framework, which enforces token-range quorum health gates, upgrade rate limits, and automatic rollback on degradation detection. Teams cannot bypass the framework for "simple" upgrades because the framework is the only authorized upgrade path. Second, the framework maintains a continuous health baseline for each managed cluster, measuring read and write latency at the P50, P99, and P99.9 levels from the application perspective (not the database internal perspective), so that degradation is detected from the client's point of view rather than the database's self-reported health. Third, the upgrade approval process requires a staging environment run at 30% of production traffic that completed without degradation in the 72 hours before the production upgrade. The staging run provides empirical evidence that the upgrade is safe under realistic load, not just under a synthetic benchmark. At Discord's scale, the 2023 incident was a consequence of a quorum health gap that the upgrade process did not catch. The platform engineering fix is making that gap uncatchable by design.

---
