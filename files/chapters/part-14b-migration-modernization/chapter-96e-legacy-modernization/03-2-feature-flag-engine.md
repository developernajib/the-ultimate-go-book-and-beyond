## 2. Feature Flag Engine

Feature flags are the control plane for migration. They allow traffic shifting without deployments and instant rollback without code changes. A feature flag engine evaluates whether a given request should be routed to the new service or the legacy one. The engine supports multiple rollout strategies: you can enable the new service for specific user IDs (allowlist), for a deterministic percentage of all users (percentage rollout), or for everyone at once. Deterministic hashing ensures that the same user always lands on the same side of the split, preventing inconsistent behavior across requests. The flag configuration can be updated at runtime without restarting the proxy, which is what makes sub-minute rollback possible.

```go
// file: internal/featureflags/engine.go
package featureflags

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// FlagName is a typed string for feature flag names.
type FlagName string

const (
	FlagNewUserService  FlagName = "new_user_service"
	FlagNewOrderService FlagName = "new_order_service"
	FlagDualWriteUsers  FlagName = "dual_write_users"
	FlagShadowMode      FlagName = "shadow_mode_users"
)

// RolloutStrategy defines how traffic is distributed.
type RolloutStrategy string

const (
	StrategyPercentage  RolloutStrategy = "percentage"
	StrategyUserID      RolloutStrategy = "user_id_hash"
	StrategyCanary      RolloutStrategy = "canary"
	StrategyAllOn       RolloutStrategy = "all_on"
	StrategyAllOff      RolloutStrategy = "all_off"
)

// Flag defines a single feature flag configuration.
type Flag struct {
	Name       FlagName        `json:"name"`
	Enabled    bool            `json:"enabled"`
	Strategy   RolloutStrategy `json:"strategy"`
	Percentage float64         `json:"percentage"` // 0.0 - 100.0
	Allowlist  []string        `json:"allowlist"`  // specific entity IDs always enabled
	Denylist   []string        `json:"denylist"`   // specific entity IDs always disabled
	UpdatedAt  time.Time       `json:"updated_at"`
}

// contextKey avoids collisions in context values.
type contextKey string

const entityIDKey contextKey = "entity_id"

// WithEntityID injects an entity ID into context for flag evaluation.
func WithEntityID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, entityIDKey, id)
}

// EntityIDFromContext extracts the entity ID from context.
func EntityIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(entityIDKey).(string)
	return id, ok
}

// Engine evaluates feature flags.
type Engine struct {
	mu      sync.RWMutex
	flags   map[FlagName]*Flag
	logger  *slog.Logger
	metrics MetricsRecorder
	version atomic.Int64
}

// MetricsRecorder records flag evaluation metrics.
type MetricsRecorder interface {
	RecordFlagEvaluation(flag FlagName, result bool, strategy RolloutStrategy)
}

// NewEngine creates an Engine pre-loaded from a config file path.
func NewEngine(configPath string, logger *slog.Logger, metrics MetricsRecorder) (*Engine, error) {
	e := &Engine{
		flags:   make(map[FlagName]*Flag),
		logger:  logger,
		metrics: metrics,
	}
	if err := e.loadFromFile(configPath); err != nil {
		return nil, fmt.Errorf("feature flag engine: load config: %w", err)
	}
	return e, nil
}

// IsEnabled evaluates whether a flag is enabled for the entity in context.
func (e *Engine) IsEnabled(ctx context.Context, name FlagName) bool {
	e.mu.RLock()
	flag, ok := e.flags[name]
	e.mu.RUnlock()

	if !ok || !flag.Enabled {
		if e.metrics != nil {
			e.metrics.RecordFlagEvaluation(name, false, StrategyAllOff)
		}
		return false
	}

	entityID, _ := EntityIDFromContext(ctx)
	result := e.evaluate(flag, entityID)

	if e.metrics != nil {
		e.metrics.RecordFlagEvaluation(name, result, flag.Strategy)
	}

	e.logger.Debug("feature flag evaluated",
		"flag", name,
		"entity_id", entityID,
		"result", result,
		"strategy", flag.Strategy,
	)

	return result
}

// evaluate applies the rollout strategy for a given entity.
func (e *Engine) evaluate(flag *Flag, entityID string) bool {
	// Denylist always wins.
	for _, id := range flag.Denylist {
		if id == entityID {
			return false
		}
	}

	// Allowlist overrides percentage.
	for _, id := range flag.Allowlist {
		if id == entityID {
			return true
		}
	}

	switch flag.Strategy {
	case StrategyAllOn:
		return true
	case StrategyAllOff:
		return false
	case StrategyPercentage:
		return e.percentageRollout(flag.Name, entityID, flag.Percentage)
	case StrategyUserID:
		return e.hashRollout(flag.Name, entityID, flag.Percentage)
	case StrategyCanary:
		return e.hashRollout(flag.Name, entityID, flag.Percentage)
	default:
		return false
	}
}

// percentageRollout uses a deterministic hash for sticky assignment.
func (e *Engine) percentageRollout(name FlagName, entityID string, pct float64) bool {
	return e.hashRollout(name, entityID, pct)
}

// hashRollout deterministically assigns an entity to a bucket using SHA-256.
// This ensures the same entity always gets the same result (sticky rollout).
func (e *Engine) hashRollout(name FlagName, entityID string, pct float64) bool {
	key := fmt.Sprintf("%s:%s", name, entityID)
	h := sha256.Sum256([]byte(key))
	// Take first 8 bytes as a uint64.
	var n big.Int
	n.SetBytes(h[:8])
	bucket := new(big.Float).SetInt(&n)
	max := new(big.Float).SetUint64(^uint64(0))
	ratio, _ := new(big.Float).Quo(bucket, max).Float64()
	return ratio*100.0 < pct
}

// UpdateFlag atomically updates a single flag without full reload.
func (e *Engine) UpdateFlag(flag *Flag) {
	e.mu.Lock()
	defer e.mu.Unlock()
	flag.UpdatedAt = time.Now()
	e.flags[flag.Name] = flag
	e.version.Add(1)
	e.logger.Info("feature flag updated",
		"flag", flag.Name,
		"strategy", flag.Strategy,
		"percentage", flag.Percentage,
		"enabled", flag.Enabled,
	)
}

// loadFromFile reads flag configuration from JSON.
func (e *Engine) loadFromFile(path string) error {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read flag config: %w", err)
	}
	var flags []*Flag
	if err := json.Unmarshal(data, &flags); err != nil {
		return fmt.Errorf("parse flag config: %w", err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, f := range flags {
		e.flags[f.Name] = f
	}
	return nil
}

// GetAll returns a snapshot of all flags (for admin/debug endpoints).
func (e *Engine) GetAll() []*Flag {
	e.mu.RLock()
	defer e.mu.RUnlock()
	result := make([]*Flag, 0, len(e.flags))
	for _, f := range e.flags {
		cp := *f
		result = append(result, &cp)
	}
	return result
}
```

### Junior → FAANG: Feature Flags as a First-Class Engineering Tool

Feature flags are one of the most powerful tools available to an engineer who understands them and one of the most misused tools for engineers who don't. The critical insight in this implementation: the flag evaluation is deterministic for a given entity ID. The same user always lands on the same side of the split. This determinism is essential for migration because it prevents the same user from experiencing inconsistent behavior across requests, which would be far more disruptive than routing them consistently to the legacy system.

The percentage-based rollout uses a hash rather than a random number, which is a subtle but critical design choice. Random numbers would route the same user differently on each request. Hashing the entity ID produces a consistent result, but without requiring the flag engine to store which users it has already routed.

For early-career engineers: the feature flag engine in this implementation is simplified for clarity. Production flag engines at FAANG companies are complex systems with their own storage, SDK clients in multiple languages, analytics, experimentation frameworks, and audit logging. Treat this implementation as an educational model, not a production template.

### Senior @ FAANG: Feature Flag Governance at Scale and the Migration Control Plane

At senior level, the feature flag engine is the primary control plane for the entire migration. Every decision about traffic allocation, rollback, and progressive rollout goes through this system. Its availability, consistency, and observability directly determine the safety of the migration.

The governance requirements for a production migration flag engine: flag updates must propagate to all proxy instances within a bounded time window (typically sub-second for safety-critical migrations). The flag store must have higher availability than the services it controls (if the flag store goes down, the proxy must have a safe degradation behavior). Every flag evaluation must be logged with the entity ID, the flag values, and the routing decision, creating an audit trail for incident investigations.

The specific design question that distinguishes senior flag engine design from junior flag engine design: what happens when the flag store is unavailable and the proxy cannot evaluate a flag. The implementation must choose between fail-open (route to legacy, safer) and fail-closed (return an error, safer from new-service exposure perspective). This is an explicit architectural decision that belongs in the ADR, not a default behavior discovered during an incident.

---
