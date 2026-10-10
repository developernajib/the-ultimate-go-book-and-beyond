## 83B.5 Netflix

```
┌──────────────────────────────────────────────────────────────────┐
│                   NETFLIX INTERVIEW PIPELINE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30-45 min)                                    │
│       │  - Culture fit, experience level, compensation           │
│       │  - Netflix discusses comp early (top-of-market policy)   │
│       ▼                                                          │
│  Hiring Manager Screen (45-60 min)                               │
│       │  - Technical depth, project discussion, team fit         │
│       │  - This is a real evaluation round, not a formality      │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Coding + system design discussion                     │
│       │  - Senior-level expectations from the start              │
│       ▼                                                          │
│  Onsite (5-6 rounds, 45-60 min each)                             │
│       │  - 2 Coding rounds (production-quality focus)            │
│       │  - 2 System Design rounds (Netflix expects depth)        │
│       │  - 1-2 Culture rounds (Freedom & Responsibility)         │
│       ▼                                                          │
│  Debrief & Decision                                              │
│       ▼                                                          │
│  Offer (top of market compensation)                              │
│  Timeline: 3-6 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Company Overview for Go Engineers

Netflix is fundamentally different from every other FAANG company. They do not hire junior engineers. There is no new grad pipeline, no internship-to-full-time conversion, no "we'll train you" mentality. Netflix expects every engineer to operate with significant autonomy from day one - to identify problems, propose solutions, execute independently, and own outcomes. This makes the Netflix interview the hardest behavioral bar in the industry and the most system-design-heavy technical evaluation you will encounter.

Netflix's engineering organization runs approximately 1,500 microservices serving 270+ million subscribers across 190 countries. Their infrastructure processes petabytes of data daily, delivers more than 15% of global internet bandwidth during peak hours, and operates one of the most sophisticated content delivery networks in existence. Understanding this scale is not optional - it is the baseline expectation for every Netflix engineer.

**How Netflix Uses Go Internally:**

Go has become one of Netflix's primary languages for infrastructure and platform services, alongside Java (which dominates their application layer). Netflix's adoption of Go accelerated significantly after 2020 as the company built more performance-critical, low-latency infrastructure services where Go's compilation speed, deployment simplicity, and concurrency model provided clear advantages over the JVM.

**Key Products and Teams That Use Go:**

- **Control plane services** - The service mesh control plane, traffic management, configuration distribution, and service discovery infrastructure. These services manage routing for all of Netflix's microservices and must operate with extremely low latency and high reliability. Go's predictable performance characteristics (no GC pauses like the JVM) make it the preferred choice.
- **Edge computing and API gateway** - Zuul gateway components, request routing, and the edge tier that handles all incoming traffic. The edge layer processes millions of requests per second and is one of Netflix's most latency-sensitive systems. Go components handle routing logic, authentication, and request transformation.
- **Chaos engineering platform** - The successor to the original Chaos Monkey (which was Java), including the Failure Injection Testing (FIT) platform, fault injection controllers, and blast radius management. Go's simplicity makes chaos engineering tools easy to audit and reason about - critical when the tool's job is to break things intentionally.
- **Observability and telemetry** - Custom metrics collection agents, distributed tracing infrastructure (building on OpenTelemetry), log aggregation pipeline components, and real-time alerting systems. These services must have minimal overhead and maximal throughput, making Go ideal.
- **Encoding pipeline orchestration** - Workflow orchestration for the video encoding pipeline. Netflix encodes every title into hundreds of different bitrate-resolution combinations. Go services manage the scheduling, parallelization, and resource allocation for this massive compute workload.
- **Content delivery network (Open Connect)** - Tooling and control plane services for Netflix's proprietary CDN, which consists of appliances deployed inside ISP networks worldwide. Go services manage appliance configuration, content placement decisions, and health monitoring.
- **Data platform tooling** - Components of the data pipeline infrastructure including schema registry services, data quality monitoring, and stream processing orchestration.

**Engineering Culture and Values:**

Netflix's culture is codified in their famous culture document, which you must read before interviewing. The key principles that affect your interview:

1. **Freedom and Responsibility.** Netflix gives engineers enormous freedom - no vacation tracking, no expense approval processes for reasonable amounts, no mandatory tech stacks, minimal process. In return, they expect exceptional judgment. Your interview will probe whether you can be trusted with this freedom. Candidates who need structure, guidance, or approval for decisions are filtered out.

2. **Context, not control.** Netflix managers provide context (goals, constraints, priorities) and trust engineers to make good decisions. Your interview answers should demonstrate that you understand why decisions matter, not just what to do. "I chose X because of trade-off Y given constraint Z" is the expected communication pattern.

3. **Highly aligned, loosely coupled.** Teams agree on strategy and goals but operate independently on execution. Your system design answers should reflect architectures where services are autonomous, team boundaries are clear, and integration happens through well-defined contracts.

4. **Stunning colleagues.** Netflix explicitly optimizes for talent density. They would rather have one exceptional engineer than three average ones. The keeper test - "If this person told me they were leaving, would I fight to keep them?" - is applied ruthlessly. Your interview must demonstrate not just competence but excellence.

5. **Radical candor.** Netflix encourages direct, honest feedback at all levels. In your interview, do not avoid difficult topics or give diplomatic non-answers. If you think an approach is wrong, say so and explain why. Interviewers respect intellectual honesty and punish performative politeness.

**Interview Process Unique Aspects:**

Three critical differences from other FAANG companies. First, **Netflix has TWO system design rounds** - more than any other company. This reflects Netflix's belief that system design skill is the strongest predictor of senior engineer success. Second, **the culture rounds are genuine evaluation rounds with veto power**, not afterthoughts. A technically brilliant candidate who fails the culture assessment will not receive an offer. Third, **Netflix discusses compensation early and does not negotiate**. They offer top-of-market and expect you to accept. This transparency is refreshing but means there is no leverage play - the offer is the offer.

### Interview Process Deep Dive

**Application to Offer: The Complete Pipeline**

**Stage 1: Application or Referral (Week 0)**

Netflix is one of the hardest companies to get an interview at without a referral. Their headcount is small (approximately 13,000 total employees vs. Google's 180,000+) and they only hire senior roles, so positions are limited. A referral from a current Netflix engineer dramatically increases your chances. Cold applications should include a strong resume emphasizing ownership, autonomy, and measurable impact - Netflix recruiters screen aggressively for seniority signals.

**Stage 2: Recruiter Screen (30-45 minutes, Week 1-2)**

The Netflix recruiter screen is more substantive than at other companies. Beyond the standard experience overview, the recruiter will:
- Discuss compensation expectations explicitly. Netflix asks about your current compensation and shares their compensation philosophy. They pay top of market in base salary and let you choose your cash vs. stock split.
- Probe for culture fit signals: autonomy, judgment, ownership. Questions like "Describe a time you made a significant technical decision without manager approval" appear at the recruiter screen stage.
- Assess whether you meet the seniority bar. Netflix does not hire engineers who would be L3 or L4 at Google - they start at the equivalent of L5.

**Stage 3: Hiring Manager Screen (45-60 minutes, Week 2-3)**

This is a real evaluation round, not a formality. The hiring manager assesses:
- Technical depth through detailed project discussion. Expect 30+ minutes discussing your most impactful past project with deep probing questions.
- Team fit - whether your working style matches the team's needs.
- Whether you can articulate the "why" behind your technical decisions. Netflix hiring managers look for engineers who think in terms of trade-offs, not just solutions.

**Stage 4: Technical Phone Screen (60 minutes, Week 3-4)**

Netflix's phone screen combines coding and system design in a single round. You might spend 30 minutes on a coding problem and 30 minutes on a design discussion, or the full hour on a design-heavy problem with implementation. The coding emphasis is on production-quality code with error handling, not algorithmic puzzles. The design emphasis is on distributed systems thinking.

**Stage 5: Onsite Interview (5-6 rounds, 45-60 minutes each, Week 4-6)**

The onsite consists of:
- **2 Coding rounds:** Problems tend to be practical rather than algorithmic puzzles. Expect problems related to building production systems: implement a cache with specific eviction policies, design and code a rate limiter, build a concurrent data processing pipeline. Netflix expects error handling, testing consideration, and observability hooks in your code.
- **2 System Design rounds:** This is where Netflix differentiates. Two full system design rounds means you need exceptional depth. Expect streaming-specific designs (CDN, encoding pipeline, recommendation engine) and infrastructure designs (chaos engineering platform, feature flag system, A/B testing framework). Netflix interviewers go deep on specific components rather than accepting hand-waving.
- **1-2 Culture rounds:** Freedom & Responsibility assessment. These are behavioral interviews but focused specifically on Netflix's values. Expect questions about autonomous decision-making, handling ambiguity, giving and receiving feedback, and making judgment calls under uncertainty.

**Who interviews you:** Senior engineers (Senior Software Engineer and above) and engineering managers from the hiring team and adjacent teams. Netflix interviewers are experienced and will challenge your answers with sharp follow-ups. They are looking for genuine depth, not rehearsed answers.

**Stage 6: Debrief and Decision (Week 5-7)**

The debrief is thorough - all interviewers discuss the candidate together. Netflix uses a "strong hire" bar - lukewarm support is insufficient. The hiring manager makes the final decision but needs strong support from the interview panel. Culture round feedback carries equal weight to technical round feedback.

**Stage 7: Offer (Week 5-7)**

Netflix offers are top of market. Base salary ranges from $300,000 to $900,000+ depending on level and role. Netflix lets you choose what percentage of your compensation you want in stock options vs. cash (including up to 100% cash). There is no vesting cliff - options vest monthly. The offer is non-negotiable in the traditional sense, but Netflix will re-level you if they believe you should be at a higher level.

**Timeline: 3-6 weeks from first screen to offer.** Netflix moves efficiently because they know senior candidates have competing offers.

### Level Expectations

Netflix has a flatter hierarchy than other FAANG companies. There are effectively three engineering levels plus management.

**Senior Software Engineer - 5-10 years (most common hire):**
- Design and implement complex distributed systems with minimal guidance
- Own significant components or services end-to-end
- Make sound technical decisions autonomously
- Write production-quality code with proper error handling, testing, and observability
- Influence technical direction within the team
- Approximate total compensation (2025-2026): $350,000-$550,000

**Staff Software Engineer - 8-15 years:**
- Architecture ownership spanning multiple teams or services
- Define technical strategy and standards that others follow
- Solve ambiguous, cross-cutting problems that affect the platform
- Mentor and elevate the technical capabilities of the team
- Represent the team in cross-organizational technical discussions
- Approximate total compensation (2025-2026): $550,000-$800,000

**Principal Software Engineer - 15+ years (rare, approximately 50 total at Netflix):**
- Organization-wide technical leadership and vision
- Define the architectural direction for major product areas
- Solve problems that no one else can solve
- Netflix's equivalent of a Distinguished Engineer
- Approximate total compensation (2025-2026): $800,000-$1,200,000+

**Note on compensation:** Netflix's compensation is unique. The base salary is the highest in the industry (often 2-3x what Google or Meta pay in base). Stock options are on top and you choose the split. There is no RSU grant with a vesting schedule - you receive options that vest monthly. This means Netflix compensation is more liquid and predictable than other FAANG companies.

### Top 20 Netflix Go Interview Questions with Solutions

#### Question 1: Design a Rate-Limited Retry with Exponential Backoff (Medium)

*Netflix-style: production-quality code with observability. Netflix expects error classification, jitter, and context-awareness as baseline requirements.*

**Key Insight:** Combine exponential backoff with jitter to prevent thundering herd, error classification to avoid retrying non-transient errors, and context cancellation for clean shutdown.

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"time"
)

// RetryConfig configures retry behavior.
type RetryConfig struct {
	MaxAttempts     int
	InitialBackoff  time.Duration
	MaxBackoff      time.Duration
	BackoffFactor   float64
	JitterFraction  float64
	RetryableErrors []error
}

// RetryResult captures the outcome of a retry sequence for observability.
type RetryResult struct {
	Attempts  int
	Duration  time.Duration
	LastError error
}

// RetryWithBackoff executes fn with exponential backoff and jitter.
func RetryWithBackoff(ctx context.Context, cfg RetryConfig, fn func() error) RetryResult {
	start := time.Now()
	var lastErr error

	for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return RetryResult{
				Attempts:  attempt,
				Duration:  time.Since(start),
				LastError: fmt.Errorf("context canceled: %w", err),
			}
		}

		lastErr = fn()
		if lastErr == nil {
			return RetryResult{
				Attempts: attempt + 1,
				Duration: time.Since(start),
			}
		}

		if !isRetryable(lastErr, cfg.RetryableErrors) {
			return RetryResult{
				Attempts:  attempt + 1,
				Duration:  time.Since(start),
				LastError: fmt.Errorf("non-retryable error: %w", lastErr),
			}
		}

		if attempt < cfg.MaxAttempts-1 {
			backoff := calculateBackoff(attempt, cfg)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return RetryResult{
					Attempts:  attempt + 1,
					Duration:  time.Since(start),
					LastError: ctx.Err(),
				}
			}
		}
	}

	return RetryResult{
		Attempts:  cfg.MaxAttempts,
		Duration:  time.Since(start),
		LastError: fmt.Errorf("max attempts exceeded: %w", lastErr),
	}
}

func calculateBackoff(attempt int, cfg RetryConfig) time.Duration {
	backoff := float64(cfg.InitialBackoff) * math.Pow(cfg.BackoffFactor, float64(attempt))
	if backoff > float64(cfg.MaxBackoff) {
		backoff = float64(cfg.MaxBackoff)
	}
	jitter := backoff * cfg.JitterFraction * (rand.Float64()*2 - 1)
	return time.Duration(backoff + jitter)
}

func isRetryable(err error, retryable []error) bool {
	if len(retryable) == 0 {
		return true
	}
	for _, re := range retryable {
		if errors.Is(err, re) {
			return true
		}
	}
	return false
}

var ErrTemporary = errors.New("temporary error")

func main() {
	callCount := 0
	cfg := RetryConfig{
		MaxAttempts:     5,
		InitialBackoff:  100 * time.Millisecond,
		MaxBackoff:      5 * time.Second,
		BackoffFactor:   2.0,
		JitterFraction:  0.1,
		RetryableErrors: []error{ErrTemporary},
	}

	ctx := context.Background()
	result := RetryWithBackoff(ctx, cfg, func() error {
		callCount++
		if callCount < 3 {
			return fmt.Errorf("attempt %d: %w", callCount, ErrTemporary)
		}
		return nil
	})

	fmt.Printf("Success after %d attempts in %v\n", result.Attempts, result.Duration)
}
```

**Time Complexity:** O(maxAttempts). **Space Complexity:** O(1).

**Netflix follow-up:** "How would you add metrics emission? What metrics would you track? How would you prevent retry storms across hundreds of instances?"

#### Question 2: Adaptive Bitrate Selection Algorithm (Medium - Netflix-Specific)

*This is a genuine Netflix domain problem. Every Netflix engineer should understand how adaptive bitrate streaming works.*

**Key Insight:** The Buffer-Based Approach (BBA) uses the client's playback buffer level as the primary signal for quality selection, with throughput as a secondary constraint. Prevent oscillation by limiting quality changes to one level at a time.

```go
package main

import (
	"fmt"
	"math"
	"time"
)

// BitrateLevel represents an available video quality level.
type BitrateLevel struct {
	Bitrate    int    // kbps
	Resolution string // e.g., "1920x1080"
}

// ABRState tracks the state for adaptive bitrate selection.
type ABRState struct {
	bufferLevel     time.Duration
	throughputEWMA  float64
	throughputAlpha float64
	levels          []BitrateLevel
	currentLevel    int
	minBuffer       time.Duration
	maxBuffer       time.Duration
}

func NewABRState(levels []BitrateLevel) *ABRState {
	return &ABRState{
		levels:          levels,
		throughputAlpha: 0.3,
		minBuffer:       5 * time.Second,
		maxBuffer:       30 * time.Second,
	}
}

func (s *ABRState) UpdateThroughput(measured float64) {
	if s.throughputEWMA == 0 {
		s.throughputEWMA = measured
		return
	}
	s.throughputEWMA = s.throughputAlpha*measured + (1-s.throughputAlpha)*s.throughputEWMA
}

func (s *ABRState) SelectBitrate() int {
	if s.bufferLevel < s.minBuffer {
		s.currentLevel = 0
		return s.levels[0].Bitrate
	}

	if s.bufferLevel > s.maxBuffer {
		for i := len(s.levels) - 1; i >= 0; i-- {
			if float64(s.levels[i].Bitrate) < s.throughputEWMA*0.8 {
				s.currentLevel = i
				return s.levels[i].Bitrate
			}
		}
		s.currentLevel = 0
		return s.levels[0].Bitrate
	}

	bufferRatio := float64(s.bufferLevel-s.minBuffer) / float64(s.maxBuffer-s.minBuffer)
	targetIdx := int(math.Round(bufferRatio * float64(len(s.levels)-1)))

	for targetIdx > 0 && float64(s.levels[targetIdx].Bitrate) > s.throughputEWMA*0.8 {
		targetIdx--
	}

	if targetIdx > s.currentLevel+1 {
		targetIdx = s.currentLevel + 1
	}
	if targetIdx < s.currentLevel-1 {
		targetIdx = s.currentLevel - 1
	}

	s.currentLevel = targetIdx
	return s.levels[targetIdx].Bitrate
}

func main() {
	levels := []BitrateLevel{
		{235, "320x240"}, {560, "640x480"}, {1050, "960x540"},
		{2100, "1280x720"}, {4200, "1920x1080"}, {8400, "3840x2160"},
	}

	abr := NewABRState(levels)
	abr.UpdateThroughput(5000)

	for _, buf := range []time.Duration{2, 8, 15, 25, 35} {
		abr.bufferLevel = buf * time.Second
		bitrate := abr.SelectBitrate()
		fmt.Printf("Buffer: %v -> %d kbps (%s)\n",
			buf*time.Second, bitrate, levels[abr.currentLevel].Resolution)
	}
}
```

**Time Complexity:** O(L) where L is the number of bitrate levels. **Space Complexity:** O(1).

#### Question 3: Consistent Hashing for Content Distribution (Medium)

*Netflix's Open Connect CDN uses consistent hashing to distribute content across cache servers. This tests distributed systems fundamentals.*

**Key Insight:** Virtual nodes ensure uniform distribution. When a node is removed, only keys that hashed to that node are redistributed, minimizing cache invalidation.

```go
package main

import (
	"fmt"
	"hash/crc32"
	"sort"
	"strconv"
	"sync"
)

type ConsistentHash struct {
	mu       sync.RWMutex
	ring     []uint32
	nodes    map[uint32]string
	replicas int
}

func NewConsistentHash(replicas int) *ConsistentHash {
	return &ConsistentHash{
		nodes:    make(map[uint32]string),
		replicas: replicas,
	}
}

func (ch *ConsistentHash) hash(key string) uint32 {
	return crc32.ChecksumIEEE([]byte(key))
}

func (ch *ConsistentHash) AddNode(node string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()

	for i := 0; i < ch.replicas; i++ {
		virtualKey := node + "#" + strconv.Itoa(i)
		h := ch.hash(virtualKey)
		ch.ring = append(ch.ring, h)
		ch.nodes[h] = node
	}
	sort.Slice(ch.ring, func(i, j int) bool { return ch.ring[i] < ch.ring[j] })
}

func (ch *ConsistentHash) RemoveNode(node string) {
	ch.mu.Lock()
	defer ch.mu.Unlock()

	for i := 0; i < ch.replicas; i++ {
		virtualKey := node + "#" + strconv.Itoa(i)
		h := ch.hash(virtualKey)
		delete(ch.nodes, h)

		idx := sort.Search(len(ch.ring), func(j int) bool { return ch.ring[j] >= h })
		if idx < len(ch.ring) && ch.ring[idx] == h {
			ch.ring = append(ch.ring[:idx], ch.ring[idx+1:]...)
		}
	}
}

func (ch *ConsistentHash) GetNode(key string) string {
	ch.mu.RLock()
	defer ch.mu.RUnlock()

	if len(ch.ring) == 0 {
		return ""
	}

	h := ch.hash(key)
	idx := sort.Search(len(ch.ring), func(i int) bool { return ch.ring[i] >= h })
	if idx == len(ch.ring) {
		idx = 0
	}
	return ch.nodes[ch.ring[idx]]
}

func main() {
	ch := NewConsistentHash(150)
	ch.AddNode("cdn-us-east-1")
	ch.AddNode("cdn-us-west-2")
	ch.AddNode("cdn-eu-west-1")
	ch.AddNode("cdn-ap-south-1")

	videos := []string{
		"stranger-things-s5e01", "wednesday-s2e03",
		"squid-game-s3e01", "the-witcher-s4e05",
	}

	for _, v := range videos {
		fmt.Printf("Video '%s' -> CDN: %s\n", v, ch.GetNode(v))
	}

	fmt.Println("\n--- After removing cdn-us-east-1 ---")
	ch.RemoveNode("cdn-us-east-1")
	for _, v := range videos {
		fmt.Printf("Video '%s' -> CDN: %s\n", v, ch.GetNode(v))
	}
}
```

**Time Complexity:** O(log(n * replicas)) for GetNode. O(n * replicas * log(n * replicas)) for AddNode. **Space Complexity:** O(n * replicas).

#### Question 4: Design a Circuit Breaker (Medium - Netflix-Specific)

*Netflix invented the circuit breaker pattern (Hystrix). Every Netflix engineer must understand this deeply.*

**Key Insight:** Three states (closed, open, half-open) with configurable thresholds. The half-open state gradually allows traffic through to test recovery.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type CBState int

const (
	CBClosed CBState = iota
	CBOpen
	CBHalfOpen
)

func (s CBState) String() string {
	return [...]string{"closed", "open", "half-open"}[s]
}

type CircuitBreaker struct {
	mu            sync.Mutex
	state         CBState
	failureCount  int
	successCount  int
	failureThresh int
	successThresh int
	timeout       time.Duration
	lastFailureAt time.Time
}

func NewCircuitBreaker(failureThresh, successThresh int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		failureThresh: failureThresh,
		successThresh: successThresh,
		timeout:       timeout,
	}
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
	cb.mu.Lock()
	if cb.state == CBOpen {
		if time.Since(cb.lastFailureAt) > cb.timeout {
			cb.state = CBHalfOpen
			cb.successCount = 0
		} else {
			cb.mu.Unlock()
			return fmt.Errorf("circuit breaker is open")
		}
	}
	cb.mu.Unlock()

	err := fn()

	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err != nil {
		cb.failureCount++
		cb.lastFailureAt = time.Now()
		if cb.failureCount >= cb.failureThresh {
			cb.state = CBOpen
		}
		return err
	}

	if cb.state == CBHalfOpen {
		cb.successCount++
		if cb.successCount >= cb.successThresh {
			cb.state = CBClosed
			cb.failureCount = 0
		}
	} else {
		cb.failureCount = 0
	}
	return nil
}

func (cb *CircuitBreaker) State() CBState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}

func main() {
	cb := NewCircuitBreaker(3, 2, 5*time.Second)

	// Simulate failures
	for i := 0; i < 4; i++ {
		err := cb.Execute(func() error {
			return fmt.Errorf("service unavailable")
		})
		fmt.Printf("Attempt %d: err=%v, state=%s\n", i+1, err, cb.State())
	}
}
```

**Time Complexity:** O(1). **Space Complexity:** O(1).

#### Question 5: Sliding Window Maximum for Stream Processing (Medium)

*Netflix processes real-time streams of viewing metrics. Sliding window maximum is fundamental to anomaly detection.*

**Key Insight:** Use a monotone decreasing deque. Remove elements outside the window from the front. Remove smaller elements from the back before adding new ones.

```go
package main

import "fmt"

func maxSlidingWindow(nums []int, k int) []int {
	if len(nums) == 0 || k == 0 {
		return nil
	}
	deque := make([]int, 0)
	result := make([]int, 0, len(nums)-k+1)

	for i := 0; i < len(nums); i++ {
		for len(deque) > 0 && deque[0] < i-k+1 {
			deque = deque[1:]
		}
		for len(deque) > 0 && nums[deque[len(deque)-1]] < nums[i] {
			deque = deque[:len(deque)-1]
		}
		deque = append(deque, i)
		if i >= k-1 {
			result = append(result, nums[deque[0]])
		}
	}
	return result
}

func main() {
	fmt.Println(maxSlidingWindow([]int{1, 3, -1, -3, 5, 3, 6, 7}, 3))
	// [3, 3, 5, 5, 6, 7]
}
```

**Time Complexity:** O(n) - each element enters and leaves the deque at most once. **Space Complexity:** O(k).

#### Question 6: Design a Feature Flag System with Gradual Rollout (Medium - Netflix-Specific)

*Netflix's experimentation culture relies heavily on feature flags. This tests practical systems design with deterministic behavior.*

**Key Insight:** Use deterministic hashing for bucketing so the same user always gets the same flag value. This prevents flapping during gradual rollouts.

```go
package main

import (
	"fmt"
	"hash/crc32"
	"sync"
)

type FeatureFlag struct {
	Name       string
	Enabled    bool
	Percentage int // 0-100 for gradual rollout
	AllowList  map[string]bool
}

type FlagService struct {
	mu    sync.RWMutex
	flags map[string]*FeatureFlag
}

func NewFlagService() *FlagService {
	return &FlagService{flags: make(map[string]*FeatureFlag)}
}

func (fs *FlagService) Register(flag *FeatureFlag) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.flags[flag.Name] = flag
}

func (fs *FlagService) IsEnabled(flagName, userID string) bool {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	flag, ok := fs.flags[flagName]
	if !ok || !flag.Enabled {
		return false
	}
	if flag.AllowList != nil && flag.AllowList[userID] {
		return true
	}
	if flag.Percentage >= 100 {
		return true
	}
	if flag.Percentage <= 0 {
		return false
	}
	// Deterministic hash-based bucketing
	h := crc32.ChecksumIEEE([]byte(flagName + ":" + userID))
	return int(h%100) < flag.Percentage
}

func main() {
	svc := NewFlagService()
	svc.Register(&FeatureFlag{
		Name:       "new-player-ui",
		Enabled:    true,
		Percentage: 25, // 25% rollout
		AllowList:  map[string]bool{"beta-tester-1": true},
	})

	enabled := 0
	for i := 0; i < 1000; i++ {
		if svc.IsEnabled("new-player-ui", fmt.Sprintf("user-%d", i)) {
			enabled++
		}
	}
	fmt.Printf("Enabled for %d/1000 users (~25%% expected)\n", enabled)
	fmt.Println("Beta tester:", svc.IsEnabled("new-player-ui", "beta-tester-1")) // true
}
```

**Time Complexity:** O(1) per flag check. **Space Complexity:** O(f + a) where f is number of flags and a is total allowlist size.

#### Question 7: Top K Frequent Elements with Bucket Sort (Easy-Medium)

*Netflix uses frequency analysis for trending content, popular searches, and viewing patterns.*

**Key Insight:** Bucket sort by frequency achieves O(n) time, beating the O(n log k) heap approach.

```go
package main

import "fmt"

func topKFrequent(nums []int, k int) []int {
	freq := make(map[int]int)
	for _, n := range nums {
		freq[n]++
	}

	buckets := make([][]int, len(nums)+1)
	for num, count := range freq {
		buckets[count] = append(buckets[count], num)
	}

	result := make([]int, 0, k)
	for i := len(buckets) - 1; i >= 0 && len(result) < k; i-- {
		result = append(result, buckets[i]...)
	}
	return result[:k]
}

func main() {
	fmt.Println(topKFrequent([]int{1, 1, 1, 2, 2, 3}, 2)) // [1, 2]
	fmt.Println(topKFrequent([]int{1}, 1))                  // [1]
}
```

**Time Complexity:** O(n). **Space Complexity:** O(n).

#### Question 8: Implement a Skip List (Hard)

*Skip lists are used in Netflix's storage infrastructure as an alternative to balanced trees. They offer probabilistic balancing with simpler implementation.*

**Key Insight:** Each node has a random number of forward pointers. Search, insert, and delete are all O(log n) expected time. The probabilistic approach avoids the rotation complexity of balanced trees.

```go
package main

import (
	"fmt"
	"math/rand/v2"
)

type skipNode struct {
	val     int
	forward []*skipNode
}

type SkipList struct {
	head     *skipNode
	maxLevel int
	level    int
}

func NewSkipList() *SkipList {
	return &SkipList{
		head:     &skipNode{forward: make([]*skipNode, 16)},
		maxLevel: 16,
	}
}

func (sl *SkipList) randomLevel() int {
	lvl := 1
	for lvl < sl.maxLevel && rand.Float64() < 0.5 {
		lvl++
	}
	return lvl
}

func (sl *SkipList) Search(target int) bool {
	curr := sl.head
	for i := sl.level - 1; i >= 0; i-- {
		for curr.forward[i] != nil && curr.forward[i].val < target {
			curr = curr.forward[i]
		}
	}
	curr = curr.forward[0]
	return curr != nil && curr.val == target
}

func (sl *SkipList) Insert(val int) {
	update := make([]*skipNode, sl.maxLevel)
	curr := sl.head
	for i := sl.level - 1; i >= 0; i-- {
		for curr.forward[i] != nil && curr.forward[i].val < val {
			curr = curr.forward[i]
		}
		update[i] = curr
	}

	lvl := sl.randomLevel()
	if lvl > sl.level {
		for i := sl.level; i < lvl; i++ {
			update[i] = sl.head
		}
		sl.level = lvl
	}

	node := &skipNode{val: val, forward: make([]*skipNode, lvl)}
	for i := 0; i < lvl; i++ {
		node.forward[i] = update[i].forward[i]
		update[i].forward[i] = node
	}
}

func (sl *SkipList) Delete(val int) bool {
	update := make([]*skipNode, sl.maxLevel)
	curr := sl.head
	for i := sl.level - 1; i >= 0; i-- {
		for curr.forward[i] != nil && curr.forward[i].val < val {
			curr = curr.forward[i]
		}
		update[i] = curr
	}

	target := curr.forward[0]
	if target == nil || target.val != val {
		return false
	}

	for i := 0; i < sl.level; i++ {
		if update[i].forward[i] != target {
			break
		}
		update[i].forward[i] = target.forward[i]
	}

	for sl.level > 0 && sl.head.forward[sl.level-1] == nil {
		sl.level--
	}
	return true
}

func main() {
	sl := NewSkipList()
	for _, v := range []int{3, 6, 7, 9, 12, 19, 17, 26, 21, 25} {
		sl.Insert(v)
	}
	fmt.Println(sl.Search(19)) // true
	fmt.Println(sl.Search(15)) // false
	sl.Delete(19)
	fmt.Println(sl.Search(19)) // false
}
```

**Time Complexity:** O(log n) expected for all operations. **Space Complexity:** O(n * maxLevel).

#### Question 9: Event Sourcing System with Optimistic Concurrency (Medium)

*Netflix uses event sourcing for state management in several infrastructure systems. This tests understanding of append-only stores and version control.*

**Key Insight:** Optimistic concurrency control using version numbers prevents lost updates without locking. If two writers submit events for the same aggregate with the same expected version, the second one fails and must retry.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type Event struct {
	ID        string
	Type      string
	Payload   map[string]any
	Timestamp time.Time
	Version   int
}

type EventStore struct {
	mu     sync.RWMutex
	events map[string][]Event
}

func NewEventStore() *EventStore {
	return &EventStore{events: make(map[string][]Event)}
}

func (es *EventStore) Append(aggregateID string, event Event) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	existing := es.events[aggregateID]
	expectedVersion := len(existing)
	if event.Version != expectedVersion {
		return fmt.Errorf("optimistic concurrency conflict: expected version %d, got %d",
			expectedVersion, event.Version)
	}

	es.events[aggregateID] = append(existing, event)
	return nil
}

func (es *EventStore) GetEvents(aggregateID string, fromVersion int) []Event {
	es.mu.RLock()
	defer es.mu.RUnlock()

	events := es.events[aggregateID]
	if fromVersion >= len(events) {
		return nil
	}
	result := make([]Event, len(events)-fromVersion)
	copy(result, events[fromVersion:])
	return result
}

func (es *EventStore) CurrentVersion(aggregateID string) int {
	es.mu.RLock()
	defer es.mu.RUnlock()
	return len(es.events[aggregateID])
}

func main() {
	store := NewEventStore()

	// Append events for a user's viewing history
	store.Append("user-123", Event{
		Type: "started_watching", Payload: map[string]any{"title": "Stranger Things"},
		Timestamp: time.Now(), Version: 0,
	})
	store.Append("user-123", Event{
		Type: "paused", Payload: map[string]any{"position_ms": 1234000},
		Timestamp: time.Now(), Version: 1,
	})

	// Conflict detection
	err := store.Append("user-123", Event{
		Type: "resumed", Version: 1, // stale version
	})
	fmt.Println("Conflict:", err) // optimistic concurrency conflict

	events := store.GetEvents("user-123", 0)
	for _, e := range events {
		fmt.Printf("v%d: %s %v\n", e.Version, e.Type, e.Payload)
	}
}
```

**Time Complexity:** O(1) for Append, O(n) for GetEvents where n is events returned. **Space Complexity:** O(total events).

#### Question 10: Implement a Concurrent Worker Pool with Backpressure (Medium)

*Netflix infrastructure processes millions of events per second. Worker pools with backpressure are fundamental.*

**Key Insight:** Use a buffered channel as the job queue. The buffer size controls backpressure - when the buffer is full, producers block. This prevents unbounded memory growth.

```go
package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type WorkerPool[T any, R any] struct {
	workers    int
	bufferSize int
	processor  func(T) R
	jobs       chan T
	results    chan R
	wg         sync.WaitGroup
	processed  atomic.Int64
}

func NewWorkerPool[T any, R any](workers, bufferSize int, processor func(T) R) *WorkerPool[T, R] {
	return &WorkerPool[T, R]{
		workers:    workers,
		bufferSize: bufferSize,
		processor:  processor,
		jobs:       make(chan T, bufferSize),
		results:    make(chan R, bufferSize),
	}
}

func (wp *WorkerPool[T, R]) Start(ctx context.Context) {
	for i := 0; i < wp.workers; i++ {
		wp.wg.Add(1)
		go func() {
			defer wp.wg.Done()
			for {
				select {
				case job, ok := <-wp.jobs:
					if !ok {
						return
					}
					result := wp.processor(job)
					wp.processed.Add(1)
					select {
					case wp.results <- result:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}
}

func (wp *WorkerPool[T, R]) Submit(job T) {
	wp.jobs <- job // blocks when buffer is full (backpressure)
}

func (wp *WorkerPool[T, R]) Results() <-chan R {
	return wp.results
}

func (wp *WorkerPool[T, R]) Shutdown() {
	close(wp.jobs)
	wp.wg.Wait()
	close(wp.results)
}

func (wp *WorkerPool[T, R]) ProcessedCount() int64 {
	return wp.processed.Load()
}

func main() {
	pool := NewWorkerPool[int, int](4, 10, func(n int) int {
		time.Sleep(10 * time.Millisecond) // simulate work
		return n * n
	})

	ctx := context.Background()
	pool.Start(ctx)

	go func() {
		for i := 0; i < 20; i++ {
			pool.Submit(i)
		}
		pool.Shutdown()
	}()

	for result := range pool.Results() {
		fmt.Printf("Result: %d\n", result)
	}
	fmt.Printf("Total processed: %d\n", pool.ProcessedCount())
}
```

**Time Complexity:** O(1) per submit/dequeue. **Space Complexity:** O(bufferSize) for the channel buffer.

#### Question 11: Graph Valid Tree using Union-Find (Easy-Medium)

*Graph connectivity problems appear in Netflix's content relationship graphs and infrastructure dependency mapping.*

**Key Insight:** A valid tree has exactly n-1 edges and no cycles. Union-Find detects cycles in O(alpha(n)) per operation.

```go
package main

import "fmt"

type UnionFind struct {
	parent []int
	rank   []int
}

func NewUnionFind(n int) *UnionFind {
	parent := make([]int, n)
	rank := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	return &UnionFind{parent: parent, rank: rank}
}

func (uf *UnionFind) Find(x int) int {
	if uf.parent[x] != x {
		uf.parent[x] = uf.Find(uf.parent[x]) // path compression
	}
	return uf.parent[x]
}

func (uf *UnionFind) Union(x, y int) bool {
	px, py := uf.Find(x), uf.Find(y)
	if px == py {
		return false // already connected
	}
	if uf.rank[px] < uf.rank[py] {
		px, py = py, px
	}
	uf.parent[py] = px
	if uf.rank[px] == uf.rank[py] {
		uf.rank[px]++
	}
	return true
}

func graphValidTree(n int, edges [][]int) bool {
	if len(edges) != n-1 {
		return false
	}
	uf := NewUnionFind(n)
	for _, e := range edges {
		if !uf.Union(e[0], e[1]) {
			return false // cycle detected
		}
	}
	return true
}

func main() {
	fmt.Println(graphValidTree(5, [][]int{{0, 1}, {0, 2}, {0, 3}, {1, 4}})) // true
	fmt.Println(graphValidTree(5, [][]int{{0, 1}, {1, 2}, {2, 3}, {1, 3}, {1, 4}})) // false
}
```

**Time Complexity:** O(n * alpha(n)) which is effectively O(n). **Space Complexity:** O(n).

#### Question 12: Design a Leaky Bucket Rate Limiter (Easy-Medium)

*Rate limiting is critical at Netflix's scale. The leaky bucket provides smooth rate enforcement.*

**Key Insight:** The leaky bucket drains at a constant rate. If the bucket overflows, the request is rejected. This smooths bursty traffic into a steady stream.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type LeakyBucket struct {
	mu         sync.Mutex
	capacity   float64
	rate       float64 // drain per second
	water      float64
	lastDrainAt time.Time
}

func NewLeakyBucket(capacity, ratePerSecond float64) *LeakyBucket {
	return &LeakyBucket{
		capacity:    capacity,
		rate:        ratePerSecond,
		lastDrainAt: time.Now(),
	}
}

func (lb *LeakyBucket) Allow() bool {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(lb.lastDrainAt).Seconds()
	lb.water -= elapsed * lb.rate
	if lb.water < 0 {
		lb.water = 0
	}
	lb.lastDrainAt = now

	if lb.water+1 > lb.capacity {
		return false
	}
	lb.water++
	return true
}

func main() {
	lb := NewLeakyBucket(5, 2) // 5 capacity, drains 2/sec

	for i := 0; i < 8; i++ {
		fmt.Printf("Request %d: %v\n", i+1, lb.Allow())
	}

	time.Sleep(2 * time.Second)
	fmt.Println("\nAfter 2 seconds:")
	for i := 0; i < 6; i++ {
		fmt.Printf("Request %d: %v\n", i+1, lb.Allow())
	}
}
```

**Time Complexity:** O(1). **Space Complexity:** O(1).

#### Question 13: LFU Cache for Content Popularity Tracking (Hard)

*Netflix tracks content popularity using frequency-based caching. LFU evicts the least frequently used item.*

**Key Insight:** Maintain a frequency-to-keys mapping alongside key-to-value and key-to-frequency maps. Track the minimum frequency to find eviction candidates in O(1).

```go
package main

import (
	"container/list"
	"fmt"
)

type LFUCache struct {
	capacity   int
	minFreq    int
	keyVal     map[int]int
	keyFreq    map[int]int
	freqKeys   map[int]*list.List
	keyElement map[int]*list.Element
}

func NewLFUCache(capacity int) *LFUCache {
	return &LFUCache{
		capacity:   capacity,
		keyVal:     make(map[int]int),
		keyFreq:    make(map[int]int),
		freqKeys:   make(map[int]*list.List),
		keyElement: make(map[int]*list.Element),
	}
}

func (c *LFUCache) Get(key int) int {
	val, ok := c.keyVal[key]
	if !ok {
		return -1
	}
	c.incrementFreq(key)
	return val
}

func (c *LFUCache) Put(key, value int) {
	if c.capacity == 0 {
		return
	}

	if _, ok := c.keyVal[key]; ok {
		c.keyVal[key] = value
		c.incrementFreq(key)
		return
	}

	if len(c.keyVal) >= c.capacity {
		c.evict()
	}

	c.keyVal[key] = value
	c.keyFreq[key] = 1
	c.minFreq = 1

	if c.freqKeys[1] == nil {
		c.freqKeys[1] = list.New()
	}
	elem := c.freqKeys[1].PushFront(key)
	c.keyElement[key] = elem
}

func (c *LFUCache) incrementFreq(key int) {
	freq := c.keyFreq[key]
	c.keyFreq[key] = freq + 1

	// Remove from current frequency list
	c.freqKeys[freq].Remove(c.keyElement[key])
	if c.freqKeys[freq].Len() == 0 {
		delete(c.freqKeys, freq)
		if c.minFreq == freq {
			c.minFreq++
		}
	}

	// Add to new frequency list
	newFreq := freq + 1
	if c.freqKeys[newFreq] == nil {
		c.freqKeys[newFreq] = list.New()
	}
	elem := c.freqKeys[newFreq].PushFront(key)
	c.keyElement[key] = elem
}

func (c *LFUCache) evict() {
	lst := c.freqKeys[c.minFreq]
	elem := lst.Back()
	key := elem.Value.(int)

	lst.Remove(elem)
	if lst.Len() == 0 {
		delete(c.freqKeys, c.minFreq)
	}

	delete(c.keyVal, key)
	delete(c.keyFreq, key)
	delete(c.keyElement, key)
}

func main() {
	cache := NewLFUCache(2)
	cache.Put(1, 1)
	cache.Put(2, 2)
	fmt.Println(cache.Get(1)) // 1 (freq of 1 is now 2)
	cache.Put(3, 3)           // evicts 2 (least frequent)
	fmt.Println(cache.Get(2)) // -1
	fmt.Println(cache.Get(3)) // 3
	cache.Put(4, 4)           // evicts 3 (freq 1 < freq 2 of key 1)
	fmt.Println(cache.Get(1)) // 1
	fmt.Println(cache.Get(3)) // -1
	fmt.Println(cache.Get(4)) // 4
}
```

**Time Complexity:** O(1) for Get and Put. **Space Complexity:** O(capacity).

#### Question 14: Design a Pub/Sub System with Topic Partitioning (Medium-Hard)

*Netflix's event-driven architecture relies heavily on pub/sub patterns for decoupled communication between microservices.*

**Key Insight:** Partition topics for parallelism. Each partition is assigned to one consumer in a consumer group, ensuring ordered processing within a partition.

```go
package main

import (
	"fmt"
	"hash/crc32"
	"sync"
)

type Message struct {
	Key   string
	Value any
}

type Partition struct {
	mu       sync.Mutex
	messages []Message
	offset   int
}

type Topic struct {
	mu         sync.RWMutex
	name       string
	partitions []*Partition
	numParts   int
}

func NewTopic(name string, numPartitions int) *Topic {
	parts := make([]*Partition, numPartitions)
	for i := range parts {
		parts[i] = &Partition{}
	}
	return &Topic{name: name, partitions: parts, numParts: numPartitions}
}

func (t *Topic) Publish(msg Message) int {
	partIdx := int(crc32.ChecksumIEEE([]byte(msg.Key))) % t.numParts

	t.partitions[partIdx].mu.Lock()
	defer t.partitions[partIdx].mu.Unlock()

	t.partitions[partIdx].messages = append(t.partitions[partIdx].messages, msg)
	return partIdx
}

func (t *Topic) Consume(partition, offset, maxCount int) ([]Message, int) {
	t.partitions[partition].mu.Lock()
	defer t.partitions[partition].mu.Unlock()

	msgs := t.partitions[partition].messages
	if offset >= len(msgs) {
		return nil, offset
	}

	end := offset + maxCount
	if end > len(msgs) {
		end = len(msgs)
	}

	result := make([]Message, end-offset)
	copy(result, msgs[offset:end])
	return result, end
}

func main() {
	topic := NewTopic("viewing-events", 4)

	events := []Message{
		{Key: "user-1", Value: "started Stranger Things"},
		{Key: "user-2", Value: "paused Wednesday"},
		{Key: "user-1", Value: "paused Stranger Things"},
		{Key: "user-3", Value: "started Squid Game"},
	}

	for _, e := range events {
		part := topic.Publish(e)
		fmt.Printf("Published to partition %d: %s -> %s\n", part, e.Key, e.Value)
	}

	// Consume from each partition
	for p := 0; p < 4; p++ {
		msgs, _ := topic.Consume(p, 0, 10)
		if len(msgs) > 0 {
			fmt.Printf("\nPartition %d:\n", p)
			for _, m := range msgs {
				fmt.Printf("  %s: %s\n", m.Key, m.Value)
			}
		}
	}
}
```

**Time Complexity:** O(1) for Publish, O(n) for Consume where n is messages consumed. **Space Complexity:** O(total messages).

#### Question 15: Alien Dictionary - Topological Sort (Hard)

*Netflix uses topological sorting for dependency resolution in their build and deployment systems.*

**Key Insight:** Build a directed graph from the lexicographic ordering implied by the word list. Topological sort (BFS with in-degree tracking) yields the character ordering.

```go
package main

import "fmt"

func alienOrder(words []string) string {
	// Build adjacency list and in-degree map
	inDegree := make(map[byte]int)
	adj := make(map[byte][]byte)

	// Initialize all characters
	for _, word := range words {
		for i := 0; i < len(word); i++ {
			if _, ok := inDegree[word[i]]; !ok {
				inDegree[word[i]] = 0
			}
		}
	}

	// Compare adjacent words to derive ordering
	for i := 0; i < len(words)-1; i++ {
		w1, w2 := words[i], words[i+1]
		minLen := len(w1)
		if len(w2) < minLen {
			minLen = len(w2)
		}

		// Check for invalid case: prefix is longer
		if len(w1) > len(w2) && w1[:minLen] == w2[:minLen] {
			return ""
		}

		for j := 0; j < minLen; j++ {
			if w1[j] != w2[j] {
				adj[w1[j]] = append(adj[w1[j]], w2[j])
				inDegree[w2[j]]++
				break
			}
		}
	}

	// BFS topological sort
	queue := make([]byte, 0)
	for ch, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, ch)
		}
	}

	var result []byte
	for len(queue) > 0 {
		ch := queue[0]
		queue = queue[1:]
		result = append(result, ch)

		for _, next := range adj[ch] {
			inDegree[next]--
			if inDegree[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	if len(result) != len(inDegree) {
		return "" // cycle detected
	}
	return string(result)
}

func main() {
	fmt.Println(alienOrder([]string{"wrt", "wrf", "er", "ett", "rftt"}))
	// "wertf"
}
```

**Time Complexity:** O(C) where C is total characters across all words. **Space Complexity:** O(V + E) where V is unique characters and E is ordering relationships.

#### Question 16: Design a Chaos Engineering Fault Injector (Medium - Netflix-Specific)

*Netflix pioneered chaos engineering. This tests whether you understand controlled failure injection.*

**Key Insight:** The fault injector intercepts requests based on configurable rules and injects failures (latency, errors, resource exhaustion) with blast radius controls to limit impact.

```go
package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"sync"
	"time"
)

type FaultType int

const (
	FaultLatency FaultType = iota
	FaultError
	FaultTimeout
)

type FaultRule struct {
	Service    string
	FaultType  FaultType
	Percentage float64 // 0.0-1.0
	Latency    time.Duration
	ErrorMsg   string
	Active     bool
}

type FaultInjector struct {
	mu    sync.RWMutex
	rules map[string]*FaultRule
}

func NewFaultInjector() *FaultInjector {
	return &FaultInjector{rules: make(map[string]*FaultRule)}
}

func (fi *FaultInjector) AddRule(rule *FaultRule) {
	fi.mu.Lock()
	defer fi.mu.Unlock()
	fi.rules[rule.Service] = rule
}

func (fi *FaultInjector) RemoveRule(service string) {
	fi.mu.Lock()
	defer fi.mu.Unlock()
	delete(fi.rules, service)
}

// Intercept applies fault injection rules before executing the actual call.
func (fi *FaultInjector) Intercept(ctx context.Context, service string, fn func(context.Context) error) error {
	fi.mu.RLock()
	rule, ok := fi.rules[service]
	fi.mu.RUnlock()

	if !ok || !rule.Active || rand.Float64() > rule.Percentage {
		return fn(ctx) // no injection
	}

	switch rule.FaultType {
	case FaultLatency:
		select {
		case <-time.After(rule.Latency):
		case <-ctx.Done():
			return ctx.Err()
		}
		return fn(ctx)

	case FaultError:
		return fmt.Errorf("injected fault: %s", rule.ErrorMsg)

	case FaultTimeout:
		timeoutCtx, cancel := context.WithTimeout(ctx, 1*time.Millisecond)
		defer cancel()
		return fn(timeoutCtx)

	default:
		return fn(ctx)
	}
}

func main() {
	fi := NewFaultInjector()
	fi.AddRule(&FaultRule{
		Service:    "payment-service",
		FaultType:  FaultError,
		Percentage: 0.5,
		ErrorMsg:   "simulated payment failure",
		Active:     true,
	})

	for i := 0; i < 10; i++ {
		err := fi.Intercept(context.Background(), "payment-service", func(ctx context.Context) error {
			return nil // successful call
		})
		if err != nil {
			fmt.Printf("Request %d: FAULT - %v\n", i+1, err)
		} else {
			fmt.Printf("Request %d: OK\n", i+1)
		}
	}
}
```

**Time Complexity:** O(1) per interception. **Space Complexity:** O(r) where r is the number of rules.

#### Question 17: Serialize and Deserialize Binary Tree (Medium)

*Serialization appears in Netflix's data pipeline for efficiently transmitting tree-structured data between services.*

**Key Insight:** Preorder traversal with nil markers. Use a delimiter between values. Deserialization consumes tokens sequentially from the preorder sequence.

```go
package main

import (
	"fmt"
	"strconv"
	"strings"
)

type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

type Codec struct{}

func (c *Codec) Serialize(root *TreeNode) string {
	var parts []string
	var build func(node *TreeNode)
	build = func(node *TreeNode) {
		if node == nil {
			parts = append(parts, "#")
			return
		}
		parts = append(parts, strconv.Itoa(node.Val))
		build(node.Left)
		build(node.Right)
	}
	build(root)
	return strings.Join(parts, ",")
}

func (c *Codec) Deserialize(data string) *TreeNode {
	parts := strings.Split(data, ",")
	idx := 0

	var build func() *TreeNode
	build = func() *TreeNode {
		if idx >= len(parts) || parts[idx] == "#" {
			idx++
			return nil
		}
		val, _ := strconv.Atoi(parts[idx])
		idx++
		return &TreeNode{Val: val, Left: build(), Right: build()}
	}

	return build()
}

func main() {
	root := &TreeNode{1,
		&TreeNode{2, nil, nil},
		&TreeNode{3, &TreeNode{4, nil, nil}, &TreeNode{5, nil, nil}},
	}

	codec := &Codec{}
	serialized := codec.Serialize(root)
	fmt.Println("Serialized:", serialized)

	deserialized := codec.Deserialize(serialized)
	fmt.Println("Reserialized:", codec.Serialize(deserialized))
}
```

**Time Complexity:** O(n) for both operations. **Space Complexity:** O(n).

#### Question 18: Word Search II - Trie-Backed Board Search (Hard)

*Netflix uses trie-based search in their content discovery and search ranking systems.*

**Key Insight:** Build a trie from the word list, then DFS on the board. The trie prunes search paths early - if no word in the dictionary starts with the current prefix, stop exploring.

```go
package main

import "fmt"

type trieNode struct {
	children [26]*trieNode
	word     string
}

func findWords(board [][]byte, words []string) []string {
	root := &trieNode{}
	for _, w := range words {
		node := root
		for _, ch := range w {
			idx := ch - 'a'
			if node.children[idx] == nil {
				node.children[idx] = &trieNode{}
			}
			node = node.children[idx]
		}
		node.word = w
	}

	rows, cols := len(board), len(board[0])
	var result []string

	var dfs func(r, c int, node *trieNode)
	dfs = func(r, c int, node *trieNode) {
		if r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] == '#' {
			return
		}

		ch := board[r][c]
		next := node.children[ch-'a']
		if next == nil {
			return
		}

		if next.word != "" {
			result = append(result, next.word)
			next.word = "" // deduplicate
		}

		board[r][c] = '#' // mark visited
		dfs(r+1, c, next)
		dfs(r-1, c, next)
		dfs(r, c+1, next)
		dfs(r, c-1, next)
		board[r][c] = ch // restore
	}

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			dfs(r, c, root)
		}
	}
	return result
}

func main() {
	board := [][]byte{
		{'o', 'a', 'a', 'n'},
		{'e', 't', 'a', 'e'},
		{'i', 'h', 'k', 'r'},
		{'i', 'f', 'l', 'v'},
	}
	words := []string{"oath", "pea", "eat", "rain"}
	fmt.Println(findWords(board, words)) // [oath, eat]
}
```

**Time Complexity:** O(M * N * 4^L) where M*N is board size and L is max word length. **Space Complexity:** O(sum of word lengths) for the trie.

#### Question 19: Design a Distributed Rate Limiter (Hard)

*Netflix needs rate limiting across hundreds of service instances. This tests distributed systems thinking.*

**Key Insight:** Use a centralized token bucket with local caching. Each instance pre-fetches a batch of tokens to reduce contention, falling back to the central store when the local cache is exhausted.

```go
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// CentralTokenStore simulates a distributed token store (e.g., Redis).
type CentralTokenStore struct {
	mu       sync.Mutex
	tokens   map[string]int64
	maxRate  int64
	interval time.Duration
	lastRefill map[string]time.Time
}

func NewCentralTokenStore(maxRate int64, interval time.Duration) *CentralTokenStore {
	return &CentralTokenStore{
		tokens:     make(map[string]int64),
		maxRate:    maxRate,
		interval:   interval,
		lastRefill: make(map[string]time.Time),
	}
}

func (s *CentralTokenStore) AcquireTokens(key string, requested int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if last, ok := s.lastRefill[key]; ok {
		elapsed := now.Sub(last)
		refill := int64(elapsed.Seconds() * float64(s.maxRate) / s.interval.Seconds())
		s.tokens[key] += refill
		if s.tokens[key] > s.maxRate {
			s.tokens[key] = s.maxRate
		}
	} else {
		s.tokens[key] = s.maxRate
	}
	s.lastRefill[key] = now

	granted := requested
	if granted > s.tokens[key] {
		granted = s.tokens[key]
	}
	s.tokens[key] -= granted
	return granted
}

// LocalRateLimiter caches tokens locally to reduce central store calls.
type LocalRateLimiter struct {
	localTokens atomic.Int64
	batchSize   int64
	store       *CentralTokenStore
	key         string
	mu          sync.Mutex
}

func NewLocalRateLimiter(store *CentralTokenStore, key string, batchSize int64) *LocalRateLimiter {
	return &LocalRateLimiter{
		store:     store,
		key:       key,
		batchSize: batchSize,
	}
}

func (l *LocalRateLimiter) Allow() bool {
	if l.localTokens.Add(-1) >= 0 {
		return true
	}

	// Refetch from central store
	l.mu.Lock()
	defer l.mu.Unlock()

	// Double-check after acquiring lock
	if l.localTokens.Load() > 0 {
		return l.localTokens.Add(-1) >= 0
	}

	granted := l.store.AcquireTokens(l.key, l.batchSize)
	if granted == 0 {
		l.localTokens.Store(0)
		return false
	}
	l.localTokens.Store(granted - 1) // -1 for current request
	return true
}

func main() {
	store := NewCentralTokenStore(100, time.Second)

	// Simulate 3 service instances sharing the rate limit
	limiters := make([]*LocalRateLimiter, 3)
	for i := range limiters {
		limiters[i] = NewLocalRateLimiter(store, "api:/v1/content", 10)
	}

	var wg sync.WaitGroup
	var totalAllowed atomic.Int64

	for i, limiter := range limiters {
		wg.Add(1)
		go func(id int, l *LocalRateLimiter) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				if l.Allow() {
					totalAllowed.Add(1)
				}
			}
		}(i, limiter)
	}

	wg.Wait()
	fmt.Printf("Total allowed: %d / 150 attempted (limit: 100/sec)\n", totalAllowed.Load())
}
```

**Time Complexity:** O(1) amortized per Allow call. **Space Complexity:** O(keys) for the central store.

#### Question 20: Design a Content Recommendation Engine (Hard - Netflix-Specific)

*This is a simplified version of Netflix's actual recommendation problem. It tests algorithmic thinking applied to a real business domain.*

**Key Insight:** Combine collaborative filtering (users who watched X also watched Y) with content-based similarity (genre, actors, director). Weight by recency and engagement depth (finished watching vs. abandoned).

```go
package main

import (
	"fmt"
	"math"
	"sort"
)

// ViewingRecord represents a user's interaction with content.
type ViewingRecord struct {
	ContentID    string
	WatchedPct   float64 // 0.0-1.0
	Rating       float64 // 1-5, 0 if unrated
	DaysAgo      int
}

// ContentMeta holds content metadata for content-based filtering.
type ContentMeta struct {
	ID     string
	Genres []string
	Tags   []string
}

// RecommendationEngine combines collaborative and content-based filtering.
type RecommendationEngine struct {
	userHistory map[string][]ViewingRecord     // userID -> history
	contentMeta map[string]*ContentMeta        // contentID -> metadata
	coWatch     map[string]map[string]float64  // contentA -> contentB -> score
}

func NewRecommendationEngine() *RecommendationEngine {
	return &RecommendationEngine{
		userHistory: make(map[string][]ViewingRecord),
		contentMeta: make(map[string]*ContentMeta),
		coWatch:     make(map[string]map[string]float64),
	}
}

func (re *RecommendationEngine) AddViewing(userID string, record ViewingRecord) {
	re.userHistory[userID] = append(re.userHistory[userID], record)
}

func (re *RecommendationEngine) AddContent(meta *ContentMeta) {
	re.contentMeta[meta.ID] = meta
}

// BuildCoWatchMatrix computes the co-watching similarity matrix from all user histories.
func (re *RecommendationEngine) BuildCoWatchMatrix() {
	for _, history := range re.userHistory {
		for i := 0; i < len(history); i++ {
			for j := i + 1; j < len(history); j++ {
				a, b := history[i].ContentID, history[j].ContentID
				score := re.engagementScore(history[i]) * re.engagementScore(history[j])

				if re.coWatch[a] == nil {
					re.coWatch[a] = make(map[string]float64)
				}
				if re.coWatch[b] == nil {
					re.coWatch[b] = make(map[string]float64)
				}
				re.coWatch[a][b] += score
				re.coWatch[b][a] += score
			}
		}
	}
}

func (re *RecommendationEngine) engagementScore(record ViewingRecord) float64 {
	// Higher score for completed viewing and recent watches
	completionWeight := record.WatchedPct
	recencyWeight := 1.0 / (1.0 + math.Log(float64(record.DaysAgo+1)))
	ratingWeight := 1.0
	if record.Rating > 0 {
		ratingWeight = record.Rating / 5.0
	}
	return completionWeight * recencyWeight * ratingWeight
}

func (re *RecommendationEngine) genreSimilarity(a, b *ContentMeta) float64 {
	if a == nil || b == nil {
		return 0
	}
	genresA := make(map[string]bool)
	for _, g := range a.Genres {
		genresA[g] = true
	}
	overlap := 0
	for _, g := range b.Genres {
		if genresA[g] {
			overlap++
		}
	}
	total := len(a.Genres) + len(b.Genres) - overlap
	if total == 0 {
		return 0
	}
	return float64(overlap) / float64(total) // Jaccard similarity
}

type Recommendation struct {
	ContentID string
	Score     float64
}

// Recommend returns top-k content recommendations for a user.
func (re *RecommendationEngine) Recommend(userID string, k int) []Recommendation {
	history := re.userHistory[userID]
	watched := make(map[string]bool)
	for _, h := range history {
		watched[h.ContentID] = true
	}

	scores := make(map[string]float64)

	for _, h := range history {
		engagement := re.engagementScore(h)

		// Collaborative filtering signal
		for candidate, coScore := range re.coWatch[h.ContentID] {
			if !watched[candidate] {
				scores[candidate] += coScore * engagement * 0.7 // 70% weight
			}
		}

		// Content-based similarity signal
		sourceMeta := re.contentMeta[h.ContentID]
		for contentID, meta := range re.contentMeta {
			if !watched[contentID] {
				similarity := re.genreSimilarity(sourceMeta, meta)
				scores[contentID] += similarity * engagement * 0.3 // 30% weight
			}
		}
	}

	recs := make([]Recommendation, 0, len(scores))
	for id, score := range scores {
		recs = append(recs, Recommendation{id, score})
	}
	sort.Slice(recs, func(i, j int) bool {
		return recs[i].Score > recs[j].Score
	})

	if len(recs) > k {
		recs = recs[:k]
	}
	return recs
}

func main() {
	engine := NewRecommendationEngine()

	engine.AddContent(&ContentMeta{ID: "stranger-things", Genres: []string{"sci-fi", "horror", "drama"}})
	engine.AddContent(&ContentMeta{ID: "dark", Genres: []string{"sci-fi", "mystery", "drama"}})
	engine.AddContent(&ContentMeta{ID: "wednesday", Genres: []string{"comedy", "horror", "mystery"}})
	engine.AddContent(&ContentMeta{ID: "squid-game", Genres: []string{"thriller", "drama"}})
	engine.AddContent(&ContentMeta{ID: "black-mirror", Genres: []string{"sci-fi", "thriller", "drama"}})

	engine.AddViewing("user-1", ViewingRecord{"stranger-things", 1.0, 4.5, 2})
	engine.AddViewing("user-1", ViewingRecord{"dark", 0.8, 4.0, 10})
	engine.AddViewing("user-2", ViewingRecord{"stranger-things", 1.0, 5.0, 5})
	engine.AddViewing("user-2", ViewingRecord{"black-mirror", 0.9, 4.0, 7})
	engine.AddViewing("user-2", ViewingRecord{"squid-game", 1.0, 3.5, 1})

	engine.BuildCoWatchMatrix()

	recs := engine.Recommend("user-1", 3)
	fmt.Println("Recommendations for user-1:")
	for _, r := range recs {
		fmt.Printf("  %s (score: %.3f)\n", r.ContentID, r.Score)
	}
}
```

**Time Complexity:** O(H^2) for BuildCoWatchMatrix where H is total viewing records. O(H * C) for Recommend where C is content catalog size. **Space Complexity:** O(C^2) for the co-watch matrix.

### System Design Topics Netflix Favors

**Top 5 System Design Questions Asked at Netflix:**

1. **Design Netflix's Video Streaming Pipeline** - The end-to-end flow from content ingestion through encoding, packaging, CDN distribution, and adaptive bitrate playback. Netflix expects you to understand per-title encoding optimization (different titles need different encoding ladders), Open Connect CDN architecture (appliances inside ISP networks), and DASH/HLS packaging. This question can easily fill two hours - they go deep.

2. **Design a Recommendation Engine** - Collaborative filtering, content-based filtering, hybrid approaches. Netflix expects you to understand the cold start problem, the explore-exploit tradeoff, A/B testing of recommendation algorithms, and how to serve recommendations at low latency for 270M+ users. Discuss offline model training vs. real-time feature computation.

3. **Design a Chaos Engineering Platform** - Failure injection at scale with blast radius control. Topics include: how to safely inject failures in production, canary analysis to detect impact, automated rollback, and how to handle failures in the chaos engineering platform itself. Netflix expects deep understanding because they pioneered this field.

4. **Design Netflix's A/B Testing Framework** - Netflix runs hundreds of concurrent A/B tests. Design the assignment system (deterministic bucketing), metrics collection pipeline, statistical analysis engine, and interaction detection (when two tests interfere with each other). This tests both systems thinking and statistical understanding.

5. **Design a Content Delivery Network** - Specifically, design Open Connect - Netflix's approach of placing CDN appliances inside ISP networks. Cover content placement algorithms (which titles go on which appliances), cache warming strategies, failover between CDN tiers, and how to handle the "new popular show" problem (sudden demand spike for newly released content).

**How deep they go:** With TWO system design rounds, Netflix goes deeper than any other company. Expect to spend 15-20 minutes on high-level architecture, then 25-30 minutes drilling into specific components. An interviewer might say "Let's focus on the encoding pipeline specifically. Walk me through how you would handle per-title encoding optimization - how do you determine the optimal encoding ladder for each title?"

**What they look for:** Trade-off articulation with quantitative reasoning. Understanding of failure modes and resilience patterns. Awareness of Netflix-specific challenges (content popularity distribution follows a heavy-tailed curve, regional content licensing, device heterogeneity). Production-readiness signals: monitoring, alerting, graceful degradation, rollback procedures.

### Behavioral Focus

Netflix's behavioral interviews evaluate their core culture principles with specific, probing questions.

**Freedom and Responsibility:**
- "Describe a time you made a significant technical decision without seeking approval. What was the outcome?"
- "Tell me about a time you were given complete freedom on a project. How did you structure your work?"
- "How do you decide when to ask for permission versus asking for forgiveness?"
- Netflix wants to hear that you are self-directed, make sound independent judgments, and take ownership of outcomes - both good and bad. The worst answer is one where you waited for someone to tell you what to do.

**Judgment and Curiosity:**
- "Tell me about a time you identified a problem no one else saw. How did you convince others it was important?"
- "Describe a technology you learned recently that changed how you think about a problem."
- "How do you decide what to work on when you have multiple competing priorities and no one is directing your work?"
- Netflix values engineers who are intellectually curious, who question assumptions, and who can prioritize by impact rather than urgency.

**Radical Candor and Communication:**
- "Tell me about a time you gave difficult feedback to a senior engineer or manager."
- "Describe a situation where you disagreed with a technical decision. How did you handle it?"
- "How do you communicate bad news - a project delay, a production incident you caused, a mistake in your design?"
- Netflix values direct, honest communication. They want to hear that you speak up when something is wrong, that you give feedback without softening it into meaninglessness, and that you can receive feedback without becoming defensive.

### Preparation Timeline (10-12 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Culture Deep Dive | 2-3h | Read Netflix culture doc (multiple times). Watch Netflix tech blog talks. Prepare 10+ culture stories aligned to F&R values. Research the specific team's domain. |
| 3-4 | System Design (Streaming) | 4h | CDN architecture, adaptive bitrate, encoding pipelines. Study Netflix's published papers on per-title encoding. Design Netflix-specific systems. |
| 5-6 | System Design (Infrastructure) | 4h | Microservices patterns, chaos engineering, observability at scale. Circuit breakers, bulkheads, and resilience patterns. Review Chapter 80. |
| 7-8 | Coding (Production Quality) | 3-4h | Focus on practical problems with full error handling, testing design, and observability hooks. Build small systems: circuit breaker, rate limiter, worker pool. |
| 9-10 | Go Infrastructure | 3h | Build complete microservice prototypes. Concurrency patterns, channel-based architectures. Study Go performance optimization. |
| 11-12 | Integration + Mock Interviews | 3-4h | Full mock interviews with combined system design + culture rounds. Practice articulating trade-offs. Simulate the hiring manager screen. |

**Key differences from generic FAANG prep:** Netflix preparation should be weighted 40% system design, 30% culture, 30% coding - almost the inverse of Google prep. The culture preparation is non-negotiable and takes weeks, not hours. System design preparation should focus on streaming and infrastructure domains specifically, not generic "design Twitter" questions.

### Insider Tips

**What most candidates get wrong:**
- Treating the culture rounds as soft, easy rounds. Netflix culture rounds are the most rigorous behavioral interviews in the industry. Candidates who prepare 20 STAR stories for Amazon but bring only generic behavioral answers to Netflix get rejected.
- Approaching coding rounds like LeetCode contests. Netflix does not care about speed - they care about production quality. Code that works but has no error handling, no testing consideration, and no observability hooks signals a junior engineer.
- Designing systems at Google scale when Netflix scale is different. Netflix has 270M subscribers (not 2 billion like Google users). Their challenges are different: heavy-tailed content popularity, bandwidth-intensive workloads, device heterogeneity. Generic system designs that do not account for Netflix's specific characteristics fall flat.

**What makes a "strong hire" signal:**
- Demonstrating genuine autonomy: "I identified the problem, proposed the solution, got buy-in, implemented it, measured the outcome, and iterated." This is the Netflix engineering narrative.
- Production-quality thinking in every answer: "Here is the happy path, here are the failure modes, here is how I would monitor it, here is how I would roll it back."
- Deep understanding of distributed systems trade-offs, articulated quantitatively: "This adds 50ms P99 latency but reduces the blast radius from regional to per-AZ."
- Intellectual curiosity demonstrated through follow-up questions and explorations: "I noticed your CDN uses Open Connect - does the placement algorithm account for ISP peering changes?"

**Red flags that lead to rejection:**
- Needing hand-holding or validation. If you ask "Is this the right approach?" instead of "I'm choosing approach A because of X and Y - let me walk you through the trade-offs," Netflix sees a junior engineer.
- Avoiding conflict or giving diplomatic non-answers in culture rounds. Netflix values radical candor. "I respectfully disagreed but ultimately deferred to my manager" is a weak answer. "I built a prototype proving my approach was 3x faster and presented the data" is strong.
- Surface-level system design with no depth. Saying "I would use Kafka for messaging" without being able to discuss partitioning strategy, consumer group management, and exactly-once semantics is insufficient.

**How to stand out from other candidates:**
- Read Netflix's tech blog (netflixtechblog.com) thoroughly. Reference specific Netflix papers, tools, or approaches in your answers. "I read about how Netflix uses Zuul for edge routing and I think a similar approach would work here" demonstrates genuine interest.
- Build something related to Netflix's domain before the interview. A personal project implementing adaptive bitrate streaming, chaos engineering, or content recommendation demonstrates alignment.
- In system design, proactively address failure modes. Netflix expects you to think about what goes wrong before the interviewer asks. "Before we move on, let me walk through the failure scenarios for this component."


### Junior → FAANG: Preparing for Netflix Interviews

Netflix's culture is unusual among FAANG companies: high performance expectations, radical transparency, and a 'freedom and responsibility' model that gives engineers significant autonomy alongside accountability for results. Coding interviews at Netflix are not as heavy on algorithmic puzzles as Google. They tend to be more practical and systems-oriented. Know Netflix's engineering challenges (streaming at scale, content delivery, personalization) and be prepared to discuss distributed systems problems in depth.

### Senior @ FAANG: Netflix Senior Engineer: Freedom and Responsibility at Scale

At the senior level, Netflix's culture creates a specific interview dynamic: the interviewer is assessing whether you can operate effectively in a high-autonomy, high-accountability environment. Stories that demonstrate you needed significant external direction or that you escalated decisions upward frequently will signal a poor fit. Strong Netflix senior stories demonstrate independent judgment in ambiguous situations, a track record of setting your own standards rather than following prescribed processes, and a clear mental model of when to escalate versus when to decide. Netflix also uses a keeper test in performance management: would your manager fight to keep you if you were leaving? Interview preparation should include stories that demonstrate the keeper test standard: irreplaceable expertise, delivered results, and a collaborative approach that made others around you more effective.

---
