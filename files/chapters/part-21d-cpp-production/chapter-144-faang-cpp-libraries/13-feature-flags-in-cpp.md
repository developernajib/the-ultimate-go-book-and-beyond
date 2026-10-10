## Feature Flags in Production C++

Feature flags decouple deploy from release. At FAANG scale the deploy cadence is daily, but a risky code path ships dark, is flipped on for one percent of traffic, and escalates to 100 percent over days while dashboards confirm no regression. Without flags a rollback means a redeploy, which costs minutes and coordination. With flags it is a config push, which costs seconds.

### Compile-time vs runtime flags

Compile-time flags (`#if defined(FEATURE_X)`) are free at runtime but require a rebuild and redeploy to change. Use them only for cross-cutting concerns like debug instrumentation or platform selection. Runtime flags are the correct default for product behavior.

### A minimal runtime flag registry

```cpp
class FlagRegistry {
    mutable absl::Mutex mu_;
    absl::flat_hash_map<std::string, std::atomic<bool>*> bools_;
    absl::flat_hash_map<std::string, std::atomic<int64_t>*> ints_;

public:
    static FlagRegistry& Instance() {
        static absl::NoDestructor<FlagRegistry> inst;
        return *inst;
    }

    std::atomic<bool>& RegisterBool(std::string name, bool def) {
        absl::MutexLock lock(&mu_);
        auto* flag = new std::atomic<bool>(def);
        bools_.emplace(std::move(name), flag);
        return *flag;
    }

    void ApplyUpdate(std::string_view name, std::string_view value) {
        absl::MutexLock lock(&mu_);
        if (auto it = bools_.find(name); it != bools_.end()) {
            it->second->store(value == "true", std::memory_order_release);
        }
    }
};

#define FEATURE_FLAG_BOOL(name, def, doc)                              \
    namespace flags { inline std::atomic<bool>& name =                 \
        FlagRegistry::Instance().RegisterBool(#name, def); }
```

The flag is a plain `std::atomic<bool>`. Reads compile to a single relaxed load, which is a few cycles and safe in the hottest path. Writes happen from the config fetcher thread only.

### Percentage rollout with sticky hashing

A flag at 10 percent must route the same user to the same branch on every request, otherwise the user sees flickering behavior. Use a stable hash, not a random number.

```cpp
bool IsEnabledFor(std::string_view flag, uint64_t user_id, int percent) {
    uint64_t h = absl::HashOf(flag, user_id);
    return (h % 100) < static_cast<uint64_t>(percent);
}
```

`absl::HashOf` is seeded per-process by default, which breaks stickiness. For flags, seed with a fixed constant, otherwise restart the service and every user gets reassigned, creating a correlated spike.

### Config plane integration

A production flag system fetches configuration from a control plane (etcd, ZooKeeper, an internal config service) on an interval or via streaming watch. Apply updates atomically and log every flip with actor, timestamp, and old/new value. The audit log is often the most important part of the system during an incident.

```cpp
void WatchFlags(ConfigClient& client) {
    client.Watch("/flags/*", [](const FlagUpdate& u) {
        LOG(INFO) << "flag_flip flag=" << u.name
                  << " old=" << u.old_value << " new=" << u.new_value
                  << " actor=" << u.actor;
        FlagRegistry::Instance().ApplyUpdate(u.name, u.new_value);
    });
}
```

### Guardrails and cleanup discipline

Every flag is technical debt. Tag each declaration with an owner and a sunset date, and fail the build if a flag is older than 90 days past its sunset.

```cpp
FEATURE_FLAG_BOOL(new_pricing_engine, false,
    "Owner: pricing-team. Sunset: 2026-09-01. Rollout plan: docs/flags/new_pricing.md");
```

Flag proliferation is the silent killer. A codebase with 5,000 active flags has a combinatorial test matrix that no CI can cover. Quarterly cleanup sprints are how mature teams keep the number bounded.

### Integration with canaries

A flag flip at one percent is useful only if observability is per-branch. Emit a `flag_variant` label on every metric and trace attribute:

```cpp
span->SetAttribute("flag.new_pricing_engine",
                   flags::new_pricing_engine.load(std::memory_order_relaxed));
```

Dashboards split by label let SRE compare p99, error rate, and CPU between the old and new branch in real time, and automated rollback triggers on a configurable SLO delta.

### Anti-patterns

- Reading a flag inside a `hot-path mutex`, which re-serializes the code you were trying to A/B test.
- Boolean flags with more than two states encoded into one bit. Use enum flags or separate flags.
- Flipping two correlated flags independently. Model the coupling explicitly with a flag group.
- Leaving stale flags in production. Dead flags execute dead branches that still consume review time.
