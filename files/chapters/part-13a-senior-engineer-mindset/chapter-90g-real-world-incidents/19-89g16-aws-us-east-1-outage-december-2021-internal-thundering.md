## 90G.16 AWS us-east-1 Outage (December 2021) - Internal Thundering Herd

*"An automated activity to scale capacity of one of the AWS services hosted in the main AWS network triggered
an unexpected behavior from a large number of clients inside the internal network."* - AWS Post-Event Summary

### The Incident

On December 7, 2021, AWS's us-east-1 region - the oldest and most heavily utilized region in all of AWS, hosting
a disproportionate share of the internet's infrastructure - suffered a major outage lasting approximately 7-8 hours of primary impact.
The outage affected AWS services including the management console, CloudWatch, Auto Scaling, Lambda, ECS, and EKS.
Critically, many AWS customers could not even view their service health dashboards to understand what was happening,
because the dashboards themselves ran in us-east-1.

The root cause was an **internal thundering herd** - a scaling operation on an internal AWS networking service
caused a surge of connection requests from internal clients. These clients were configured with aggressive retry
policies and no backoff jitter. When the scaling operation temporarily reduced available capacity, all clients
retried simultaneously, creating a traffic spike orders of magnitude larger than normal. This traffic overwhelmed
internal networking devices, which caused cascading failures across dependent services.

The most devastating aspect: **AWS's own observability and management tools were affected**. Engineers working
to resolve the issue could not access their own monitoring dashboards, deployment tools, or communication systems.
This is the same "recovery tools depend on the failing system" pattern seen in the Meta outage.

### Timeline Reconstruction

The outage unfolded over approximately 8 hours, with the first 2 hours being the most chaotic because AWS's own observability tools were unavailable. The timeline reveals the classic thundering herd escalation pattern: brief capacity reduction, aggressive retries, overwhelming traffic, cascading failures.

```
Dec 7, 07:30 EST   Automated scaling event begins on internal network service
Dec 7, 07:32 EST   Scaling operation causes brief capacity reduction
Dec 7, 07:33 EST   Internal clients begin retrying with no jitter
Dec 7, 07:35 EST   Thundering herd: millions of retry requests per second
Dec 7, 07:40 EST   Internal network devices overwhelmed
Dec 7, 07:45 EST   Cascading failures: CloudWatch, Lambda, ECS affected
Dec 7, 08:00 EST   AWS status page NOT updated (it too is affected)
Dec 7, 08:30 EST   Engineers cannot access management console
Dec 7, 09:00 EST   Out-of-band communication established
Dec 7, 10:00 EST   Root cause identified: internal retry storms
Dec 7, 12:00 EST   Traffic shaping applied to reduce internal retry volume
Dec 7, 15:00 EST   Internal services begin recovering
Dec 7, 18:00 EST   Most services restored, monitoring recovering
Dec 7, 21:30 EST   Full recovery - approximately 14 hours total
```

### Go Implementation: Retry Policy with Jitter and Global Rate Limiting

The direct technical cause of the AWS outage was retry policies without jitter. This implementation demonstrates
production-grade retry logic that prevents thundering herds.

```go
package retrypolicy

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// RetryPolicy defines how a client should retry failed operations.
type RetryPolicy struct {
	MaxRetries     int
	BaseDelay      time.Duration
	MaxDelay       time.Duration
	JitterStrategy JitterStrategy
	RetryBudget    *RetryBudget // global budget shared across all operations
}

// JitterStrategy determines how randomization is applied to retry delays.
type JitterStrategy int

const (
	// NoJitter uses exact exponential backoff (DANGEROUS - causes thundering herd).
	NoJitter JitterStrategy = iota
	// FullJitter randomizes between 0 and the calculated delay.
	FullJitter
	// EqualJitter uses half the delay plus random jitter for the other half.
	EqualJitter
	// DecorrelatedJitter uses the previous delay to calculate the next one.
	DecorrelatedJitter
)

// RetryBudget limits the total number of retries across all clients to prevent
// thundering herds. This is the critical missing piece in AWS's internal clients.
type RetryBudget struct {
	maxRetriesPerSecond int64
	currentCount        atomic.Int64
	windowStart         atomic.Int64 // unix nano
	logger              *slog.Logger
}

// NewRetryBudget creates a budget that allows at most maxPerSecond retries globally.
func NewRetryBudget(maxPerSecond int64, logger *slog.Logger) *RetryBudget {
	rb := &RetryBudget{
		maxRetriesPerSecond: maxPerSecond,
		logger:              logger,
	}
	rb.windowStart.Store(time.Now().UnixNano())
	return rb
}

// Allow checks if a retry is permitted under the budget.
func (rb *RetryBudget) Allow() bool {
	now := time.Now().UnixNano()
	windowStart := rb.windowStart.Load()

	// Reset counter every second.
	if now-windowStart > int64(time.Second) {
		rb.windowStart.CompareAndSwap(windowStart, now)
		rb.currentCount.Store(0)
	}

	current := rb.currentCount.Add(1)
	if current > rb.maxRetriesPerSecond {
		rb.logger.Warn("retry budget exhausted",
			"current", current,
			"max", rb.maxRetriesPerSecond,
		)
		return false
	}
	return true
}

// DefaultPolicy returns a production-safe retry policy.
func DefaultPolicy(budget *RetryBudget) *RetryPolicy {
	return &RetryPolicy{
		MaxRetries:     5,
		BaseDelay:      100 * time.Millisecond,
		MaxDelay:       30 * time.Second,
		JitterStrategy: DecorrelatedJitter,
		RetryBudget:    budget,
	}
}

// Execute runs an operation with the retry policy applied.
func (p *RetryPolicy) Execute(
	ctx context.Context,
	operation func(ctx context.Context) error,
) error {
	var lastErr error
	prevDelay := p.BaseDelay

	for attempt := 0; attempt <= p.MaxRetries; attempt++ {
		if err := operation(ctx); err != nil {
			lastErr = err

			if attempt == p.MaxRetries {
				break
			}

			// Check global retry budget before retrying.
			if p.RetryBudget != nil && !p.RetryBudget.Allow() {
				return fmt.Errorf("retry budget exhausted after %d attempts: %w",
					attempt+1, lastErr)
			}

			delay := p.calculateDelay(attempt, prevDelay)
			prevDelay = delay

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
				continue
			}
		}
		return nil // success
	}
	return fmt.Errorf("all %d retries exhausted: %w", p.MaxRetries, lastErr)
}

// calculateDelay computes the delay for a given attempt with jitter.
func (p *RetryPolicy) calculateDelay(attempt int, prevDelay time.Duration) time.Duration {
	// Base exponential backoff: baseDelay * 2^attempt
	expDelay := time.Duration(float64(p.BaseDelay) * math.Pow(2, float64(attempt)))
	if expDelay > p.MaxDelay {
		expDelay = p.MaxDelay
	}

	switch p.JitterStrategy {
	case NoJitter:
		// WARNING: This causes thundering herds. Included only for demonstration.
		return expDelay

	case FullJitter:
		// Uniform random between 0 and expDelay.
		return time.Duration(rand.Int64N(int64(expDelay)))

	case EqualJitter:
		// Half the delay is fixed, half is random.
		half := expDelay / 2
		return half + time.Duration(rand.Int64N(int64(half)))

	case DecorrelatedJitter:
		// Uses previous delay: random between baseDelay and prevDelay * 3.
		maxJitter := int64(prevDelay) * 3
		if maxJitter <= int64(p.BaseDelay) {
			return p.BaseDelay
		}
		jittered := time.Duration(int64(p.BaseDelay) + rand.Int64N(maxJitter-int64(p.BaseDelay)))
		if jittered > p.MaxDelay {
			return p.MaxDelay
		}
		return jittered

	default:
		return expDelay
	}
}

// ThunderingHerdSimulator demonstrates the difference between retry strategies
// under concurrent load - exactly the scenario that brought down AWS us-east-1.
type ThunderingHerdSimulator struct {
	mu             sync.Mutex
	requestsPerMs  map[int64]int64 // millisecond timestamp to request count
	peakRequests   int64
	totalRequests  int64
}

// NewThunderingHerdSimulator creates a new simulator.
func NewThunderingHerdSimulator() *ThunderingHerdSimulator {
	return &ThunderingHerdSimulator{
		requestsPerMs: make(map[int64]int64),
	}
}

// RecordRequest tracks when a retry request would be sent.
func (s *ThunderingHerdSimulator) RecordRequest(t time.Time) {
	ms := t.UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requestsPerMs[ms]++
	s.totalRequests++
	if s.requestsPerMs[ms] > s.peakRequests {
		s.peakRequests = s.requestsPerMs[ms]
	}
}

// Stats returns peak and average requests per millisecond.
func (s *ThunderingHerdSimulator) Stats() (peak int64, avg float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.requestsPerMs) == 0 {
		return 0, 0
	}
	return s.peakRequests, float64(s.totalRequests) / float64(len(s.requestsPerMs))
}
```

### Key Lessons for Go Engineers

1. **Every retry policy must include jitter** - exponential backoff without jitter causes synchronized
   retries that create thundering herds. Use `DecorrelatedJitter` or `FullJitter` as the default.
2. **Global retry budgets prevent cascading load** - even with jitter, if thousands of clients all retry
   simultaneously, the aggregate load can overwhelm the target. A shared retry budget caps total retry volume.
3. **Your observability must not depend on what it observes** - AWS engineers could not access CloudWatch
   to diagnose a CloudWatch outage. Monitoring systems must be independently deployable.
4. **us-east-1 is special and dangerous** - many AWS services have hidden dependencies on us-east-1 (IAM,
   Route53, S3 for CloudFormation templates). Design for us-east-1 failure even if you deploy elsewhere.

### Exercises

1. Build a **thundering herd visualizer** that simulates 10,000 clients retrying with `NoJitter`,
   `FullJitter`, `EqualJitter`, and `DecorrelatedJitter`, plotting the requests-per-second distribution.
2. Implement a **client-side rate limiter** using Go's `golang.org/x/time/rate` that adapts based on
   server response headers (HTTP 429 with Retry-After).
3. Design a **multi-region health dashboard** that runs independently in each region, uses peer-to-peer
   gossip for cross-region status, and never depends on a single region for operation.

---

### Junior → FAANG: Thundering Herd and Jitter as System Design Fundamentals

The AWS us-east-1 outage is the canonical example for "why do we use jitter in retry logic?" in system design interviews. The answer is not "to be polite to the server." The answer is that synchronized retries from thousands of clients create a traffic spike that is larger than the original load that caused the failure, ensuring that a recovering service is immediately overwhelmed again. Jitter breaks the synchronization by randomizing when each client retries. For FAANG interviews, know the four jitter strategies: no jitter (never use in production), full jitter (uniform random between 0 and the exponential cap), equal jitter (half fixed, half random), and decorrelated jitter (uses the previous delay as the base, producing the smoothest distribution). Interviewers who ask about retry policies expect you to name at least two strategies and explain the trade-off. Adding a global retry budget (the `RetryBudget` in this section) to your answer, which caps aggregate retry volume across all client instances, demonstrates a level of systems thinking that separates L4 from L5 candidates.

### Senior @ FAANG: Hidden Control Plane Dependencies and Observability Independence as Platform Standards

At L6, the AWS us-east-1 incident reveals two organizational risks that require platform-level responses. The first is hidden dependency mapping. The outage propagated beyond us-east-1 because many AWS services have undocumented runtime dependencies on us-east-1 endpoints for IAM, Route 53, and S3-backed CloudFormation templates. Services believed to be multi-region were actually us-east-1 dependent through their control planes. The staff-level response is to run a dependency audit against the control plane, not just the data plane. For every service you own, document: which IAM role refresh calls are made, which DNS resolution depends on Route 53 hosted zones, and whether CloudFormation or Terraform state files are stored in us-east-1 S3 buckets. This audit is the prerequisite for any honest multi-region disaster recovery plan.

The second risk is observability coupling. During the outage, AWS engineers could not use CloudWatch to diagnose the CloudWatch disruption. Your monitoring system must not depend on the infrastructure it monitors. At staff level, this is an explicit architectural constraint: the observability stack (metrics aggregation, alert routing, dashboard serving) must deploy independently from the application stack, use different underlying infrastructure primitives, and have a tested runbook for operation when the primary environment is degraded. "Tested" means you have conducted a drill where the primary observability stack is intentionally unavailable and verified that the fallback produces actionable signal. If your team has never run that drill, the fallback does not functionally exist, regardless of what the architecture diagram shows.

