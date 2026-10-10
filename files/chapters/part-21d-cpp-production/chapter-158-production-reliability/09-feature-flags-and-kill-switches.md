## Feature Flags and Kill Switches

A binary deploy takes hours. A feature-flag flip takes seconds. When a regression is found in production, the difference between rolling back the binary (slow) and flipping a flag (fast) is the difference between an SLO breach and a non-event. Every senior C++ engineer should be able to design and operate the feature-flag system for their service.

### The Two Kinds of Flags

**Static flags** (`absl::flags`, `gflags`). Set at process startup, immutable for the process lifetime. Useful for behaviors that genuinely cannot change at runtime: thread-pool size at init, choice of allocator. The cost of changing them is a binary restart, which means staged rollout.

**Dynamic flags**. Read at every use site. Update without restart. Useful for kill switches, ramp-up of new code paths, A/B experiment control, throttling toggles. This is where the action is.

A modern C++ service almost always has both. The static flags configure long-lived state. The dynamic flags control behavior that needs to change in seconds when something goes wrong.

### A Minimal Dynamic Flag Library

The contract:

- A flag is a typed value (`bool`, `int64`, `double`, `string`) plus a name.
- Reads are O(1) and lock-free in the hot path.
- Updates are atomic and visible to all threads within a bounded delay.
- A central configuration source (a file, a service, an etcd watch) pushes updates.

A sketch:

```cpp
// dynamic_flag.h
#pragma once
#include <atomic>
#include <string>
#include <string_view>

template <typename T>
class DynamicFlag {
public:
    DynamicFlag(std::string name, T default_value)
        : name_(std::move(name)), value_(default_value) {
        FlagRegistry::Instance().Register(name_, this);
    }

    T Get() const noexcept {
        return value_.load(std::memory_order_relaxed);
    }

    void Set(T v) noexcept {
        value_.store(v, std::memory_order_relaxed);
    }

private:
    const std::string name_;
    std::atomic<T> value_;
};

// Definition macro
#define DEFINE_DYNAMIC_FLAG(type, name, def) \
    DynamicFlag<type> FLAGS_##name(#name, def)

#define DECLARE_DYNAMIC_FLAG(type, name) \
    extern DynamicFlag<type> FLAGS_##name
```

Use:

```cpp
DEFINE_DYNAMIC_FLAG(bool, use_new_ranker, false);
DEFINE_DYNAMIC_FLAG(int64_t, max_concurrent_requests, 1000);
DEFINE_DYNAMIC_FLAG(double, ranker_temperature, 1.0);

void Server::HandleRequest(Request* req) {
    if (FLAGS_use_new_ranker.Get()) {
        return new_ranker_.Rank(req);
    }
    return old_ranker_.Rank(req);
}
```

The hot-path cost is one relaxed atomic load, which is identical in cost to a normal load on x86 and AArch64. There is no contention, because writers are rare.

For non-trivially-copyable types (strings, structures), use `std::shared_ptr<const T>` with `std::atomic_load` and copy-on-write at the writer.

### Kill Switches

A kill switch is a feature flag whose only job is to disable a code path that is misbehaving in production. The discipline:

- Every new feature ships behind a kill switch by default.
- The kill switch is wired before the feature ships, not after.
- The on-call engineer at 3 AM can flip the switch without a binary deploy.
- The runbook for the feature names the kill switch and the flip command.

A kill switch is not an admission that the feature is unreliable. It is an admission that nobody knows the future, and the cost of the switch is essentially zero.

```cpp
DEFINE_DYNAMIC_FLAG(bool, enable_new_cache_layer, true);

CacheResult Lookup(Key k) {
    if (!FLAGS_enable_new_cache_layer.Get()) {
        return DirectLookup(k);  // bypass the new layer
    }
    return new_cache_.Lookup(k);
}
```

When the new cache layer breaks, flip the flag, traffic resumes immediately, the team has a few hours to investigate without an active incident.

### Atomic Switch Without Restart

The trickier case: a flag controls which of two implementations is active, and the implementations have different state lifetimes.

```cpp
// WRONG: this is racy
class Service {
    std::unique_ptr<Engine> engine_;
public:
    void Reload() {
        if (FLAGS_use_new_engine.Get()) {
            engine_ = std::make_unique<NewEngine>();
        } else {
            engine_ = std::make_unique<OldEngine>();
        }
    }
    void Process(Req* r) {
        engine_->Process(r);  // race with Reload
    }
};
```

The fix is to publish the new engine atomically and let inflight requests on the old engine drain:

```cpp
class Service {
    std::shared_ptr<Engine> engine_;  // accessed via atomic ops
    std::mutex reload_mutex_;
public:
    void Reload() {
        std::lock_guard<std::mutex> lock(reload_mutex_);
        std::shared_ptr<Engine> next = FLAGS_use_new_engine.Get()
            ? std::shared_ptr<Engine>(std::make_shared<NewEngine>())
            : std::shared_ptr<Engine>(std::make_shared<OldEngine>());
        std::atomic_store(&engine_, next);
    }
    void Process(Req* r) {
        auto e = std::atomic_load(&engine_);  // snapshot
        e->Process(r);                         // safe even if Reload runs
    }
};
```

The old engine's destructor runs when the last in-flight request releases its `shared_ptr`. No restart, no race.

C++20 introduced `std::atomic<std::shared_ptr<T>>` which makes this cleaner. The pre-C++20 free-function `std::atomic_load`/`atomic_store` for shared_ptr is deprecated in C++20 but still ubiquitous in production code.

### Gradual Ramp: 1% / 5% / 25% / 50% / 100%

A kill switch is binary. A ramp is gradual. The pattern:

```cpp
DEFINE_DYNAMIC_FLAG(int64_t, new_path_pct, 0);  // 0..100

bool UseNewPath(uint64_t request_id) {
    return (request_id % 100) < FLAGS_new_path_pct.Get();
}
```

The hash should be over a stable identity (request id, user id, tenant id) so that the same request consistently goes the same way, otherwise your A/B is invalidated by within-request flapping. Hash to bucket: `hash(request_id) % 100`.

Operational use:

```
T+0:   set new_path_pct=1 (1% canary)
T+30m: set new_path_pct=5
T+90m: set new_path_pct=25
T+3h:  set new_path_pct=50
T+4h:  set new_path_pct=100
```

If anything goes wrong, set the flag to 0. Rollback is instant.

### Configuration Source

Where does the dynamic flag value come from? Three options:

**File watcher.** A local config file is reread on `inotify`. Simple, robust to network failures. Cost: deploying a new flag value requires distributing the file to every machine.

**Service-side config.** A central service (Chubby, etcd, ZooKeeper, Consul) holds the truth. Each binary subscribes via long-poll or watch. Cost: a network dependency in the config path. Benefit: one update propagates fleet-wide in seconds.

**Hybrid.** A central service is the source, but every binary writes a local cache file as a fallback. If the central service is unavailable, the binary uses the last known good value. This is the default at most large shops.

The reload thread:

```cpp
class FlagReloader {
public:
    void Run() {
        while (!stopping_.load()) {
            try {
                auto config = config_client_.Fetch();
                ApplyToFlags(config);
                WriteCache(config);
            } catch (const std::exception& e) {
                LOG(WARNING) << "config fetch failed: " << e.what();
            }
            std::this_thread::sleep_for(std::chrono::seconds(5));
        }
    }
};
```

The 5-second poll is a typical floor. Lower poll rates create load on the central config service. Higher poll rates increase the time to react to a flag flip.

### Audit and Versioning

Flags accumulate. A real codebase will have hundreds. Every flag should have:

- A description (what does it control?).
- An owner (which team?).
- A creation date.
- A "kill date" (when do we expect to delete this flag?).

Without ownership, flags become permanent fixtures, and the codebase fills with dead branches that nobody dares to remove. A quarterly flag review is the discipline that keeps the count bounded.

Audit logs: every flag change should be logged with `who, what, when, why`. The `why` is the single most useful field during postmortem investigation. "Who set the rate-limit flag to 0 at 03:14 UTC" is a question you will need to answer.

### A Real Case

A C++ payment service had 240 dynamic flags across the codebase. A new on-call engineer flipped a flag named `enable_high_volume_path`, believing it was unused. The flag had been set to `true` for 18 months and was actively in production use. Disabling it forced 30% of payment traffic onto a slower fallback path, blowing the latency SLO by an order of magnitude for 14 minutes.

The team adopted three rules: every flag has an owner, every flag has documentation visible from the flag-management UI, and changing a flag requires a brief justification logged in the audit trail.

Total cost: an evening of work to add the metadata. Net benefit: zero further incidents from accidental flag changes in the following two years.

### Senior at FAANG: The Operational Mindset

The senior contribution is treating flags as production infrastructure. A clear flag library, a defined config source, a documented reload semantics, an audit trail, and a quarterly review process. The on-call engineer at 3 AM can find the flag, know its owner, see its history, and flip it with confidence. That is the bar.

---
