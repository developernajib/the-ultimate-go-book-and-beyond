## 105.8 Production Pitfalls: SRE Practice Mistakes

### Pitfall 1: Setting SLOs Without Data

**Real Incident Report**: A team set a 99.99% availability SLO (52 minutes downtime/year) for a new service without historical data. Within the first month, they exhausted their annual error budget. The SLO was aspirational but unrealistic for their system's maturity.

**The Anti-Pattern**:
- Setting SLOs based on aspirations, not reality
- Copying another service's SLOs
- Setting 99.99% because it "sounds good"
- Not measuring current baseline

**The Better Approach**:
```markdown
# SLO Setting Process

## Step 1: Measure current state (2-4 weeks)
- What's current availability?
- What are current latencies (p50, p95, p99)?
- What are error rates?

## Step 2: Set achievable SLO
- If current availability is 99%
- Set SLO at 99.5% (achievable with effort)
- NOT 99.99% (10x improvement required)

## Step 3: Iterate
- Meet SLO consistently for a quarter
- Then tighten if business requires
- Document what changes enabled improvement

## Starting points:
- New service: 99.5% (3.6 hours/month downtime)
- Maturing service: 99.9% (43 minutes/month)
- Critical infrastructure: 99.95%+ (only after proven)
```

**Key Insight**: SLOs should be achievable. Unachievable SLOs lead to ignored SLOs and unhealthy team dynamics.

### Pitfall 2: Error Budget Without Consequences

**Real Incident Report**: A team tracked error budgets but nothing changed when they were exhausted. They continued shipping features while reliability degraded. The error budget was a dashboard metric, not an operational tool.

**The Anti-Pattern**:
- Tracking error budget but not acting on it
- No policy for exhausted budget
- Features always win over reliability
- SLOs as metrics, not agreements

**The Better Approach**:
```markdown
# Error Budget Policy

## When budget is healthy (>50% remaining):
- Normal feature velocity
- Reliability work in background
- Regular risk-taking allowed

## When budget is depleted (0-50% remaining):
- Feature freeze consideration
- Prioritize reliability work
- Review recent changes

## When budget is exhausted (<0%):
- MUST freeze non-critical features
- All hands on reliability
- Postmortems for major contributors
- Resume features only when budget recovers

## Executive buy-in required:
- Engineering leadership must enforce
- Product must agree to freeze
- Document policy before you need it
```

**Key Insight**: Error budgets only work if exhaustion has consequences. Otherwise, they're just numbers.

### Pitfall 3: Blameful Postmortems

**Real Incident Report**: After an outage, the postmortem concluded: "Engineer X deployed buggy code without testing." That engineer stopped deploying, started hiding mistakes, and eventually left. The team learned to avoid blame by avoiding visibility, and incidents went unreported.

**The Anti-Pattern**:
- Finding "who" instead of "what" and "why"
- Naming individuals in postmortems
- Using postmortems for performance discussions
- Creating fear of reporting incidents

**The Better Approach**:
```markdown
# Blameless Postmortem Template

## What happened (facts only):
- Timeline of events
- Systems involved
- Business impact

## Contributing factors (not "root cause"):
- What conditions allowed this?
- What safeguards were missing?
- Where did assumptions break?

## How did we respond?
- Time to detection
- Time to resolution
- What went well in response?

## Remediation items:
- System changes to prevent
- Process changes to detect earlier
- Documentation or training needs

## What we learned:
- About our systems
- About our processes
- To share with other teams

## NEVER INCLUDE:
- Individual names in blame context
- "Human error" as root cause
- Punitive language
```

**Key Insight**: Blame creates fear. Fear prevents reporting. Without reports, you can't learn. Blameless culture is a reliability investment.

### Pitfall 4: On-Call Without Runbooks

**Real Incident Report**: A new engineer was on-call for the first time. At 2 AM, an alert fired for a service they'd never worked on. No runbook existed. They spent 45 minutes reading code to understand what the service did, while customers were impacted. A runbook would have enabled a 5-minute fix.

**The Anti-Pattern**:
- Alerts without runbooks
- Runbooks that are outdated
- Tribal knowledge required for response
- Only "experts" can handle incidents

**The Better Approach**:
````markdown
# Runbook Template for [Alert Name]

## What this alert means
[Brief explanation for someone unfamiliar with the service]

## Quick check
1. Check [dashboard link]
2. Run `kubectl get pods -l app=X`
3. Look for [specific symptoms]

## Common causes and fixes

### Cause 1: [Most common]
Symptoms: [What you'll see]
Fix: [Exact commands]

```bash
kubectl rollout restart deployment/X
```

### Cause 2: [Second most common]
Symptoms: [What you'll see]
Fix: [Exact commands]

## Escalation
- Team Slack: #service-team
- Primary on-call: [PagerDuty]
- Subject matter expert: @person (only if needed)

## If nothing works
[Emergency playbook, including how to roll back]
````

**Key Insight**: Every alert should link to a runbook. If you can't write a runbook, the alert isn't actionable.

### Pitfall 5: SLIs That Don't Reflect User Experience

**Real Incident Report**: A team's SLIs showed 99.99% availability, the server was responding. But users were experiencing failures because the third-party payment provider was down. The SLI measured server health, not user journeys.

**The Anti-Pattern**:
- Measuring server uptime instead of user success
- Ignoring dependency failures
- Internal metrics instead of user-facing ones
- "Green dashboards, angry users"

**The Better Approach**:

```go
// RIGHT: User-centric SLIs

// Instead of "server responded 200":
// Measure "user successfully completed checkout"

// Bad SLI: httpResponseCode == 200

// Good SLI:
func recordUserOutcome(ctx context.Context, journey string, success bool) {
    // Track the user journey, not just the HTTP response
    sliCounter.WithLabelValues(journey, strconv.FormatBool(success)).Inc()
}

// In checkout flow:
func handleCheckout(w http.ResponseWriter, r *http.Request) {
    // ... process checkout ...

    if paymentSuccessful && inventoryUpdated && emailSent {
        recordUserOutcome(r.Context(), "checkout", true)
    } else {
        recordUserOutcome(r.Context(), "checkout", false)
    }
}
```

**Key Insight**: SLIs should answer "did the user succeed?" not "did the server respond?" Measure user journeys end-to-end.

### Pitfall 6: The Unrecovered Panic in Fan-Out Workers

**Real Incident Report**: A webhook dispatch gateway delivered notifications to hundreds of external subscriber URLs concurrently. One subscriber changed their webhook endpoint to a malformed URL that triggered an internal `nil` pointer panic in an HTTP client transport wrapper. Because the worker dispatched each delivery in a bare goroutine (`go deliver(sub, event)`), the single unrecovered panic immediately crashed the entire Go OS process, severing active deliveries for all other tenants and causing a system-wide outage.

As detailed in [The Production Incidents That Changed How We Write Go](https://medium.com/@yaninyzwitty/the-go-patterns-that-everyone-copies-and-why-it-) by Yaninyz witty, Go's runtime does not isolate panics between goroutines: an unhandled panic in *any* background goroutine terminates the entire binary.

**The Anti-Pattern**:
```go
// WRONG: Fan-out without panic recovery boundary
func broadcast(events []Event, subscribers []Subscriber) {
    var wg sync.WaitGroup
    for _, sub := range subscribers {
        wg.Add(1)
        go func(s Subscriber) {
            defer wg.Done()
            deliver(s, events) // A panic here crashes the entire operating process!
        }(sub)
    }
    wg.Wait()
}
```

**The Better Approach - Structural Panic Isolation**:
Encapsulate all concurrent background goroutines inside an isolated runner (`SafeGo`) that catches panics, captures the stack trace via `runtime/debug.Stack()`, and marks the individual task as failed without disrupting sibling goroutines:

```go
package worker

import (
	"log/slog"
	"runtime/debug"
	"sync"
)

// SafeGo executes a task within an isolated panic recovery boundary
func SafeGo(logger *slog.Logger, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.Error("isolated goroutine panic recovered",
					slog.Any("panic", r),
					slog.String("stack", string(debug.Stack())),
				)
			}
		}()
		fn()
	}()
}

// Resilient fan-out worker
func BroadcastResilient(logger *slog.Logger, events []Event, subscribers []Subscriber) {
	var wg sync.WaitGroup
	for _, sub := range subscribers {
		wg.Add(1)
		s := sub
		SafeGo(logger, func() {
			defer wg.Done()
			deliver(s, events) // Panics are logged and isolated to this subscriber only
		})
	}
	wg.Wait()
}
```

### Quick Reference: SRE Practice Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Aspirational SLOs | Budget exhausted immediately | Measure first, then set achievable target |
| No budget policy | Features ship despite poor reliability | Enforce feature freeze when budget exhausted |
| Blameful postmortems | Engineers hide incidents | Focus on systems, not individuals |
| No runbooks | Long MTTR, expert dependency | Every alert links to actionable runbook |
| Server-centric SLIs | Green dashboards, angry users | Measure user journey success |
| Unrecovered worker panics | Single task crash kills whole service | `SafeGo` panic boundary + `debug.Stack()` |
| No error budget tracking | Don't know reliability state | Dashboard showing budget consumption |

### Junior → FAANG: Recognizing These Pitfalls in Your Current Environment

The five pitfalls in the table are not theoretical: they appear in almost every engineering organization that has not explicitly adopted SRE practices. "Server-centric SLIs" is particularly common: a team reports "CPU is fine, memory is fine, error rate is 0%" while users are experiencing 30-second page load times because a downstream dependency is slow.

For a first job, identify which of these pitfalls exist in your current team. You do not need to fix all of them immediately, but being able to name them and describe their impact is a sign of SRE maturity that shows in interviews.

### Senior @ FAANG: Pitfall Prevention Through Process Design

The five pitfalls in the table are all preventable with the right process design. "No budget policy" is fixed by writing a policy and getting leadership sign-off. "Blameful postmortems" is fixed by a facilitator training program and a standard post-mortem template that explicitly asks for contributing factors rather than responsible parties. "No runbooks" is fixed by a launch checklist that blocks production deployment until runbooks exist for all alerts.

An L6 engineer who has systematically eliminated these pitfalls across an engineering organization has concrete metrics to show: MTTR reduced by X%, post-mortem action item completion rate increased from Y% to Z%, on-call alert volume reduced by N alerts per rotation. These metrics are the evidence that the pitfall prevention work had organizational impact, which is the kind of story that wins staff-level promotions.

---
