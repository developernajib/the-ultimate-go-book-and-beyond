## 26.3 Feature Flag Implementation

### Basic Feature Flags

A feature flag store is a thread-safe map from flag name to boolean value. The `RWMutex` allows many concurrent `IsEnabled` reads without contention while serializing writes from the admin API or background sync goroutine. Returning a copy of the full flag map in `All()` prevents callers from modifying the internal map while holding no lock.

```go
package features

import (
    "sync"
)

type FeatureFlags struct {
    mu    sync.RWMutex
    flags map[string]bool
}

func NewFeatureFlags() *FeatureFlags {
    return &FeatureFlags{
        flags: make(map[string]bool),
    }
}

func (f *FeatureFlags) Set(name string, enabled bool) {
    f.mu.Lock()
    defer f.mu.Unlock()
    f.flags[name] = enabled
}

func (f *FeatureFlags) IsEnabled(name string) bool {
    f.mu.RLock()
    defer f.mu.RUnlock()
    return f.flags[name]
}

func (f *FeatureFlags) All() map[string]bool {
    f.mu.RLock()
    defer f.mu.RUnlock()

    result := make(map[string]bool, len(f.flags))
    for k, v := range f.flags {
        result[k] = v
    }
    return result
}
```

### Percentage-Based Rollout

Rather than using `rand.Float64()` to decide per-request, `hashToBucket` derives a deterministic bucket from the flag name concatenated with the user ID. This ensures the same user always sees the same experience across requests and across service restarts, random sampling would cause a user to flicker between enabled and disabled states on every page load. Concatenating the flag name into the hash input means that a user in bucket 42 for one flag is not automatically in bucket 42 for every other flag, preventing correlated rollouts that would skew experiment results.

```go
package features

import (
    "hash/fnv"
    "sync"
)

type RolloutConfig struct {
    Percentage int      // 0-100
    AllowList  []string // Always enabled for these IDs
    BlockList  []string // Always disabled for these IDs
}

type RolloutFlags struct {
    mu    sync.RWMutex
    flags map[string]RolloutConfig
}

func NewRolloutFlags() *RolloutFlags {
    return &RolloutFlags{
        flags: make(map[string]RolloutConfig),
    }
}

func (r *RolloutFlags) Configure(name string, config RolloutConfig) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.flags[name] = config
}

func (r *RolloutFlags) IsEnabled(name string, userID string) bool {
    r.mu.RLock()
    config, exists := r.flags[name]
    r.mu.RUnlock()

    if !exists {
        return false
    }

    // Check block list
    for _, id := range config.BlockList {
        if id == userID {
            return false
        }
    }

    // Check allow list
    for _, id := range config.AllowList {
        if id == userID {
            return true
        }
    }

    // Percentage-based rollout
    if config.Percentage == 0 {
        return false
    }
    if config.Percentage >= 100 {
        return true
    }

    // Consistent hash for user. The ":" separator is not decoration: see below.
    bucket := hashToBucket(name + ":" + userID)
    return bucket < config.Percentage
}

func hashToBucket(s string) int {
    h := fnv.New32a()
    h.Write([]byte(s))
    return int(h.Sum32() % 100)
}
```

**Why the separator matters.** Hashing `name + userID` with no delimiter makes the boundary between the two fields ambiguous, and distinct pairs collapse onto the same input string. Flag `new` with user `checkout1` and flag `newcheckout` with user `1` both hash the bytes `newcheckout1`, so they land in the same bucket (44, if you want to check). This is not theoretical: flag names and user IDs are both attacker-influenced or at least product-influenced strings, and a rename from `checkout` to `checkout2` silently re-buckets a different flag's population. Any delimiter that cannot appear in a flag name fixes it. Prefixing each field with its length is the fully rigorous version.

Verify the distribution rather than trusting it. Hashing 100,000 synthetic user IDs per rollout percentage with the FNV-1a bucketing above gives:

| Requested | Actual | Delta |
|-----------|--------|-------|
| 1% | 0.98% | -0.02 |
| 5% | 5.02% | +0.02 |
| 10% | 10.02% | +0.02 |
| 25% | 25.03% | +0.03 |
| 50% | 50.09% | +0.09 |
| 99% | 98.99% | -0.01 |

Every bucket lands within 0.1 points of its target, which is well inside sampling noise at this sample size. The cross-flag check matters just as much: with five independent 50% flags and 5,000 users, 163 users were enabled on all five, against a chance expectation of 156. That is the number you want. If it came back near 2,500 you would have the correlated-rollout bug described next.

> **The bug this design exists to prevent.** Hash the user ID *alone* (`hashToBucket(userID)`) and every flag in your system buckets that user identically. The user in bucket 12 is in bucket 12 for every experiment you will ever run, so the same minority of users is enabled on everything and the same majority is enabled on nothing. Your 10% rollouts all hit the *same* 10% of users. This does not look like a bug: each flag independently reports a correct 10% exposure, dashboards are green, and the rollout percentages are exactly right. What breaks is that your experiments are no longer independent samples, so every interaction effect is confounded and the same unlucky cohort absorbs every new feature and every new bug. Mixing the flag name into the hash input is the entire fix, and the cross-flag independence check above is how you prove it is working. Run that check in CI.

> **Senior track**: FNV-1a is fine for assignment buckets: fast, non-cryptographic, and uniform enough (the table above is the evidence). Two refinements. First, for security-sensitive targeting, such as a flag gating access to internal tooling, prefer SHA-256 over a server-side secret salt, because FNV is trivially invertible and a user can otherwise compute which bucket to claim. Note that this only matters when the *client* asserts its own identity attributes. Second, on the choice of reduction: `% 100` on a 32-bit hash has a modulo bias of roughly `(2^32 mod 100) / 2^32`, about two parts in a hundred million. That is negligible at 100 buckets and still negligible at 10,000. Do not let anyone talk you into a more complicated reduction on uniformity grounds at these sizes. The real reason to use more hash bits is granularity: 100 integer buckets cannot express a 0.5% rollout. If you need finer control, hash into 10,000 buckets and compare against `percentage * 100`.

### Evaluation Performance Budget

A flag evaluation sits on the hot path of every request. Aim for single-digit microseconds per evaluation:

- **No I/O on the hot path**. All flag state must live in memory. A database lookup per evaluation is a design bug.
- **Use `atomic.Value` for the flag snapshot**. Background refresh builds a new map and swaps the pointer, so readers never block on a mutex. `RWMutex` looks free but is not: every `RLock` is a write to shared cache-line state, so readers contend with each other even though none of them mutates anything. Benchmarking both stores below on an 8-core laptop, `-cpu 8`, with the full read path (lock, map lookup, FNV hash, compare) gives 268 ns/op for the `RWMutex` version against 99 ns/op for `atomic.Value`, so about 2.7x. Both figures include the hashing work, which is why neither is near zero. Measure on your own hardware and at your own core count before quoting any of this: the gap widens with more cores, and on a single core it nearly vanishes.
- **Pre-compile rules on refresh**. Parse once, evaluate many. Don't re-parse `"user_id in [a,b,c]"` on every request.
- **Batch impression events**. Writing one analytics event per evaluation to Kafka will destroy your service. Ring buffer in memory, flush every second or every 1000 events.

```go
// Lock-free read path using atomic.Value.
type FastStore struct {
    snapshot atomic.Value // holds map[string]*CompiledFlag
}

func (s *FastStore) IsEnabled(key, userID string) bool {
    m, _ := s.snapshot.Load().(map[string]*CompiledFlag)
    flag, ok := m[key]
    if !ok {
        return false
    }
    return flag.Evaluate(userID) // pre-compiled, no parsing
}

// Background refresh rebuilds the whole map and swaps the pointer.
// Readers see either the old or new map, never a partial state.
func (s *FastStore) swap(next map[string]*CompiledFlag) {
    s.snapshot.Store(next)
}
```

### Contextual Feature Flags

Contextual flags solve the limitation of percentage rollouts by letting you target along any dimension, country, platform, app version, beta opt-in status, without writing ad hoc `if` chains throughout application code. Rule sets are evaluated in declaration order and short-circuit on the first match, so you can layer specificity: a rule that enables a feature for beta users in the US takes precedence over a broader rule that disables it for all US traffic. The `Attributes` map on `EvaluationContext` acts as an escape hatch for domain-specific properties (like `subscription_tier` or `org_id`) without requiring schema changes to the struct.

```go
package features

import (
    "strings"
    "sync"
)

type EvaluationContext struct {
    UserID      string
    Country     string
    Platform    string
    AppVersion  string
    IsBeta      bool
    Attributes  map[string]string
}

type Rule struct {
    Attribute string
    Operator  string // "eq", "ne", "in", "contains", "gt", "lt"
    Value     any
}

type FlagConfig struct {
    DefaultValue bool
    Rules        []RuleSet
}

type RuleSet struct {
    Rules  []Rule
    Result bool
}

type ContextualFlags struct {
    mu    sync.RWMutex
    flags map[string]FlagConfig
}

func NewContextualFlags() *ContextualFlags {
    return &ContextualFlags{
        flags: make(map[string]FlagConfig),
    }
}

func (c *ContextualFlags) Configure(name string, config FlagConfig) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.flags[name] = config
}

func (c *ContextualFlags) Evaluate(name string, ctx EvaluationContext) bool {
    c.mu.RLock()
    config, exists := c.flags[name]
    c.mu.RUnlock()

    if !exists {
        return false
    }

    // Evaluate rules in order
    for _, ruleSet := range config.Rules {
        if c.evaluateRuleSet(ruleSet, ctx) {
            return ruleSet.Result
        }
    }

    return config.DefaultValue
}

func (c *ContextualFlags) evaluateRuleSet(rs RuleSet, ctx EvaluationContext) bool {
    for _, rule := range rs.Rules {
        if !c.evaluateRule(rule, ctx) {
            return false
        }
    }
    return true
}

func (c *ContextualFlags) evaluateRule(rule Rule, ctx EvaluationContext) bool {
    var actual string
    switch rule.Attribute {
    case "user_id":
        actual = ctx.UserID
    case "country":
        actual = ctx.Country
    case "platform":
        actual = ctx.Platform
    case "app_version":
        actual = ctx.AppVersion
    default:
        actual = ctx.Attributes[rule.Attribute]
    }

    // Every assertion below is comma-ok. A malformed rule must not panic the
    // request: an unmatched rule is a non-match, not a crash. See the warning.
    switch rule.Operator {
    case "eq":
        want, ok := rule.Value.(string)
        return ok && actual == want
    case "ne":
        want, ok := rule.Value.(string)
        return ok && actual != want
    case "in":
        return matchesAny(actual, rule.Value)
    case "contains":
        want, ok := rule.Value.(string)
        return ok && strings.Contains(actual, want)
    default:
        return false
    }
}

// matchesAny handles both []string (rules built in Go) and []any (rules
// decoded from JSON, where encoding/json always produces []any).
func matchesAny(actual string, value any) bool {
    switch vs := value.(type) {
    case []string:
        for _, v := range vs {
            if actual == v {
                return true
            }
        }
    case []any:
        for _, v := range vs {
            if s, ok := v.(string); ok && actual == s {
                return true
            }
        }
    }
    return false
}
```

> **The `in` operator above was a guaranteed panic before it was fixed, and the reason is worth internalizing.** The original wrote `rule.Value.([]string)`. But `Value` is typed `any`, and flags arrive as JSON from a remote service. `encoding/json` has no idea you wanted `[]string`: decoding into `any` always yields `[]interface{}`. So the assertion fails on *every* `in` rule ever loaded from the flag service, and a bare type assertion panics rather than returning false. That panic fires inside the flag evaluator, which sits on the hot path of every request, so the first targeting rule you deploy takes down every handler that reads a flag.
>
> Two lessons compound here. First, prefer comma-ok assertions anywhere the value crosses a serialization boundary. Second, and more important for this chapter specifically: **a flag evaluator must never be able to panic.** It is infrastructure that every request touches, and it is fed data edited through a web UI by people who are not running your test suite. A typo in a targeting rule should disable a feature, not the service. Consider a `defer recover()` at the top of `Evaluate` returning the default value, and treat any recovered panic as a loud alert. That is not defensive programming as a substitute for correctness, it is a blast-radius decision.

### Staff Lens: Consistent Bucketing

Percentage rollouts need consistent user-to-bucket hashing. Same user always gets same experience. Use a stable hash (FNV, xxhash) of user-id plus flag-name. Without consistency, users flip between variants which is confusing and breaks A/B test statistics.

---
