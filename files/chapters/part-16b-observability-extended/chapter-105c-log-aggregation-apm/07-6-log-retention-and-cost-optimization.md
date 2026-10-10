## 105C.7 Log Retention and Cost Optimization

Log storage costs grow proportionally with ingestion volume, making tiered retention policies essential for production observability budgets. The approach below differentiates between security audit logs (kept roughly two years for compliance), error logs (one year), and info and debug logs (two weeks), and automates tier transitions and deletion by generating and applying Elasticsearch ILM (Index Lifecycle Management) policies. Understanding what to keep and for how long prevents both runaway storage costs and compliance gaps from premature deletion.

```go
package logretention

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// RetentionPolicy defines how long to keep different log types
type RetentionPolicy struct {
	Tiers []RetentionTier
}

// RetentionTier represents a storage tier with retention settings
type RetentionTier struct {
	Name          string
	QueryPattern  string // e.g., "log.level:ERROR"
	HotDays       int    // Days in hot (fast, expensive) storage
	WarmDays      int    // Days in warm storage
	ColdDays      int    // Days in cold (slow, cheap) storage
	DeleteAfterDays int  // Total retention period
}

// DefaultRetentionPolicy returns sensible defaults
func DefaultRetentionPolicy() RetentionPolicy {
	return RetentionPolicy{
		Tiers: []RetentionTier{
			{
				Name:            "errors",
				QueryPattern:    "log.level:error OR log.level:critical",
				HotDays:         30,
				WarmDays:        60,
				ColdDays:        275,
				DeleteAfterDays: 365,
			},
			{
				Name:            "security-audit",
				QueryPattern:    "event.audit:true",
				HotDays:         30,
				WarmDays:        90,
				ColdDays:        640,
				DeleteAfterDays: 760, // 2 years + buffer
			},
			{
				Name:            "info-debug",
				QueryPattern:    "log.level:info OR log.level:debug",
				HotDays:         3,
				WarmDays:        7,
				ColdDays:        0, // No cold storage
				DeleteAfterDays: 14,
			},
		},
	}
}

// ILMPolicy represents an Elasticsearch Index Lifecycle Management policy
type ILMPolicy struct {
	Policy ILMPolicyConfig `json:"policy"`
}

// ILMPolicyConfig holds ILM configuration
type ILMPolicyConfig struct {
	Phases map[string]ILMPhase `json:"phases"`
}

// ILMPhase represents an ILM lifecycle phase
type ILMPhase struct {
	MinAge  string          `json:"min_age,omitempty"`
	Actions map[string]any `json:"actions"`
}

// GenerateILMPolicy generates an Elasticsearch ILM policy
func GenerateILMPolicy(tier RetentionTier) ILMPolicy {
	phases := map[string]ILMPhase{
		"hot": {
			Actions: map[string]any{
				"rollover": map[string]any{
					"max_size": "50gb",
					"max_age":  "1d",
				},
				"set_priority": map[string]any{
					"priority": 100,
				},
			},
		},
	}

	if tier.WarmDays > 0 {
		phases["warm"] = ILMPhase{
			MinAge: fmt.Sprintf("%dd", tier.HotDays),
			Actions: map[string]any{
				"shrink": map[string]any{
					"number_of_shards": 1,
				},
				"forcemerge": map[string]any{
					"max_num_segments": 1,
				},
				"set_priority": map[string]any{
					"priority": 50,
				},
			},
		}
	}

	if tier.ColdDays > 0 {
		phases["cold"] = ILMPhase{
			MinAge: fmt.Sprintf("%dd", tier.HotDays+tier.WarmDays),
			Actions: map[string]any{
				"readonly": map[string]any{},
				"set_priority": map[string]any{
					"priority": 0,
				},
			},
		}
	}

	phases["delete"] = ILMPhase{
		MinAge: fmt.Sprintf("%dd", tier.DeleteAfterDays),
		Actions: map[string]any{
			"delete": map[string]any{},
		},
	}

	return ILMPolicy{
		Policy: ILMPolicyConfig{Phases: phases},
	}
}

// ApplyILMPolicy applies an ILM policy to Elasticsearch
func ApplyILMPolicy(ctx context.Context, esURL, policyName string, policy ILMPolicy) error {
	body, err := json.Marshal(policy)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		fmt.Sprintf("%s/_ilm/policy/%s", esURL, policyName),
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("ILM policy apply failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ILM error %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// LogVolumeSampler implements adaptive log sampling to control costs
type LogVolumeSampler struct {
	targetRatePerSecond float64
	windowSize          time.Duration
	mu                  sync.RWMutex
	counters            map[string]*rateCounter
}

type rateCounter struct {
	count     int64
	windowStart time.Time
}

// NewLogVolumeSampler creates a volume-based sampler
func NewLogVolumeSampler(targetRatePerSecond float64) *LogVolumeSampler {
	return &LogVolumeSampler{
		targetRatePerSecond: targetRatePerSecond,
		windowSize:          time.Second,
		counters:            make(map[string]*rateCounter),
	}
}

// ShouldLog determines if a log entry should be emitted
func (s *LogVolumeSampler) ShouldLog(service, level string) bool {
	// Always log errors
	if level == "error" || level == "critical" {
		return true
	}

	key := service + ":" + level

	s.mu.Lock()
	defer s.mu.Unlock()

	counter, exists := s.counters[key]
	now := time.Now()

	if !exists || now.Sub(counter.windowStart) > s.windowSize {
		s.counters[key] = &rateCounter{
			count:       1,
			windowStart: now,
		}
		return true
	}

	counter.count++
	rate := float64(counter.count) / s.windowSize.Seconds()

	if rate > s.targetRatePerSecond {
		// Sample: allow 1 in N
		sampleN := int(rate / s.targetRatePerSecond)
		return counter.count%int64(sampleN) == 0
	}

	return true
}
```

### Junior → FAANG: Log Retention Is a Business and Compliance Decision

Log retention is not just a cost question: it is a compliance question. GDPR requires that personal data not be retained longer than necessary. PCI DSS requires that certain logs be retained for at least 1 year. SOC 2 requires log retention sufficient to reconstruct security events. The retention policy must be set with input from legal and compliance, not just engineering.

For a first job, understand the retention policy for the services you work on and why it is set at that duration. "We retain logs for 90 days because it matches our security incident response SLA and our compliance requirement" is a more defensible policy than "90 days because that's what we've always done."

### Senior @ FAANG: Tiered Retention as a Cost Architecture

**ILM tiering.** Elasticsearch Index Lifecycle Management (ILM) and Loki's retention rules enable tiered storage: hot storage (fast NVMe, expensive) for recent logs queried frequently during incidents, warm storage (slower SSD, cheaper) for logs queried occasionally during investigations, and cold storage (object storage, very cheap) for compliance archive logs that are never queried but must be retained.

The tiering thresholds and costs depend on the log query patterns. An L6 engineer analyzes query patterns (what percentage of queries access logs older than 7 days? 30 days? 90 days?) to calibrate tier boundaries. If 95% of queries access logs less than 7 days old, moving logs to warm storage after 7 days has minimal query impact while significantly reducing storage cost.

**Log volume budgeting.** At FAANG scale, log volume is a line item in the engineering budget. An L6 engineer sets per-service log volume budgets (bytes per second), monitors actual volume against budget using Fluent Bit metrics, and alerts when a service exceeds its budget. Exceeding the budget triggers a review: was it a traffic spike (expected), a logging verbosity regression (must be fixed), or a new service deployment that was not budgeted for (must be planned for)?

---
