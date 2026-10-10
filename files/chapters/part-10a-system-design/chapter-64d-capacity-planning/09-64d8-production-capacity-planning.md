## 64D.8 Production Capacity Planning

### Capacity Runway

**Definition**: How long until you run out of a resource at current growth rate.

```
Capacity Runway = (Current Capacity - Current Usage) / Growth Rate

Example:
- PostgreSQL primary: 10,000 QPS capacity
- Current usage: 3,000 QPS
- Growth rate: 15% per month

Monthly growth in absolute QPS:
Month 1: 3,000 × 1.15 = 3,450 (+450 QPS)
Month 2: 3,450 × 1.15 = 3,968 (+518 QPS)
...

Runway = months until 10,000 QPS is hit
At 15%/month compound: 10,000 = 3,000 × 1.15^n
1.15^n = 3.33
n = log(3.33) / log(1.15) = 8.8 months

Action needed by: today minus (8.8 months - buffer)
If you want 3 months to implement a solution, act at month 5.8
```

**Go tool for capacity runway calculation**:

```go
package capacity

import (
    "math"
    "time"
)

// RunwayConfig describes a resource's current state and growth.
type RunwayConfig struct {
    ResourceName    string
    CurrentUsage    float64
    TotalCapacity   float64
    MaxSafeUsage    float64   // e.g., 0.70 for 70% utilization target
    MonthlyGrowthPct float64  // e.g., 0.15 for 15% growth
}

// RunwayResult describes when a resource will be exhausted.
type RunwayResult struct {
    ResourceName       string
    CurrentUsagePct    float64
    MonthsToSoftLimit  float64 // Months until max safe utilization
    MonthsToHardLimit  float64 // Months until total capacity
    SoftLimitDate      time.Time
    HardLimitDate      time.Time
    ActionRequired     bool
    ActionByDate       time.Time // When to start capacity work (hard - 3 months)
}

// Calculate computes the capacity runway for a resource.
func Calculate(cfg RunwayConfig) RunwayResult {
    softLimit := cfg.TotalCapacity * cfg.MaxSafeUsage

    monthsToSoft := monthsUntil(cfg.CurrentUsage, softLimit, cfg.MonthlyGrowthPct)
    monthsToHard := monthsUntil(cfg.CurrentUsage, cfg.TotalCapacity, cfg.MonthlyGrowthPct)

    now := time.Now()
    planningLeadMonths := 3.0 // We need 3 months to provision capacity

    result := RunwayResult{
        ResourceName:      cfg.ResourceName,
        CurrentUsagePct:   cfg.CurrentUsage / cfg.TotalCapacity,
        MonthsToSoftLimit: monthsToSoft,
        MonthsToHardLimit: monthsToHard,
        SoftLimitDate:     now.AddDate(0, int(monthsToSoft), 0),
        HardLimitDate:     now.AddDate(0, int(monthsToHard), 0),
    }

    actionByMonths := monthsToHard - planningLeadMonths
    if actionByMonths < planningLeadMonths {
        result.ActionRequired = true
        result.ActionByDate = now.AddDate(0, int(math.Max(actionByMonths, 0)), 0)
    }

    return result
}

// monthsUntil calculates months until current grows to target at monthlyGrowth rate.
func monthsUntil(current, target, monthlyGrowthRate float64) float64 {
    if current >= target {
        return 0 // Already exceeded
    }
    // n = log(target/current) / log(1 + growth_rate)
    return math.Log(target/current) / math.Log(1+monthlyGrowthRate)
}
```

### Headroom Targets

A healthy production system runs at 40-60% utilization. This seems wasteful - why not run at 90%? The reasons:

1. **Traffic spikes**: Marketing campaigns, viral events, and external triggers can double traffic instantly. At 70% baseline, a 2x spike takes you to 140% - service failure.

2. **Rolling deployments**: During a deployment, some servers are out of rotation. If you run 16 servers at 90%, taking 2 out during a rolling deploy leaves 14 servers handling 100% of traffic - each at 103% capacity.

3. **Hardware failures**: In a large fleet, hardware fails regularly. At 50% utilization, losing 10% of servers means remaining servers handle 56% utilization. At 80% utilization, the same failure means 89% - dangerously close to saturation.

4. **Latency characteristics**: Many systems (databases, queues, load balancers) experience nonlinear latency increases as utilization approaches 100%. At 70% utilization, latency is predictable. At 90%, it may be 2-5x higher.

**Headroom targets by resource**:

```
Resource                    Target Utilization    Maximum Tolerated
─────────────────────────────────────────────────────────────────────
CPU (application servers)   50-60%               80%
Memory                      70-80%               90%
Disk (database data)        60-70%               85%
Network                     30-40%               60%
Database connections        60-70%               85%
Kafka consumer lag          < 60s                < 300s
```

### Load Testing in Go

Load testing establishes performance baselines and validates capacity estimates before you need them in production.

**Option 1: k6 (recommended for most teams)**

k6 is a developer-friendly load testing tool with a JavaScript API. It integrates with Grafana and generates clean reports.

```javascript
// k6 script: load_test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    // Ramp up to 1000 virtual users over 2 minutes,
    // hold for 5 minutes, then ramp down
    stages: [
        { duration: '2m', target: 1000 },
        { duration: '5m', target: 1000 },
        { duration: '1m', target: 0 },
    ],
    thresholds: {
        // 95% of requests must complete below 100ms
        'http_req_duration': ['p(95)<100'],
        // Error rate must stay below 1%
        'http_req_failed': ['rate<0.01'],
    },
};

export default function() {
    const response = http.get('https://your-service.example.com/api/v1/health');
    check(response, {
        'status is 200': (r) => r.status === 200,
        'response time < 50ms': (r) => r.timings.duration < 50,
    });
    sleep(1);
}
```

**Option 2: Custom Go load tester**

For fine-grained control and integration with internal tooling:

```go
package loadtest

import (
    "context"
    "fmt"
    "net/http"
    "slices"
    "sync"
    "sync/atomic"
    "time"
)

// LoadTestConfig defines the test parameters.
type LoadTestConfig struct {
    TargetURL     string
    Concurrency   int           // Number of concurrent goroutines
    Duration      time.Duration // How long to run
    RampUpTime    time.Duration // Time to reach full concurrency
    Timeout       time.Duration // Per-request timeout
}

// LoadTestResult holds the test results.
type LoadTestResult struct {
    TotalRequests   int64
    Successful      int64
    Failed          int64
    Duration        time.Duration
    RPS             float64
    LatencyP50      time.Duration
    LatencyP95      time.Duration
    LatencyP99      time.Duration
    ErrorRate       float64
}

// LoadTester runs a configurable load test.
type LoadTester struct {
    config    LoadTestConfig
    client    *http.Client
    latencies []time.Duration
    mu        sync.Mutex
    total     atomic.Int64
    success   atomic.Int64
    failed    atomic.Int64
}

// NewLoadTester creates a load tester with the given configuration.
func NewLoadTester(config LoadTestConfig) *LoadTester {
    return &LoadTester{
        config: config,
        client: &http.Client{
            Timeout: config.Timeout,
            Transport: &http.Transport{
                MaxIdleConnsPerHost: config.Concurrency,
            },
        },
    }
}

// Run executes the load test and returns results.
func (lt *LoadTester) Run(ctx context.Context) (*LoadTestResult, error) {
    start := time.Now()
    deadline := start.Add(lt.config.Duration)

    // Ramp up: add workers gradually
    workerInterval := lt.config.RampUpTime / time.Duration(lt.config.Concurrency)

    var wg sync.WaitGroup
    for i := 0; i < lt.config.Concurrency; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            lt.worker(ctx, deadline)
        }()

        // Ramp up delay
        if lt.config.RampUpTime > 0 {
            time.Sleep(workerInterval)
        }
    }

    wg.Wait()
    testDuration := time.Since(start)

    result := lt.computeResult(testDuration)
    return result, nil
}

// worker is a single load test goroutine that fires requests until deadline.
func (lt *LoadTester) worker(ctx context.Context, deadline time.Time) {
    for time.Now().Before(deadline) {
        select {
        case <-ctx.Done():
            return
        default:
        }

        start := time.Now()
        resp, err := lt.client.Get(lt.config.TargetURL)
        latency := time.Since(start)

        lt.total.Add(1)

        if err != nil || resp.StatusCode >= 400 {
            lt.failed.Add(1)
        } else {
            lt.success.Add(1)
            lt.mu.Lock()
            lt.latencies = append(lt.latencies, latency)
            lt.mu.Unlock()
        }

        if resp != nil {
            resp.Body.Close()
        }
    }
}

// computeResult aggregates metrics from all workers.
func (lt *LoadTester) computeResult(duration time.Duration) *LoadTestResult {
    lt.mu.Lock()
    latencies := make([]time.Duration, len(lt.latencies))
    copy(latencies, lt.latencies)
    lt.mu.Unlock()

    total := lt.total.Load()
    success := lt.success.Load()
    failed := lt.failed.Load()

    var p50, p95, p99 time.Duration
    if len(latencies) > 0 {
        slices.Sort(latencies)
        p50 = latencies[len(latencies)*50/100]
        p95 = latencies[len(latencies)*95/100]
        p99 = latencies[len(latencies)*99/100]
    }

    return &LoadTestResult{
        TotalRequests: total,
        Successful:    success,
        Failed:        failed,
        Duration:      duration,
        RPS:           float64(total) / duration.Seconds(),
        LatencyP50:    p50,
        LatencyP95:    p95,
        LatencyP99:    p99,
        ErrorRate:     float64(failed) / float64(total),
    }
}

func (r *LoadTestResult) String() string {
    return fmt.Sprintf(`
Load Test Results
─────────────────────────────────
Total Requests:  %d
Successful:      %d (%.1f%%)
Failed:          %d (%.1f%% error rate)
Duration:        %s
RPS:             %.0f

Latency:
  P50:  %s
  P95:  %s
  P99:  %s
`,
        r.TotalRequests,
        r.Successful, float64(r.Successful)/float64(r.TotalRequests)*100,
        r.Failed, r.ErrorRate*100,
        r.Duration.Round(time.Second),
        r.RPS,
        r.LatencyP50.Round(time.Millisecond),
        r.LatencyP95.Round(time.Millisecond),
        r.LatencyP99.Round(time.Millisecond),
    )
}
```

### Auto-Scaling Limits and Costs

Auto-scaling solves the immediate capacity problem but introduces new constraints:

**Scaling limits**:
- AWS EC2 auto-scaling: configures min/max instance counts, and scale-out takes 2-5 minutes (new instance boot + application warmup)
- Kubernetes HPA: scales pods in 15-30 seconds, but new nodes still take 2-5 minutes
- Database read replicas: provision takes 15-30 minutes and cannot be auto-scaled in real-time

**Cost implications**:

```
Auto-scaling cost model:
- Baseline (50% utilization): 10 servers × $0.50/hour = $5/hour
- Peak burst (2x traffic): auto-scale to 20 servers
- Burst cost: 20 servers × $0.50/hour = $10/hour
- Burst duration: 2 hours/day

Monthly cost:
- Baseline (22 hours/day): 10 × $0.50 × 22 × 30 = $3,300/month
- Peak (2 hours/day): 20 × $0.50 × 2 × 30 = $600/month
- Total: $3,900/month

vs. over-provisioning for peak:
- Always 20 servers: 20 × $0.50 × 24 × 30 = $7,200/month
- Savings from auto-scaling: $3,300/month (46%)
```

**Go application warmup**: Go applications start fast (< 1 second to serve traffic), but they may need time to:
- Fill in-memory caches
- Establish database connection pools
- Complete initialization in `init()` functions

Design for fast startup. Avoid large initialization workloads in the critical path.

### Junior → FAANG: Translating Production Capacity Concepts into Interview Fluency

The production concepts in this section (capacity runway, headroom targets, load testing, auto-scaling limits) are what separate candidates who have operated production systems from those who have only built hobby projects. Interviewers ask about these topics in behavioral rounds ("tell me about a time you dealt with a capacity issue") and in system design follow-ups ("how would you know when to add more servers?").

**Capacity runway as a decision-making tool.** The runway formula (months until saturation at current growth rate) is the answer to "when do we need to act?" The key insight is that at 15% monthly compound growth, a resource currently at 30% capacity (3,000 of 10,000 QPS) reaches the 70% safe-utilization soft limit (7,000 QPS) in about 6 months and the hard 100% limit in about 8.8 months. Since you need to start capacity work about 3 months ahead, the soft limit means you have only ~3 months of comfortable runway before you must act. This calculation should be automatic: when you see growth rate and current utilization, you should immediately think "how many months of runway do I have?" Interviewers who ask "how do you monitor for capacity problems?" expect this kind of quantitative answer, not "we set up alerts."

**The nonlinear latency curve is the reason headroom targets exist.** The statement that databases and queues experience "nonlinear latency increases as utilization approaches 100%" is not intuitive until you see it. Practice explaining it with a queuing theory argument: as utilization approaches 100%, the average queue depth grows without bound (M/M/1 queue theory), which means average latency grows without bound. At 70% utilization, average queue depth is 2.3 requests. At 90%, it is 9 requests. At 95%, it is 19 requests. The jump from 70% to 90% multiplies average queue depth by 4. This is why 70% is the standard headroom target: it keeps you safely below the cliff in the latency curve.

**Load testing baseline versus load testing validation.** There are two distinct uses of load testing. Baseline load testing (run once, measure the maximum RPS at target latency SLA) establishes the system's capacity. Validation load testing (run against every significant change) confirms that the capacity estimate remains accurate as the system evolves. Junior engineers often run baseline tests but forget validation. In an interview or behavioral question, distinguish between these two uses: "We ran a baseline load test at launch to measure maximum RPS, and we run validation load tests after every release that touches a critical path."

**First-job habit:** After joining a team, find the current load test results for each service you own. If they are more than six months old, propose running a new load test. The gap between the last load test and today represents unknown capacity drift: schema changes, data growth, and dependency changes all affect the capacity baseline. Running and documenting a fresh load test on your first month is a high-value contribution that also teaches you the system deeply.

**Interview entry point:** "Our database is at 80% CPU utilization. What do you do?" The expected answer does not jump to "add a read replica." It starts with: what is the capacity runway at current growth rate, what is the source of the load (reads or writes, which queries, is there an N+1 problem?), and what is the target utilization? Then evaluate options: caching, query optimization, read replicas, sharding, or vertical scaling. Candidates who immediately propose adding hardware without diagnosing the load pattern signal that they cargo-cult solutions rather than reason from first principles.

### Senior @ FAANG: Production Capacity Planning as an Organizational System

At senior level, production capacity planning is not a set of techniques you apply to individual services: it is an organizational system you design and maintain across your team's entire portfolio.

**ADR: capacity runway alert thresholds by resource type.** Different resources have different provisioning lead times, which should determine how early the runway alert fires. Adding EC2 instances can be done in hours with auto-scaling. Provisioning a new RDS instance takes 15-30 minutes. Migrating to a larger database instance type requires a maintenance window and causes brief downtime. Adding a new Kafka cluster requires weeks of planning, testing, and migration. The runway alert threshold for each resource type must account for its provisioning lead time: auto-scaling resources alert at 30 days runway, manually-provisioned resources at 90 days, architectural changes at 180 days. A staff engineer defines these thresholds for the team's capacity monitoring system.

**Load testing as a platform investment.** Running load tests manually for each service is not scalable across a team with dozens of services. A staff engineer invests in a load testing platform: a standard k6 or Gatling test harness with common patterns (ramp-up, steady-state, spike, soak), integration with the team's staging environments, automatic comparison against the previous run's baseline, and CI/CD integration that fails the build if load test results regress by more than 10%. This platform makes load testing the default behavior for every release, not an occasional manual exercise.

**Auto-scaling configuration as a capacity planning output.** The auto-scaling limits discussion in this section highlights that auto-scaling is not a substitute for capacity planning: it is a capacity planning tool with specific constraints. A staff engineer designing an auto-scaling configuration must specify: minimum instance count (for availability when scaling events are in progress), maximum instance count (the hard capacity ceiling, constrained by database connection limits or other downstream dependencies), scale-out threshold and cooldown (how aggressively to add capacity, and how long to wait before scaling out again), and scale-in threshold and cooldown (how conservatively to remove capacity, to avoid oscillation). Each of these parameters must be justified by the service's traffic pattern and downstream constraints, not set to arbitrary defaults.

**Governance: capacity post-mortems as a planning system feedback loop.** Every capacity-related incident (service degradation or outage due to CPU, memory, connections, disk, or bandwidth exhaustion) should produce a capacity post-mortem that feeds back into the planning system. The post-mortem answers: what was the actual peak at the time of failure, what was the estimated capacity (from the last capacity plan), what caused the divergence (faster-than-expected growth, new traffic pattern, load test gap, wrong assumptions), and what change to the planning process would have caught the divergence earlier? Over time, this feedback loop calibrates the team's estimation methodology to match actual system behavior.

**L6/L7 concern: capacity planning for stateful services versus stateless services.** Stateless application servers can be auto-scaled horizontally with no data migration. Stateful services (databases, caches, message queues) require careful capacity planning because scaling them involves data migration, rebalancing, or cluster expansion that takes hours to days and carries risk. A staff engineer distinguishes these two classes sharply in the capacity planning process: stateless services are monitored with shorter runway thresholds and addressed with auto-scaling. Stateful services are monitored with longer runway thresholds and addressed through planned migration projects. The Go capacity runway tool in this section should be configured with different alert thresholds for stateful versus stateless resources.

**Cost optimization as a capacity planning outcome.** Capacity planning is often framed as a reliability practice. At FAANG scale, it is equally an efficiency practice. A team that runs its database at 30% utilization is paying 3x what it needs to pay for that resource. A staff engineer who owns both the reliability target and the cost budget must balance these: over-provisioning reduces risk but increases cost, and under-provisioning reduces cost but increases risk. The right approach is to measure actual utilization, compare it to the target utilization band (50-70%), and right-size resources that are persistently outside the band. Quarterly cost reviews that compare utilization to cost create the accountability structure for this balance.

---
