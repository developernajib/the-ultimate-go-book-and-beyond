## Failure Models and the Fallacies of Distributed Computing

Every distributed bug, without exception, can be traced to an engineer who assumed a failure mode that the network does not actually provide. The eight fallacies, attributed originally to Peter Deutsch and James Gosling at Sun in 1994, are the canonical list of these wrong assumptions. Each one has a direct, observable consequence in production C++ services.

### The Eight Fallacies, Applied to C++ Services

#### Fallacy 1: The Network Is Reliable

Wrong. TCP packets are reordered, retransmitted, and occasionally lost wholesale when a switch reboots. A `send()` that returns success means the kernel queued the bytes, not that the peer received them. A C++ service that treats a successful `write()` as a successful delivery will lose data.

The correct pattern is end-to-end acknowledgment at the application layer.

```cpp
// Wrong: success of send() does not mean the peer got the message.
auto n = ::send(fd, buf, len, 0);
if (n == static_cast<ssize_t>(len)) {
    mark_delivered();  // BUG: peer might never receive this.
}

// Right: wait for an application-level ack with a deadline.
auto ack_future = rpc.SendAsync(message, deadline);
if (ack_future.wait_until(deadline) == std::future_status::ready) {
    mark_delivered();
} else {
    schedule_retry();
}
```

#### Fallacy 2: Latency Is Zero

Wrong. A round trip across a US data center is 500 microseconds. Across a continent it is 70 milliseconds. Across the Pacific it is 150. A C++ service that issues N sequential RPCs to compute a single response has latency at least N times the per-hop RTT.

```cpp
// Wrong: N sequential RPCs.
std::vector<Reply> replies;
for (const auto& shard : shards) {
    replies.push_back(client.Call(shard, request));  // serialized RTTs
}

// Right: scatter-gather with bounded fanout.
std::vector<std::future<Reply>> pending;
pending.reserve(shards.size());
for (const auto& shard : shards) {
    pending.push_back(client.CallAsync(shard, request));
}
std::vector<Reply> replies;
replies.reserve(pending.size());
for (auto& f : pending) replies.push_back(f.get());
```

#### Fallacy 3: Bandwidth Is Infinite

Wrong. Even 100 Gbps NICs saturate. A backfill job that reads a petabyte from S3 will hit the egress cap of the bucket long before it hits CPU. Your C++ design must have backpressure: an unbounded `std::queue` of pending work is a memory bomb waiting for the next traffic spike.

Bounded channels and credit-based flow control are the production-grade patterns.

#### Fallacy 4: The Network Is Secure

Wrong. Inside the data center, plaintext traffic was once acceptable. Today, BeyondCorp and zero-trust assume every link is hostile. mTLS between services is the default, with certificate rotation handled by a service mesh. A C++ service that does not present a verified peer certificate has no business holding user data.

#### Fallacy 5: Topology Does Not Change

Wrong. Pods restart. ASGs rotate. The IP that resolved your peer five seconds ago is now a different process. Hardcoding IPs anywhere outside a service discovery callback is a guaranteed outage.

```cpp
// Wrong: cached IP forever.
class Client {
    std::string addr_ = "10.4.2.17:9000";  // becomes a stale ghost in 2 hours
};

// Right: resolve through service discovery on every connect, with a TTL.
class Client {
    ServiceDiscovery* sd_;
    std::string Resolve() { return sd_->Lookup("billing.prod"); }
};
```

#### Fallacy 6: There Is One Administrator

Wrong. At FAANG scale there are thousands. Schema changes happen mid-traffic. A field your service depends on may be deprecated by another team's migration. Versioned protobuf schemas and feature flags are the only safe path.

#### Fallacy 7: Transport Cost Is Zero

Wrong. Serialization is expensive. Protobuf encode/decode of a 10 KB message costs perhaps 5 microseconds of CPU. At 100k QPS that is 50 percent of a core. JSON is 10x worse. Cap'n Proto and Flatbuffers exist precisely because transport cost dominates many real services.

#### Fallacy 8: The Network Is Homogeneous

Wrong. Some links are 10 Gbps, some are 100. Some have 50 microsecond RTT (rack-local), some have 70 ms (cross-region). A C++ service that uses a single timeout for all peers will either time out the slow ones too aggressively or wait too long on the fast ones.

The fix is per-peer adaptive timeouts based on EWMA of observed latency, with a floor of three standard deviations above the mean.

### Failure Models, Formally

Distributed systems literature distinguishes failure models by what assumptions hold about a faulty process.

**Fail-stop**. A failed process halts and the failure is detectable. This is the friendliest model. Real systems approximate it with crash detection plus state on stable storage. Most production C++ services target fail-stop and use Raft or Paxos to recover from it.

**Crash-recovery**. A failed process halts but later restarts with whatever it persisted before crashing. The protocol must handle resurrection of an old replica. Raft handles this with the term mechanism.

**Omission**. A faulty process drops messages but otherwise behaves correctly. Senders must retransmit. Most TCP-based protocols assume omission failures are transient and handled by TCP itself, which is correct for short partitions and dangerous for long ones.

**Timing**. A process is too slow. From the outside this is indistinguishable from omission. The design choice is whether your system trusts timeouts (synchronous model) or makes no timing assumptions (asynchronous model). Real systems are partially synchronous: timing usually holds, but fall back to safety when it doesn't.

**Byzantine**. A faulty process can do anything: send wrong messages, lie about state, collude with other faulty processes. Byzantine fault tolerance requires `3f+1` replicas to tolerate `f` faults. Required only for trust-boundary crossings (blockchain consensus, multi-tenant cloud) and for safety-critical aerospace. Skip it inside a single trust domain unless you have a specific threat model that demands it.

### Gray Failures: The Failures Your Monitoring Misses

A 2017 paper from MSR ("Gray Failure: The Achilles' Heel of Cloud-Scale Systems") introduced the term *gray failure* for a class of failures where the system observes itself as healthy while clients observe failure. A storage node responds to heartbeats but takes 30 seconds to serve a read. A switch port has 5 percent packet loss but stays administratively up. The control plane sees green dashboards, the data plane is on fire.

The defense is to monitor from the same vantage point as the client. If your service has a `/healthz` endpoint, your health check must traverse the same code path as a real request, including the database call, the cache lookup, and the downstream RPC. A check that pings only the HTTP listener will report green during a gray failure.

```cpp
// Anemic health check. Reports green during gray failure.
void HealthHandler(HttpResponse* resp) { resp->set_status(200); }

// Real health check. Exercises the full request path.
void HealthHandler(HttpResponse* resp) {
    auto start = std::chrono::steady_clock::now();
    auto db_ok = db_->Ping(std::chrono::milliseconds(50));
    auto cache_ok = cache_->Ping(std::chrono::milliseconds(20));
    auto upstream_ok = upstream_.HealthCheck();
    auto elapsed = std::chrono::steady_clock::now() - start;

    if (!db_ok || !cache_ok || !upstream_ok ||
        elapsed > std::chrono::milliseconds(200)) {
        resp->set_status(503);
        return;
    }
    resp->set_status(200);
}
```

### Partial Failures: The Hardest Class

In a single-process program, a function either returns or throws. In a distributed system, a request can also be in a third state: nobody knows. The peer accepted the bytes, possibly performed the side effect, and then crashed before sending an ack. The client retries. The peer recovers and applies the side effect a second time.

The defenses are idempotency keys, exactly-once delivery via dedup tables, and end-to-end transaction IDs.

```cpp
// Idempotency via client-supplied request ID and a dedup table.
absl::Status WriteHandler(const WriteRequest& req) {
    {
        absl::MutexLock lock(&dedup_mu_);
        auto [it, inserted] = dedup_.try_emplace(req.request_id(), absl::OkStatus());
        if (!inserted) return it->second;  // already applied, return cached result.
    }

    auto status = ApplyWrite(req);

    {
        absl::MutexLock lock(&dedup_mu_);
        dedup_[req.request_id()] = status;
    }
    return status;
}
```

### Network Partitions

A partition splits the cluster into two or more groups that cannot communicate. CAP says you must choose: stay available on both sides (AP, accept divergence and reconcile) or stay consistent on at most one side (CP, the minority becomes unavailable). Most production systems are CP for writes and AP for reads, sometimes called PACELC: P partition, A or C, E else, L latency or C consistency.

A senior C++ engineer reasons about partitions in terms of *quorum*. Raft requires a majority, if your cluster splits 3-2, the minority cannot elect a leader and refuses writes. Dynamo allows the minority to accept writes with eventual reconciliation.

The design choice is downstream. If your service holds money, choose CP. If it holds shopping carts, choose AP and reconcile.

### Junior at FAANG: How to Sound Senior in a Design Review

When asked "what happens if the network partitions?", do not say "we use Raft and it handles it." Say: "the minority partition stops accepting writes, the majority continues. When the partition heals, the minority replays log entries from the leader. Clients in the minority partition see write failures and must retry on the majority. Read-after-write consistency holds within a partition only if the client is sticky to the partition that holds the leader."

That answer demonstrates that you understand failure modes from the operator and the client perspectives, not just the server perspective. That is the difference between L5 and L6.

---
