## 64G.4 Network Partition Testing

### Simulating Partitions with tc netem

Linux `tc netem` (Network Emulator) can add delay, packet loss, duplication, and corruption to network interfaces, enabling realistic partition simulation.

```bash
# Add 100ms delay to simulate inter-datacenter latency
tc qdisc add dev eth0 root netem delay 100ms

# Add 200ms delay with 50ms jitter (realistic WAN simulation)
tc qdisc add dev eth0 root netem delay 200ms 50ms distribution normal

# Simulate packet loss (5% random loss)
tc qdisc add dev eth0 root netem loss 5%

# Simulate complete partition (100% packet loss)
tc qdisc add dev eth0 root netem loss 100%

# Remove simulation
tc qdisc del dev eth0 root

# More targeted: only affect specific destination
tc qdisc add dev eth0 root handle 1: prio
tc qdisc add dev eth0 parent 1:3 handle 30: netem delay 200ms loss 10%
tc filter add dev eth0 parent 1:0 protocol ip u32 \
    match ip dst 10.0.0.2/32 flowid 1:3
```

### Go Service Partition Test

Testing that a Go service behaves correctly during a network partition requires a harness that can programmatically block connections between services while the system is under load. The following test uses `tc netem` rules wrapped in Go test setup/teardown to simulate a partition, asserts that the service degrades gracefully, and verifies that it converges to a consistent state once the partition heals.

```go
// partition_test.go - testing Go service behavior under network partition
package integration_test

import (
    "context"
    "os"
    "os/exec"
    "testing"
    "time"
)

type CacheService struct{}

func NewCacheService(addr string) *CacheService { return &CacheService{} }
func (c *CacheService) Get(ctx context.Context, k string) (string, error) { return "val", nil }
func (c *CacheService) Set(ctx context.Context, k, v string) error { return nil }

// NetworkPartition simulates a partition using tc netem
type NetworkPartition struct {
    t       *testing.T
    iface   string
    target  string
}

func NewPartition(t *testing.T, iface, targetIP string) *NetworkPartition {
    t.Helper()
    return &NetworkPartition{t: t, iface: iface, target: targetIP}
}

func (p *NetworkPartition) Apply() {
    p.t.Helper()
    // Require root or CAP_NET_ADMIN
    cmd := exec.Command("tc", "qdisc", "add", "dev", p.iface,
        "root", "netem", "loss", "100%")
    if err := cmd.Run(); err != nil {
        p.t.Fatalf("applying partition: %v", err)
    }
    p.t.Logf("partition applied: %s → %s (100%% loss)", p.iface, p.target)
}

func (p *NetworkPartition) Heal() {
    p.t.Helper()
    cmd := exec.Command("tc", "qdisc", "del", "dev", p.iface, "root")
    if err := cmd.Run(); err != nil {
        p.t.Logf("healing partition (may already be healed): %v", err)
    }
}

// Test: what happens to our service during a partition?
func TestCacheServiceUnderPartition(t *testing.T) {
    if os.Getenv("INTEGRATION_TEST") != "true" {
        t.Skip("skipping partition test (requires root + real network)")
    }

    svc := NewCacheService("localhost:6379") // Redis

    t.Run("reads serve stale data during partition", func(t *testing.T) {
        // Pre-populate cache
        ctx := context.Background()
        svc.Set(ctx, "key1", "value1")

        // Apply partition between service and Redis
        partition := NewPartition(t, "eth0", "redis-host")
        partition.Apply()
        defer partition.Heal()

        // Service should serve stale cached data (AP behavior)
        val, err := svc.Get(ctx, "key1")
        if err != nil {
            t.Logf("cache miss during partition (CP behavior): %v", err)
        } else {
            t.Logf("stale cache hit during partition (AP behavior): %v", val)
        }

        // Verify: our service must have a documented behavior
        // Document which behavior is correct for this service
    })

    t.Run("write failures during partition are queued", func(t *testing.T) {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()

        partition := NewPartition(t, "eth0", "redis-host")
        partition.Apply()
        defer partition.Heal()

        // Attempt write during partition
        err := svc.Set(ctx, "key2", "value2")
        if err == nil {
            // Service accepted write - does it queue for later? Or is it lost?
            t.Log("service accepted write during partition")
            // Verify the write completes after partition heals
        } else {
            t.Logf("service rejected write during partition (CP): %v", err)
        }
    })
}
```

### Expected Behavior Documentation

Documenting the expected behavior of a distributed service under network partition is as important as testing it: it creates an explicit contract that prevents regressions and guides incident response. The following behavior matrix maps partition scenarios to the expected client-visible outcomes and recovery time objectives.

```go
package integration_test

import "time"

// Every distributed service component should document partition behavior
// This is often not done - it's technical debt waiting to become an incident

type PartitionBehavior struct {
    Component string
    ReadBehavior string
    WriteBehavior string
    Timeout time.Duration
    RecoveryBehavior string
}

var servicePartitionBehaviors = []PartitionBehavior{
    {
        Component:        "User Profile Cache (Redis)",
        ReadBehavior:     "Serve stale data for up to TTL (30min), then return error",
        WriteBehavior:    "Return error immediately; client must retry",
        Timeout:          500 * time.Millisecond,
        RecoveryBehavior: "Cache repopulated on next read after partition heals",
    },
    {
        Component:        "Order Database (CockroachDB)",
        ReadBehavior:     "Error if can't reach quorum; no stale data served",
        WriteBehavior:    "Error if can't reach quorum; no partial writes",
        Timeout:          5 * time.Second,
        RecoveryBehavior: "Normal operation resumes when quorum restored",
    },
    {
        Component:        "Analytics Event Stream (Kafka)",
        ReadBehavior:     "Consumer lag increases; no data loss",
        WriteBehavior:    "Producer blocks/buffers; events not lost if buffer not full",
        Timeout:          30 * time.Second,
        RecoveryBehavior: "Consumer catches up; eventual consistency in dashboards",
    },
}
```

### Junior → FAANG: Partition Testing as a First-Class Engineering Discipline

Most junior engineers write tests that only exercise the happy path. Distributed system tests that only test "all services up" give a false sense of confidence: the failures that matter most happen when something is down or slow.

Before your first FAANG system design interview, understand that partition testing is expected for production-ready systems. If you describe a distributed architecture and an interviewer asks "how do you test that this behaves correctly during a network partition?" the answer "we'd use integration tests with testcontainers and tc netem to simulate partition conditions" demonstrates production readiness. The answer "we'd test it manually" does not.

The partition behavior documentation table in this section is a practical deliverable for any junior engineer joining a team that owns a distributed service. Producing this document for an existing service demonstrates initiative and surfaces undocumented behavior before it becomes an incident.

First-job habit: whenever you write an integration test for a distributed service, add at least one failure scenario. Start with the simplest: inject a 2-second delay on the downstream dependency and verify the service returns the expected error within the configured timeout. This single test catches missing timeouts and incorrect error handling.

### Senior @ FAANG: Chaos Engineering as a Team Practice and Platform Investment

At senior level, the question is not whether to test network partitions: it is how to make partition testing a continuous, automated practice rather than a one-time exercise before a major release.

**Chaos engineering graduation model.** Teams at FAANG typically progress through four stages of chaos engineering maturity: (1) manual chaos: engineers inject failures by hand during planned maintenance windows. (2) scripted chaos: partition tests run as part of the pre-release test suite. (3) scheduled chaos: chaos experiments run on a regular schedule in a staging environment that mirrors production. (4) production chaos: controlled experiments (canary-scoped) run in production to verify that real traffic degrades gracefully. Most teams are at stage 1 or 2. Staff engineers push teams to stage 3, with a clear plan and approval process for stage 4.

**Partition behavior as a deployment contract.** The `PartitionBehavior` struct in this section should be a required field in every service's design document. The deployment pipeline at FAANG-scale organizations should verify that this document exists and is up to date before allowing a deployment to production. If the documented behavior is "serve stale for 30 minutes" and the code actually returns a 500 after 500ms, the contract is wrong and the gap will surprise on-call engineers during an incident.

**tc netem in CI: operational considerations.** Running tc netem in CI requires elevated privileges (CAP_NET_ADMIN) that most CI environments do not grant by default. The practical alternative for most teams is toxiproxy (a Go-based TCP proxy that can inject latency, bandwidth limits, and connection drops) or testcontainers with a network simulation layer. Staff engineers evaluate the trade-off between test fidelity (tc netem is more accurate) and operational simplicity (toxiproxy runs without root) and document the choice in the team's testing standards.

**Blast radius analysis for chaos experiments.** Before running any chaos experiment in staging or production, staff engineers require a written blast radius analysis: what is the maximum customer-visible impact if this experiment produces an unexpected cascading failure? Who has the authority to abort the experiment? What is the kill switch? Without this analysis, chaos engineering is gambling. With it, chaos engineering is controlled risk-taking with documented bounds.

**Partition test coverage as an SLO input.** If a service has never been tested under the partition conditions documented in its `PartitionBehavior` struct, its availability SLO is not evidence-based: it is a guess. Staff engineers connect partition test coverage to SLO confidence: "we claim 99.9% availability, but we have never tested what happens when Redis is unavailable for 5 minutes, so that SLO is not validated." This framing makes the test investment concrete and justifiable in planning cycles.

---
