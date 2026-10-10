## Section 5: A/B Testing Framework

### 5.0 Statistical Foundations You Cannot Skip

Before any code, four rules that distinguish a valid experiment from a false-positive factory:

1. **Stable hash bucketing**. Assignment must be deterministic per (userID, experimentName). Random assignment on every request flips users between variants and invalidates the experiment. Use a cryptographic hash (SHA-256, xxhash) of `userID + salt + experimentName`, then map into `[0, 1)` by treating the first 8 bytes as a uint64 and dividing by `math.MaxUint64`.
2. **Minimum sample size, pre-computed**. Before starting the experiment, compute required N from the minimum detectable effect (MDE), baseline conversion rate, α (typically 0.05), and power (typically 0.8). For a 5% baseline with a 10% relative lift MDE, you need roughly 31,000 users per arm. Tools: Evan Miller's sample size calculator, Optimizely's built-in planner, or the `github.com/montanaflynn/stats` package.
3. **No peeking**. Checking p-value repeatedly and stopping as soon as p < 0.05 inflates the type-I error rate from 5% to 30%+. Either fix N up front and analyze once, or use a **sequential testing** method that corrects for continuous monitoring: Always Valid Inference (Johari et al., used by Optimizely), mSPRT (used by Netflix), or group sequential designs with alpha-spending functions. GrowthBook and Statsig ship sequential-testing out of the box.
4. **Sample Ratio Mismatch (SRM) check**. If a 50/50 experiment reports 52/48 actual traffic, a bug is biasing assignment or event logging. SRM should be monitored continuously. Any p < 0.001 on a chi-square test against the intended split invalidates the experiment until you find the cause.

### 5.1 Experiment Framework

An A/B experiment framework assigns each user to a control or treatment group, tracks metric events per group, and computes the statistical significance of any observed difference. Note *assigns*, not *randomly assigns on each request*: per rule 1 above, assignment is a deterministic hash of the user and the experiment, so a returning user always lands in the same arm. Randomising per request would flip users between variants and destroy the experiment.

Unlike feature flags, which simply target a known audience, A/B experiments demand statistical design: a pre-computed sample size, pre-registered metrics, and a fixed analysis point. The framework below implements hash-based assignment, counts assignments and conversions per arm, and exposes an `Analyze` method that returns per-variant conversion rates, uplift, and a two-sided significance verdict.

```go
package abtest

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
)

// Experiment defines an A/B test.
type Experiment struct {
	Name     string
	Variants []Variant
	Metric   string // primary metric to optimize
}

// Variant is one arm of an A/B test.
type Variant struct {
	Name   string
	Weight float64 // relative weight (e.g., 50/50 or 80/20)
}

// Assignment records which variant a user is in.
type Assignment struct {
	UserID     string
	Experiment string
	Variant    string
}

// ExperimentResult holds statistical analysis of A/B test data.
type ExperimentResult struct {
	Experiment   string
	Variants     []VariantStats
	Winner       string
	Confidence   float64
	Significant  bool
}

// VariantStats tracks metrics for one variant.
type VariantStats struct {
	Name         string
	Assignments  int64
	Conversions  int64
	ConversionRate float64
	Uplift       float64 // vs control
}

// ExperimentEngine manages A/B test assignments and analysis.
type ExperimentEngine struct {
	experiments  map[string]*Experiment
	assignments  sync.Map // userID+experiment → Variant
	conversions  sync.Map // userID+experiment+metric → bool
	counts       sync.Map // experiment+variant → *counter
	mu           sync.RWMutex
}

type counter struct {
	assigned   atomic.Int64
	converted  atomic.Int64
}

func NewExperimentEngine() *ExperimentEngine {
	return &ExperimentEngine{
		experiments: make(map[string]*Experiment),
	}
}

// RegisterExperiment adds an experiment to the engine.
func (e *ExperimentEngine) RegisterExperiment(exp *Experiment) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.experiments[exp.Name] = exp
}

// Assign returns the variant for a user in an experiment.
// Assignment is sticky: same user always gets same variant.
func (e *ExperimentEngine) Assign(userID, experimentName string) (string, error) {
	key := userID + ":" + experimentName

	// Check sticky assignment
	if v, ok := e.assignments.Load(key); ok {
		return v.(string), nil
	}

	e.mu.RLock()
	exp, ok := e.experiments[experimentName]
	e.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("experiment %q not found", experimentName)
	}

	// Stable assignment based on user ID hash
	variant := e.assignVariant(userID, experimentName, exp.Variants)
	e.assignments.LoadOrStore(key, variant)

	// Track assignment
	cKey := experimentName + ":" + variant
	v, _ := e.counts.LoadOrStore(cKey, &counter{})
	v.(*counter).assigned.Add(1)

	return variant, nil
}

func (e *ExperimentEngine) assignVariant(userID, expName string, variants []Variant) string {
	// Hash user+experiment for stable assignment
	h := sha256.New()
	fmt.Fprintf(h, "%s:%s", userID, expName)
	hashBytes := h.Sum(nil)
	hashFloat := float64(binary.BigEndian.Uint64(hashBytes[:8])) / float64(math.MaxUint64)

	// Weighted assignment: map hashFloat into [0, totalWeight) and
	// pick the variant whose cumulative weight bucket contains target.
	totalWeight := 0.0
	for _, v := range variants {
		totalWeight += v.Weight
	}
	target := hashFloat * totalWeight
	cumulative := 0.0
	for _, v := range variants {
		cumulative += v.Weight
		if target <= cumulative {
			return v.Name
		}
	}
	return variants[len(variants)-1].Name
}

// RecordConversion records a conversion event for a user.
func (e *ExperimentEngine) RecordConversion(userID, experimentName, metricName string) error {
	variant, err := e.Assign(userID, experimentName)
	if err != nil {
		return err
	}

	convKey := fmt.Sprintf("%s:%s:%s:%s", userID, experimentName, metricName, variant)
	if _, loaded := e.conversions.LoadOrStore(convKey, true); loaded {
		return nil // already recorded
	}

	cKey := experimentName + ":" + variant
	if v, ok := e.counts.Load(cKey); ok {
		v.(*counter).converted.Add(1)
	}
	return nil
}

// Analyze computes statistical significance using two-proportion z-test.
func (e *ExperimentEngine) Analyze(experimentName string) (*ExperimentResult, error) {
	e.mu.RLock()
	exp, ok := e.experiments[experimentName]
	e.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("experiment %q not found", experimentName)
	}

	result := &ExperimentResult{Experiment: experimentName}
	var controlStats *VariantStats

	for i, variant := range exp.Variants {
		cKey := experimentName + ":" + variant.Name
		var assigned, converted int64

		if v, ok := e.counts.Load(cKey); ok {
			c := v.(*counter)
			assigned = c.assigned.Load()
			converted = c.converted.Load()
		}

		stats := VariantStats{
			Name:        variant.Name,
			Assignments: assigned,
			Conversions: converted,
		}
		if assigned > 0 {
			stats.ConversionRate = float64(converted) / float64(assigned)
		}
		result.Variants = append(result.Variants, stats)

		if i == 0 {
			controlStats = &result.Variants[0]
		}
	}

	// Calculate uplift and statistical significance
	for i := range result.Variants {
		v := &result.Variants[i]
		if controlStats != nil && i > 0 {
			if controlStats.ConversionRate > 0 {
				v.Uplift = (v.ConversionRate - controlStats.ConversionRate) / controlStats.ConversionRate * 100
			}
		}
	}

	// Two-proportion z-test for control vs. the best-performing variant.
	//
	// Caveat worth stating out loud, because this function does not correct
	// for it: picking the best of k variants and then testing that one is a
	// multiple-comparisons problem. With k treatment arms you get k chances
	// to draw a lucky sample, so the real false-positive rate is well above
	// the nominal 5% even with a correct two-sided test. For k > 1, apply a
	// Bonferroni correction (require confidence >= 100 - 5/k) or move to a
	// framework that handles sequential testing properly. Two arms and a
	// fixed sample size is the only case this simple form is honest for.
	if len(result.Variants) >= 2 && controlStats != nil {
		best := result.Variants[1]
		for _, v := range result.Variants[2:] {
			if v.ConversionRate > best.ConversionRate {
				best = v
			}
		}

		if controlStats.Assignments > 30 && best.Assignments > 30 {
			z := twoProportionZScore(
				controlStats.ConversionRate, float64(controlStats.Assignments),
				best.ConversionRate, float64(best.Assignments),
			)

			// Two-sided confidence. normCDF(|z|) alone is the ONE-SIDED
			// figure: it reads 0.95 at |z| = 1.645, so comparing it against
			// 95 silently runs a one-sided test at alpha = 0.05. On an A/A
			// test, where the two variants are identical by construction,
			// that rule calls a winner about 9% of the time instead of 5%.
			// An experiment framework that doubles its own false-positive
			// rate will happily ship a stream of imaginary wins.
			//
			// 2*normCDF(|z|) - 1 is the two-sided figure: 0.95 at |z| = 1.96.
			result.Confidence = (2*normCDF(math.Abs(z)) - 1) * 100
			result.Significant = result.Confidence >= 95.0

			// Only ever call a winner in the direction the data points. A
			// large |z| with best below control is a significant LOSS.
			if result.Significant && best.ConversionRate > controlStats.ConversionRate {
				result.Winner = best.Name
			}
		}
	}

	return result, nil
}

// twoProportionZScore computes the z-score for two proportions.
func twoProportionZScore(p1 float64, n1 float64, p2 float64, n2 float64) float64 {
	pPool := (p1*n1 + p2*n2) / (n1 + n2)
	se := math.Sqrt(pPool * (1 - pPool) * (1/n1 + 1/n2))
	if se == 0 {
		return 0
	}
	return (p2 - p1) / se
}

// normCDF approximates the normal CDF using Horner's method.
func normCDF(z float64) float64 {
	t := 1.0 / (1.0 + 0.2316419*z)
	d := 0.3989422819 * math.Exp(-z*z/2)
	p := d * t * (0.3193815 + t*(-0.3565638 + t*(1.7814779 + t*(-1.8212560 + t*1.3302744))))
	return 1.0 - p
}
```

### 5.2 A/B testing vs feature flags: two different problems

Feature flags and A/B tests share mechanics (hash-based user bucketing, variant assignment, rollout control) but solve different problems. Feature flags answer "should this user see this feature?" and are controlled by engineering and product based on rollout readiness. A/B tests answer "does variant B produce a statistically significant lift on metric X compared to variant A?" and are controlled by analytics and product with formal statistical rigor. The practical implication: do not conflate the two. A feature flag that is also an A/B test adds statistical constraints (fixed sample size, no peeking, SRM monitoring) that engineering flags do not usually respect. A team that uses feature flags for experiments without the statistical machinery ships features on the basis of noise and calls it data-driven. Keep the systems separate, or integrate them explicitly with a framework (Statsig, GrowthBook, Optimizely) that enforces the statistical constraints.

### 5.3 Junior → FAANG: the five questions before any A/B test

Before you run any A/B test, answer five questions on paper. (1) What is the primary metric? One metric, not a basket. (2) What is the minimum detectable effect (MDE)? The smallest lift that would matter to the business. (3) What is the required sample size to detect the MDE at the chosen alpha and power? Compute it, do not guess. (4) How long will that sample size take to accumulate at current traffic? If the answer is "too long," the MDE is too small or the feature affects too few users. (5) What will you do if the result is negative? Kill the feature, iterate, or accept the cost? Answering these five questions up front separates a rigorous experiment from a noise-chasing one. Most junior-led A/B tests fail at question two or three. Fixing this is one of the most impactful skills a data-aware engineer can build.

### 5.4 Senior @ FAANG: the experimentation platform governance

At scale, A/B testing is a platform capability with governance obligations. Four staff-level concerns. **Statistical rigor**: the platform must enforce pre-registration of metrics, fixed sample sizes (or sequential designs), SRM monitoring, and automated flagging of invalid experiments. **Experiment velocity**: a single team running 10 experiments a quarter is fine, but a company running 1000 simultaneous experiments needs orthogonal variance reduction (CUPED) and interaction effect monitoring. **Data infrastructure**: experiment events must flow to a warehouse with low latency (under 24 hours) and be queryable without hand-rolled SQL per experiment. **Ethics and compliance**: experiments that affect user outcomes (pricing, content moderation, medical advice) require ethical review. Every large organization eventually discovers this requirement the hard way. Staff engineers who build and maintain this governance create the conditions for hundreds of experiments to run without degrading into chaos. Those who skip it end up owning a platform whose results leadership quietly stops trusting.

---
