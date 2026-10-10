## Graceful Degradation

A reliable service does not promise to never fail. It promises that when a part fails, the failure is bounded and the user sees something useful. The discipline is graceful degradation: the deliberate engineering of fallback paths so that a partial failure produces a partial response, not a total outage.

This chapter is the playbook.

### The Hierarchy of Responses

When a dependency fails, the service has options, ordered from best to worst:

1. **Fresh, complete response** (normal path).
2. **Stale, complete response** (cached data).
3. **Fresh, partial response** (some sub-results missing).
4. **Stale, partial response** (some sub-results from cache, others missing).
5. **Generic fallback** (a placeholder or default).
6. **Error response** (5xx).
7. **No response** (timeout, the worst option).

The goal of degradation is to push the user as far up this hierarchy as possible, even when something is broken.

### Fallback Responses

The simplest pattern. When the dependency fails, return a sensible default.

```cpp
UserProfile GetUserProfile(UserId uid) {
    if (auto profile = profile_service_.Lookup(uid); profile.ok()) {
        return *profile;
    }
    LOG(WARNING) << "profile lookup failed for " << uid << ", using default";
    return UserProfile::Default();
}
```

The default must be safe: an empty preferences struct, a generic name, no claimed permissions. A "default profile" that grants admin permissions because it includes `is_admin = true` is a security incident.

### Cache-on-Error

A more powerful pattern. Cache successful responses, on dependency failure, return the cached version even if it is stale.

```cpp
template <typename Key, typename Value>
class CacheOnError {
public:
    Value Lookup(Key k, std::function<Value(Key)> fetch) {
        try {
            Value v = fetch(k);
            cache_.Insert(k, v);
            return v;
        } catch (const std::exception& e) {
            if (auto cached = cache_.Get(k); cached.has_value()) {
                LOG(WARNING) << "fetch failed, using cached value: " << e.what();
                return *cached;
            }
            throw;
        }
    }
};
```

The cache TTL is irrelevant for the error path, the cache is consulted only when the live path fails. This means stale data can be served arbitrarily long during a sustained dependency outage. That is usually the right tradeoff: stale data is better than no data.

Operational caveat: surface a metric. A spike in "served from cache due to error" is the signal that a dependency is down.

### Partial Result Return

For fan-out services (search, ad ranking, recommendations), a request hits N backends in parallel. If one backend is slow or fails, the service has a choice: wait for it (slow), drop its results (incomplete), or return what came back so far.

```cpp
struct RankingResponse {
    std::vector<Result> results;
    bool partial = false;
    std::vector<std::string> failed_backends;
};

RankingResponse Rank(const Query& q) {
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
    std::vector<std::future<BackendResult>> futures;
    for (auto& backend : backends_) {
        futures.push_back(backend.RankAsync(q));
    }

    RankingResponse resp;
    for (size_t i = 0; i < futures.size(); ++i) {
        auto status = futures[i].wait_until(deadline);
        if (status == std::future_status::ready) {
            auto result = futures[i].get();
            if (result.ok()) {
                AppendResults(&resp, result);
            } else {
                resp.partial = true;
                resp.failed_backends.push_back(backends_[i].name());
            }
        } else {
            resp.partial = true;
            resp.failed_backends.push_back(backends_[i].name());
        }
    }
    return resp;
}
```

The hard deadline is critical. Without it, a single slow backend turns the fan-out into a serial wait.

The contract for callers: a `partial` response is still a valid response, and the caller should display it (perhaps with a "some results unavailable" indicator). At Google, search has been doing this for two decades, which is why a search query with one slow shard still returns results within the latency budget.

### Request Shedding by Priority

Under sustained overload, the service cannot serve all requests. The choice is: serve some completely, or serve all partially. The first is usually correct.

Priority shedding: classify requests by importance, drop low-priority ones first.

```cpp
enum class Priority { kCritical, kStandard, kBatch };

class LoadShedder {
public:
    bool Admit(Priority p) {
        double current_load = LoadFactor();  // 0..1
        switch (p) {
            case Priority::kCritical:
                return current_load < 0.99;
            case Priority::kStandard:
                return current_load < 0.85;
            case Priority::kBatch:
                return current_load < 0.65;
        }
        return false;
    }
};
```

Critical requests (interactive user, payment confirmation) get the largest budget. Batch requests (analytics, daily report) are shed first. This is the same pattern as in differentiated services networking, applied to RPC traffic.

The classification has to be set by the caller, with verification at the entry point. A caller cannot mark its own batch traffic as critical to bypass shedding, that would defeat the system.

### Brownout vs Blackout

Two failure styles:

**Blackout**: the service returns errors for all traffic that hits the failure mode.

**Brownout**: the service serves all traffic, but with degraded quality (slower, partial results, stale cache, fewer features).

For most user-facing services, brownout is preferable: the user sees something. For some services (financial transactions), blackout is correct: a partial transaction is worse than no transaction.

The senior choice is explicit. For each feature, decide whether the failure mode is brownout or blackout. Document it. Test it.

### Soft Dependencies vs Hard Dependencies

Mark each dependency in the service code:

- **Hard dependency**: the request cannot be served without this. If it fails, the request fails.
- **Soft dependency**: the request can be served without this, with reduced quality. If it fails, log the degradation and continue.

```cpp
struct DepClassification {
    bool required;
    Priority shed_at;
};

constexpr DepClassification kAuth = {true, Priority::kCritical};
constexpr DepClassification kRanker = {true, Priority::kCritical};
constexpr DepClassification kPersonalization = {false, Priority::kStandard};
constexpr DepClassification kRecommendations = {false, Priority::kBatch};
```

When a soft dependency fails, the service degrades by serving without it. The soft/hard classification turns the response of "what should this service do when X is down?" into a one-line answer for every X.

### Real Patterns from FAANG

**Search**: a query that fails on the spelling-correction backend returns the user's original query. A query that fails on the personalization backend returns the unpersonalized result. A query that fails on the index? That is a hard dependency, and the request fails.

**Maps**: a request that fails on the live-traffic service returns the route without traffic data. A request that fails on the road-network service fails the request.

**Streaming video**: a player whose recommendations service is down shows the previously cached recommendations or a curated default list. The video itself is the hard dependency.

The common pattern: classify ruthlessly. Most "essential" features are not. The user noticed missing personalization less than the user noticed total outage.

### Brownout Probes and Auto-Recovery

A brownout that masks a dependency outage is dangerous if the masking is too good. The on-call engineer might not know the dependency is down, because the user-visible signal is unchanged.

The discipline:

- Every degraded response increments a metric.
- The metric drives a SLO independent of the user-facing latency/error metrics.
- A sustained degradation triggers an alert, even when the user-facing signal is healthy.

A user-facing 100% success rate combined with a 30% rate of "served from stale cache because backend down" is a pageable condition.

### Real Postmortem Flavor

A C++ news service had a recommendations backend that failed silently when its database hit a memory limit. The frontend served the cached top-10 recommendations from the morning to every user. User-facing metrics looked normal. The on-call team did not notice for six hours. By the time they did, the cached data was stale enough that engagement metrics had dropped 12%, costing the team an internal escalation and a quarter of trust.

Fix: the cache-on-error path emits a high-priority metric. Sustained brown rate above 5% pages on-call. The next outage was detected in two minutes.

### Senior at FAANG: The Discipline

The senior bar is: every dependency call has a degradation strategy, the strategy is documented, the metric for the degraded path is wired into alerting, and the team has tested the degraded path in a game day. The user gets the best response possible given the current state of the world, the on-call engineer sees the truth about that state.

---
