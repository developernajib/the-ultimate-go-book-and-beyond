## 64G.5 Clock Skew Problems

### Why time.Now() Is Dangerous in Distributed Systems

Wall clocks on different servers drift and can jump due to NTP corrections. Two events with timestamps A < B might have B happen causally before A.

```go
package hlc

import "time"

// Common clock-based bugs:

// Bug 1: Using wall clock for distributed event ordering
// Node A (clock: 10:00:00.100) processes event 1
// Node B (clock: 10:00:00.050, slightly behind) processes event 2 AFTER event 1
// Logs show event 2 timestamp (10:00:00.050) < event 1 timestamp (10:00:00.100)
// Analysis: "B was processed before A" - WRONG, confusing investigations

// Bug 2: Using wall clock for distributed lock expiry
type DistributedLock struct {
    expiresAt time.Time // Based on time.Now() - clock jumps can cause problems
}

func (l *DistributedLock) IsExpired() bool {
    return time.Now().After(l.expiresAt) // If clock jumps forward, lock expires "early"
}

// Bug 3: Using wall clock for conflict detection in multi-master replication
// Last-Write-Wins (LWW) with wall clocks:
// Node A writes value=100 at t=1000
// Node B writes value=200 at t=999 (B's clock is behind)
// LWW picks value=100 as "winner" but value=200 was the actual later write
```

### Hybrid Logical Clocks (HLC)

HLC combines physical time (for human-readability) with logical time (for causality). It's the algorithm used by CockroachDB, YugabyteDB, and others.

```go
// Hybrid Logical Clock implementation
// Based on: Kulkarni et al. "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases"

package hlc

import (
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

// HLC represents a Hybrid Logical Clock timestamp
// wall: physical time component (nanoseconds)
// logical: logical counter (disambiguates events at same physical time)
type HLC struct {
    Wall    int64 // Physical time in nanoseconds since Unix epoch
    Logical int32 // Logical counter
}

// HLCClock is a thread-safe HLC implementation
type HLCClock struct {
    mu      sync.Mutex
    current HLC
    maxDrift time.Duration // Max allowed clock skew from physical time
}

func NewHLCClock(maxDrift time.Duration) *HLCClock {
    return &HLCClock{
        maxDrift: maxDrift,
    }
}

// Now generates a new HLC timestamp for a local event
// Guarantees: returned timestamp > all previously returned timestamps
func (c *HLCClock) Now() HLC {
    c.mu.Lock()
    defer c.mu.Unlock()

    physicalNow := time.Now().UnixNano()

    if physicalNow > c.current.Wall {
        // Physical clock has advanced - use physical time, reset logical
        c.current = HLC{Wall: physicalNow, Logical: 0}
    } else {
        // Physical clock is behind or equal - increment logical counter
        c.current = HLC{
            Wall:    c.current.Wall,
            Logical: c.current.Logical + 1,
        }
    }

    return c.current
}

// Update incorporates a received timestamp (from a message or operation)
// Ensures this node's clock is >= the received clock
func (c *HLCClock) Update(received HLC) (HLC, error) {
    c.mu.Lock()
    defer c.mu.Unlock()

    physicalNow := time.Now().UnixNano()

    // Check for excessive clock skew
    if received.Wall > physicalNow+c.maxDrift.Nanoseconds() {
        return HLC{}, fmt.Errorf("received HLC %v is too far in future (max drift: %v)",
            time.Unix(0, received.Wall), c.maxDrift)
    }

    // new.wall = max(physical_now, current.wall, received.wall)
    newWall := physicalNow
    if c.current.Wall > newWall {
        newWall = c.current.Wall
    }
    if received.Wall > newWall {
        newWall = received.Wall
    }

    var newLogical int32
    if newWall == c.current.Wall && newWall == received.Wall {
        // All equal: increment to disambiguate
        newLogical = max32(c.current.Logical, received.Logical) + 1
    } else if newWall == c.current.Wall {
        newLogical = c.current.Logical + 1
    } else if newWall == received.Wall {
        newLogical = received.Logical + 1
    } else {
        // newWall == physicalNow > both current and received
        newLogical = 0
    }

    c.current = HLC{Wall: newWall, Logical: newLogical}
    return c.current, nil
}

// Before returns true if h happens-before other
// This is the core causal ordering guarantee
func (h HLC) Before(other HLC) bool {
    if h.Wall != other.Wall {
        return h.Wall < other.Wall
    }
    return h.Logical < other.Logical
}

func (h HLC) Equal(other HLC) bool {
    return h.Wall == other.Wall && h.Logical == other.Logical
}

func (h HLC) String() string {
    return fmt.Sprintf("%s.%d", time.Unix(0, h.Wall).UTC().Format(time.RFC3339Nano), h.Logical)
}

func max32(a, b int32) int32 {
    if a > b {
        return a
    }
    return b
}

// Usage: attach HLC to all messages and events
type Event struct {
    ID        string
    Timestamp HLC
    Data      json.RawMessage
}

// Distributed service using HLC
type DistributedStore struct {
    clock *HLCClock
    mu    sync.RWMutex
    data  map[string]*VersionedValue
}

type VersionedValue struct {
    Value     string
    Timestamp HLC
}

func (s *DistributedStore) Write(key, value string) {
    ts := s.clock.Now()
    s.mu.Lock()
    defer s.mu.Unlock()
    s.data[key] = &VersionedValue{Value: value, Timestamp: ts}
}

func (s *DistributedStore) ReadWithCausalConsistency(key string, minTimestamp HLC) (*VersionedValue, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    v, ok := s.data[key]
    if !ok {
        return nil, fmt.Errorf("key not found: %s", key)
    }

    // Causal consistency: only return value if it's at least as new as minTimestamp
    if v.Timestamp.Before(minTimestamp) {
        return nil, fmt.Errorf("causal consistency violation: value too old")
    }

    return v, nil
}
```

### Practical Clock Skew Protection

Clock skew between nodes in a distributed system can cause events to appear out of order, leases to expire prematurely, and time-based deduplication to fail. The following Go implementation adds a bounded-skew tolerance layer around time comparisons and lease checks, treating any timestamp within the configured skew window as potentially concurrent rather than definitively ordered.

```go
package hlc

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
)

type HLC struct {
	Wall    int64 `json:"wall"`
	Logical int32 `json:"logical"`
}

type HLCClock struct{}

func (c *HLCClock) Now() HLC                         { return HLC{} }
func (c *HLCClock) Update(received HLC) (HLC, error) { return HLC{}, nil }

type Handler struct {
	clock *HLCClock
}

func (h *Handler) processRequest(ctx context.Context, req Request) (string, error) {
	return "ok", nil
}

type Client struct {
	clock      *HLCClock
	httpClient *http.Client
}

func buildHTTPRequest(req Request) *http.Request {
	r, _ := http.NewRequest("POST", "http://example.com", nil)
	return r
}

// Pattern: include HLC in all cross-service messages
type Request struct {
	Data      string `json:"data,omitempty"`
	ClientHLC HLC    `json:"client_hlc"` // Sender's HLC at time of send
}

type Response struct {
	Data      string `json:"data,omitempty"`
	ServerHLC HLC    `json:"server_hlc"` // Server's HLC at time of response
}

// Service handler: update local clock with received timestamp
func (h *Handler) HandleRequest(ctx context.Context, req Request) (Response, error) {
	// Update local clock with client's HLC
	myHLC, err := h.clock.Update(req.ClientHLC)
	if err != nil {
		return Response{}, fmt.Errorf("clock skew too large: %w", err)
	}

	// Process request
	result, err := h.processRequest(ctx, req)
	if err != nil {
		return Response{}, err
	}

	// Return server's current HLC for client to update its clock
	return Response{
		Data:      result,
		ServerHLC: myHLC,
	}, nil
}

// Client: update clock with received HLC
func (c *Client) Call(ctx context.Context, req Request) (Response, error) {
	req.ClientHLC = c.clock.Now()

	httpResp, err := c.httpClient.Do(buildHTTPRequest(req))
	if err != nil {
		return Response{}, err
	}
	defer httpResp.Body.Close()

	var resp Response
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return Response{}, err
	}

	// Update client clock with server's HLC
	if _, err := c.clock.Update(resp.ServerHLC); err != nil {
		// Log warning but don't fail - clock skew detection
		slog.Warn("clock skew detected with server", "error", err)
	}

	return resp, nil
}
```

### Junior → FAANG: Clock Skew as an Interview Signal

Clock skew is a prerequisite topic for FAANG distributed systems interviews because it exposes whether a candidate has actually thought about the physical reality of multi-machine systems. Candidates who have only worked on single-machine systems often assume clocks are synchronized. They are not.

The practical entry point: when an interviewer asks "how do you order events across services?", the answer "use timestamps from `time.Now()`" is a red flag. The correct answer is "use a logical clock (Lamport clock, vector clock) or HLC so that causality is preserved regardless of clock skew." Being able to explain why wall clocks fail and what HLC does differently is an L4-to-L5 differentiator.

For first-job engineers: the three bugs listed in this section (ordering, lock expiry, LWW conflict resolution) are real patterns in production codebases. When reviewing code that uses `time.Now()` for distributed event comparison, raise a question in code review: is this comparison safe in the presence of NTP corrections or multi-node clock skew?

The HLC implementation in this section is worth reading carefully. The `Update` method, which takes the maximum of local physical time, local logical time, and the received timestamp, is the core of the algorithm. Understand why each component is necessary before the interview.

### Senior @ FAANG: HLC Adoption as a Platform Decision

At senior level, clock skew handling is not a per-service decision: it is a platform decision. If one service uses wall clocks and another uses HLC, the system cannot produce a consistent causal ordering of events across service boundaries. The result is that post-mortems during incidents may reconstruct a causally incorrect timeline, leading to wrong root cause attribution.

**HLC in the shared SDK.** Staff engineers at FAANG-scale organizations provide HLC as a first-class component of the internal service SDK, alongside structured logging and distributed tracing. The API surface is minimal: `clock.Now()` returns an HLC timestamp, and outbound request/response types include an HLC field that is automatically populated and extracted by the SDK's HTTP/gRPC transport layer. Engineers using the SDK get correct causal ordering without understanding the HLC algorithm. Engineers who bypass the SDK and use `time.Now()` are subject to code review rejection.

**Maximum drift configuration and alerting.** The `maxDrift` parameter in the `HLCClock.Update` method is a platform-level configuration concern. If it is too small, legitimate clock skew causes requests to be rejected. If it is too large, HLC loses its ability to bound the difference between physical time and logical time, which affects the human-readability guarantee. At FAANG, the value is determined by the NTP configuration of the production fleet (typically 500ms to 2 seconds) and is managed centrally rather than configured per service. An alert fires when any node's HLC drifts beyond 80% of the configured maximum, triggering an NTP investigation before it causes correctness issues.

**TrueTime vs HLC: when to use each.** HLC is the practical choice for most distributed systems: it is implementable in any language, requires no special hardware, and provides causal ordering with bounded physical-time deviation. TrueTime (Google Spanner) provides a stronger guarantee: commit wait ensures that no future transaction can have an earlier physical timestamp, enabling external consistency (a stricter form of linearizability across data centers). The cost is GPS receivers and atomic clocks in every data center. For most organizations, HLC at the application layer combined with per-region strong consistency (CockroachDB) is the correct trade-off. TrueTime is justified only when cross-region linearizability is a hard requirement, as in global financial transaction systems.

**HLC in event sourcing and audit logs.** Systems that use event sourcing (appending immutable events to a log) rely on event ordering for correctness. If wall clocks are used, an event written by a node with a slow clock may be replayed out of order during event stream reconstruction, corrupting the aggregate state. HLC, propagated through the event metadata, provides a total causal ordering that is safe for event stream replay. This is the argument for making HLC the default event timestamp format in any event-sourced system at FAANG, regardless of whether the team understands clock skew: the platform-level default is correct, and the cost of not using it is a subtle, hard-to-reproduce correctness bug.

---
