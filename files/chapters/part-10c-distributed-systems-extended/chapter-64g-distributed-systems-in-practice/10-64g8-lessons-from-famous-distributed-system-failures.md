## 64G.8 Lessons from Famous Distributed System Failures

### Amazon S3 Outage (February 28, 2017)

**What happened**: An S3 engineer ran a playbook to remove capacity from an S3 subsystem. The command had a bug: it removed too many servers, taking the index subsystem offline. S3 requires this index to serve any request, so all S3 operations failed globally.

**Root causes**:
1. No bounds checking on the removal command (could remove more than intended)
2. Index subsystem had no graceful degradation mode
3. Restart time for the index was much longer than anticipated (metadata revalidation)

**Go lessons**:
```go
package failures

import "fmt"

// Lesson 1: Validate capacity reduction commands against minimums
type CapacityOperation struct {
    Component string
    Action    string
    Count     int
}

func ValidateCapacityReduction(op CapacityOperation, current, minimum int) error {
    remaining := current - op.Count
    if remaining < minimum {
        return fmt.Errorf(
            "operation would reduce %s to %d instances (minimum: %d)",
            op.Component, remaining, minimum,
        )
    }
    if op.Count > current/2 {
        return fmt.Errorf(
            "operation would reduce %s by >50%% at once (requires confirmation)",
            op.Component,
        )
    }
    return nil
}

// Lesson 2: Critical services must have graceful degradation
// When the "index" is unavailable, can you serve reads from cache? Return stale? Error clearly?
type ServiceDegradation struct {
    Mode string // "full", "read-only", "cached-only", "unavailable"
}

// Lesson 3: Test restart time under load
// Measure: how long does full restart take with current data volume?
// Alert: if restart time > acceptable downtime SLA
```

### Cloudflare BGP Leak (June 24, 2019)

**What happened**: A BGP route optimizer at a small Pennsylvania company generated more-specific routes for Cloudflare (and many others), which its ISP (DQE, AS33154) leaked to a customer and onward to Verizon. Verizon accepted and propagated the routes without filtering, so traffic meant for Cloudflare was routed through networks that could not handle the load. Result: roughly 15% of Cloudflare's global traffic affected for about two hours.

**Root causes**:
1. A BGP optimizer emitted more-specific routes that escaped the local network
2. Verizon didn't have route filtering rules (should have used RPKI or prefix filters)
3. No maximum prefix limits - Verizon accepted an unusually large number of routes

**Go lessons**:
```go
package failures

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"
)

// Lesson: External dependencies can fail in ways completely outside your control
// Defense: design for external network failures

// Health check with timeout - don't assume network is always available
func healthCheckWithTimeout(ctx context.Context, url string) error {
    ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return fmt.Errorf("health check failed: %w", err)
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("health check returned %d", resp.StatusCode)
    }
    return nil
}

// Redundant upstreams - don't rely on single DNS/BGP path
type LoadBalancer struct {
    upstreams []string
    healthMap sync.Map // upstream → isHealthy
}

func (lb *LoadBalancer) ChooseHealthyUpstream() (string, error) {
    for _, upstream := range lb.upstreams {
        if healthy, ok := lb.healthMap.Load(upstream); ok && healthy.(bool) {
            return upstream, nil
        }
    }
    return "", fmt.Errorf("no healthy upstreams available")
}
```

### Facebook October 4, 2021 BGP Withdrawal

**What happened**: A routine BGP configuration change accidentally withdrew all of Facebook's BGP routes. All Facebook services (FB, Instagram, WhatsApp, Oculus) went offline globally for ~6 hours.

**Root causes**:
1. BGP routes were withdrawn, making Facebook's infrastructure unreachable from the internet
2. The tools used to diagnose and fix the problem (including SSH and VPN) also ran on Facebook's network - they were unreachable too
3. Physical access was required to fix, but many data centers had restricted access

**Go lessons**:
```go
package failures

import "fmt"

// Lesson 1: Out-of-band management plane
// Your management and monitoring infrastructure must be independent
// of your production infrastructure

// Management services should be on separate network/cloud:
// - Monitoring (Prometheus, Grafana)
// - Access (VPN, bastion hosts)
// - DNS (for management plane, not same as prod)
// - Alerting (PagerDuty, OpsGenie)

// Lesson 2: DNS dependency
// Facebook's authoritative DNS servers were unreachable because they advertised routes
// that were now withdrawn. Even with working servers, DNS didn't work.

// Always use IP addresses (not DNS names) for critical bootstrap config
type BootstrapConfig struct {
    // Wrong: database.internal (DNS-dependent)
    // Right: 10.0.0.5:5432 (IP-based, DNS-independent for bootstrap)
    EtcdEndpoints []string // Use IPs for the bootstrap etcd connection
    // Then use service discovery for everything else
}

// Lesson 3: Runbook for "what if we can't reach our own infrastructure?"
// Document: how to access servers when all normal paths are down?
// Options: out-of-band IPMI/iDRAC, physical access procedures, emergency contact list

// Lesson 4: Staged rollouts for infrastructure changes
// Never apply BGP configuration changes to all routers simultaneously
func ValidateStagedRollout(changePercent float64) error {
    if changePercent > 0.05 { // Max 5% of infrastructure per stage
        return fmt.Errorf("rollout percent %v exceeds maximum 5%% per stage", changePercent)
    }
    return nil
}
```

### Junior → FAANG: Using Failure Case Studies in Interviews

Reading post-mortems from major outages is one of the most effective activities for a junior engineer preparing for FAANG system design interviews. The three cases in this section (Amazon S3 2017, Cloudflare BGP 2019, Facebook BGP 2021) teach concrete, reusable lessons that interviewers explicitly test for.

For the Amazon S3 case: when designing a system that has administrative operations (capacity adjustments, node removals, configuration changes), always mention minimum safeguards and two-person approval processes. The question "what could go wrong if an operator runs the wrong command?" should have a structural answer, not a procedural one ("we'd train operators better" is not an acceptable answer at FAANG).

For the Facebook case: when designing any large-scale distributed system, interviewers often ask "how would you recover if the system became completely unreachable?" The answer must address out-of-band management: monitoring and access tooling that runs on independent infrastructure, IP-based (not DNS-based) bootstrap configuration, and a documented physical access procedure for the worst case.

First-job habit: before joining any on-call rotation, ask your team lead "if our primary management path (VPN, SSH, monitoring) were unavailable, how would we access the systems to fix them?" If there is no answer, that is the first operational gap to address.

### Senior @ FAANG: Failure Analysis as Input to Platform Investment

At senior level, the value of analyzing famous distributed system failures is not the individual lessons: it is the identification of failure mode classes that require platform-level investment to prevent systematically.

**The Amazon S3 lesson applied at platform scale.** The S3 outage was caused by a command that had no bounds checking on its impact. The platform-level generalization is: any administrative operation that can affect more than X% of a system's capacity should require explicit confirmation, a maximum batch size limit, and an automatic rollback trigger if error rates spike within the first N minutes. At FAANG, this is implemented in the deployment and operations platform, not left to individual service owners. Staff engineers define X, N, and the rollback trigger criteria as platform policy.

**The Facebook lesson applied at organizational scale.** The Facebook outage revealed that the management plane (tools to access and repair infrastructure) had a hard dependency on the data plane (the production network that was down). The organizational-level lesson is that the management plane must be treated as a separate system with its own availability requirements, its own deployment pipeline, and its own dependency analysis. Staff engineers at FAANG advocate for this separation as a platform architecture requirement: every production system must have a documented management plane architecture that is independent of the system's production traffic path.

**Failure pattern libraries as institutional memory.** Famous failures become institutionally valuable when they are formalized into pattern libraries that every engineer can reference during design reviews. The three failures in this section each exemplify a pattern: Amazon S3 is the "unchecked administrative operation" pattern, Cloudflare BGP is the "external routing dependency" pattern, Facebook BGP is the "management plane self-dependency" pattern. Staff engineers maintain and extend these pattern libraries, connecting each pattern to a specific design review question in the checklist. This converts individual post-mortems into systematic prevention.

**Change management as a distributed systems discipline.** All three failures in this section were caused or amplified by a change (a playbook command, a route advertisement, a BGP configuration update) that had an unbounded blast radius. The common prevention is change management policy: mandatory staged rollout, automatic rollback on metric anomaly, and blast radius documentation as a required field in every change request. Staff engineers design the enforcement mechanisms: canary rollouts in the deployment platform, automatic rollback triggers in the monitoring system, and blast radius analysis in the change approval workflow. The mechanism must be structural, not procedural.

---
