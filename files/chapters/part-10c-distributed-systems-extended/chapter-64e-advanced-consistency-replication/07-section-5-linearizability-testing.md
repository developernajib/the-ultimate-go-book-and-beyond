## Section 5: Linearizability Testing

### 5.1 History-Based Linearizability Checker

Linearizability testing validates that a concurrent execution history is consistent with some sequential ordering of operations. This is a critical correctness property for distributed databases and coordination services. The following Go implementation uses the Wing-Gong algorithm to exhaustively search for a valid sequential history that matches the observed concurrent execution.

```go
package linearcheck

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Operation represents a single operation in a linearizability test.
type Operation struct {
	Process   int    // Client/process ID.
	OpType    string // "write", "read", "cas", etc.
	Key       string
	Value     any // Value written or read.
	CallTime  time.Time   // When the operation was invoked.
	RetTime   time.Time   // When the operation returned.
	Succeeded bool        // Whether the operation succeeded.
}

// History is a sequence of operations from multiple concurrent processes.
type History []Operation

// LinearizabilityResult reports the linearizability check outcome.
type LinearizabilityResult struct {
	IsLinearizable bool
	Violations     []Violation
}

// Violation describes a specific linearizability violation.
type Violation struct {
	Operations []Operation
	Reason     string
}

// CheckLinearizability checks if a history is linearizable.
// A history is linearizable if there exists a sequential ordering of
// all operations such that:
// 1. Each operation appears to take effect at a single point between
//    its invocation and return.
// 2. The sequential ordering respects the real-time ordering of
//    non-overlapping operations.
// 3. The sequential ordering is consistent with the specification
//    of the data structure.
//
// This is a simplified checker for read/write operations on a single register.
// Full linearizability checking (WGL algorithm) is NP-complete.
func CheckLinearizability(history History) LinearizabilityResult {
	// Sort operations by call time.
	sort.Slice(history, func(i, j int) bool {
		return history[i].CallTime.Before(history[j].CallTime)
	})

	checker := &linearChecker{
		history:    history,
		violations: nil,
	}
	checker.check()

	return LinearizabilityResult{
		IsLinearizable: len(checker.violations) == 0,
		Violations:     checker.violations,
	}
}

type linearChecker struct {
	history    History
	violations []Violation
	state      any // Current register value.
}

func (c *linearChecker) check() {
	// Try to find a linearization order.
	// For a simple register: check that reads return the most recently written value.
	lastWrite := map[string]any{}

	// Find all completed operations that overlap in time.
	for _, op := range c.history {
		if !op.Succeeded {
			continue
		}
		switch op.OpType {
		case "write":
			lastWrite[op.Key] = op.Value
		case "read":
			expected, ok := lastWrite[op.Key]
			if ok && op.Value != expected {
				// The read saw a value that wasn't the last write.
				// Could be linearizable if there was a concurrent write.
				// For this simplified checker: flag as potential violation.
				c.violations = append(c.violations, Violation{
					Operations: []Operation{op},
					Reason: fmt.Sprintf(
						"read key=%s returned %v, expected %v",
						op.Key, op.Value, expected),
				})
			}
		}
	}
}

// JepsenStyleTest runs a concurrency test and records operations for linearizability checking.
type JepsenStyleTest struct {
	numProcesses int
	duration     time.Duration
	history      chan Operation
}

func NewJepsenStyleTest(processes int, duration time.Duration) *JepsenStyleTest {
	return &JepsenStyleTest{
		numProcesses: processes,
		duration:     duration,
		history:      make(chan Operation, 100000),
	}
}

// Run executes the test against the provided system under test.
func (t *JepsenStyleTest) Run(sut SystemUnderTest) LinearizabilityResult {
	ctx, cancel := context.WithTimeout(context.Background(), t.duration)
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < t.numProcesses; i++ {
		wg.Add(1)
		go t.runProcess(ctx, &wg, i, sut)
	}
	wg.Wait()
	close(t.history)

	var history History
	for op := range t.history {
		history = append(history, op)
	}

	return CheckLinearizability(history)
}

func (t *JepsenStyleTest) runProcess(ctx context.Context, wg *sync.WaitGroup, processID int, sut SystemUnderTest) {
	defer wg.Done()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Alternate between reads and writes.
		key := "shared-key"
		op := Operation{
			Process:  processID,
			Key:      key,
			CallTime: time.Now(),
		}

		if processID%2 == 0 {
			// Write.
			val := processID * 1000
			op.OpType = "write"
			op.Value = val
			err := sut.Put(key, val)
			op.RetTime = time.Now()
			op.Succeeded = err == nil
		} else {
			// Read.
			op.OpType = "read"
			val, err := sut.Get(key)
			op.RetTime = time.Now()
			op.Value = val
			op.Succeeded = err == nil
		}

		select {
		case t.history <- op:
		default:
			// History buffer full.
		}
	}
}

// SystemUnderTest is the interface for the system being tested.
type SystemUnderTest interface {
	Get(key string) (any, error)
	Put(key string, value any) error
}

// imports
var _ = sync.WaitGroup{}
var _ = context.Background
```

### Junior → FAANG: Linearizability Testing as a Correctness Discipline

The most important thing to understand about linearizability testing is that it is the only reliable way to catch consistency bugs in distributed systems. Unit tests can verify individual operations in isolation. Integration tests can verify the happy path. But linearizability testing explores the concurrent execution histories that only occur under real concurrency, and these are precisely the executions where consistency bugs hide.

The `JepsenStyleTest` in this section is a simplified version of what Jepsen actually does. The real insight is the test structure: run concurrent clients against the system under test, record every operation with its call time and return time, and then verify that the recorded history is consistent with some sequential execution. If no sequential execution matches the history, the system violated linearizability during that test run.

For a junior engineer, the practical takeaway is that distributed systems testing requires deliberately inducing failures during concurrent operation. Running the system without faults and checking the happy path is not sufficient. The bugs that matter (the ones that cause data corruption) only manifest under: concurrent writes from multiple clients, network partitions (kill a node mid-request), and process restarts during write replication. A test framework that does not inject these faults is not testing the failure modes that matter.

When reading this implementation: note that the `check()` function here is a simplified heuristic, not the full WGL algorithm. The full algorithm is NP-complete in the worst case. For practical use, Jepsen uses a more efficient approximation (Elle, based on dependency cycle detection) that handles most real-world violations in polynomial time.

Interview framing: if asked "how would you test your distributed key-value store for correctness," the answer should include linearizability testing with fault injection, not just unit tests on individual operations.

### Senior @ FAANG: Building a Production Linearizability Testing Pipeline

At the platform level, linearizability testing is a CI/CD gate, not a one-time verification. The question is how to integrate a correctness checker that requires running concurrent clients with fault injection into a standard pull-request pipeline.

The practical architecture for a production linearizability test pipeline: a hermetic test environment that spins up a cluster (typically in Docker or on VMs), a test driver that spawns concurrent clients with configurable concurrency and fault injection profiles, a history recorder that captures operation timing with nanosecond precision, and an analyzer (Elle or a similar checker) that runs on the recorded history. The entire test run should complete in under 10 minutes to be viable as a CI gate.

Fault injection profiles to cover: leader election (SIGKILL the Raft leader mid-write), network partition (iptables DROP between specific nodes for 5 seconds), process restart during log replication, and clock skew injection (shift the system clock on one node by 200ms). Each profile targets a different failure mode and should be run as a separate test case with a deterministic fault injection schedule to make failures reproducible.

False positive management: a history analyzer that reports violations when none exist is worse than no analyzer. The common source of false positives is imprecise timing: if the test driver records operation timestamps in user space, scheduling jitter can make the recorded call/return times incorrect, leading the analyzer to believe operations overlapped when they did not. Production test frameworks solve this with kernel-level timing (eBPF probes on syscalls) or by using a test proxy that records timestamps at the network layer.

At the staff level, integrating linearizability testing into your team's culture is a governance challenge. Engineers who have never seen a linearizability violation resist the overhead. The most effective approach is to run linearizability tests on the current production system and find a violation first, then use the violation as justification for adding the test gate. Most distributed systems that have never been Jepsen-tested have at least one violation waiting to be found.

The relationship between linearizability testing and SLO: a linearizability violation found in CI prevents a consistency regression from reaching production. But a violation found in CI does not guarantee no violations in production (the test does not cover all possible interleavings). The SLO should include a meantime-to-detect metric for production consistency violations, implemented via anomaly detection on read-your-own-writes checks or sentinel key monitoring.

---
