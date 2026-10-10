## Section 10: Horizontal Scaling Patterns

### 10.1 Stateless Design for Horizontal Scale

Stateless services scale horizontally by design: any instance can handle any request because session state lives in an external store (Redis, database) rather than process memory, and instance count becomes an operational dial rather than a code constraint. Achieving true statelessness requires auditing every in-process cache, every goroutine that accumulates state, and every connection pool to ensure they are either externalized or intentionally ephemeral. The design patterns below show how to refactor common stateful patterns, rate limiters, session stores, distributed locks, into stateless equivalents that scale linearly with instance count.

```go
package scaling

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"hash/fnv"
	"net/http"
	"sort"
	"sync"
	"time"
)

// StatelessSessionManager stores session data in Redis instead of memory.
// Allows any node to handle any request, which is what makes the fleet
// horizontally scalable.
type StatelessSessionManager struct {
	redis SessionStore
	ttl   time.Duration
}

// SessionStore abstracts the session storage backend.
type SessionStore interface {
	Get(ctx context.Context, sessionID string) (*Session, error)
	Set(ctx context.Context, sessionID string, session *Session, ttl time.Duration) error
	Delete(ctx context.Context, sessionID string) error
	Extend(ctx context.Context, sessionID string, ttl time.Duration) error
}

// Session holds user session data.
type Session struct {
	UserID    string    `json:"user_id"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	IPAddress string    `json:"ip_address"`
	UserAgent string    `json:"user_agent"`
}

func NewStatelessSessionManager(store SessionStore, ttl time.Duration) *StatelessSessionManager {
	return &StatelessSessionManager{redis: store, ttl: ttl}
}

// CreateSession generates a cryptographically random session ID
// and stores session data in Redis.
func (m *StatelessSessionManager) CreateSession(ctx context.Context, userID, role string, r *http.Request) (string, error) {
	sessionID, err := generateSessionID()
	if err != nil {
		return "", fmt.Errorf("generate session id: %w", err)
	}

	session := &Session{
		UserID:    userID,
		Role:      role,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(m.ttl),
		IPAddress: r.RemoteAddr,
		UserAgent: r.UserAgent(),
	}

	if err := m.redis.Set(ctx, sessionID, session, m.ttl); err != nil {
		return "", fmt.Errorf("store session: %w", err)
	}
	return sessionID, nil
}

// GetSession retrieves and validates a session from Redis.
func (m *StatelessSessionManager) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("empty session id")
	}
	session, err := m.redis.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	if time.Now().After(session.ExpiresAt) {
		_ = m.redis.Delete(ctx, sessionID)
		return nil, fmt.Errorf("session expired")
	}
	// Sliding expiry: extend TTL on access.
	_ = m.redis.Extend(ctx, sessionID, m.ttl)
	return session, nil
}

func generateSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// ConsistentHashRouter routes requests to backend nodes using consistent hashing.
// Removing one of N nodes remaps roughly 1/N of keys, where modulo hashing would
// remap nearly all of them. Section 10.3 gives the measured numbers.
//
// The mutex is not optional. Membership changes arrive from service discovery on
// one goroutine while request handlers call Route on many others, so the
// unsynchronized version of this type is a data race on `ring`, and the race
// detector reports it immediately.
type ConsistentHashRouter struct {
	mu       sync.RWMutex
	ring     []ringEntry
	replicas int
}

type ringEntry struct {
	hash uint32
	node string
}

func NewConsistentHashRouter(nodes []string, replicas int) *ConsistentHashRouter {
	r := &ConsistentHashRouter{replicas: replicas}
	for _, node := range nodes {
		r.AddNode(node)
	}
	return r
}

func (r *ConsistentHashRouter) AddNode(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < r.replicas; i++ {
		key := fmt.Sprintf("%s-%d", node, i)
		r.ring = append(r.ring, ringEntry{hash: r.hash(key), node: node})
	}
	// The new replicas hash to positions scattered across the whole ring, so
	// the ring is *not* nearly sorted after an add and an insertion sort
	// degrades to O(n^2): building a 100-node ring at 150 replicas costs 57.3
	// million swaps. sort.Slice does it in O(n log n).
	sort.Slice(r.ring, func(i, j int) bool { return r.ring[i].hash < r.ring[j].hash })
}

// RemoveNode drops every replica of node. Filtering in place preserves the
// existing order, so the ring stays sorted and needs no re-sort.
func (r *ConsistentHashRouter) RemoveNode(node string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	newRing := r.ring[:0]
	for _, entry := range r.ring {
		if entry.node != node {
			newRing = append(newRing, entry)
		}
	}
	r.ring = newRing
}

// Route returns the node responsible for the given key.
func (r *ConsistentHashRouter) Route(key string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.ring) == 0 {
		return ""
	}
	h := r.hash(key)
	// Binary search for the first node with hash >= key's hash.
	lo, hi := 0, len(r.ring)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1) // >>1 on uint cannot overflow
		if r.ring[mid].hash < h {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	// Wrap around.
	if lo == len(r.ring) {
		lo = 0
	}
	return r.ring[lo].node
}

func (r *ConsistentHashRouter) hash(key string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(key))
	return h.Sum32()
}
```

### 10.2 Vertical vs horizontal: the trade-off table

The industry default is "scale horizontally," and it is usually right, but not universally. Vertical scale on a dual-socket 64-core box with 256 GB RAM buys you lower latency (no network hop), simpler ops (one process, one log stream, one dashboard), and lower cross-zone network cost. Horizontal scale on 64 four-core VMs buys you fault isolation (one crash takes out 1.5 percent of capacity, not 100 percent), easier rolling deploys, and cheaper cloud pricing (the sweet spot for CPU-hours is usually 4 to 16 vCPUs per VM). A 1M RPS system typically lands on horizontal for production (dozens to hundreds of instances) but keeps the single-binary-vertical shape available for staging, debugging, and capacity emergencies. Write down your target per-instance RPS (50K, 100K, 250K?), the total fleet size, and the cost per million requests. These three numbers drive almost every other architectural decision and are the first thing a capacity reviewer will ask for.

### 10.3 Consistent hashing in practice (and where it breaks)

Consistent hashing is a beautiful technique that shows up in every senior distributed-systems interview, but in production it has failure modes worth knowing.

Start with the property that earns it its place. Routing 100,000 keys across 100 backends at 150 replicas each and then removing a single node, the implementation above remapped **1.25 percent** of keys, close to the 1/N ideal of 1 percent. Modulo hashing over the same removal remapped **98.99 percent**. At N=10 the numbers were 10.45 percent versus 90.10 percent. That is the whole argument for the technique, and it holds up.

What does not hold up is the assumption that the ring distributes load evenly. Virtual replicas land at random ring positions, so the arcs they own are not equal. Measured on the code above, 200,000 keys across 100 backends:

| Virtual replicas per node | Busiest node vs average | Quietest node vs average |
|---|---|---|
| 100 | 1.92x | 0.35x |
| 150 | 2.29x | 0.53x |
| 500 | 1.44x | 0.69x |
| 1000 | 1.35x | 0.70x |

Even at 1000 replicas per node, the busiest backend still takes 35 percent more than its share. Replicas buy you smoothness with diminishing returns, and they never buy you a bound. Provision against the peak, not the average, or the ring will find the difference for you.

The second failure mode is removal. Every key owned by a departing node moves to the single next node clockwise on the ring, so that neighbor absorbs the whole departed share rather than 1/N of it. Google's "consistent hashing with bounded loads" (Mirrokni, Thorup, and Zadimoghaddam, 2016) addresses exactly this: it caps any node's load at a configurable factor c above the fleet average, commonly 1.25, and spills overflow to the next node with capacity. Use it for any routing decision that actually determines where hot traffic lands. Note that jump consistent hashing (Lamping and Veach, 2014) is a different tool solving a different problem: it is O(1) in memory and faster to compute, but it only supports removing the *last* bucket, so it does not fit a fleet where arbitrary nodes fail. It is not a bounded-load variant.

For session affinity only (cache locality, not correctness), basic consistent hashing with a few hundred virtual replicas is fine, since a 1.4x cache-hit imbalance costs you nothing but a little memory. Know the alternative: rendezvous hashing (HRW, "highest random weight") hashes the key against every node and picks the maximum. It is simpler to implement, needs no ring and no virtual replicas, and distributes *better* than a basic ring because it has no arc-length lottery. The cost is O(N) per lookup instead of O(log N). For small N (under 64 backends) it is often the better choice.

### 10.4 Junior → FAANG: the statelessness audit

Take any service you own and answer these questions on paper. What state does a request depend on beyond its own input? Where does that state live (process memory, local disk, a downstream service)? If this instance died mid-request, can a replay on a different instance succeed? If not, which step fails and what is the user-visible effect? Do any two consecutive requests from the same user need to land on the same instance? If yes, why, and is that requirement negotiable? This audit takes half a day, surfaces every hidden stateful coupling, and is the conversation that interviewers are probing for when they ask "design a scalable X." Preparing this walkthrough for one or two services you have shipped is more valuable than memorizing any particular pattern.

### 10.5 Senior @ FAANG: the multi-region 1M RPS architecture

At 1M RPS single-region, the next scaling question is multi-region, and it is a different problem. The choices are active-active (every region takes writes, which demands conflict resolution, typically via CRDT or last-writer-wins with careful semantics), active-passive (one region takes writes, others serve reads, failover is a manual or slow-automated event), and regional sharding (each user or tenant is pinned to one region, writes never cross). Each choice is a trade-off between latency (active-active minimizes user-observed RTT), consistency (active-passive gives the strongest consistency guarantees), and complexity (sharding is simplest but creates cross-region traffic when users move or share data). The staff-engineer's artifact is a document that states which model the service uses, what the RPO and RTO are (recovery point and recovery time objectives), what happens during a region outage, and what happens during a region split-brain. If that document does not exist, the system does not have a real multi-region story, it has a wish list. Writing it, defending it at review, and keeping it current as the service evolves is the load-bearing work that separates staff engineers from senior engineers in this space.

---
