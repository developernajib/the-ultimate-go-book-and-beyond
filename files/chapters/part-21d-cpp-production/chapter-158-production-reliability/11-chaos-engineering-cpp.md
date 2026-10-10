## Chaos Engineering for C++ Services

Netflix popularized chaos engineering with Chaos Monkey, a service that killed random production VMs at random times. The premise: if your system cannot survive random failures introduced by you, it cannot survive random failures introduced by reality. The discipline turned out to be one of the highest-use reliability practices ever invented.

This chapter is about applying it to C++ services, where the failure modes (memory corruption, deadlock, file-descriptor exhaustion) are richer than in a typical garbage-collected service.

### The Premise

Production fails in ways your tests do not anticipate. The reasons:

- Network partitions partial, not total.
- Disks fill slowly, not instantly.
- Dependencies degrade (slow), not fail (fast).
- Multiple things fail simultaneously.
- Failures correlate (a single switch failure takes out a rack).

Chaos engineering injects these failures deliberately, in production or in production-like environments, while you watch. If the system handles them, you have evidence the system is resilient. If it does not, you have a postmortem-worthy bug, found while you are watching, with safety controls in place.

### What to Inject

The standard catalog:

**Network failures.**
- Latency injection: add 100ms to all packets to a dependency.
- Packet loss: drop 1% of packets to a dependency.
- Partial partition: 50% of clients can reach the dependency, 50% cannot.
- DNS failure: the dependency's hostname stops resolving.

**Process failures.**
- `kill -9` of one replica.
- `kill -9` of half the replicas in a region.
- Slow start: a new replica takes 5 minutes to be ready.

**Resource failures.**
- Disk fill: write garbage until 95% full.
- Memory pressure: allocate huge buffers.
- CPU saturation: pin threads to 100%.
- File descriptor exhaustion: open 90% of the available FDs.

**Dependency failures.**
- Database returns 5xx for 10% of queries.
- Cache returns wrong data.
- Auth service times out.

**Clock failures.**
- NTP drift: the clock jumps backward 5 seconds.
- Sustained slow drift forward.

A C++ service has additional categories:

- **Allocator failure.** `malloc` returns null. Many C++ codebases assume infinite memory and segfault on this case.
- **Signal injection.** SIGUSR1, SIGTERM under load, SIGCHLD when a fork-exec subprocess dies.
- **Mmap failure.** A memory-mapped file is unmapped while another thread is using it.

### A Minimal Fault-Injection Library

For C++ services, in-process injection is often the right shape because it gives you knobs at the right granularity (per-RPC, per-codepath) without external infrastructure.

```cpp
// fault_injector.h
#pragma once
#include <atomic>
#include <random>
#include <string_view>

class FaultInjector {
public:
    static FaultInjector& Instance();

    // Returns true with the configured probability for fault `name`.
    bool ShouldInject(std::string_view name);

    // Sleep for the configured latency for fault `name`.
    void InjectLatency(std::string_view name);

    // Set probability and latency from config.
    void Configure(std::string_view name, double prob, std::chrono::nanoseconds latency);

private:
    struct FaultConfig {
        std::atomic<double> probability{0.0};
        std::atomic<int64_t> latency_ns{0};
    };
    absl::flat_hash_map<std::string, std::unique_ptr<FaultConfig>> faults_;
    absl::Mutex mu_;  // Protects map structure, not values
};
```

Use:

```cpp
Status DatabaseClient::Query(const Q& q) {
    if (FaultInjector::Instance().ShouldInject("db.client.error")) {
        return Status(StatusCode::kUnavailable, "injected fault");
    }
    FaultInjector::Instance().InjectLatency("db.client.latency");
    return real_query(q);
}
```

In production, every fault probability defaults to 0. A privileged operator (or a chaos-orchestration service) can set probabilities at runtime via the same dynamic-flag system from chapter 9.

### Blast-Radius Bounds

Chaos in production is only safe if the blast radius is bounded. The discipline:

- **Scope by tenant.** Inject faults for synthetic test traffic only, not real user traffic.
- **Scope by region.** Inject in `us-central1-canary`, not globally.
- **Scope by percentage.** Inject for 0.1% of requests, never 100%.
- **Scope by time window.** Inject for 5 minutes during a planned game day, not continuously.
- **Auto-disable.** If error rates spike, the fault automatically disables itself.

A safety harness:

```cpp
class BoundedFault {
public:
    bool Active() {
        if (TimeNow() > deadline_) return false;
        if (TotalErrorsThisHour() > error_budget_) return false;
        return enabled_.load();
    }
};
```

### Game Days

A "game day" is a scheduled chaos exercise. The team picks a failure scenario, announces the time, and runs it on a service that is fully staffed and observing. Examples:

- "We will kill the primary database replica at 14:00."
- "We will inject 200ms latency between the search service and the index service for 10 minutes."
- "We will partition `eu-west1` from the global control plane."

The goals:

1. **Verify hypotheses.** "We believe replica failover takes under 30 seconds." Find out if that is true.
2. **Train responders.** The on-call rotation runs the incident response. Rust on procedures gets removed.
3. **Find latent bugs.** Most game days uncover at least one minor reliability bug that nobody had noticed.

A game-day cadence of one per quarter per critical service is typical at FAANG-scale orgs. Prepare a written scenario, have a rollback plan, watch the dashboards live, and write a postmortem afterward even when nothing goes wrong.

### Real Examples

A C++ ranking service ran a game day where they killed 30% of replicas in one region, simulating a rack failure. Two latent bugs surfaced:

1. The remaining replicas thundered the database with cache-fill traffic, briefly tripling DB load. Fix: jittered cache warm.
2. The load balancer's health checker took 90 seconds to detect dead replicas, causing 90 seconds of partial errors. Fix: shortened the health-check interval and added passive health detection on consecutive 5xxs.

Neither bug had ever fired in production. Both would have made an actual rack failure worse. The game day cost a half-day of engineer time. The avoided cost was a public-facing outage.

A C++ payment service ran a game day injecting clock skew (one replica's clock jumped backward 30 seconds). The expected behavior: replicas detect the skew and refuse to process transactions. Actual behavior: the skewed replica processed transactions normally and double-billed users whose request hit it. Fix: explicit clock-skew detection, plus a CHECK on monotonic time in the billing path. Bug found before any user was double-billed.

### Chaos Tooling

The vendored options:

- **Chaos Monkey** (Netflix) and **Chaos Mesh** (CNCF). Kubernetes-native.
- **Gremlin** (commercial). UI-driven, broad support.
- **toxiproxy** (Shopify). Network-fault injection proxy. Useful for unit-level chaos in CI.
- **iptables/tc** scripts. The lowest-level option. Powerful, brittle.

For C++ services, in-process injection (the FaultInjector pattern above) plus toxiproxy at the network boundary plus Kubernetes-level pod kills covers most scenarios.

### Continuous Chaos

A maturity step beyond game days: continuous chaos. The chaos service runs 24/7 in production, injecting low-rate faults (under 0.1% of requests) all the time. The system is constantly being tested. Bugs that only manifest under multi-failure scenarios are caught during normal operation.

This requires:

- Solid baseline reliability (do not turn on chaos until your normal SLO is healthy).
- Excellent observability (you must see the difference between chaos-induced errors and real errors).
- Tight blast-radius controls.

Few teams reach this maturity. Those that do report a meaningful drop in surprise-outages.

### What Goes Wrong

- **Chaos with no rollback plan.** The fault was supposed to last 5 minutes. The control plane is partitioned. The fault cannot be turned off. The blast widens.
- **Chaos in environments without observability.** You inject the fault, the system goes red, you cannot tell why. Time to MTTR is dominated by the lack of telemetry.
- **Chaos that masks real bugs.** A real network outage happened during a chaos exercise. The team blamed it on the chaos for 40 minutes before realizing it was independent. Solution: chaos events should be clearly labeled in the dashboards.
- **Tests of failures the system was not designed to handle.** Killing the only database replica when there is no replication is not a test, it is data loss. Inject failures the system claims to handle.

### Senior at FAANG: The Reliability Multiplier

A senior engineer's chaos contribution is twofold: build the in-process fault-injection library so that any team can run scoped experiments, and run a cadenced game-day program against the service. Chaos engineering pays back as a reliability multiplier, the bugs it finds are bugs that would have fired during real incidents.

---
