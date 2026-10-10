## 14. Testing Multi-Region Behavior

Tests must cover the full stack: CRDT merges, conflict resolution, failover logic, and chaos fault injection. Multi-region systems are notoriously difficult to test because real failures involve network partitions, clock skew, and race conditions that are hard to reproduce deterministically. The tests below use Go's standard testing package to verify each layer independently: vector clock causal ordering, CRDT merge commutativity and idempotency, LWW and vector-clock-based conflict resolution, failover controller drain behavior, and traffic weight validation. Each test constructs its dependencies in-process with no external services required, making them fast and reliable enough to run in CI on every commit.

```go
// tests/multiregion_test.go
package tests

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"yourmodule/crdt"
	"yourmodule/failover"
	"yourmodule/region"
	"yourmodule/replication"
	"yourmodule/trafficmgr"

	"log/slog"
	"os"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// ── Vector Clock Tests ────────────────────────────────────────────────────────

func TestVectorClockCausalOrdering(t *testing.T) {
	a := crdt.NewVectorClock()
	b := crdt.NewVectorClock()

	a.Increment("node-A")
	a.Increment("node-A")

	// b has not seen node-A's events
	rel := b.Compare(a)
	if rel != crdt.RelationBefore {
		t.Errorf("expected b to be before a; got %s", rel)
	}

	b.Merge(a) // b now knows about node-A's events

	rel = b.Compare(a)
	if rel != crdt.RelationEqual && rel != crdt.RelationAfter {
		t.Errorf("after merge, b should be equal or after a; got %s", rel)
	}
}

func TestVectorClockConcurrentWrites(t *testing.T) {
	alice := crdt.NewVectorClock()
	bob := crdt.NewVectorClock()

	// Both clocks advance independently - no communication.
	alice.Increment("alice")
	bob.Increment("bob")

	rel := alice.Compare(bob)
	if rel != crdt.RelationConcurrent {
		t.Errorf("expected concurrent; got %s", rel)
	}
}

// ── CRDT Tests ───────────────────────────────────────────────────────────────

func TestLWWRegisterMerge(t *testing.T) {
	r1 := crdt.NewLWWRegister[string]("node-1")
	r2 := crdt.NewLWWRegister[string]("node-2")

	t1 := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Second)

	r1.Set("old-value", t1)
	r2.Set("new-value", t2)

	r1.Merge(r2)

	val, _ := r1.Get()
	if val != "new-value" {
		t.Errorf("expected new-value after merge; got %q", val)
	}
}

func TestGCounterMerge(t *testing.T) {
	c1 := crdt.NewGCounter("region-1")
	c2 := crdt.NewGCounter("region-2")

	c1.Increment(10)
	c2.Increment(5)

	c1.Merge(c2)

	if c1.Value() != 15 {
		t.Errorf("expected 15 after merge; got %d", c1.Value())
	}

	// Merging again is idempotent.
	c1.Merge(c2)
	if c1.Value() != 15 {
		t.Errorf("merge should be idempotent; got %d", c1.Value())
	}
}

func TestPNCounterBehavior(t *testing.T) {
	c := crdt.NewPNCounter("node-1")
	c.Increment(100)
	c.Decrement(30)

	if c.Value() != 70 {
		t.Errorf("expected 70; got %d", c.Value())
	}
}

// ── Replication Conflict Resolution Tests ────────────────────────────────────

func TestLWWConflictResolution(t *testing.T) {
	older := &replication.ReplicationEvent{
		ID:           "1",
		SourceRegion: "us-east-1",
		Timestamp:    time.Now().Add(-time.Minute),
	}
	newer := &replication.ReplicationEvent{
		ID:           "2",
		SourceRegion: "eu-west-1",
		Timestamp:    time.Now(),
	}

	resolver := &replication.LWWConflictResolver{}
	winner, err := resolver.Resolve(older, newer)
	if err != nil {
		t.Fatal(err)
	}
	if winner.ID != newer.ID {
		t.Errorf("expected newer event to win; got %s", winner.ID)
	}
}

func TestVectorClockConflictDetection(t *testing.T) {
	conflictCalled := false

	resolver := replication.NewVectorClockResolver(
		func(local, remote *replication.ReplicationEvent) (*replication.ReplicationEvent, error) {
			conflictCalled = true
			return remote, nil
		},
	)

	// Build two events with concurrent clocks.
	clock1 := crdt.NewVectorClock()
	clock1.Increment("node-A")

	clock2 := crdt.NewVectorClock()
	clock2.Increment("node-B")

	local := &replication.ReplicationEvent{
		ID:        "1",
		Clock:     clock1,
		Timestamp: time.Now(),
	}
	remote := &replication.ReplicationEvent{
		ID:        "2",
		Clock:     clock2,
		Timestamp: time.Now().Add(time.Millisecond),
	}

	_, err := resolver.Resolve(local, remote)
	if err != nil {
		t.Fatal(err)
	}
	if !conflictCalled {
		t.Error("expected conflict handler to be called for concurrent clocks")
	}
}

// ── Failover Controller Tests ─────────────────────────────────────────────────

type mockNotifier struct {
	events []failover.Event
}

func (m *mockNotifier) Notify(_ context.Context, e failover.Event) error {
	m.events = append(m.events, e)
	return nil
}

func TestFailoverDrainsUnhealthyRegion(t *testing.T) {
	logger := testLogger()
	reg := region.NewRegistry(region.TopologyActiveActive, "us-east-1", logger)

	r1 := &region.Region{ID: "us-east-1", Priority: 1}
	r2 := &region.Region{ID: "eu-west-1", Priority: 2}
	r1.UpdateHealth(1.0)
	r2.UpdateHealth(1.0)
	r1.SetRole(region.RolePrimary)
	r2.SetRole(region.RoleSecondary)
	reg.Register(r1)
	reg.Register(r2)

	shifter := trafficmgr.NewTrafficShifter(reg, logger)
	notifier := &mockNotifier{}
	cfg := failover.Config{
		HealthThreshold:   0.4,
		RecoveryThreshold: 0.7,
		CheckInterval:     50 * time.Millisecond,
		DrainDuration:     200 * time.Millisecond,
		MinHealthyRegions: 1,
	}

	fc := failover.NewController(cfg, reg, shifter, notifier, logger)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go fc.Run(ctx)

	// Drop eu-west-1 below threshold.
	time.Sleep(100 * time.Millisecond)
	r2.UpdateHealth(0.1)

	// Wait for drain to complete.
	time.Sleep(600 * time.Millisecond)

	if r2.GetRole() != region.RoleStandby {
		t.Errorf("expected eu-west-1 to be standby; got %s", r2.GetRole())
	}
	if len(notifier.events) == 0 {
		t.Error("expected at least one failover notification")
	}
}

// ── Traffic Weight Tests ──────────────────────────────────────────────────────

func TestTrafficWeightValidation(t *testing.T) {
	valid := trafficmgr.WeightMap{"us-east-1": 60, "eu-west-1": 40}
	if err := valid.Validate(); err != nil {
		t.Errorf("valid map should pass; got: %v", err)
	}

	invalid := trafficmgr.WeightMap{"us-east-1": 60, "eu-west-1": 50}
	if err := invalid.Validate(); err == nil {
		t.Error("weights summing to 110 should fail validation")
	}

	negative := trafficmgr.WeightMap{"us-east-1": -10, "eu-west-1": 110}
	if err := negative.Validate(); err == nil {
		t.Error("negative weight should fail validation")
	}
}

func TestWeightMapSerialization(t *testing.T) {
	wm := trafficmgr.WeightMap{"us-east-1": 70, "eu-west-1": 30}
	raw, err := json.Marshal(wm)
	if err != nil {
		t.Fatal(err)
	}
	var decoded trafficmgr.WeightMap
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["us-east-1"] != 70 || decoded["eu-west-1"] != 30 {
		t.Errorf("round-trip failed: %v", decoded)
	}
}
```

---

### Junior -> FAANG: Testing Distributed System Properties

Multi-region tests require testing properties that do not appear in single-server tests: commutativity, idempotency, causal ordering, and convergence. These properties cannot be verified by asserting a single output value. They require composing multiple operations and asserting invariants hold across all orderings.

The `TestVectorClockConcurrentWrites` test is a good template: it sets up two clocks that advance independently (simulating two nodes without communication), then asserts the comparison returns `RelationConcurrent`. This tests the precise definition of concurrency in a distributed system. Practice writing similar tests for CRDT merge commutativity: `A.Merge(B)` must produce the same result as `B.Merge(A)`.

The `TestFailoverDrainsUnhealthyRegion` test uses `time.Sleep` to coordinate test timing. This is an anti-pattern in Go unit tests (tests should not sleep), but for control-loop tests it is sometimes unavoidable because you need to wait for the ticker to fire. A better approach is to inject a test clock that advances on demand, replacing `time.NewTicker` with a testable abstraction. The test becomes deterministic: advance the clock, assert the drain happened.

### Senior @ FAANG: Test Architecture for Distributed Systems at Scale

**Property-based testing for CRDT correctness.** The tests above verify specific scenarios. Property-based testing generates random inputs and verifies invariants hold across all of them. For CRDTs, the relevant invariants are: merge is commutative (A.Merge(B) == B.Merge(A)), merge is idempotent (A.Merge(B).Merge(B) == A.Merge(B)), and merge is associative (A.Merge(B).Merge(C) == A.Merge(B.Merge(C))). The `pgregory.net/rapid` or `github.com/leanovate/gopter` libraries provide property-based testing for Go. At L6, you write property tests for every CRDT implementation and run them as part of CI, not just the happy-path scenario tests.

**Fault injection in unit tests.** The chaos injector in the production code accepts a `*chaos.Injector`. Unit tests can create an injector, inject a specific fault, and verify that the middleware or replication engine handles it correctly. This is the correct level of testing for fault paths: test each fault type independently, with the minimal amount of production code in scope, before running full integration tests that combine multiple faults. The tests above do not exercise the chaos injector at all. Add those as a follow-on.

**Test isolation and the in-memory stubs.** The tests use `region.NewRegistry` and `trafficmgr.NewTrafficShifter` directly without any mocking. This is correct because both are pure in-memory structures. The tests would need mocks if any component made external network calls or accessed real databases. Keep tests at the correct isolation level: unit tests use in-memory fakes, integration tests use Docker-based real dependencies, and end-to-end tests use real environments.

**Race detector as a required CI gate.** All tests in this file should run with the race detector enabled (`go test -race`). The `Controller`, `TrafficShifter`, and `Registry` all use internal mutexes. If any mutex is acquired in an inconsistent order or a field is accessed without the mutex held, the race detector will catch it. At L6+, `-race` is non-negotiable in CI. Any test suite that does not enable the race detector is missing a whole class of bugs that only appear under concurrent load.

**Failover test determinism.** The `TestFailoverDrainsUnhealthyRegion` test uses `time.Sleep(100 * time.Millisecond)` to let the controller start before setting the region unhealthy, then `time.Sleep(600 * time.Millisecond)` to wait for the drain to complete. These sleeps are fragile under CPU load. A principal engineer replaces them with a polling loop with a reasonable deadline: `require.Eventually(t, func() bool { return r2.GetRole() == region.RoleStandby }, 2*time.Second, 50*time.Millisecond)`. The `testify/require.Eventually` helper provides this without fixed sleeps, making the test fast when the drain completes quickly and still correct when the CI machine is loaded.
