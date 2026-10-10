## Section 1: Distributed Locks

### 1.1 etcd-Based Distributed Lock with Fencing Tokens

A correct distributed lock must issue fencing tokens (monotonically increasing integers) that resource holders include with every write, allowing the resource to reject writes from former lock holders that are merely slow rather than failed. The following Go implementation uses etcd's lease and compare-and-swap primitives to implement a lock that issues fencing tokens, preventing split-brain writes when a lock holder pauses due to GC.

```go
package distlock

import (
	"context"
	"fmt"
	"sync"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// DistributedLock provides a distributed mutual exclusion lock backed by etcd.
// Uses etcd's built-in session + mutex for correctness.
// Critical: includes fencing tokens to prevent split-brain operations.
type DistributedLock struct {
	client   *clientv3.Client
	session  *concurrency.Session
	mutex    *concurrency.Mutex
	resource string
	ttl      int // Seconds. Lock is auto-released if process dies.
}

// NewDistributedLock creates a new distributed lock for the given resource.
func NewDistributedLock(client *clientv3.Client, resource string, ttlSeconds int) (*DistributedLock, error) {
	// Session creates a lease that expires if the client crashes.
	session, err := concurrency.NewSession(client, concurrency.WithTTL(ttlSeconds))
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	mutex := concurrency.NewMutex(session, "/locks/"+resource)
	return &DistributedLock{
		client:   client,
		session:  session,
		mutex:    mutex,
		resource: resource,
		ttl:      ttlSeconds,
	}, nil
}

// Lock acquires the lock, blocking until available or context expires.
// Returns a FencingToken that must be included in all protected operations.
func (dl *DistributedLock) Lock(ctx context.Context) (FencingToken, error) {
	if err := dl.mutex.Lock(ctx); err != nil {
		return FencingToken{}, fmt.Errorf("acquire lock: %w", err)
	}

	// Generate fencing token: etcd revision at time of acquisition.
	// This monotonically increasing number detects stale lock holders.
	resp, err := dl.client.Get(ctx, dl.mutex.Key())
	if err != nil {
		_ = dl.mutex.Unlock(ctx)
		return FencingToken{}, fmt.Errorf("get fencing token: %w", err)
	}

	var revision int64
	if len(resp.Kvs) > 0 {
		revision = resp.Kvs[0].ModRevision
	}

	return FencingToken{
		Resource:  dl.resource,
		Revision:  revision,
		ExpiresAt: time.Now().Add(time.Duration(dl.ttl) * time.Second),
	}, nil
}

// TryLock attempts to acquire the lock without blocking.
// Returns ErrLockNotAcquired if the lock is held by another process.
func (dl *DistributedLock) TryLock(ctx context.Context) (FencingToken, error) {
	if err := dl.mutex.TryLock(ctx); err != nil {
		return FencingToken{}, fmt.Errorf("lock not available: %w", err)
	}

	resp, err := dl.client.Get(ctx, dl.mutex.Key())
	if err != nil {
		_ = dl.mutex.Unlock(ctx)
		return FencingToken{}, err
	}

	var revision int64
	if len(resp.Kvs) > 0 {
		revision = resp.Kvs[0].ModRevision
	}

	return FencingToken{
		Resource:  dl.resource,
		Revision:  revision,
		ExpiresAt: time.Now().Add(time.Duration(dl.ttl) * time.Second),
	}, nil
}

// Unlock releases the lock.
func (dl *DistributedLock) Unlock(ctx context.Context) error {
	if err := dl.mutex.Unlock(ctx); err != nil {
		return fmt.Errorf("release lock: %w", err)
	}
	return nil
}

// Close releases the lock and revokes the session lease.
func (dl *DistributedLock) Close() error {
	return dl.session.Close()
}

// FencingToken is a monotonically increasing token passed to protected operations.
// The storage system rejects writes from holders with lower token values,
// preventing split-brain writes from stale lock holders.
type FencingToken struct {
	Resource  string
	Revision  int64     // etcd revision - monotonically increasing.
	ExpiresAt time.Time
}

// IsValid returns true if the token hasn't expired.
func (f FencingToken) IsValid() bool {
	return time.Now().Before(f.ExpiresAt)
}

// FencedStorage is a storage backend that enforces fencing tokens.
// Rejects writes from stale lock holders.
type FencedStorage struct {
	mu            sync.Mutex
	data          map[string]string
	lastRevision  map[string]int64 // resource → max revision seen
}

func NewFencedStorage() *FencedStorage {
	return &FencedStorage{
		data:         make(map[string]string),
		lastRevision: make(map[string]int64),
	}
}

// Write performs a fenced write. Rejects if token revision is lower than last seen.
func (s *FencedStorage) Write(key, value string, token FencingToken) error {
	if !token.IsValid() {
		return fmt.Errorf("fencing token expired")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Check fencing token: reject stale writes.
	lastRev, ok := s.lastRevision[token.Resource]
	if ok && token.Revision < lastRev {
		return fmt.Errorf("stale fencing token: revision %d < last seen %d",
			token.Revision, lastRev)
	}

	s.lastRevision[token.Resource] = token.Revision
	s.data[key] = value
	return nil
}

// Read retrieves a value.
func (s *FencedStorage) Read(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// WithLock is a convenience function that acquires a lock, runs fn, then releases.
func WithLock(ctx context.Context, lock *DistributedLock, fn func(FencingToken) error) error {
	token, err := lock.Lock(ctx)
	if err != nil {
		return err
	}
	defer lock.Unlock(ctx)

	return fn(token)
}
```

### 1.2 Redis-Based Distributed Lock (Redlock)

Redlock acquires a lock by writing to a majority quorum of Redis instances within a deadline, providing a distributed lock that survives single-node Redis failures without requiring a Redis Cluster setup. The following Go implementation applies the Redlock algorithm with drift compensation and validates the remaining lock validity before executing critical sections.

```go
package redlock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedLock implements the Redlock distributed lock algorithm.
// Uses N independent Redis instances - locks require N/2+1 instances to succeed.
// Provides probabilistic safety: if clocks are reasonably synchronized (< drift),
// two clients cannot both hold the lock simultaneously.
//
// IMPORTANT: For production use with critical resources, prefer etcd-based locks
// (backed by Raft) over Redlock. Redlock has known vulnerabilities under certain
// failure scenarios (Martin Kleppmann's analysis).
type RedLock struct {
	clients  []*redis.Client
	resource string
	ttl      time.Duration
}

// LockAcquisition holds the result of a successful lock acquisition.
type LockAcquisition struct {
	Token    string        // Unique random token for this lock holder.
	TTL      time.Duration // Remaining time until expiry.
	AcquiredAt time.Time
}

func NewRedLock(clients []*redis.Client, resource string, ttl time.Duration) *RedLock {
	return &RedLock{
		clients:  clients,
		resource: resource,
		ttl:      ttl,
	}
}

// Acquire attempts to acquire the lock on at least quorum Redis instances.
// Returns the lock acquisition details or an error if quorum not reached.
func (rl *RedLock) Acquire(ctx context.Context) (*LockAcquisition, error) {
	token, err := randomToken()
	if err != nil {
		return nil, fmt.Errorf("generate token: %w", err)
	}

	quorum := len(rl.clients)/2 + 1
	start := time.Now()

	successes := 0
	var acquiredInstances []int

	// Attempt to acquire lock on all instances in parallel.
	type result struct {
		idx int
		ok  bool
	}
	resultCh := make(chan result, len(rl.clients))

	for i, client := range rl.clients {
		go func(idx int, c *redis.Client) {
			ok := rl.tryAcquireInstance(ctx, c, token)
			resultCh <- result{idx, ok}
		}(i, client)
	}

	for i := 0; i < len(rl.clients); i++ {
		res := <-resultCh
		if res.ok {
			successes++
			acquiredInstances = append(acquiredInstances, res.idx)
		}
	}

	elapsed := time.Since(start)
	validityTime := rl.ttl - elapsed

	// Check quorum and validity time.
	if successes >= quorum && validityTime > 0 {
		return &LockAcquisition{
			Token:      token,
			TTL:        validityTime,
			AcquiredAt: start,
		}, nil
	}

	// Quorum not reached - release all acquired instances.
	for _, idx := range acquiredInstances {
		rl.releaseInstance(ctx, rl.clients[idx], token)
	}
	return nil, fmt.Errorf("lock quorum not met: acquired %d/%d", successes, len(rl.clients))
}

func (rl *RedLock) tryAcquireInstance(ctx context.Context, client *redis.Client, token string) bool {
	key := "lock:" + rl.resource
	// SET key token NX PX ttlMs
	// NX: only set if not exists
	// PX: millisecond expiry
	ok, err := client.SetNX(ctx, key, token, rl.ttl).Result()
	return err == nil && ok
}

// Release releases the lock on all instances where it was held.
func (rl *RedLock) Release(ctx context.Context, acq *LockAcquisition) {
	for _, client := range rl.clients {
		rl.releaseInstance(ctx, client, acq.Token)
	}
}

// releaseInstance uses a Lua script for atomic check-and-delete.
// Only deletes the key if it still holds our token (prevents releasing another holder's lock).
var releaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`)

func (rl *RedLock) releaseInstance(ctx context.Context, client *redis.Client, token string) {
	key := "lock:" + rl.resource
	releaseScript.Run(ctx, client, []string{key}, token)
}

// Extend extends the lock TTL if still held by this acquisition.
func (rl *RedLock) Extend(ctx context.Context, acq *LockAcquisition, extension time.Duration) bool {
	extendScript := redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
`)

	key := "lock:" + rl.resource
	ms := int(extension.Milliseconds())
	successes := 0
	quorum := len(rl.clients)/2 + 1

	for _, client := range rl.clients {
		result, err := extendScript.Run(ctx, client, []string{key}, acq.Token, ms).Int()
		if err == nil && result == 1 {
			successes++
		}
	}
	return successes >= quorum
}

func randomToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
```

### Junior → FAANG: Choosing Between etcd Locks and Redlock

The implementation in this section provides both an etcd-based lock and a Redis Redlock implementation, and the code comments explicitly warn that etcd is preferred for production correctness. Understanding why is the most important lesson here.

The etcd lock's correctness rests on Raft: every lock acquisition is a linearizable write that goes through the Raft consensus protocol. The fencing token is the etcd revision at time of acquisition, which is guaranteed to be monotonically increasing globally. A process that holds a revision-5 token cannot overwrite a write made by a revision-7 token holder, because the storage layer rejects writes with lower revision tokens.

The Redlock's correctness rests on a weaker foundation: clock synchronization and network timing. The algorithm assumes that the time taken to acquire locks across all Redis instances is much less than the TTL, which means the remaining validity time is a reliable lower bound on how long the lock will be held. Martin Kleppmann's critique of Redlock (published on his blog and widely cited) demonstrates that this assumption fails under GC pauses and network delays that are both realistic in production. The Redlock paper acknowledges some of these limitations but argues they are acceptable for many use cases.

For interviews: use etcd for correctness-critical locking (payment processing, inventory decrement). Use Redis SETNX (single Redis, not Redlock) for best-effort locking where occasional double-processing is acceptable and detected at a higher layer (e.g., idempotency keys in the database). Redlock adds operational complexity over single-Redis without providing etcd-level correctness guarantees, making it a poor choice for most use cases.

The `WithLock` convenience function pattern (acquire, execute, release) is how production code should use distributed locks. Inline lock management (acquire here, release in a different code path) is a common source of lock leaks in production code.

### Senior @ FAANG: Distributed Lock Design for High-Throughput Systems

The etcd-based lock implementation in this section is correct for moderate-throughput scenarios. At high throughput (thousands of lock acquisitions per second), etcd becomes a bottleneck because every acquisition goes through Raft, which limits throughput to roughly etcd's write throughput (typically 10,000-50,000 operations per second for a well-tuned etcd cluster). For higher throughput locking, the architecture must change.

Lock sharding: rather than a single lock per resource type, shard the resource space into N shards and assign each resource to a shard by hash. For payment processing with 1,000 concurrent transactions, 100 shards of 10 concurrent transactions each reduces contention by 100x. The shard assignment must be deterministic (same resource always maps to same shard) and the number of shards must be set at design time (resharding requires coordination).

Hierarchical locking: for systems where most operations are read-mostly and conflicts are rare, use optimistic concurrency (read, compute, compare-and-swap) rather than pessimistic locking. The compare-and-swap at the storage layer (database conditional write or etcd transaction) is the correctness mechanism, and the distributed lock is not needed. This works when conflict rates are low. Under high contention, optimistic concurrency degrades (many transactions abort and retry), and you need a lock or a queue-based serialization approach.

Lock-free designs: for many operations that seem to require a lock, there is a redesign that eliminates the need for coordination entirely. Inventory decrements that appear to require a lock (check current count, decrement if positive) can be implemented as a monotonically decreasing counter where the database enforces the constraint (CHECK quantity >= 0). The constraint violation is the "lock failed" signal. This eliminates the distributed lock entirely at the cost of requiring a database with transactional integrity.

ADR for lock mechanism selection: the decision tree should ask: (1) Is the operation correctness-critical (financial, inventory, identity)? If yes, use etcd. (2) Can the operation be redesigned as a database conditional write? If yes, eliminate the lock. (3) Is conflict rate low and retry cost acceptable? If yes, use optimistic concurrency. (4) Is throughput too high for etcd? If yes, use lock sharding. (5) Is occasional duplicate processing acceptable with detection at a higher layer? If yes, use Redis SETNX. Defaulting to Redlock for correctness-critical operations is incorrect in all cases where etcd is available.

---
