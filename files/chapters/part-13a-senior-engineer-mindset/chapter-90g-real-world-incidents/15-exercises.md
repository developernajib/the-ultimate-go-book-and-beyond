## Guided Exercises: Incident Prevention Patterns (Part 1)

### Exercise 1: Multi-Region Failover Client

Build a complete multi-region HTTP client in Go that:
- Maintains health checks for 3+ regions on different continents
- Automatically fails over when a region becomes unreachable
- Includes submarine cable corridor awareness
- Implements circuit breaking per region
- Logs all failover decisions for post-incident analysis

Test by simulating: one region goes down, then the cable corridor for the backup region fails.

### Exercise 2: Progressive Rollout System

Implement a canary deployment controller that:
- Supports configurable stages (canary → 1% → 10% → 50% → 100%)
- Collects error rate and crash rate metrics at each stage
- Automatically rolls back when thresholds are exceeded
- Requires minimum bake time before advancing
- Supports manual approval gates between stages

Test by injecting a "bad update" that causes 5% crash rate and verify the system rolls back at the canary stage.

### Exercise 3: Out-of-Band Health Monitor

Build a health monitoring system that runs on completely independent infrastructure:
- Checks HTTP endpoints, DNS resolution, and BGP route advertisement
- Alerts through SMS and phone calls (not just Slack/email)
- Cannot be brought down by failure of the monitored system
- Maintains its own independent state and history

### Exercise 4: AI Output Quality Monitor

Implement a quality monitoring system for an AI service that detects:
- Unexpected Unicode script characters in responses
- Language mismatches between request and response
- Excessive repetition indicating model degeneration
- Syntax corruption in code output
- Set thresholds that would have caught Anthropic's 0.8% misrouting bug

### Exercise 5: Goroutine Leak Detector

Build a goroutine leak detection tool that:
- Establishes a baseline goroutine count after warmup
- Alerts when count exceeds 2x baseline for more than 5 minutes
- Captures goroutine stack dumps for analysis
- Identifies common leak patterns (blocked channel sends, unclosed ranges)
- Integrates with pprof for detailed analysis

### Exercise 6: Circuit Breaker with Retry Budget

Implement a circuit breaker that:
- Transitions through closed → open → half-open states
- Includes a global retry budget (retries limited to 20% of successful requests)
- Uses exponential backoff with full jitter
- Provides metrics on circuit state transitions
- Handles the GitHub scenario: backend comes back but is immediately overwhelmed

### Exercise 7: Configuration Validation Pipeline

Build a configuration validator that catches:
- Unreachable rules in ordered policy lists (the Cloudflare BGP bug)
- Duplicate rules
- Missing catch-all rules
- Shadow rules (allow-all before deny rules)
- Support multiple policy types: BGP, firewall, ACL

### Exercise 8: Service Dependency Graph

Implement a runtime dependency graph that:
- Records all service-to-service calls from mesh telemetry
- Discovers undocumented dependencies
- Performs impact analysis (if service X goes down, what else fails?)
- Generates ownership reports (which services have no known owner?)
- Alerts when new dependencies appear

### Exercise 9: Incident Management System

Build a basic incident management system with:
- Incident declaration with severity and commander assignment
- Phase tracking (detection → triage → mitigation → resolution → postmortem)
- Timeline recording with timestamped entries
- Action item tracking
- Notification through independent channels

### Exercise 10: GC Optimization Lab

Create a benchmark suite that demonstrates:
- The impact of GOGC values on GC frequency and latency
- The ballast pattern and its effect on GC scheduling
- GOMEMLIMIT behavior with different memory budgets
- The difference between pointer-heavy and value-type maps on GC pause time
- At what point Go's GC overhead makes another language worth considering

Measure everything with `runtime/metrics` and present results as a decision framework.

### Junior → FAANG: Choosing Your Two Portfolio Exercises

Exercises 5 (goroutine leak detector) and 6 (circuit breaker with retry budget) are the highest return on investment for junior candidates. Exercise 5 produces a tool that is immediately useful in any Go service and demonstrates runtime monitoring depth. Exercise 6 demonstrates distributed systems resilience knowledge at the pattern-implementation level, which is what FAANG system design interviewers probe. Both can be implemented in a weekend and added to a GitHub portfolio.

### Senior @ FAANG: Exercises 7 Through 10 as Platform Investment Candidates

Exercises 7 (config validation), 8 (dependency graph), 9 (incident management), and 10 (GC optimization lab) are platform tools, not individual learning exercises. Each one, if deployed in a real org, directly prevents a class of incident documented in this chapter. Exercise 8 specifically addresses the Twitter problem at the platform level: automatic discovery of runtime dependencies eliminates the institutional-knowledge single point of failure. At staff level, completing one of these exercises and deploying it in production is worth more than completing all ten as academic exercises.

---
