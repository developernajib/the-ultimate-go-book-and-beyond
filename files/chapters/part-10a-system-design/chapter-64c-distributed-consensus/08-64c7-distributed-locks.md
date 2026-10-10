## 64C.7 Distributed Locks

### Correctness Requirements

A correct distributed lock must satisfy:
1. **Mutual exclusion** - at most one process holds the lock at any time
2. **Deadlock-free** - a lock holder that crashes eventually releases the lock (via TTL/lease expiry)
3. **Fault-tolerant** - the lock system itself must tolerate node failures

### Why Redis SETNX + Expire Is Not Safe (Redlock Controversy)

A common pattern is to use Redis SETNX (set-if-not-exists) with an expiry:

```
# Client A acquires lock:
SETNX lock:my-resource "client-a" PX 30000

# ... does work ...

# Client A releases lock:
DEL lock:my-resource
```

**Problems with this approach:**

1. **SETNX and EXPIRE are not atomic** (historical. Now `SET key value NX PX ms` is atomic)
2. **Client A's lock expires due to GC pause** while it is still doing work - Client B acquires the lock. Client A resumes and deletes Client B's lock.
3. **Single Redis instance is a single point of failure** - if it crashes after granting the lock but before the client acts, the lock is lost.

Martin Kleppmann's critique of **Redlock** (Redis distributed lock using 5 nodes):
- Even with 5 Redis nodes and majority voting, there are race conditions under clock skew and process pauses
- Without fencing tokens, Redlock cannot guarantee correctness in the face of arbitrary process pauses (GC, VM preemption)

**The safe approach: etcd-based distributed lock with fencing tokens.**

### etcd-Based Distributed Lock

etcd's `concurrency.Mutex` solves the fencing problem that makes Redis-based locks unsafe: when a lock is acquired, etcd records a monotonically increasing `CreateRevision` for the lock key, and any write to an external system can include this revision as a fencing token. The receiving system rejects writes carrying a token older than the last accepted one, ensuring a slow or GC-paused process that woke up after its lock expired cannot overwrite work done by the successor that legitimately holds the lock. The `concurrency.Session` underneath the mutex runs an etcd lease keepalive goroutine, so the lock's TTL is continuously renewed as long as the owning process is alive, if the process crashes, the keepalive stops and etcd expires the lease automatically after `ttlSeconds`.

```go
// lock/distributed_lock.go
package lock

import (
	"context"
	"fmt"
	"log"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// DistributedLock provides a distributed mutual exclusion lock backed by etcd.
// The lock lease is automatically renewed while held.
// The fencing token is the etcd revision at lock acquisition time.
type DistributedLock struct {
	client     *clientv3.Client
	lockName   string
	ttlSeconds int
}

// LockHandle represents a held lock.
type LockHandle struct {
	mutex        *concurrency.Mutex
	session      *concurrency.Session
	FencingToken int64 // use this when writing to external systems
}

func NewDistributedLock(client *clientv3.Client, lockName string, ttlSeconds int) *DistributedLock {
	if ttlSeconds <= 0 {
		ttlSeconds = 30
	}
	return &DistributedLock{
		client:     client,
		lockName:   lockName,
		ttlSeconds: ttlSeconds,
	}
}

// Acquire acquires the lock. Blocks until the lock is acquired or ctx is canceled.
// Returns a LockHandle that must be passed to Release.
func (dl *DistributedLock) Acquire(ctx context.Context) (*LockHandle, error) {
	session, err := concurrency.NewSession(dl.client,
		concurrency.WithTTL(dl.ttlSeconds),
		concurrency.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	mutex := concurrency.NewMutex(session, "/locks/"+dl.lockName)

	if err := mutex.Lock(ctx); err != nil {
		session.Close()
		return nil, fmt.Errorf("lock: %w", err)
	}

	// The fencing token is the key's create revision.
	// It increases monotonically across lock acquisitions.
	getResp, err := dl.client.Get(ctx, mutex.Key())
	if err != nil {
		mutex.Unlock(ctx)
		session.Close()
		return nil, fmt.Errorf("get fencing token: %w", err)
	}
	var fencingToken int64
	if len(getResp.Kvs) > 0 {
		fencingToken = getResp.Kvs[0].CreateRevision
	}

	log.Printf("lock acquired: %s (fencing token: %d)", dl.lockName, fencingToken)

	return &LockHandle{
		mutex:        mutex,
		session:      session,
		FencingToken: fencingToken,
	}, nil
}

// Release releases the lock.
func (dl *DistributedLock) Release(ctx context.Context, handle *LockHandle) error {
	defer handle.session.Close()

	if err := handle.mutex.Unlock(ctx); err != nil {
		return fmt.Errorf("unlock: %w", err)
	}

	log.Printf("lock released: %s", dl.lockName)
	return nil
}

// TryLock attempts to acquire the lock without blocking.
// Returns (handle, nil) if acquired, (nil, nil) if not available.
func (dl *DistributedLock) TryLock(ctx context.Context) (*LockHandle, error) {
	session, err := concurrency.NewSession(dl.client,
		concurrency.WithTTL(dl.ttlSeconds),
		concurrency.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	mutex := concurrency.NewMutex(session, "/locks/"+dl.lockName)

	if err := mutex.TryLock(ctx); err != nil {
		session.Close()
		if err == concurrency.ErrLocked {
			return nil, nil // Not available - not an error
		}
		return nil, fmt.Errorf("trylock: %w", err)
	}

	getResp, err := dl.client.Get(ctx, mutex.Key())
	if err != nil {
		mutex.Unlock(ctx)
		session.Close()
		return nil, err
	}
	var fencingToken int64
	if len(getResp.Kvs) > 0 {
		fencingToken = getResp.Kvs[0].CreateRevision
	}

	return &LockHandle{
		mutex:        mutex,
		session:      session,
		FencingToken: fencingToken,
	}, nil
}

// ─── Usage Pattern with Fencing Token ────────────────────────────────────────

func ExampleCriticalSection(client *clientv3.Client, storage *fencedStorage) error {
	lock := NewDistributedLock(client, "payment-processor", 30)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	handle, err := lock.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire lock: %w", err)
	}
	defer lock.Release(context.Background(), handle)

	// Use the fencing token when writing to external systems
	// The storage service will reject writes from stale leaders
	if err := storage.Write("payment-state", "processing", handle.FencingToken); err != nil {
		return fmt.Errorf("fenced write: %w", err)
	}

	// ... do critical section work ...

	return nil
}

// Placeholder to satisfy reference above
type fencedStorage struct{}
func (f *fencedStorage) Write(key, value string, token int64) error { return nil }
```

### Lock Expiry and Lease Renewal

The etcd concurrency library handles lease renewal automatically via `KeepAlive`. As long as the process is alive and the context is not canceled, the lease is renewed before it expires. If the process crashes or the network is partitioned, the lease expires after `ttlSeconds` and the lock is automatically released.

**Critical**: the lock's TTL should be set conservatively. If your critical section takes up to 10 seconds, set a TTL of 60 seconds - not 10. The TTL is a safety net for failures, not a budget for normal operations.

### Junior → FAANG: Distributed Locks Done Right

Distributed locks are one of the most misused primitives in distributed systems. The common pattern is to reach for Redis SETNX because it is simple and familiar. Here is the argument for why that is wrong at FAANG scale, and what to use instead.

**The GC pause scenario is not hypothetical.** Go's garbage collector can pause goroutines for milliseconds or longer under memory pressure. A lock held for 30 seconds with a 30-second TTL will be expired by the time a GC-paused goroutine resumes, if the GC pause is long enough. This is not a theoretical concern: it has caused production incidents at major Go-using companies. The combination of a short TTL and a long critical section is a correctness time bomb.

**Why etcd beats Redis for locks.** The difference is not just five-node vs. single-node fault tolerance. The fundamental difference is that etcd's lease is backed by a consensus protocol: the lease is valid as long as the Raft quorum agrees it is valid. Redis's TTL is backed by a single node's clock. Under the Redlock protocol (five Redis nodes), there is a window during which a crashed node restarts, loses its TTL state, and accepts a SETNX that conflicts with a lock the majority considers valid. This window is a correctness violation that fencing tokens prevent only if the storage system enforces them.

**The TryLock pattern and when to use it.** The `TryLock` method in this section returns immediately if the lock is unavailable. Use TryLock when "skip if locked" is the correct behavior (e.g., a cron job that should not queue up). Use blocking `Lock` when the caller must proceed only after acquiring the lock (e.g., a payment coordinator that cannot skip). Using TryLock in a retry loop to simulate blocking Lock is an antipattern: it wastes CPU on tight retries and does not provide fair queuing among waiters.

**Interview framing.** "How would you implement a distributed lock for a payment coordinator?" is a classic L5 question. The expected answer covers: etcd with `concurrency.Mutex`, session-backed lease with keepalive, fencing token passed to the database write, and explicit resign on graceful shutdown. Mentioning Redlock and then explaining why it is insufficient for this use case is a strong positive signal.

### Senior @ FAANG: Distributed Lock Governance and Correctness

**ADR: distributed lock vs. saga pattern for long-running transactions.** A distributed lock held for minutes is a design smell. If your critical section is "process a payment that involves three external API calls and two database writes over 90 seconds," a distributed lock with a 90-second TTL is not the right answer. A saga pattern with compensating transactions is: each step is idempotent, each step records its completion, and a failure at any step triggers compensation rather than holding a lock across the entire sequence. The ADR for any critical section longer than a few seconds should explicitly evaluate the saga alternative.

**Governance: lock naming and key space isolation.** All distributed lock keys should follow a naming convention that isolates them by service, environment, and resource: `/locks/{env}/{service}/{resource-id}`. Without this convention, two unrelated services can accidentally use the same lock key and interfere with each other's critical sections. Staff engineers enforce naming conventions through code review and key space access control policies in etcd.

**Operational concern: lock contention monitoring.** The time from `Lock()` call to lock acquisition is the lock wait time. If the lock wait time spikes, it means the critical section is taking longer than expected and blocking other lock holders. This metric should be exported (as a Prometheus histogram) and alert on p95 > 5 seconds. Sustained high lock contention indicates either a critical section that is too long, a lock that should be sharded (per-user lock instead of global lock), or a deadlock between two lock holders.

**The fencing token as a distributed transaction primitive.** The fencing token (etcd CreateRevision) is a monotonically increasing number across all etcd operations. It can serve as a causal ordering token: any write with a higher token happened after any write with a lower token. This makes it useful not just for rejecting stale writes but for ordering writes from concurrent leaders. Staff engineers designing systems with multiple concurrent leaders (a sharded coordinator where each shard has its own leader) use fencing tokens to establish the causal order of cross-shard writes and detect causal violations in post-hoc analysis.

**L6/L7 concern: lock-free alternatives.** At L6/L7, the question is not "how do you implement a distributed lock" but "do you need one?" Many coordination problems that seem to require a lock can be solved with optimistic locking: read the current state, compute the new state, write with a conditional update that fails if the state has changed since you read it. etcd's `Txn` (compare-and-swap) supports this pattern directly. Optimistic locking has better throughput under low contention (no lock acquisition latency) and degrades gracefully under high contention (retries with exponential backoff). A staff engineer's instinct is to reach for optimistic locking first and introduce a distributed lock only when the retry rate under optimistic locking is unacceptably high.

---
