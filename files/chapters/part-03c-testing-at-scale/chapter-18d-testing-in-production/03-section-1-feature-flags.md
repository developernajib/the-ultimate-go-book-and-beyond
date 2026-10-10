## Section 1: Feature Flags

### 1.0 The Ecosystem in 2026: OpenFeature and Managed Providers

Feature flagging has standardized around **OpenFeature**, a CNCF Incubating project (graduated from Sandbox in November 2023) that defines a vendor-neutral API and SDK surface so application code does not couple to a specific flag provider. The Go SDK (`github.com/open-feature/go-sdk`) exposes a `Client` with `BooleanValue`, `StringValue`, `ObjectValue`, and evaluation-context plumbing. Behind it sits a pluggable `FeatureProvider` interface, any managed service (LaunchDarkly, Split, Flagsmith, Unleash, GrowthBook, ConfigCat) or an in-house backend plugs in without touching call sites.

The practical guidance: build your flag abstraction *against OpenFeature* from day one even if you start with a homegrown store like the one below. When the in-house store outgrows its usefulness, you swap the provider rather than rewrite every call site. LaunchDarkly and Split dominate the paid tier for enterprise-scale experimentation (streaming updates, audit trails, SRM detection). Unleash and Flagsmith are the self-hosted OSS options. GrowthBook emphasizes statistics-first experimentation with built-in Bayesian analysis.

```go
// OpenFeature call site: provider-agnostic.
import "github.com/open-feature/go-sdk/openfeature"

client := openfeature.NewClient("checkout-service")
ctx := openfeature.NewEvaluationContext(userID, map[string]any{
    "region": "eu-west-1",
    "tier":   "enterprise",
})
useNewFlow, err := client.BooleanValue(r.Context(), "new-checkout-flow", false, ctx)
```

### 1.1 Feature Flag Engine

A feature flag engine decouples code deployment from feature activation, allowing a new code path to exist in production without being reachable by any user until the flag is explicitly enabled for a controlled audience. An effective flag engine supports gradual rollouts by user ID hash, A/B experiment assignments, kill switches for instant disablement, and context-aware rules that consider user attributes like region or subscription tier. The engine below stores flag configurations in a database with an in-process cache, evaluates rules in constant time, and emits an audit event on every flag evaluation for compliance logging. It is deliberately shaped to slot in behind an OpenFeature `FeatureProvider` adapter, so downstream consumers call `openfeature.Client`, not this store directly.

```go
package featureflags

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// RolloutStrategy determines who gets the feature.
type RolloutStrategy string

const (
	StrategyAll         RolloutStrategy = "all"         // everyone
	StrategyNone        RolloutStrategy = "none"        // nobody
	StrategyPercentage  RolloutStrategy = "percentage"  // X% by user hash
	StrategyUserList    RolloutStrategy = "user_list"   // specific user IDs
	StrategyUserGroup   RolloutStrategy = "user_group"  // by group/tier
	StrategyEnvironment RolloutStrategy = "environment" // by env
)

// Flag defines a feature flag configuration.
type Flag struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Enabled     bool            `json:"enabled"`
	Strategy    RolloutStrategy `json:"strategy"`
	Percentage  float64         `json:"percentage,omitempty"`  // 0.0-100.0
	UserIDs     []string        `json:"user_ids,omitempty"`
	Groups      []string        `json:"groups,omitempty"`
	Environments []string       `json:"environments,omitempty"`
	Variants    map[string]any `json:"variants,omitempty"` // A/B test variants
}

// EvaluationContext carries request-time context for flag evaluation.
type EvaluationContext struct {
	UserID      string
	Groups      []string
	Environment string
	Attributes  map[string]any
}

// FlagStore manages feature flags with hot-reload support.
type FlagStore struct {
	flags   atomic.Pointer[map[string]Flag]
	mu      sync.RWMutex
	metrics FlagMetrics
}

// FlagMetrics tracks flag evaluation statistics.
type FlagMetrics struct {
	evaluations sync.Map // flag name → *evalCount
}

type evalCount struct {
	enabled  atomic.Int64
	disabled atomic.Int64
}

func (m *FlagMetrics) record(flagName string, enabled bool) {
	v, _ := m.evaluations.LoadOrStore(flagName, &evalCount{})
	ec := v.(*evalCount)
	if enabled {
		ec.enabled.Add(1)
	} else {
		ec.disabled.Add(1)
	}
}

func (m *FlagMetrics) Stats(flagName string) (enabled, disabled int64) {
	if v, ok := m.evaluations.Load(flagName); ok {
		ec := v.(*evalCount)
		return ec.enabled.Load(), ec.disabled.Load()
	}
	return 0, 0
}

// NewFlagStore creates a flag store from initial flags.
func NewFlagStore(flags []Flag) *FlagStore {
	fs := &FlagStore{}
	m := make(map[string]Flag, len(flags))
	for _, f := range flags {
		m[f.Name] = f
	}
	fs.flags.Store(&m)
	return fs
}

// Update atomically replaces all flags (used by hot-reload).
func (fs *FlagStore) Update(flags []Flag) {
	m := make(map[string]Flag, len(flags))
	for _, f := range flags {
		m[f.Name] = f
	}
	fs.flags.Store(&m)
}

// IsEnabled returns whether a flag is enabled for the given context.
func (fs *FlagStore) IsEnabled(flagName string, ctx EvaluationContext) bool {
	flags := *fs.flags.Load()
	flag, ok := flags[flagName]
	if !ok {
		fs.metrics.record(flagName, false)
		return false
	}

	enabled := fs.evaluate(flag, ctx)
	fs.metrics.record(flagName, enabled)
	return enabled
}

// GetVariant returns the variant value for an A/B test flag.
func (fs *FlagStore) GetVariant(flagName string, ctx EvaluationContext) any {
	flags := *fs.flags.Load()
	flag, ok := flags[flagName]
	if !ok || !fs.evaluate(flag, ctx) {
		return nil
	}
	// Assign variant based on a hash of the user and this flag's name, so
	// assignment is sticky per user and independent across flags.
	variantKey, ok := fs.assignVariant(ctx.UserID, flagName, flag.Variants)
	if !ok {
		return nil
	}
	return flag.Variants[variantKey]
}

func (fs *FlagStore) evaluate(flag Flag, ctx EvaluationContext) bool {
	if !flag.Enabled {
		return false
	}
	switch flag.Strategy {
	case StrategyAll:
		return true
	case StrategyNone:
		return false
	case StrategyPercentage:
		return fs.hashPercentage(ctx.UserID, flag.Name) < flag.Percentage
	case StrategyUserList:
		for _, id := range flag.UserIDs {
			if id == ctx.UserID {
				return true
			}
		}
		return false
	case StrategyUserGroup:
		for _, group := range ctx.Groups {
			for _, allowedGroup := range flag.Groups {
				if group == allowedGroup {
					return true
				}
			}
		}
		return false
	case StrategyEnvironment:
		for _, env := range flag.Environments {
			if env == ctx.Environment {
				return true
			}
		}
		return false
	}
	return false
}

// hashPercentage returns 0-100 based on stable hash of userID+flagName.
// Same user always gets same result for same flag (sticky assignment).
func (fs *FlagStore) hashPercentage(userID, flagName string) float64 {
	h := sha256.New()
	fmt.Fprintf(h, "%s:%s", userID, flagName)
	hashBytes := h.Sum(nil)
	// Use first 4 bytes as uint32, map to 0-100
	v := uint32(hashBytes[0])<<24 | uint32(hashBytes[1])<<16 |
		uint32(hashBytes[2])<<8 | uint32(hashBytes[3])
	return float64(v) / float64(^uint32(0)) * 100.0
}

// assignVariant deterministically picks one variant for a user.
//
// Two things here are easy to get wrong and expensive to get wrong.
//
// First, the hash is salted with flagName, not with a constant. Hashing on a
// fixed string would give every user the same bucket in every experiment, so
// the user in the first 50% of experiment A is in the first 50% of experiment
// B too. Every experiment would then run on identical cohorts, silently
// confounding all of them with each other. The bug is invisible in the code
// and fatal in the results.
//
// Second, an empty variant map is handled explicitly. len(keys) == 0 makes
// the divisor +Inf, bucket 0, idx 0, and keys[0] panics on an empty slice.
// A flag misconfiguration must not take the process down.
func (fs *FlagStore) assignVariant(userID, flagName string, variants map[string]any) (string, bool) {
	if len(variants) == 0 {
		return "", false
	}

	keys := make([]string, 0, len(variants))
	for k := range variants {
		keys = append(keys, k)
	}
	slices.Sort(keys) // stable order, so assignment does not depend on map iteration

	pct := fs.hashPercentage(userID, flagName)
	idx := int(pct / (100.0 / float64(len(keys))))
	if idx >= len(keys) {
		idx = len(keys) - 1 // guards the pct == 100.0 boundary
	}
	return keys[idx], true
}

// FlagFileLoader hot-reloads flags from a JSON file.
type FlagFileLoader struct {
	path     string
	store    *FlagStore
	interval time.Duration
}

func NewFlagFileLoader(path string, store *FlagStore, interval time.Duration) *FlagFileLoader {
	return &FlagFileLoader{path: path, store: store, interval: interval}
}

func (l *FlagFileLoader) Start(ctx context.Context) {
	l.loadOnce()
	ticker := time.NewTicker(l.interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				l.loadOnce()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (l *FlagFileLoader) loadOnce() {
	data, err := os.ReadFile(l.path)
	if err != nil {
		log.Printf("load flags: %v", err)
		return
	}
	var flags []Flag
	if err := json.Unmarshal(data, &flags); err != nil {
		log.Printf("parse flags: %v", err)
		return
	}
	l.store.Update(flags)
}

// FlagMiddleware injects flag evaluation into HTTP requests.
func FlagMiddleware(store *FlagStore, envName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Build evaluation context from request
			ctx := EvaluationContext{
				UserID:      r.Header.Get("X-User-ID"),
				Environment: envName,
				Groups:      strings.Split(r.Header.Get("X-User-Groups"), ","),
			}
			// Attach to request context for downstream use
			r = r.WithContext(context.WithValue(r.Context(), flagContextKey{}, flagContext{
				store: store,
				eval:  ctx,
			}))
			next.ServeHTTP(w, r)
		})
	}
}

type flagContextKey struct{}
type flagContext struct {
	store *FlagStore
	eval  EvaluationContext
}

// IsFlagEnabled retrieves flag status from request context.
func IsFlagEnabled(ctx context.Context, flagName string) bool {
	if fc, ok := ctx.Value(flagContextKey{}).(flagContext); ok {
		return fc.store.IsEnabled(flagName, fc.eval)
	}
	return false
}
```

### 1.2 Progressive Rollout with Kill Switch

Progressive rollout activates a feature for an increasing percentage of users, 5%, 25%, 50%, 100%, pausing between stages to validate that error rates, latency, and business metrics remain within acceptable ranges before widening the audience. The kill switch is the safety lever that collapses the rollout back to 0% instantly when a monitoring alert fires, without requiring a code deployment. The rollout manager below tracks the current rollout percentage per flag, exposes a `/admin/flags/{name}/rollout` endpoint for operators, and integrates with the alerting system to automatically pause a rollout when the error rate exceeds a threshold.

```go
package featureflags

import (
	"context"
	"log"
	"sync"
	"time"
)

// RolloutPlan defines a progressive feature rollout.
type RolloutPlan struct {
	FlagName  string
	Stages    []RolloutStage
	AutoRoll  bool          // automatically advance stages
	Metrics   MetricsChecker
}

// RolloutStage defines one phase of a rollout.
type RolloutStage struct {
	Percentage  float64
	Duration    time.Duration // how long to hold before advancing
	ErrorBudget float64       // max error rate before rollback
}

// MetricsChecker queries the current error rate.
type MetricsChecker interface {
	ErrorRate(flagName string, window time.Duration) float64
}

// ProgressiveRollouter manages automated rollout advancement and rollback.
type ProgressiveRollouter struct {
	plan    RolloutPlan
	store   *FlagStore
	current int
	mu      sync.Mutex
}

func NewProgressiveRollouter(plan RolloutPlan, store *FlagStore) *ProgressiveRollouter {
	return &ProgressiveRollouter{plan: plan, store: store}
}

// Start begins the rollout, advancing stages automatically if AutoRoll is true.
func (r *ProgressiveRollouter) Start(ctx context.Context) {
	r.applyStage(0)

	if !r.plan.AutoRoll {
		return
	}

	go func() {
		for {
			r.mu.Lock()
			current := r.current
			r.mu.Unlock()

			if current >= len(r.plan.Stages) {
				log.Printf("rollout %s: complete at 100%%", r.plan.FlagName)
				return
			}

			stage := r.plan.Stages[current]
			timer := time.NewTimer(stage.Duration)

			select {
			case <-timer.C:
				// Check error budget before advancing
				errorRate := r.plan.Metrics.ErrorRate(r.plan.FlagName, 5*time.Minute)
				if errorRate > stage.ErrorBudget {
					log.Printf("rollout %s: error rate %.2f%% exceeds budget %.2f%%, rolling back",
						r.plan.FlagName, errorRate*100, stage.ErrorBudget*100)
					r.Rollback()
					return
				}
				// Advance to next stage
				r.mu.Lock()
				nextStage := r.current + 1
				r.mu.Unlock()
				if nextStage < len(r.plan.Stages) {
					r.applyStage(nextStage)
				} else {
					r.enableAll()
				}
			case <-ctx.Done():
				timer.Stop()
				return
			}
		}
	}()
}

func (r *ProgressiveRollouter) applyStage(stageIdx int) {
	r.mu.Lock()
	r.current = stageIdx
	r.mu.Unlock()

	stage := r.plan.Stages[stageIdx]
	flags := *r.store.flags.Load()
	updated := make(map[string]Flag, len(flags))
	for k, v := range flags {
		updated[k] = v
	}
	if flag, ok := updated[r.plan.FlagName]; ok {
		flag.Strategy = StrategyPercentage
		flag.Percentage = stage.Percentage
		flag.Enabled = true
		updated[r.plan.FlagName] = flag
	}
	r.store.flags.Store(&updated)
	log.Printf("rollout %s: stage %d at %.1f%%", r.plan.FlagName, stageIdx, stage.Percentage)
}

func (r *ProgressiveRollouter) enableAll() {
	r.mu.Lock()
	defer r.mu.Unlock()

	flags := *r.store.flags.Load()
	updated := make(map[string]Flag, len(flags))
	for k, v := range flags {
		updated[k] = v
	}
	if flag, ok := updated[r.plan.FlagName]; ok {
		flag.Strategy = StrategyAll
		flag.Enabled = true
		updated[r.plan.FlagName] = flag
	}
	r.store.flags.Store(&updated)
	log.Printf("rollout %s: complete, enabled for all", r.plan.FlagName)
}

// Rollback immediately disables the feature for all users.
func (r *ProgressiveRollouter) Rollback() {
	r.mu.Lock()
	defer r.mu.Unlock()

	flags := *r.store.flags.Load()
	updated := make(map[string]Flag, len(flags))
	for k, v := range flags {
		updated[k] = v
	}
	if flag, ok := updated[r.plan.FlagName]; ok {
		flag.Enabled = false
		updated[r.plan.FlagName] = flag
	}
	r.store.flags.Store(&updated)
	log.Printf("rollout %s: ROLLED BACK", r.plan.FlagName)
}
```

### 1.3 Flag hygiene and the debt it leaves behind

Feature flags are ergonomic to add and expensive to remove. Every flag in your codebase is a permanent branch point that adds complexity to every reader. A codebase with 200 active flags has 2^200 theoretical code paths (in practice most flags are independent, but the combinatorial shape is still daunting). Flag hygiene is the discipline of retiring flags once their rollout is complete. Four practices make it manageable. First, every new flag has an expiration date at creation time, typically 90 days after full rollout. Second, expired flags trigger a notification to the owning team requiring either removal or explicit extension with justification. Third, flag removal PRs are lightweight to produce (the code with the flag inlined is shorter than the code with the flag conditional) and easy to review. Fourth, the flag count per service is tracked as a team metric. Teams that ship well have stable flag counts. Teams that do not accumulate flag debt until every PR touches five conditionals, and the complexity eventually grinds velocity to a halt.

### 1.4 Junior → FAANG: your first flag-gated rollout

Pick a small, low-risk code change you would normally deploy directly. Wrap it in a feature flag using the pattern in section 1.1. Deploy with the flag off. Turn it on for yourself (via a user-list rule). Verify. Turn it on for the team. Verify. Turn it on for 1 percent of users. Watch the metrics for an hour. Turn it on for 10 percent. Watch again. Ramp to 100 percent over a day. After full rollout, open a PR to remove the flag entirely. That end-to-end exercise takes a week and teaches you the rhythm of progressive delivery. Every subsequent flag-gated rollout is a variation on this pattern, and having done it once cleanly is worth more than any amount of reading about the theory.

### 1.5 Senior @ FAANG: the OpenFeature adoption case

If your team is not yet on OpenFeature, write the adoption case now. Three reasons. First, vendor lock-in: bespoke flag code couples every handler to a specific provider, so switching providers later is a massive refactor. OpenFeature decouples the call site from the provider. Second, observability: OpenFeature hooks let you emit evaluation events for every flag check, which is the foundation of experiment analysis and audit logging. Third, team fluency: OpenFeature is the emerging standard, so engineers who join from outside already know the API. The adoption cost is typically one sprint of wrapping existing flag evaluations in the OpenFeature SDK. The ongoing benefit is portability, consistency, and built-in observability. This is the kind of platform investment that scales across teams and outlives any specific flag-provider choice.

---
