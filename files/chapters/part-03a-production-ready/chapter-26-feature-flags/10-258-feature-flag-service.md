## 26.8 Feature Flag Service

### Complete Feature Flag Service

A production-grade feature flag service must handle flag storage, evaluation rules (boolean, percentage rollout, user targeting), and flag updates without a restart. This implementation uses a `sync.RWMutex`-protected in-memory cache populated from a remote source, with a background refresh goroutine that updates the cache on a configurable interval so flag changes propagate without redeployment.

Note the failure posture this design commits to. `Start` does not return an error when the initial fetch fails, so a flag service outage cannot prevent your fleet from starting or restarting. That is the right call, since the alternative is a flag service outage escalating into a total inability to deploy or scale. But it has a direct consequence: **the flag default is not a formality, it is the behavior your service exhibits during a flag service outage.** Choose every default to be the currently-shipping, known-good behavior, never the new path. This is what "fail-safe" means concretely for flags, and it is why a flag defaulting to "on" for an unreleased feature is a latent incident.

```go
package features

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"
)

type Flag struct {
    Key          string          `json:"key"`
    Enabled      bool            `json:"enabled"`
    Percentage   int             `json:"percentage"`
    Rules        []EvaluationRule `json:"rules"`
    DefaultValue bool            `json:"default_value"`
}

type EvaluationRule struct {
    Conditions []Condition `json:"conditions"`
    Value      bool        `json:"value"`
}

type Condition struct {
    Attribute string   `json:"attribute"`
    Operator  string   `json:"operator"`
    Values    []string `json:"values"`
}

type FlagService struct {
    mu           sync.RWMutex
    flags        map[string]Flag
    logger       *slog.Logger
    remoteURL    string
    pollInterval time.Duration
    httpClient   *http.Client
}

func NewFlagService(logger *slog.Logger, remoteURL string) *FlagService {
    return &FlagService{
        flags:        make(map[string]Flag),
        logger:       logger,
        remoteURL:    remoteURL,
        pollInterval: 30 * time.Second,
        httpClient:   &http.Client{Timeout: 10 * time.Second},
    }
}

func (s *FlagService) Start(ctx context.Context) error {
    // Initial fetch. Deliberately non-fatal: a flag service outage must not
    // stop your fleet from booting. The cost is that every flag evaluates to
    // its default until the first successful poll, so defaults must be the
    // safe, currently-shipping behavior. See the note on this below.
    if err := s.refresh(ctx); err != nil {
        s.logger.Warn("initial flag fetch failed, serving defaults until first successful poll", "error", err)
    }

    // Start background polling
    go func() {
        ticker := time.NewTicker(s.pollInterval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if err := s.refresh(ctx); err != nil {
                    s.logger.Error("flag refresh failed", "error", err)
                }
            }
        }
    }()

    return nil
}

func (s *FlagService) refresh(ctx context.Context) error {
    req, err := http.NewRequestWithContext(ctx, "GET", s.remoteURL, nil)
    if err != nil {
        return err
    }

    resp, err := s.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("flag refresh: unexpected status %s", resp.Status)
    }

    var flags []Flag
    if err := json.NewDecoder(resp.Body).Decode(&flags); err != nil {
        return err
    }

    // Build a fresh map and REPLACE the old one wholesale. Merging into the
    // existing map would make deletion impossible: see the note below.
    next := make(map[string]Flag, len(flags))
    for _, flag := range flags {
        next[flag.Key] = flag
    }

    s.mu.Lock()
    prev := len(s.flags)
    s.flags = next
    s.mu.Unlock()

    s.logger.Debug("flags refreshed", "count", len(next), "previous", prev)

    return nil
}

func (s *FlagService) IsEnabled(key string, userCtx UserContext) bool {
    s.mu.RLock()
    flag, exists := s.flags[key]
    s.mu.RUnlock()

    if !exists {
        return false
    }

    if !flag.Enabled {
        return false
    }

    // Evaluate targeting rules. First match wins, so order is significant.
    for _, rule := range flag.Rules {
        if s.evaluateRule(rule, userCtx) {
            return rule.Value
        }
    }

    // Percentage rollout. Once a percentage is configured it is authoritative
    // for everyone who reached this point: users outside the bucket are OUT,
    // they do not fall through to DefaultValue. See the note below.
    if flag.Percentage > 0 {
        return hashToBucket(key+":"+userCtx.UserID) < flag.Percentage
    }

    return flag.DefaultValue
}

func (s *FlagService) evaluateRule(rule EvaluationRule, ctx UserContext) bool {
    for _, cond := range rule.Conditions {
        if !s.evaluateCondition(cond, ctx) {
            return false
        }
    }
    return true
}

func (s *FlagService) evaluateCondition(cond Condition, ctx UserContext) bool {
    var actual string
    switch cond.Attribute {
    case "user_id":
        actual = ctx.UserID
    case "country":
        actual = ctx.Country
    case "platform":
        actual = ctx.Platform
    case "app_version":
        actual = ctx.AppVersion
    default:
        actual = ctx.CustomAttributes[cond.Attribute]
    }

    switch cond.Operator {
    case "in":
        for _, v := range cond.Values {
            if actual == v {
                return true
            }
        }
        return false
    case "not_in":
        for _, v := range cond.Values {
            if actual == v {
                return false
            }
        }
        return true
    case "eq":
        return len(cond.Values) > 0 && actual == cond.Values[0]
    case "ne":
        return len(cond.Values) > 0 && actual != cond.Values[0]
    default:
        return false
    }
}

type UserContext struct {
    UserID           string
    Country          string
    Platform         string
    AppVersion       string
    CustomAttributes map[string]string
}
```

> **Two bugs worth dwelling on, because both are invisible in testing and catastrophic in production.**
>
> **The percentage rollout used to fall through to `DefaultValue`.** The original wrote `if bucket < flag.Percentage { return true }` and then let execution continue to `return flag.DefaultValue`. When `DefaultValue` is `false` this happens to work, which is why it survives review and testing. But set `Percentage: 25` on a flag whose `DefaultValue` is `true` and measure it: **100% of users get the feature.** Users inside the bucket return `true` early, and users outside the bucket fall through to a `true` default. A dial that reads "25%" ships to everyone. This is the shape of the worst flag incidents, because the operator's entire mental model, and the number rendered on the dashboard, says the blast radius is one quarter of traffic. Once a percentage is configured, it must be authoritative for everyone who reaches it: in the bucket means on, out of the bucket means off, and the default is what applies when no percentage is set at all.
>
> **`refresh` merged into the live map instead of replacing it.** `for _, flag := range flags { s.flags[flag.Key] = flag }` can only ever add or update keys. It has no way to express deletion, so a flag removed upstream stays resident in every running process until it restarts. That directly defeats the lifecycle discipline described immediately below: you archive a flag, tooling reports it clean, and meanwhile every instance in the fleet is still evaluating it. Worse, an operator deleting a flag to stop a bad rollout would watch the deletion succeed and the behavior persist. Build a new map and swap it. The replace-wholesale pattern also gives you the empty-payload guard for free, since an upstream returning `[]` becomes visibly "0 flags" rather than silently "no change".

### Flag Lifecycle and Cleanup

Every feature flag is technical debt from the day it ships. A permanent kill switch or entitlement flag is fine. A rollout flag that has been at 100% for six months is a liability, it adds a code path, a conditional, and a mental tax on every reader of that file. Teams that adopt flags at scale routinely accumulate hundreds of stale flags within a couple of years, which is exactly why flag platforms now ship dedicated stale-flag detection and code-reference tooling.

Enforce a lifecycle:

1. **Tag every flag at creation** with `type` (rollout, experiment, ops, permission), `owner` (team), and `expected_lifetime` (e.g., 30 days for a rollout flag).
2. **Dashboard of stale flags**. Query for flags that are at 0% or 100% for longer than their expected lifetime. Surface these weekly to owners.
3. **Auto-archive after a grace period**. After 90 days at 100%, mark the flag as pending removal. Fail builds that reference archived flags (static analysis or linter rule).
4. **Delete the flag and the dead code path together** in a single PR. Do not remove the flag but leave the conditional, that is the worst of both worlds.
5. **Kill-switch flags are exempt**. Tag them as `type: ops, permanent: true` so cleanup tooling skips them.

```go
type FlagMetadata struct {
    Key              string    `json:"key"`
    Type             string    `json:"type"` // rollout|experiment|ops|permission
    Owner            string    `json:"owner"`
    CreatedAt        time.Time `json:"created_at"`
    ExpectedLifetime time.Duration `json:"expected_lifetime"`
    Permanent        bool      `json:"permanent"` // skip cleanup
}

func (m FlagMetadata) IsStale(now time.Time) bool {
    if m.Permanent {
        return false
    }
    return now.Sub(m.CreatedAt) > m.ExpectedLifetime
}
```

> **Senior track**: "How do you prevent feature flag sprawl" is a classic FAANG interview question. The answer must include (1) tagging and ownership at creation, (2) automated staleness detection, (3) build-time enforcement (lint rules that fail on archived flag references), and (4) a culture of deleting flag plus code in the same PR. If you only say "we review them quarterly," you have failed the question.

### Staff Lens: Feature Flag Debt Is Real

Unused flags accumulate. Each one is code complexity, a testing matrix dimension, and a potential misfire. The staff-level investment is the governance that prevents accumulation. Without it, a team of 20 engineers accumulates hundreds of stale flags over a year.

---
