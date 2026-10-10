## Distributed Locks

A distributed lock allows multiple processes to coordinate access to a shared resource. Done right, it prevents two writers from clobbering each other. Done wrong, it produces split-brain, double-spend, or silent data corruption. This section covers Redlock (and its critique), Chubby-style locks, etcd and Consul locks, and the fence-token protocol that makes locks correct under partition.

### What Locks Cannot Do

Distributed locks are not transactions. They do not provide atomicity across multiple operations. They are not free, every lock acquire and release is a network round trip. They are not safe by default, almost every naive implementation has a correctness bug under partition or process pause.

When you need transactionality, use a database transaction (single-shard) or 2PC (cross-shard). When you need a distributed lock, you need fence tokens (chapter 8) at every resource that observes the lock.

### Redlock

Redis's Redlock algorithm, proposed by Salvatore Sanfilippo in 2014, attempts to provide a distributed lock by acquiring it on a majority of N independent Redis instances.

Algorithm:
1. Get current time `t1`.
2. Try to acquire the lock on each of the N Redis instances with the same key, value, and TTL. Use a short timeout per acquire (~50 ms).
3. Compute time elapsed since `t1`. If acquired on majority and elapsed time < TTL, lock is held. Effective TTL is original TTL minus elapsed.
4. If not, release on all instances.

```cpp
class RedlockClient {
public:
    std::optional<LockToken> TryAcquire(std::string_view key, std::chrono::milliseconds ttl) {
        auto val = NewUuid();
        auto t1 = std::chrono::steady_clock::now();
        int acquired = 0;
        for (auto* r : redis_clients_) {
            if (r->SetNX(key, val, ttl, std::chrono::milliseconds(50))) acquired++;
        }
        auto elapsed = std::chrono::steady_clock::now() - t1;
        auto remaining = ttl - elapsed;
        if (acquired >= (redis_clients_.size() / 2 + 1) && remaining > std::chrono::milliseconds(0)) {
            return LockToken{key, val, remaining};
        }
        for (auto* r : redis_clients_) r->DelIfValueMatches(key, val);
        return std::nullopt;
    }
};
```

### Kleppmann's Critique

Martin Kleppmann's 2016 blog post "How to do distributed locking" argued that Redlock is unsafe even when implemented correctly. The critique is rooted in two observations:

1. **Process pauses**. A client may acquire the lock, then be paused (GC, kernel preemption, hypervisor migration) for longer than the TTL. The lock expires, another client acquires it, and now both think they hold it.

2. **Clock drift**. Redlock relies on bounded clock drift across Redis instances and the client. A clock that jumps forward (NTP correction) can expire the lock prematurely. A clock that jumps backward extends it past safe limits.

Sanfilippo's response argued that Redlock's safety is acceptable for most use cases. The exchange is required reading for any engineer who plans to use distributed locks in production.

### The Fence Token Solution

Both critiques are right. The fix is to **never trust the lock alone**. Instead, the lock service hands out a monotonically increasing fence token with each acquisition. The shared resource (the storage layer, the queue, whatever) tracks the highest token it has seen and rejects writes from any token less than that.

```cpp
struct Acquired {
    std::string lock_key;
    std::string holder;
    uint64_t fence_token;
    std::chrono::milliseconds ttl;
};

class FenceableLockServer {
public:
    std::optional<Acquired> TryAcquire(std::string_view key, std::string_view holder,
                                        std::chrono::milliseconds ttl) {
        std::lock_guard lock(mu_);
        auto now = std::chrono::steady_clock::now();
        auto& s = state_[std::string(key)];
        if (s.held && now < s.expires) return std::nullopt;
        s.held = true;
        s.holder = std::string(holder);
        s.expires = now + ttl;
        s.fence_token++;
        return Acquired{std::string(key), std::string(holder), s.fence_token, ttl};
    }

private:
    struct LockState { bool held = false; std::string holder; std::chrono::steady_clock::time_point expires; uint64_t fence_token = 0; };
    std::unordered_map<std::string, LockState> state_;
    std::mutex mu_;
};
```

Every operation on the resource carries the fence token. The resource:

```cpp
absl::Status Write(const WriteRequest& req) {
    std::lock_guard lock(mu_);
    if (req.fence_token < highest_seen_) {
        return absl::FailedPreconditionError("stale lock holder");
    }
    highest_seen_ = req.fence_token;
    return DoWrite(req);
}
```

Now the safety property is: only the *most recent* lock holder can write. A paused holder coming back with a stale token is rejected. Two holders that briefly overlap due to timing both pass the lock check but only the later one passes the fence check. Split-brain becomes impossible by construction.

### Chubby-Style Locks

Google's Chubby implements locks as files. A client opens a file in exclusive mode, the open succeeds only if no other holder. The file's *sequencer* (Chubby's name for a fence token) is bumped on every acquire. Operations on protected resources include the sequencer.

The Chubby paper recommends: "any operation that requires the lock to be held should be designed to take a sequencer". Without it, locks are advisory only and split-brain is undetectable.

### etcd and Consul Locks

Both etcd and Consul provide lock primitives.

**etcd**: a lease grant + a key created with the lease. Holding the key means holding the lock. The lease's keep-alive heartbeats prevent expiry. Each acquisition produces a unique revision number, which serves as a fence token.

```cpp
auto lease = etcd_.LeaseGrant(10s);
etcd_.Put("/locks/myresource", "holder-1", lease.id, /*if_not_exists=*/true);
// Use lease.id and revision as fence token in downstream writes.
```

**Consul**: similar, with a session whose invalidation expires the lock. Each session has an ID, use it as a fence token. Consul also supports a `lock-delay` (a brief grace period after expiration) to mitigate a small class of timing races.

In practice, etcd and Consul provide better lock primitives than Redlock for two reasons. First, they are Raft-replicated, so the lock state survives node failures without losing locks. Second, they expose a fence token natively (revision number, session ID) rather than requiring you to roll your own.

### ZooKeeper Locks

The ZooKeeper recipe: create an ephemeral sequential node under `/locks/<resource>/`. The lowest-sequence-number node is the lock holder. To wait, watch the next-lower node and react when it disappears. The sequence number is the fence token.

```cpp
// Pseudocode for ZK lock acquisition.
auto path = zk.Create("/locks/myresource/lock-", /*ephemeral=*/true, /*sequential=*/true);
auto seq = ExtractSeq(path);
while (true) {
    auto children = zk.GetChildren("/locks/myresource");
    std::sort(children.begin(), children.end());
    auto self_idx = IndexOf(children, path);
    if (self_idx == 0) return seq;  // we hold the lock.
    auto prev = children[self_idx - 1];
    zk.ExistsWithWatch("/locks/myresource/" + prev, [/*signal*/]);
    Wait();  // until previous node disappears.
}
```

The ZooKeeper recipe has been the canonical distributed-lock pattern for over a decade. It is correct under partition (the ephemeral node's session ensures that an unreachable client loses its lock) and provides a fence token (the sequence number).

### Lease Length Tuning

The trade-off:
- Long lease (minutes): low overhead, but a crashed holder pins the resource for the full lease duration.
- Short lease (seconds): fast recovery, but high renewal traffic and risk of false expiry under network blips.

Production rule: lease duration = 5 to 10 times expected RTT, renewal interval = lease / 3. A 10 second lease renewed every 3 seconds is a typical default.

### Junior at FAANG: The Lock Question

When asked "how do you implement a distributed lock?", do not say "use Redis SETNX." Say: "Use etcd or ZooKeeper, both of which provide leases and fence tokens natively. Pass the fence token through to every resource that observes the lock, the resource rejects operations whose token is below its highest seen. Locks alone are unsafe under partition or process pauses, fence tokens are what makes the protocol correct. Redlock is acceptable for advisory use cases (rate limiting, idempotency hints) but not for safety-critical mutual exclusion."

That answer demonstrates you have read Kleppmann's critique and Chubby's response.

---
