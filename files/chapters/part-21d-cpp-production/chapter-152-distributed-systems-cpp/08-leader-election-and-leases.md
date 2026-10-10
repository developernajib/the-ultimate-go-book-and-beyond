## Leader Election and Leases

Lease-based leadership is the production pattern for coordination at scale. Chubby pioneered it, etcd and ZooKeeper inherited it, and every modern C++ service that needs a single-writer property uses some variant. The protocol is simple, the failure modes are subtle, and the difference between a correct implementation and a split-brain disaster is two or three lines of code.

### The Lease Abstraction

A lease is a time-bounded grant of exclusivity. A client (the leader) acquires a lease for duration L. While the lease is valid, it has the right to perform privileged operations (write to a key, accept client requests, mutate cluster state). Before L expires, the client either renews or relinquishes. After L expires, any other client may acquire the lease.

The correctness invariant: at any moment, at most one client holds the lease. Violation produces split brain.

### Naive Implementation (Broken)

```cpp
// BROKEN: relies on synchronized wall clocks.
struct Lease { std::string holder; uint64_t expires_at_unix_ms; };

bool TryAcquire(std::string client) {
    std::lock_guard lock(mu_);
    auto now = NowUnixMs();
    if (lease_ && now < lease_->expires_at_unix_ms) return false;
    lease_ = Lease{client, now + 10'000};
    return true;
}

bool IsLeader(std::string client) {
    auto now = NowUnixMs();
    return lease_ && lease_->holder == client && now < lease_->expires_at_unix_ms;
}
```

Two bugs. First, the wall clock can step. NTP correction can advance `now` past `expires_at_unix_ms` and revoke leadership unexpectedly, or step backward and extend it. Second, the leader and the lock service may disagree about when the lease ends because their clocks differ.

### Correct Lease Protocol

The fix is to communicate *durations*, not absolute times, and to use monotonic clocks at both ends.

```cpp
struct LeaseGrant {
    uint64_t epoch;                          // monotonically increasing per acquisition
    std::chrono::milliseconds duration;       // how long from "now" the lease is valid
};

// Server side.
class LeaseServer {
public:
    std::optional<LeaseGrant> TryAcquire(std::string client) {
        std::lock_guard lock(mu_);
        auto now = std::chrono::steady_clock::now();
        if (lease_holder_ && now < lease_expires_) return std::nullopt;
        lease_holder_ = client;
        lease_expires_ = now + lease_duration_;
        epoch_++;
        return LeaseGrant{epoch_, lease_duration_};
    }

    bool Renew(std::string client, uint64_t epoch) {
        std::lock_guard lock(mu_);
        auto now = std::chrono::steady_clock::now();
        if (lease_holder_ != client || epoch != epoch_) return false;
        if (now >= lease_expires_) return false;
        lease_expires_ = now + lease_duration_;
        return true;
    }

private:
    std::mutex mu_;
    std::optional<std::string> lease_holder_;
    std::chrono::steady_clock::time_point lease_expires_;
    std::chrono::milliseconds lease_duration_{10'000};
    uint64_t epoch_ = 0;
};
```

```cpp
// Client side.
class LeaseClient {
public:
    bool IsLeader() const {
        std::lock_guard lock(mu_);
        if (!grant_) return false;
        // Use monotonic clock and the duration we recorded at receipt.
        return std::chrono::steady_clock::now() < my_expires_;
    }

    void OnGranted(LeaseGrant g) {
        std::lock_guard lock(mu_);
        grant_ = g;
        // Subtract a safety margin to account for RTT.
        my_expires_ = std::chrono::steady_clock::now()
                    + g.duration - std::chrono::milliseconds(500);
    }

private:
    mutable std::mutex mu_;
    std::optional<LeaseGrant> grant_;
    std::chrono::steady_clock::time_point my_expires_;
};
```

The critical line is the safety margin (`-500ms` here). The leader believes its lease is valid for slightly less time than the server thinks. This bounds split-brain: even with maximum clock-drift between leader and server, the leader will give up before the server hands the lease to a successor.

The size of the margin must exceed the worst-case RTT plus the worst-case clock-skew rate (typically a few microseconds per second of drift, dominated by RTT).

### Fence Tokens

Even with a correct lease protocol, a slow leader can cause split brain. Imagine: leader A acquires the lease, makes a request to a downstream storage service, the request stalls in a GC pause or a kernel scheduler delay for 15 seconds, the lease expires, leader B is elected, leader B writes, finally leader A's stalled request arrives at the storage service.

The defense is a fence token. The lease grant includes a monotonically increasing token, the storage service rejects any request with a token less than the highest it has seen.

```cpp
struct WriteRequest {
    uint64_t fence_token;
    Key k;
    Value v;
};

class StorageService {
public:
    absl::Status Write(const WriteRequest& req) {
        std::lock_guard lock(mu_);
        if (req.fence_token < highest_seen_) {
            return absl::FailedPreconditionError("stale leader");
        }
        highest_seen_ = req.fence_token;
        return ApplyWrite(req);
    }

private:
    std::mutex mu_;
    uint64_t highest_seen_ = 0;
};
```

The lease epoch from the server is a natural fence token. Every write the leader sends to a storage node carries the epoch, the storage node refuses any write with an epoch less than the highest it has seen. Even if leader A's stalled request arrives after leader B has written, A's lower epoch causes a rejection.

Martin Kleppmann's blog post "How to do distributed locking" (2016) explains this in detail and is the standard reference cited in interviews.

### Session Timeouts vs Lease Durations

A common confusion is between session timeout and lease duration.

**Session timeout** is the period of inactivity after which a client is presumed dead. Used by ZooKeeper, etcd. If the client does not heartbeat within the timeout, all its ephemeral state (including held locks) is released.

**Lease duration** is how long a single grant is valid. The client renews periodically.

These are usually equal in simple implementations. They diverge when the lock holder is allowed to be slow but not dead: the session can be longer than the lease, and the client renews the lease repeatedly within one session.

Production rule of thumb: lease duration should be 5x the expected RTT plus 5x the expected clock skew. Renewal interval should be one third of the lease duration. So a 10 second lease renews every 3.3 seconds, leaving two missed renewals as headroom before expiry.

### Integrating with a C++ Service

A long-running C++ daemon that uses lease-based leadership typically structures the loop as follows.

```cpp
class LeaderDaemon {
public:
    void Run() {
        while (running_) {
            if (!lease_client_.IsLeader()) {
                if (!TryAcquireLease()) { Sleep(500ms); continue; }
                OnBecameLeader();
            }
            DoLeaderWork();
            ScheduleRenewal();
        }
    }

private:
    void DoLeaderWork() {
        // CRITICAL: re-check leadership before any side effect.
        if (!lease_client_.IsLeader()) return;
        ProcessOneBatch();
    }

    void ScheduleRenewal() {
        auto now = std::chrono::steady_clock::now();
        if (now >= next_renewal_) {
            auto ok = lease_client_.Renew();
            if (!ok) OnLostLease();
            next_renewal_ = now + lease_duration_ / 3;
        }
    }

    void OnLostLease() {
        // Drain in-flight work, refuse new work, log loudly.
        Drain();
    }
};
```

The discipline of re-checking `IsLeader()` immediately before any side effect is what catches the case where the lease expired between the start of `DoLeaderWork()` and the actual write. Combined with fence tokens at the storage layer, this gives you a system where split brain is provably impossible (modulo correctness of the lease server itself, which should be Raft-replicated).

### Chubby and ZooKeeper Patterns

Chubby exposes leases as a side effect of holding a file lock. A client opens `/some/path` in exclusive mode, and the file's session corresponds to the lease. Releasing the file releases the lease.

ZooKeeper uses ephemeral nodes. A client creates an ephemeral sequential node under `/election/`. The client with the lowest sequence number is the leader, others watch the next-lower node and react to its deletion (the *herd-effect-free* election protocol).

etcd combines both ideas: lease grants are first-class API objects, keys can be associated with a lease, and leader election is built in (`etcd put --lease=ID --prev-kv ...` plus a watch).

When integrating from C++, prefer the C++ etcd client (`etcd-cpp-apiv3`) or the ZooKeeper C client wrapped in a modern C++ adapter. Do not roll your own coordination service unless you are building one (in which case see the Raft and Multi-Paxos sections).

### Junior at FAANG: The Lease Question

When asked "how do you prevent split brain in a leader-elected system?", do not say "we use a lease and it expires." Say: "we use a lease for liveness, fence tokens for safety. The lease handles the common case of a clean handoff. Fence tokens handle the worst case where a leader is slow but not dead. Without fence tokens, any GC pause or scheduling delay longer than the lease can cause two leaders to write simultaneously."

That answer is the litmus test that separates engineers who have read Kleppmann from those who have not.

---
