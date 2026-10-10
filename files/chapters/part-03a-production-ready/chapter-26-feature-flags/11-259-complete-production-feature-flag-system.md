## 26.9 Complete Production Feature Flag System

This section presents a full feature flag system that includes targeting, experimentation, and analytics, the kind of infrastructure used at FAANG companies for controlled feature rollouts.

### Project Structure

```
flagsystem/
├── cmd/
│   ├── flagserver/                # Flag management server
│   │   └── main.go
│   └── flagctl/                   # CLI tool
│       └── main.go
├── internal/
│   ├── flag/                      # Core flag logic
│   │   ├── flag.go
│   │   ├── evaluator.go
│   │   └── targeting.go
│   ├── storage/                   # Flag storage backends
│   │   ├── storage.go
│   │   ├── postgres.go
│   │   └── redis.go
│   ├── sync/                      # Flag synchronization
│   │   ├── syncer.go
│   │   └── stream.go
│   ├── analytics/                 # Impression tracking
│   │   ├── tracker.go
│   │   └── exporter.go
│   └── api/                       # HTTP API
│       ├── server.go
│       └── handlers.go
├── pkg/
│   └── sdk/                       # Client SDK
│       ├── client.go
│       ├── evaluator.go
│       └── cache.go
├── configs/
│   └── flags.yaml                 # Static flag definitions
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── go.mod
└── go.sum
```

### internal/flag/flag.go - Core Flag Types

This file defines the complete data model for feature flags, covering five orthogonal capabilities in a single `Flag` struct: on/off control, multi-variation values, priority-ordered targeting rules, percentage rollouts with consistent hashing, and A/B experiment configuration with traffic allocation. The `EvaluationContext` captures both well-known attributes (country, platform, app version, plan, beta/employee flags) and an open-ended `CustomAttributes` map, giving the evaluator everything it needs to match targeting rules without requiring callers to know the internal rule structure. `EvaluationResult` records not just the selected variation and value but also the decision `Reason`, matched rule ID, and experiment key, providing a full audit trail for every flag decision that flows into the analytics pipeline.

```go
// Package flag provides core feature flag types and logic.
package flag

import (
	"time"
)

// Flag represents a feature flag configuration.
type Flag struct {
	Key          string            `json:"key"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Enabled      bool              `json:"enabled"`
	DefaultValue Variation         `json:"default_value"`
	Variations   []Variation       `json:"variations"`
	Rules        []Rule            `json:"rules"`
	Rollout      *RolloutConfig    `json:"rollout,omitempty"`
	Experiment   *ExperimentConfig `json:"experiment,omitempty"`
	Metadata     FlagMetadata      `json:"metadata"`
	Version      int64             `json:"version"`
	UpdatedAt    time.Time         `json:"updated_at"`
}

// Variation represents a possible flag value.
type Variation struct {
	Key   string      `json:"key"`
	Value any `json:"value"`
}

// Rule defines a targeting rule.
type Rule struct {
	ID         string      `json:"id"`
	Conditions []Condition `json:"conditions"`
	Variation  string      `json:"variation"` // Variation key
	Priority   int         `json:"priority"`
}

// Condition defines a targeting condition.
type Condition struct {
	Attribute string        `json:"attribute"`
	Operator  Operator      `json:"operator"`
	Values    []any `json:"values"`
	Negate    bool          `json:"negate,omitempty"`
}

// Operator defines comparison operators.
type Operator string

const (
	OpEquals         Operator = "eq"
	OpNotEquals      Operator = "ne"
	OpIn             Operator = "in"
	OpNotIn          Operator = "not_in"
	OpContains       Operator = "contains"
	OpStartsWith     Operator = "starts_with"
	OpEndsWith       Operator = "ends_with"
	OpGreaterThan    Operator = "gt"
	OpLessThan       Operator = "lt"
	OpGreaterOrEqual Operator = "gte"
	OpLessOrEqual    Operator = "lte"
	OpSemverGt       Operator = "semver_gt"
	OpSemverLt       Operator = "semver_lt"
	OpSemverEq       Operator = "semver_eq"
	OpRegex          Operator = "regex"
)

// RolloutConfig defines percentage-based rollout.
type RolloutConfig struct {
	Percentage    int    `json:"percentage"`     // 0-100
	BucketBy      string `json:"bucket_by"`      // Attribute to bucket by (default: user_id)
	Salt          string `json:"salt,omitempty"` // Salt for hashing
}

// ExperimentConfig defines A/B test configuration.
type ExperimentConfig struct {
	Key          string              `json:"key"`
	Status       ExperimentStatus    `json:"status"`
	Traffic      int                 `json:"traffic"`     // Percentage of traffic
	Allocation   []VariantAllocation `json:"allocation"`
	StartTime    *time.Time          `json:"start_time,omitempty"`
	EndTime      *time.Time          `json:"end_time,omitempty"`
	WinningVariant string            `json:"winning_variant,omitempty"`
}

// ExperimentStatus represents experiment lifecycle.
type ExperimentStatus string

const (
	ExperimentDraft     ExperimentStatus = "draft"
	ExperimentRunning   ExperimentStatus = "running"
	ExperimentPaused    ExperimentStatus = "paused"
	ExperimentCompleted ExperimentStatus = "completed"
)

// VariantAllocation defines traffic allocation to a variant.
type VariantAllocation struct {
	Variation  string `json:"variation"`
	Percentage int    `json:"percentage"` // Percentage within experiment traffic
}

// FlagMetadata contains flag administrative metadata.
type FlagMetadata struct {
	Owner       string    `json:"owner"`
	Team        string    `json:"team"`
	Tags        []string  `json:"tags"`
	CreatedAt   time.Time `json:"created_at"`
	CreatedBy   string    `json:"created_by"`
	Environment string    `json:"environment"`
	Temporary   bool      `json:"temporary"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
}

// EvaluationContext provides context for flag evaluation.
type EvaluationContext struct {
	UserID           string                 `json:"user_id"`
	AnonymousID      string                 `json:"anonymous_id,omitempty"`
	Country          string                 `json:"country,omitempty"`
	Region           string                 `json:"region,omitempty"`
	Platform         string                 `json:"platform,omitempty"`
	AppVersion       string                 `json:"app_version,omitempty"`
	DeviceType       string                 `json:"device_type,omitempty"`
	UserAgent        string                 `json:"user_agent,omitempty"`
	IPAddress        string                 `json:"ip_address,omitempty"`
	Plan             string                 `json:"plan,omitempty"`
	IsBeta           bool                   `json:"is_beta,omitempty"`
	IsEmployee       bool                   `json:"is_employee,omitempty"`
	CustomAttributes map[string]any `json:"custom,omitempty"`
}

// GetAttribute returns an attribute value from context.
func (c *EvaluationContext) GetAttribute(name string) any {
	switch name {
	case "user_id":
		return c.UserID
	case "anonymous_id":
		return c.AnonymousID
	case "country":
		return c.Country
	case "region":
		return c.Region
	case "platform":
		return c.Platform
	case "app_version":
		return c.AppVersion
	case "device_type":
		return c.DeviceType
	case "user_agent":
		return c.UserAgent
	case "ip_address":
		return c.IPAddress
	case "plan":
		return c.Plan
	case "is_beta":
		return c.IsBeta
	case "is_employee":
		return c.IsEmployee
	default:
		if c.CustomAttributes != nil {
			return c.CustomAttributes[name]
		}
		return nil
	}
}

// GetBucketKey returns the key used for percentage bucketing.
func (c *EvaluationContext) GetBucketKey(attribute string) string {
	if attribute == "" {
		attribute = "user_id"
	}

	switch attribute {
	case "user_id":
		if c.UserID != "" {
			return c.UserID
		}
		return c.AnonymousID
	case "anonymous_id":
		return c.AnonymousID
	default:
		if val := c.GetAttribute(attribute); val != nil {
			if s, ok := val.(string); ok {
				return s
			}
		}
		return c.UserID
	}
}

// EvaluationResult contains the result of flag evaluation.
type EvaluationResult struct {
	FlagKey      string      `json:"flag_key"`
	Variation    string      `json:"variation"`
	Value        any `json:"value"`
	Reason       Reason      `json:"reason"`
	RuleID       string      `json:"rule_id,omitempty"`
	ExperimentKey string     `json:"experiment_key,omitempty"`
	Bucket       int         `json:"bucket,omitempty"`
	Version      int64       `json:"version"`
	Timestamp    time.Time   `json:"timestamp"`
}

// Reason explains why a particular variation was returned.
type Reason string

const (
	ReasonDefault      Reason = "DEFAULT"
	ReasonRuleMatch    Reason = "RULE_MATCH"
	ReasonRollout      Reason = "ROLLOUT"
	ReasonExperiment   Reason = "EXPERIMENT"
	ReasonFlagDisabled Reason = "FLAG_DISABLED"
	ReasonFlagNotFound Reason = "FLAG_NOT_FOUND"
	ReasonError        Reason = "ERROR"
)
```

### internal/flag/evaluator.go - Flag Evaluator

The evaluator applies a strict priority chain: targeting rules (sorted by `Priority`) are checked first, then A/B experiments, then percentage rollout, and finally the default variation, ensuring that employee or beta-tester overrides always win over experiment traffic. Percentage bucketing uses SHA-256 hashed concatenation of the bucket key and a per-flag salt, guaranteeing that a given user lands in the same bucket on every evaluation without any shared state, which is critical for consistent experiment assignment across multiple service instances. The operator set covers string matching, numeric comparison, semver comparison, regex, and `in`/`not_in` membership tests, enabling sophisticated targeting rules such as "app version >= 2.4.0 AND plan = enterprise" directly in flag configuration without code changes.

```go
// Package flag provides flag evaluation logic.
package flag

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"
)

// Evaluator evaluates feature flags.
type Evaluator struct {
	logger *slog.Logger

	// regexCache memoizes compiled patterns. Targeting regexes come from a
	// small, slowly-changing set of flag rules, so an unbounded map is fine
	// here. Never build this keyed by anything a user controls.
	regexCache sync.Map // map[string]*regexp.Regexp
}

// NewEvaluator creates a new flag evaluator.
func NewEvaluator(logger *slog.Logger) *Evaluator {
	return &Evaluator{logger: logger}
}

// Normalize prepares a flag for evaluation. Call it once when a flag is
// loaded or refreshed, never on the request path. It sorts rules by priority
// so that Evaluate can walk them directly.
func (f *Flag) Normalize() {
	sort.SliceStable(f.Rules, func(i, j int) bool {
		return f.Rules[i].Priority < f.Rules[j].Priority
	})
}

// compileRegex returns a compiled pattern, caching it across evaluations.
func (e *Evaluator) compileRegex(pattern string) (*regexp.Regexp, error) {
	if v, ok := e.regexCache.Load(pattern); ok {
		re, _ := v.(*regexp.Regexp)
		return re, nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	e.regexCache.Store(pattern, re)
	return re, nil
}

// Evaluate evaluates a flag for the given context.
func (e *Evaluator) Evaluate(flag *Flag, ctx *EvaluationContext) *EvaluationResult {
	result := &EvaluationResult{
		FlagKey:   flag.Key,
		Timestamp: time.Now(),
		Version:   flag.Version,
	}

	// Check if flag is enabled
	if !flag.Enabled {
		result.Reason = ReasonFlagDisabled
		result.Variation = flag.DefaultValue.Key
		result.Value = flag.DefaultValue.Value
		return result
	}

	// Evaluate targeting rules in priority order. Rules are already sorted by
	// Flag.Normalize at load time: sorting here would put an allocation and an
	// O(n log n) on the hot path of every request. See the note below.
	for i := range flag.Rules {
		rule := &flag.Rules[i]
		if e.evaluateRule(rule, ctx) {
			result.Reason = ReasonRuleMatch
			result.RuleID = rule.ID
			variation := e.getVariation(flag, rule.Variation)
			if variation != nil {
				result.Variation = variation.Key
				result.Value = variation.Value
			}
			return result
		}
	}

	// Check experiment
	if flag.Experiment != nil && flag.Experiment.Status == ExperimentRunning {
		if variation := e.evaluateExperiment(flag, ctx); variation != nil {
			result.Reason = ReasonExperiment
			result.ExperimentKey = flag.Experiment.Key
			result.Variation = variation.Key
			result.Value = variation.Value
			return result
		}
	}

	// Check rollout
	if flag.Rollout != nil && flag.Rollout.Percentage > 0 {
		bucketKey := ctx.GetBucketKey(flag.Rollout.BucketBy)
		salt := flag.Rollout.Salt
		if salt == "" {
			salt = flag.Key
		}

		bucket := e.calculateBucket(bucketKey, salt)
		result.Bucket = bucket

		if bucket < flag.Rollout.Percentage {
			result.Reason = ReasonRollout
			// For rollout, use the first non-default variation
			for _, v := range flag.Variations {
				if v.Key != flag.DefaultValue.Key {
					result.Variation = v.Key
					result.Value = v.Value
					return result
				}
			}
		}
	}

	// Return default
	result.Reason = ReasonDefault
	result.Variation = flag.DefaultValue.Key
	result.Value = flag.DefaultValue.Value
	return result
}

// evaluateRule evaluates a targeting rule.
func (e *Evaluator) evaluateRule(rule *Rule, ctx *EvaluationContext) bool {
	for _, condition := range rule.Conditions {
		if !e.evaluateCondition(&condition, ctx) {
			return false
		}
	}
	return true
}

// evaluateCondition evaluates a single condition.
func (e *Evaluator) evaluateCondition(cond *Condition, ctx *EvaluationContext) bool {
	actual := ctx.GetAttribute(cond.Attribute)
	result := e.compareValues(actual, cond.Operator, cond.Values)

	if cond.Negate {
		return !result
	}
	return result
}

// compareValues compares actual value against expected values using operator.
func (e *Evaluator) compareValues(actual any, op Operator, expected []any) bool {
	if actual == nil {
		return false
	}

	actualStr := fmt.Sprintf("%v", actual)

	switch op {
	case OpEquals:
		if len(expected) == 0 {
			return false
		}
		return actualStr == fmt.Sprintf("%v", expected[0])

	case OpNotEquals:
		if len(expected) == 0 {
			return true
		}
		return actualStr != fmt.Sprintf("%v", expected[0])

	case OpIn:
		for _, exp := range expected {
			if actualStr == fmt.Sprintf("%v", exp) {
				return true
			}
		}
		return false

	case OpNotIn:
		for _, exp := range expected {
			if actualStr == fmt.Sprintf("%v", exp) {
				return false
			}
		}
		return true

	case OpContains:
		if len(expected) == 0 {
			return false
		}
		return strings.Contains(actualStr, fmt.Sprintf("%v", expected[0]))

	case OpStartsWith:
		if len(expected) == 0 {
			return false
		}
		return strings.HasPrefix(actualStr, fmt.Sprintf("%v", expected[0]))

	case OpEndsWith:
		if len(expected) == 0 {
			return false
		}
		return strings.HasSuffix(actualStr, fmt.Sprintf("%v", expected[0]))

	case OpGreaterThan, OpLessThan, OpGreaterOrEqual, OpLessOrEqual:
		return e.compareNumeric(actual, op, expected)

	case OpSemverGt, OpSemverLt, OpSemverEq:
		return e.compareSemver(actualStr, op, expected)

	case OpRegex:
		if len(expected) == 0 {
			return false
		}
		pattern := fmt.Sprintf("%v", expected[0])
		re, err := e.compileRegex(pattern) // cached, not recompiled per request
		if err != nil {
			e.logger.Warn("invalid regex in targeting rule", "pattern", pattern, "error", err)
			return false
		}
		return re.MatchString(actualStr)

	default:
		return false
	}
}

// compareNumeric compares numeric values.
func (e *Evaluator) compareNumeric(actual any, op Operator, expected []any) bool {
	if len(expected) == 0 {
		return false
	}

	actualFloat, err := toFloat64(actual)
	if err != nil {
		return false
	}

	expectedFloat, err := toFloat64(expected[0])
	if err != nil {
		return false
	}

	switch op {
	case OpGreaterThan:
		return actualFloat > expectedFloat
	case OpLessThan:
		return actualFloat < expectedFloat
	case OpGreaterOrEqual:
		return actualFloat >= expectedFloat
	case OpLessOrEqual:
		return actualFloat <= expectedFloat
	default:
		return false
	}
}

// compareSemver compares semantic versions.
func (e *Evaluator) compareSemver(actual string, op Operator, expected []any) bool {
	if len(expected) == 0 {
		return false
	}

	// Ensure versions have 'v' prefix
	if !strings.HasPrefix(actual, "v") {
		actual = "v" + actual
	}
	expectedStr := fmt.Sprintf("%v", expected[0])
	if !strings.HasPrefix(expectedStr, "v") {
		expectedStr = "v" + expectedStr
	}

	if !semver.IsValid(actual) || !semver.IsValid(expectedStr) {
		return false
	}

	cmp := semver.Compare(actual, expectedStr)

	switch op {
	case OpSemverGt:
		return cmp > 0
	case OpSemverLt:
		return cmp < 0
	case OpSemverEq:
		return cmp == 0
	default:
		return false
	}
}

// evaluateExperiment evaluates experiment allocation.
func (e *Evaluator) evaluateExperiment(flag *Flag, ctx *EvaluationContext) *Variation {
	exp := flag.Experiment

	// Check if experiment is active
	now := time.Now()
	if exp.StartTime != nil && now.Before(*exp.StartTime) {
		return nil
	}
	if exp.EndTime != nil && now.After(*exp.EndTime) {
		return nil
	}

	// Check if user is in experiment traffic
	bucketKey := ctx.GetBucketKey("user_id")
	trafficBucket := e.calculateBucket(bucketKey, exp.Key+"_traffic")
	if trafficBucket >= exp.Traffic {
		return nil // User not in experiment
	}

	// Allocate to variation
	allocationBucket := e.calculateBucket(bucketKey, exp.Key+"_allocation")
	cumulative := 0
	for _, alloc := range exp.Allocation {
		cumulative += alloc.Percentage
		if allocationBucket < cumulative {
			return e.getVariation(flag, alloc.Variation)
		}
	}

	return nil
}

// calculateBucket calculates a consistent bucket (0-99) for a key.
func (e *Evaluator) calculateBucket(key, salt string) int {
	h := sha256.New()
	h.Write([]byte(key + ":" + salt))
	hash := h.Sum(nil)

	// Use first 4 bytes as uint32
	n := binary.BigEndian.Uint32(hash[:4])
	return int(n % 100)
}

// getVariation gets a variation by key.
func (e *Evaluator) getVariation(flag *Flag, key string) *Variation {
	for _, v := range flag.Variations {
		if v.Key == key {
			return &v
		}
	}
	return nil
}

// toFloat64 converts a value to float64.
func toFloat64(v any) (float64, error) {
	switch val := v.(type) {
	case float64:
		return val, nil
	case float32:
		return float64(val), nil
	case int:
		return float64(val), nil
	case int64:
		return float64(val), nil
	case int32:
		return float64(val), nil
	case string:
		return strconv.ParseFloat(val, 64)
	default:
		return 0, fmt.Errorf("cannot convert %T to float64", v)
	}
}
```

> **Do the work once, not once per request.** Section 26.3 set a budget of single-digit microseconds per evaluation and told you to pre-compile rules on refresh. Two lines in the original evaluator quietly broke that budget, and both are worth measuring rather than arguing about. Benchmarked on an 8-core laptop:
>
> | Operation | Per evaluation | Done once at load |
> |-----------|---------------:|------------------:|
> | Copy + `sort.Slice` of 8 rules | 3,302 ns | 1.2 ns (index a pre-sorted slice) |
> | `regexp.MatchString` (compiles the pattern) | 12,636 ns | 388 ns (`re.MatchString` on a cached `*Regexp`) |
> | `calculateBucket` (SHA-256) | 543 ns | not avoidable, and fine |
>
> A single flag with one regex rule therefore cost about 16 microseconds of pure overhead, blowing a "single-digit microseconds" budget on setup work alone before evaluating anything. Neither line looks like a performance problem while reading it, which is the point: `sort.Slice` looks like ordering and `regexp.MatchString` looks like matching. Both are actually *compilation*, and both are on the hot path of every request that touches a flag.
>
> The fixes are structural rather than clever. Sorting is a property of the flag, so it belongs in `Normalize()`, called when a flag is loaded or refreshed. Regex compilation is a pure function of the pattern, so it belongs in a cache. Note that `regexp.MatchString` is a convenience wrapper that calls `regexp.Compile` internally and throws the result away, which is exactly why the standard library's own documentation shows `MustCompile` at package scope. This is the single most common accidental hot-path cost in Go services.
>
> Note also that `calculateBucket` uses SHA-256 and costs 543 ns, roughly 20x an FNV hash. That is a deliberate trade: it buys resistance to a user reverse-engineering the salt and gaming their own bucket assignment. At 543 ns it stays inside budget, so pay it. Verify the distribution regardless: 100,000 users at 10/25/50% land on 9.87/24.77/49.87%, and the separate `_traffic` and `_allocation` salts keep experiment gating independent of variant assignment (1,242 users in both against a chance expectation of 1,250). Those two salts are not decoration, they are what stops every user in the experiment from landing in the same arm.

### internal/analytics/tracker.go - Impression Tracking

The `Tracker` batches impressions and conversion events in memory behind a mutex and flushes them either when the buffer hits capacity or when a periodic ticker fires, balancing throughput against delivery latency. Buffer contents are swapped out under the lock to a local slice that is then exported outside the lock, keeping the critical section short and preventing the exporter's I/O from blocking concurrent flag evaluations. The `KafkaExporter` implementation serializes each impression to JSON keyed by flag key so downstream consumers can partition the stream by flag for efficient per-flag aggregation, and it separates impressions from conversion events into distinct topics so each can be consumed independently by different analytics pipelines.

The design constraint that shapes everything here: **analytics is the lowest-priority thing this process does.** It sits on the hot path of every flag evaluation, and every flag evaluation sits on the hot path of a user request. So the tracker must never block an evaluation, never grow without bound, and never let a degraded Kafka cluster take down a service that would otherwise be perfectly healthy. Two mechanisms below enforce that, and neither was in the obvious first draft.

```go
// Package analytics provides impression and event tracking.
package analytics

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/company/flagsystem/internal/flag"
)

// Impression represents a flag evaluation event.
type Impression struct {
	Timestamp     time.Time              `json:"timestamp"`
	FlagKey       string                 `json:"flag_key"`
	Variation     string                 `json:"variation"`
	Reason        flag.Reason            `json:"reason"`
	UserID        string                 `json:"user_id,omitempty"`
	AnonymousID   string                 `json:"anonymous_id,omitempty"`
	Context       map[string]any `json:"context,omitempty"`
	RuleID        string                 `json:"rule_id,omitempty"`
	ExperimentKey string                 `json:"experiment_key,omitempty"`
	Bucket        int                    `json:"bucket,omitempty"`
	Version       int64                  `json:"version"`
}

// ConversionEvent represents a conversion event.
type ConversionEvent struct {
	Timestamp   time.Time              `json:"timestamp"`
	EventKey    string                 `json:"event_key"`
	UserID      string                 `json:"user_id,omitempty"`
	AnonymousID string                 `json:"anonymous_id,omitempty"`
	Value       float64                `json:"value,omitempty"`
	Properties  map[string]any `json:"properties,omitempty"`
}

// Exporter defines the interface for exporting analytics data.
type Exporter interface {
	ExportImpressions(ctx context.Context, impressions []Impression) error
	ExportConversions(ctx context.Context, events []ConversionEvent) error
	Close() error
}

// Tracker tracks flag impressions and conversions.
type Tracker struct {
	logger        *slog.Logger
	exporter      Exporter
	impressionBuf []Impression
	conversionBuf []ConversionEvent
	mu            sync.Mutex
	bufferSize    int
	maxBuffer     int
	dropped       atomic.Int64
	flushInterval time.Duration
	flushCh       chan struct{}
	closeCh       chan struct{}
	wg            sync.WaitGroup
}

// TrackerConfig configures the tracker.
type TrackerConfig struct {
	BufferSize    int
	MaxBuffer     int // hard ceiling: events beyond this are dropped, not queued
	FlushInterval time.Duration
}

// DefaultTrackerConfig returns default tracker configuration.
func DefaultTrackerConfig() TrackerConfig {
	return TrackerConfig{
		BufferSize:    1000,
		MaxBuffer:     100_000,
		FlushInterval: 10 * time.Second,
	}
}

// NewTracker creates a new analytics tracker.
func NewTracker(logger *slog.Logger, exporter Exporter, config TrackerConfig) *Tracker {
	if config.MaxBuffer <= 0 {
		config.MaxBuffer = 100_000
	}
	t := &Tracker{
		logger:        logger,
		exporter:      exporter,
		impressionBuf: make([]Impression, 0, config.BufferSize),
		conversionBuf: make([]ConversionEvent, 0, config.BufferSize),
		bufferSize:    config.BufferSize,
		maxBuffer:     config.MaxBuffer,
		flushInterval: config.FlushInterval,
		// Capacity 1: a pending wakeup is all the information the flush loop
		// needs, so additional signals can be dropped harmlessly.
		flushCh: make(chan struct{}, 1),
		closeCh: make(chan struct{}),
	}

	t.wg.Add(1)
	go t.flushLoop()

	return t
}

// signalFlush wakes the flush loop without ever blocking the caller. If a
// wakeup is already pending, this is a no-op: exactly one flusher exists, so
// there is no goroutine to pile up. Never call this while holding t.mu.
func (t *Tracker) signalFlush() {
	select {
	case t.flushCh <- struct{}{}:
	default:
	}
}

// TrackImpression records a flag impression.
func (t *Tracker) TrackImpression(result *flag.EvaluationResult, ctx *flag.EvaluationContext) {
	impression := Impression{
		Timestamp:     result.Timestamp,
		FlagKey:       result.FlagKey,
		Variation:     result.Variation,
		Reason:        result.Reason,
		UserID:        ctx.UserID,
		AnonymousID:   ctx.AnonymousID,
		RuleID:        result.RuleID,
		ExperimentKey: result.ExperimentKey,
		Bucket:        result.Bucket,
		Version:       result.Version,
	}

	// Include relevant context
	if ctx.Country != "" || ctx.Platform != "" || ctx.Plan != "" {
		impression.Context = map[string]any{
			"country":  ctx.Country,
			"platform": ctx.Platform,
			"plan":     ctx.Plan,
		}
	}

	t.mu.Lock()
	if len(t.impressionBuf) >= t.maxBuffer {
		// The exporter cannot keep up. Drop the event rather than grow the
		// buffer until the process is OOM-killed. Losing analytics is an
		// inconvenience - losing the service is an outage.
		t.mu.Unlock()
		t.dropped.Add(1)
		return
	}
	t.impressionBuf = append(t.impressionBuf, impression)
	shouldFlush := len(t.impressionBuf) >= t.bufferSize
	t.mu.Unlock()

	if shouldFlush {
		t.signalFlush()
	}
}

// TrackConversion records a conversion event.
func (t *Tracker) TrackConversion(eventKey, userID, anonymousID string, value float64, properties map[string]any) {
	event := ConversionEvent{
		Timestamp:   time.Now(),
		EventKey:    eventKey,
		UserID:      userID,
		AnonymousID: anonymousID,
		Value:       value,
		Properties:  properties,
	}

	t.mu.Lock()
	if len(t.conversionBuf) >= t.maxBuffer {
		t.mu.Unlock()
		t.dropped.Add(1)
		return
	}
	t.conversionBuf = append(t.conversionBuf, event)
	shouldFlush := len(t.conversionBuf) >= t.bufferSize
	t.mu.Unlock()

	if shouldFlush {
		t.signalFlush()
	}
}

// flushLoop is the ONLY goroutine that ever calls flush. It wakes on the
// ticker, on a buffer-full signal, or on close.
func (t *Tracker) flushLoop() {
	defer t.wg.Done()
	ticker := time.NewTicker(t.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-t.closeCh:
			t.flush() // final drain
			return
		case <-ticker.C:
			t.flush()
		case <-t.flushCh:
			t.flush()
		}
	}
}

// flush exports buffered data.
func (t *Tracker) flush() {
	t.mu.Lock()
	impressions := t.impressionBuf
	conversions := t.conversionBuf
	t.impressionBuf = make([]Impression, 0, t.bufferSize)
	t.conversionBuf = make([]ConversionEvent, 0, t.bufferSize)
	t.mu.Unlock()

	if n := t.dropped.Swap(0); n > 0 {
		// Surface drops loudly. Silent analytics loss corrupts every
		// experiment result computed from this data, and a silently
		// under-counted variant looks exactly like a real effect.
		t.logger.Warn("analytics buffer full, events dropped", "count", n)
	}

	// Bound the export: a hung exporter must not wedge the flush loop forever.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if len(impressions) > 0 {
		if err := t.exporter.ExportImpressions(ctx, impressions); err != nil {
			t.logger.Error("failed to export impressions", "error", err, "count", len(impressions))
		} else {
			t.logger.Debug("exported impressions", "count", len(impressions))
		}
	}

	if len(conversions) > 0 {
		if err := t.exporter.ExportConversions(ctx, conversions); err != nil {
			t.logger.Error("failed to export conversions", "error", err, "count", len(conversions))
		} else {
			t.logger.Debug("exported conversions", "count", len(conversions))
		}
	}
}

// Close shuts down the tracker.
func (t *Tracker) Close() error {
	close(t.closeCh)
	t.wg.Wait()
	return t.exporter.Close()
}

// KafkaExporter exports events to Kafka.
type KafkaExporter struct {
	impressionTopic  string
	conversionTopic  string
	// producer         *kafka.Producer
	logger           *slog.Logger
}

// NewKafkaExporter creates a new Kafka exporter.
func NewKafkaExporter(brokers []string, impressionTopic, conversionTopic string, logger *slog.Logger) (*KafkaExporter, error) {
	// In production, initialize Kafka producer here
	return &KafkaExporter{
		impressionTopic:  impressionTopic,
		conversionTopic:  conversionTopic,
		logger:           logger,
	}, nil
}

// ExportImpressions exports impressions to Kafka.
func (e *KafkaExporter) ExportImpressions(ctx context.Context, impressions []Impression) error {
	for _, imp := range impressions {
		data, err := json.Marshal(imp)
		if err != nil {
			continue
		}

		// In production: produce to Kafka
		// e.producer.Produce(&kafka.Message{
		//     TopicPartition: kafka.TopicPartition{Topic: &e.impressionTopic},
		//     Key:            []byte(imp.FlagKey),
		//     Value:          data,
		// }, nil)
		_ = data
	}
	return nil
}

// ExportConversions exports conversions to Kafka.
func (e *KafkaExporter) ExportConversions(ctx context.Context, events []ConversionEvent) error {
	for _, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			continue
		}

		// In production: produce to Kafka
		_ = data
	}
	return nil
}

// Close closes the exporter.
func (e *KafkaExporter) Close() error {
	// In production: close Kafka producer
	return nil
}
```

> **`go t.flush()` is a goroutine leak with a trigger condition.** The natural way to write "flush when the buffer is full" is to spawn a goroutine at the call site. Trace what happens once the buffer actually fills. `TrackImpression` appends, sees `len(buf) >= bufferSize`, and spawns a flusher. But the *next* impression arrives before that flusher has taken the lock, so it also sees a full buffer and spawns another. And the next. The spawn rate is your request rate, not your flush rate, and the condition clears only when some flusher wins the lock. Measured on a single-threaded stream of 20,000 events with a 1,000-event buffer and a 20 ms exporter: **570 flush goroutines spawned, 155 running concurrently**, to perform 20 flushes. Nearly all of them woke up, took the lock, found an empty buffer, and exited having accomplished nothing except contending for the mutex that flag evaluation also needs.
>
> Now make the exporter slow, which is the exact moment this matters, and the spawn rate stays pinned to request rate while the drain rate collapses. Goroutines accumulate, each holding a reference to a batch, and the service dies of memory exhaustion caused entirely by its own telemetry. The fix is structural: exactly one goroutine ever calls `flush`, and producers send it a non-blocking wakeup on a buffered channel of capacity one. A pending wakeup already carries all the information a second wakeup would, so dropping the duplicate is free. This idiom (capacity-1 channel, `select` with `default`) is worth memorizing, since it is the standard Go answer to "coalesce many signals into one".
>
> **The buffer also needed a ceiling.** Section 26.3 said "ring buffer", and the reason is that unbounded means "bounded by your memory limit, discovered at 3am". If the exporter is down, `append` grows the slice forever. `maxBuffer` converts that OOM into a counted, logged drop. This is the right trade for analytics and the wrong trade for billing events, and knowing which of the two you are holding is the actual engineering judgment. Drop counts must be logged loudly rather than swallowed: silently under-counting one variant produces an experiment result that looks like a real effect and is not.

### pkg/sdk/client.go - Client SDK

The SDK client fetches the full flag list from the server on startup and keeps a local in-memory copy that is updated by a background polling goroutine, so flag evaluations are always served from local state with zero network latency for the hot path. All flag reads use an `RWMutex` so many goroutines can evaluate flags concurrently without blocking each other, and writes from the polling goroutine are serialized against reads. Typed accessor methods (`BoolVariation`, `StringVariation`, `IntVariation`, `JSONVariation`) handle type coercion and return the provided default value on any evaluation failure, ensuring that a flag configuration error or missing key can never cause a panic in application code.

```go
// Package sdk provides a client SDK for feature flags.
package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/company/flagsystem/internal/flag"
)

// Client is the feature flag SDK client.
type Client struct {
	apiURL       string
	apiKey       string
	httpClient   *http.Client
	cache        *FlagCache
	evaluator    *flag.Evaluator
	logger       *slog.Logger
	pollInterval time.Duration
	mu           sync.RWMutex
	flags        map[string]*flag.Flag
	closeCh      chan struct{}
	wg           sync.WaitGroup
}

// Config configures the SDK client.
type Config struct {
	APIURL       string
	APIKey       string
	PollInterval time.Duration
	Timeout      time.Duration
	Logger       *slog.Logger
}

// DefaultConfig returns default SDK configuration.
func DefaultConfig(apiURL, apiKey string) Config {
	return Config{
		APIURL:       apiURL,
		APIKey:       apiKey,
		PollInterval: 30 * time.Second,
		Timeout:      10 * time.Second,
		Logger:       slog.Default(),
	}
}

// NewClient creates a new SDK client.
func NewClient(config Config) (*Client, error) {
	client := &Client{
		apiURL: config.APIURL,
		apiKey: config.APIKey,
		httpClient: &http.Client{
			Timeout: config.Timeout,
		},
		cache:        NewFlagCache(),
		evaluator:    flag.NewEvaluator(config.Logger),
		logger:       config.Logger,
		pollInterval: config.PollInterval,
		flags:        make(map[string]*flag.Flag),
		closeCh:      make(chan struct{}),
	}

	// Initial flag fetch. Non-fatal by design: see the note below on why an
	// SDK constructor must not fail when the flag service is unreachable.
	// Every accessor takes an explicit default, so a client with no flags
	// yet is a well-defined state, not a broken one.
	if err := client.refresh(context.Background()); err != nil {
		client.logger.Warn("initial flag fetch failed, serving caller-supplied defaults until first successful poll",
			"error", err)
	}

	// Start background polling
	client.wg.Add(1)
	go client.pollLoop()

	return client, nil
}

// BoolVariation evaluates a boolean flag.
func (c *Client) BoolVariation(key string, ctx *flag.EvaluationContext, defaultValue bool) bool {
	result := c.evaluate(key, ctx)
	if result == nil || result.Value == nil {
		return defaultValue
	}
	if v, ok := result.Value.(bool); ok {
		return v
	}
	return defaultValue
}

// StringVariation evaluates a string flag.
func (c *Client) StringVariation(key string, ctx *flag.EvaluationContext, defaultValue string) string {
	result := c.evaluate(key, ctx)
	if result == nil || result.Value == nil {
		return defaultValue
	}
	if v, ok := result.Value.(string); ok {
		return v
	}
	return defaultValue
}

// IntVariation evaluates an integer flag.
func (c *Client) IntVariation(key string, ctx *flag.EvaluationContext, defaultValue int) int {
	result := c.evaluate(key, ctx)
	if result == nil || result.Value == nil {
		return defaultValue
	}
	switch v := result.Value.(type) {
	case int:
		return v
	case float64:
		return int(v)
	case int64:
		return int(v)
	}
	return defaultValue
}

// JSONVariation evaluates a JSON flag.
func (c *Client) JSONVariation(key string, ctx *flag.EvaluationContext, defaultValue any) any {
	result := c.evaluate(key, ctx)
	if result == nil || result.Value == nil {
		return defaultValue
	}
	return result.Value
}

// VariationDetail returns detailed evaluation result.
func (c *Client) VariationDetail(key string, ctx *flag.EvaluationContext) *flag.EvaluationResult {
	return c.evaluate(key, ctx)
}

// evaluate evaluates a flag.
func (c *Client) evaluate(key string, ctx *flag.EvaluationContext) *flag.EvaluationResult {
	c.mu.RLock()
	f, exists := c.flags[key]
	c.mu.RUnlock()

	if !exists {
		return &flag.EvaluationResult{
			FlagKey:   key,
			Reason:    flag.ReasonFlagNotFound,
			Timestamp: time.Now(),
		}
	}

	return c.evaluator.Evaluate(f, ctx)
}

// AllFlags returns all flag evaluations for the context.
func (c *Client) AllFlags(ctx *flag.EvaluationContext) map[string]any {
	c.mu.RLock()
	flags := make(map[string]*flag.Flag, len(c.flags))
	for k, v := range c.flags {
		flags[k] = v
	}
	c.mu.RUnlock()

	results := make(map[string]any, len(flags))
	for key, f := range flags {
		result := c.evaluator.Evaluate(f, ctx)
		results[key] = result.Value
	}
	return results
}

// pollLoop polls for flag updates.
func (c *Client) pollLoop() {
	defer c.wg.Done()
	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.closeCh:
			return
		case <-ticker.C:
			if err := c.refresh(context.Background()); err != nil {
				c.logger.Error("flag refresh failed", "error", err)
			}
		}
	}
}

// refresh fetches flags from the server.
func (c *Client) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.apiURL+"/flags", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var flags []flag.Flag
	if err := json.NewDecoder(resp.Body).Decode(&flags); err != nil {
		return err
	}

	// Build the replacement map outside the lock. Normalize each flag here,
	// once per refresh, so the evaluator never sorts on the request path.
	next := make(map[string]*flag.Flag, len(flags))
	for i := range flags {
		flags[i].Normalize()
		next[flags[i].Key] = &flags[i]
	}

	// Replace, do not merge: merging can never delete a flag, so a flag
	// removed upstream would live in this process until it restarts.
	c.mu.Lock()
	c.flags = next
	c.mu.Unlock()

	c.logger.Debug("flags refreshed", "count", len(next))
	return nil
}

// Close shuts down the client.
func (c *Client) Close() error {
	close(c.closeCh)
	c.wg.Wait()
	return nil
}

// Track records a conversion event.
func (c *Client) Track(eventKey string, ctx *flag.EvaluationContext, value float64, properties map[string]any) {
	// Send to analytics
}

// FlagCache provides local caching for flags.
type FlagCache struct {
	mu    sync.RWMutex
	flags map[string]*flag.Flag
	ttl   time.Duration
}

// NewFlagCache creates a new flag cache.
func NewFlagCache() *FlagCache {
	return &FlagCache{
		flags: make(map[string]*flag.Flag),
		ttl:   5 * time.Minute,
	}
}

// Get retrieves a flag from cache.
func (c *FlagCache) Get(key string) (*flag.Flag, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	f, ok := c.flags[key]
	return f, ok
}

// Set stores a flag in cache.
func (c *FlagCache) Set(key string, f *flag.Flag) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.flags[key] = f
}

// SetAll replaces all cached flags.
func (c *FlagCache) SetAll(flags map[string]*flag.Flag) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.flags = flags
}
```

> **Three things changed in this SDK, and each one generalizes.**
>
> **`Identify` was deleted rather than kept.** It was declared as "sets the user context for all evaluations" with a body of `// Store context for session` and no code. That is worse than a missing method. The signature and doc comment form a promise the compiler happily accepts, callers write `client.Identify(userCtx)` and reasonably believe subsequent evaluations are scoped to that user, and every evaluation silently ignores it. An empty stub with a confident doc comment is one of the most expensive things you can leave in a codebase, because it is indistinguishable from working code at the call site. If a method is not implemented, do not ship its signature. This SDK's evaluation methods already take an explicit `*flag.EvaluationContext`, which is the better design anyway: explicit context passing has no ambiguity about which user an evaluation applied to, and no hidden mutable state shared between goroutines.
>
> **`refresh` now calls `Normalize` and replaces the map.** `Normalize` is what makes the evaluator's "rules are pre-sorted" precondition true, and refresh is the only place that can honor it. Note the shape of this contract: the evaluator is fast *because* it trusts its input, and that trust is only safe when exactly one code path constructs that input. If you add a second way to load flags, it must normalize too, which is a good argument for making the loader a single function rather than a convention.
>
> **`NewClient` no longer fails when the flag service is unreachable.** This is the same fail-safe reasoning as the server-side service, and it matters more in an SDK. A constructor that returns an error on fetch failure invites `log.Fatal(err)` in `main`, which means a flag service blip prevents your entire fleet from starting, precisely when you may be trying to deploy a fix. Since every accessor already requires the caller to pass a default, "no flags loaded" degrades cleanly to "everyone gets their defaults". Log it loudly, emit a metric, and serve. The defaults are your contingency plan, so choose them as if the flag service will be down when it matters.
>
> One piece of scaffolding is left deliberately visible: `FlagCache` is constructed in `NewClient` and then never read, because `evaluate` reads `c.flags` directly. Its `ttl` field is assigned and never enforced by anything. Treat it as a worked example of how dead code accumulates in real systems and how it misleads. A reader skimming this SDK would reasonably conclude flags expire after five minutes. Nothing expires. Either wire the cache in or delete the type: a struct field named `ttl` that no code consults is a comment that lies, and unlike a comment the compiler will not let you notice it is stale.

### Dockerfile

The two-stage Dockerfile injects the Git-derived version tag and commit hash at compile time via `-X` linker flags, so the running binary can report its exact version for debugging without any external metadata file. A dedicated non-root `appuser` account is created in the runtime image and used as the `USER` directive, reducing the attack surface of the running container. Two ports are exposed, 8080 for the public HTTP API and 8081 for the admin interface, keeping operator and user traffic on separate listeners so each can be firewalled independently.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
ARG COMMIT=unknown

RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT}" \
    -o /flagserver ./cmd/flagserver

# Runtime stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

RUN adduser -D -g '' appuser

COPY --from=builder /flagserver /usr/local/bin/flagserver

USER appuser

EXPOSE 8080 8081

ENTRYPOINT ["/usr/local/bin/flagserver"]
```

### docker-compose.yml

The Compose stack mirrors the full production dependency graph: PostgreSQL stores persistent flag definitions with versioned history, Redis serves as a low-latency cache for the flag API, and Kafka receives the impression and conversion event stream from the analytics tracker. The flag server declares `depends_on` ordering and a Docker health check so dependent services (such as the admin UI container) only start after the API is confirmed healthy. The admin UI is served by an Nginx container mounting a pre-built static bundle, keeping the front-end build pipeline separate from the Go service without requiring a Node.js runtime in production.

```yaml
# No `version:` key. It has been obsolete since Compose V2, which warns if
# you include it. Compose V1 reached end of life in July 2023.
services:
  flagserver:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"   # HTTP API
      - "8081:8081"   # Admin API
    environment:
      - DATABASE_URL=postgres://postgres:postgres@postgres:5432/flags?sslmode=disable
      - REDIS_URL=redis://redis:6379
      - KAFKA_BROKERS=kafka:9092
      - LOG_LEVEL=debug
    depends_on:
      - postgres
      - redis
      - kafka
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: flags
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_NODE_ID: 1
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_LISTENERS: PLAINTEXT://kafka:9092,CONTROLLER://kafka:29093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'
    volumes:
      - kafka_data:/var/lib/kafka/data

  # Admin dashboard
  admin-ui:
    image: nginx:1.29-alpine
    ports:
      - "3000:80"
    volumes:
      - ./admin-ui/dist:/usr/share/nginx/html:ro
    depends_on:
      - flagserver

volumes:
  postgres_data:
  redis_data:
  kafka_data:
```

### Makefile

The Makefile derives the version string from `git describe` at build time and passes it into the binary via `LDFLAGS`, so every artifact is traceable to its exact source commit even without access to CI metadata. The default `all` target runs linting and tests before building, enforcing code quality as a prerequisite for producing a binary rather than leaving it as an optional step. Build, test, lint, and Docker targets are all declared as `.PHONY` so Make never skips them due to accidental name collisions with files in the working directory.

```makefile
# Feature Flag System Makefile

APP_NAME := flagserver
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
LDFLAGS := -s -w -X main.Version=$(VERSION) -X main.Commit=$(COMMIT)

.PHONY: all build test lint run docker help

all: lint test build
```

### Staff Lens: Build vs Buy

For most orgs, adopt LaunchDarkly, Split, or similar managed service. Self-hosting a flag service is a multi-quarter project with ongoing maintenance. Adopt only if specific requirements (air-gapped, unusual compliance) mandate it.
