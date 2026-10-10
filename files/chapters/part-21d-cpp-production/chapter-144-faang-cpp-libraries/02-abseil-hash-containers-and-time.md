## Abseil: Hash Containers and Time

Two of the most universally needed utilities in any application are fast associative containers and correct time handling. The C++ standard library provides both, `std::unordered_map` and `<chrono>`, but both have serious shortcomings at scale. Abseil replaces them.

### absl::flat_hash_map

`std::unordered_map` uses a **node-based** layout: each key-value pair is heap-allocated separately, and the hash table holds pointers to those nodes. This means every lookup requires two memory accesses: one to the table, one to the node. At scale, this pointer chasing causes L1/L2 cache misses on every lookup.

`absl::flat_hash_map` uses **open addressing with inline storage**. Keys and values live directly in the table array, no separate heap nodes, no pointer indirection. This makes it 30-40% faster than `std::unordered_map` in most workloads.

```cpp
#include "absl/container/flat_hash_map.h"
#include "absl/container/flat_hash_set.h"

// API is identical to std::unordered_map
absl::flat_hash_map<std::string, int> word_count;
word_count["hello"]++;
word_count.emplace("world", 42);

// Lookup -- returns pointer, null if absent (no exception)
if (auto it = word_count.find("hello"); it != word_count.end()) {
    int count = it->second;
    (void)count;
}

// contains() -- C++20-style, available in Abseil today
if (word_count.contains("hello")) {
    // ...
}

// Batch reserve to avoid rehashing
word_count.reserve(10000);

// flat_hash_set -- same performance benefits
absl::flat_hash_set<int64_t> seen_ids;
seen_ids.insert(request_id);
bool already_seen = seen_ids.contains(request_id);
```

### Why Flat Hash Maps Are Faster

The memory layout difference is profound:

```
std::unordered_map lookup:
  table[hash % buckets]  -->  node*  -->  {key, value}
  ^cache miss likely              ^second cache miss

absl::flat_hash_map lookup:
  table[hash % capacity]  -->  {metadata, key, value}  (inline)
  ^one cache line covers multiple slots
```

Abseil's implementation stores 1-byte hash fingerprints (the "control bytes") in a separate array from the key-value data. A SIMD scan over 16 control bytes can find candidate slots in a single CPU instruction, making the common case (not found, or found in first probe) extremely fast.

### absl::node_hash_map: When You Need Pointer Stability

`flat_hash_map` may relocate elements on rehash, invalidating pointers and iterators. If you store raw pointers or references to map values elsewhere, use `absl::node_hash_map` instead:

```cpp
#include "absl/container/node_hash_map.h"

absl::node_hash_map<std::string, LargeObject> registry;

// Insert and take a pointer to the value
auto [it, inserted] = registry.emplace("key", LargeObject{});
LargeObject* ptr = &it->second;  // pointer remains valid after rehash

registry.emplace("another_key", LargeObject{});  // rehash safe -- ptr still valid
```

Use `flat_hash_map` by default. Switch to `node_hash_map` only when you have proven pointer stability requirements.

### Custom Hash with AbslHashValue

Making a user-defined type hashable for `absl::flat_hash_map` requires implementing a single `AbslHashValue` friend function that feeds the struct's fields into the provided `H` hash state using `H::combine`. Abseil's hash framework automatically combines all fields with a high-quality hash algorithm, so there is no need to write XOR-based hash functions that produce poor distributions on structured keys like `{user_id, endpoint}` pairs.
```cpp
struct RequestKey {
    int64_t     user_id;
    std::string endpoint;

    bool operator==(const RequestKey& other) const {
        return user_id == other.user_id && endpoint == other.endpoint;
    }

    // AbslHashValue is the hook Abseil uses -- no need to specialize std::hash
    template <typename H>
    friend H AbslHashValue(H state, const RequestKey& key) {
        return H::combine(std::move(state), key.user_id, key.endpoint);
    }
};

absl::flat_hash_map<RequestKey, RequestStats> stats_by_request;
```

This is more ergonomic than specializing `std::hash<T>`. The `H::combine` function composes hashes safely, avoiding common pitfalls like XOR-based hash combination (which destroys entropy when two values are equal).

### absl::Time and absl::Duration

`std::chrono` is powerful but incomplete, it has no concept of time zones, civil time (year/month/day), or timezone-aware formatting until C++20, and even then the implementation support is patchy. `absl::Time` fills this gap.

```cpp
#include "absl/time/time.h"
#include "absl/time/clock.h"

// Current time
absl::Time now = absl::Now();

// Duration arithmetic
absl::Duration d = absl::Minutes(5) + absl::Seconds(30);
absl::Time deadline = now + d;

// Duration decomposition
int64_t total_seconds = absl::ToInt64Seconds(d);
double  total_ms      = absl::ToDoubleMilliseconds(d);

// Comparison
if (absl::Now() > deadline) {
    // Request timed out
}

// Formatting with timezone
absl::TimeZone utc = absl::UTCTimeZone();
absl::TimeZone la;
absl::LoadTimeZone("America/Los_Angeles", &la);

std::string formatted = absl::FormatTime(
    "%Y-%m-%dT%H:%M:%S%Ez", now, utc
);
// "2024-01-15T10:23:45+00:00"

// Parsing
absl::Time parsed;
std::string err;
absl::ParseTime("%Y-%m-%dT%H:%M:%S%Ez", "2024-01-15T10:23:45+00:00",
                utc, &parsed, &err);
```

### Civil Time: Working with Calendar Dates

Abseil's civil-time types (`absl::CivilDay`, `absl::CivilSecond`) model calendar dates and wall-clock times without a time zone, which is exactly what you want for birthdays, billing periods, and other human-calendar concepts that must not shift when the server's zone does.
```cpp
// Civil time -- year/month/day without timezone ambiguity
absl::CivilDay today = absl::ToCivilDay(absl::Now(), utc);
absl::CivilDay next_week = today + 7;

// Convert civil time back to absolute time
absl::Time start_of_day = absl::FromCivil(today, utc);

// CivilSecond, CivilMinute, CivilHour, CivilDay, CivilMonth, CivilYear
absl::CivilSecond cs(2024, 1, 15, 10, 23, 45);
absl::Time t = absl::FromCivil(cs, la);  // Jan 15 10:23:45 LA time as absolute time
```

### Production Example: Timestamped Event Cache

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```cpp
#include "absl/container/flat_hash_map.h"
#include "absl/time/time.h"
#include "absl/time/clock.h"

struct CachedEvent {
    std::string payload;
    absl::Time  inserted_at;
    absl::Time  expires_at;
};

class EventCache {
    absl::flat_hash_map<int64_t, CachedEvent> cache_;
    absl::Duration                             ttl_;

public:
    explicit EventCache(absl::Duration ttl) : ttl_(ttl) {
        cache_.reserve(1024);
    }

    void insert(int64_t event_id, std::string payload) {
        absl::Time now = absl::Now();
        cache_.insert_or_assign(event_id, CachedEvent{
            .payload     = std::move(payload),
            .inserted_at = now,
            .expires_at  = now + ttl_,
        });
    }

    std::optional<std::string> get(int64_t event_id) {
        auto it = cache_.find(event_id);
        if (it == cache_.end()) return std::nullopt;

        if (absl::Now() > it->second.expires_at) {
            cache_.erase(it);
            return std::nullopt;
        }

        return it->second.payload;
    }

    void evict_expired() {
        absl::Time now = absl::Now();
        absl::erase_if(cache_, [&](const auto& kv) {
            return now > kv.second.expires_at;
        });
    }

    size_t size() const { return cache_.size(); }
};
```

The Go equivalent combines `map[int64]CachedEvent` with `time.Time`, nearly the same structure. The C++ version is faster at lookup due to `flat_hash_map`'s cache-friendliness, but the programming model is identical. The key lesson: Go's `map` and `time.Time` were influenced by the same lessons Abseil codified. Go just shipped them as standard library features.

---
