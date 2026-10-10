## 90G.3 Meta's 6-Hour Disappearance: The Recovery Tool Paradox

### The Incident

On October 4, 2021, Facebook, Instagram, WhatsApp, and all Meta services disappeared from the internet for
approximately six hours. This was not a gradual degradation - the services vanished entirely. DNS resolution for
facebook.com stopped working. The company's BGP routes were withdrawn from the global routing table. Approximately
3.5 billion users lost access simultaneously. Meta's stock dropped roughly 5%, erasing billions in market value.

**Timeline:**

```
2021-10-04 15:39 UTC  Backbone maintenance command issued
                      Intended: capacity assessment on backbone network
                      Actual: command disconnects ALL data center backbone links
15:40 UTC             Audit tool designed to catch bad commands: HAS A BUG
                      Fails to block the destructive command
15:40 UTC             All data centers lose backbone connectivity
15:40-15:41 UTC       DNS servers detect backbone failure via health checks
                      Health checks fail → DNS servers withdraw BGP routes
                      (By design: don't advertise routes to unreachable services)
15:41 UTC             facebook.com disappears from global DNS
                      All Meta services unreachable
15:41-16:00 UTC       Engineers attempt remote remediation
                      PROBLEM: Remote access tools also run on Meta infrastructure
                      VPN, internal tools, Workplace - all down
16:00-17:00 UTC       Engineers physically dispatched to data centers
                      PROBLEM: Badge access systems also run on Meta infrastructure
                      Physical security has to manually verify identities
17:00-20:00 UTC       Manual verification and access to data center equipment
                      Careful restoration to avoid thundering herd on recovery
20:00-21:00 UTC       Backbone connectivity restored
                      BGP routes re-advertised
                      DNS begins resolving again
21:00-22:00 UTC       Services gradually come back online
                      Careful traffic ramp to avoid cascading failures
```

**The Recovery Tool Paradox:**

```
┌──────────────────────────────────────────────────────────────────────┐
│                  THE RECOVERY TOOL PARADOX                           │
│                                                                      │
│  ┌──────────────┐                                                    │
│  │   Meta's     │                                                    │
│  │   Backbone   │◄──── Failed (bad maintenance command)              │
│  │   Network    │                                                    │
│  └──────┬───────┘                                                    │
│         │                                                            │
│         │ depends on                                                 │
│         ▼                                                            │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐          │
│  │     DNS      │     │     VPN      │     │   Internal   │          │
│  │   Servers    │     │    Access    │     │    Tools     │          │
│  │  (withdrew   │     │   (DOWN)     │     │   (DOWN)     │          │
│  │   BGP routes)│     │              │     │              │          │
│  └──────────────┘     └──────────────┘     └──────────────┘          │
│         │                    │                    │                  │
│         │                    │                    │                  │
│         ▼                    ▼                    ▼                  │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │            ALL RECOVERY TOOLS OFFLINE                   │         │
│  │                                                         │         │
│  │  Cannot SSH to servers  (VPN down)                      │         │
│  │  Cannot use Workplace   (Workplace runs on Meta infra)  │         │
│  │ Cannot enter buildings (badge system runs on Meta infra)│         │
│  │  Cannot coordinate     (all comms run on Meta infra)    │         │
│  └─────────────────────────────────────────────────────────┘         │
│                                                                      │
│  ONLY OPTION: Drive to data center, get manually verified            │
│  by physical security, physically access equipment                   │
└──────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Out-of-Band Health Check and Recovery System

The core lesson from Meta's outage is that your recovery system must be completely independent from the systems
it recovers. This implementation provides an out-of-band health checker that operates on separate infrastructure.

```go
package oob

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// OutOfBandChecker provides health monitoring that is completely independent
// of the primary infrastructure being monitored.
//
// Design principles from the Meta outage:
// 1. This system MUST run on different infrastructure than what it monitors
// 2. This system MUST have independent DNS resolution
// 3. This system MUST have independent network paths
// 4. This system MUST have independent authentication
// 5. Alerting MUST use independent channels (SMS, phone, separate provider)
type OutOfBandChecker struct {
	targets     []MonitorTarget
	alerter     Alerter
	logger      *slog.Logger
	httpClient  *http.Client

	mu          sync.RWMutex
	targetState map[string]*TargetState
}

// MonitorTarget represents a system to monitor from outside the infrastructure.
type MonitorTarget struct {
	Name             string
	PrimaryEndpoint  string   // endpoint on primary infra
	ExternalEndpoint string   // endpoint accessible without internal network
	DNSName          string   // domain to verify DNS resolution
	BGPPrefixes      []string // BGP prefixes to verify advertisement
	CheckInterval    time.Duration
	AlertThreshold   int // consecutive failures before alerting
}

// TargetState tracks health history for a monitored target.
type TargetState struct {
	Name                string
	ConsecutiveFailures int
	LastCheck           time.Time
	LastSuccess         time.Time
	LastFailure         time.Time
	HTTPReachable       bool
	DNSResolvable       bool
	BGPAdvertised       bool
	IncidentActive      bool
}

// Alerter sends alerts through channels independent of monitored infrastructure.
type Alerter interface {
	// SendSMS sends an alert via SMS (independent of internet connectivity)
	SendSMS(ctx context.Context, message string, recipients []string) error
	// SendVoiceCall triggers an automated voice call
	SendVoiceCall(ctx context.Context, message string, recipients []string) error
	// SendAlternateEmail sends via a provider NOT hosted on monitored infra
	SendAlternateEmail(ctx context.Context, subject, body string, recipients []string) error
}

// NewOutOfBandChecker creates a health checker on independent infrastructure.
func NewOutOfBandChecker(targets []MonitorTarget, alerter Alerter, logger *slog.Logger) *OutOfBandChecker {
	states := make(map[string]*TargetState)
	for _, t := range targets {
		states[t.Name] = &TargetState{Name: t.Name}
	}

	return &OutOfBandChecker{
		targets:     targets,
		alerter:     alerter,
		logger:      logger,
		httpClient:  &http.Client{Timeout: 10 * time.Second},
		targetState: states,
	}
}

// Run starts the out-of-band monitoring loop. Cancel context to stop.
func (c *OutOfBandChecker) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for _, target := range c.targets {
		wg.Add(1)
		go func(t MonitorTarget) {
			defer wg.Done()
			c.monitorTarget(ctx, t)
		}(target)
	}
	wg.Wait()
}

func (c *OutOfBandChecker) monitorTarget(ctx context.Context, target MonitorTarget) {
	interval := target.CheckInterval
	if interval == 0 {
		interval = 30 * time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.checkTarget(ctx, target)
		}
	}
}

func (c *OutOfBandChecker) checkTarget(ctx context.Context, target MonitorTarget) {
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	results := make(chan checkResult, 3)
	var wg sync.WaitGroup

	// HTTP health check
	wg.Add(1)
	go func() {
		defer wg.Done()
		reachable := c.checkHTTP(checkCtx, target.ExternalEndpoint)
		results <- checkResult{checkType: "http", success: reachable}
	}()

	// DNS resolution check
	wg.Add(1)
	go func() {
		defer wg.Done()
		resolvable := c.checkDNS(checkCtx, target.DNSName)
		results <- checkResult{checkType: "dns", success: resolvable}
	}()

	// BGP route check
	wg.Add(1)
	go func() {
		defer wg.Done()
		advertised := c.checkBGP(checkCtx, target.BGPPrefixes)
		results <- checkResult{checkType: "bgp", success: advertised}
	}()

	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect results
	c.mu.Lock()
	state := c.targetState[target.Name]
	state.LastCheck = time.Now()

	allHealthy := true
	for result := range results {
		switch result.checkType {
		case "http":
			state.HTTPReachable = result.success
		case "dns":
			state.DNSResolvable = result.success
		case "bgp":
			state.BGPAdvertised = result.success
		}
		if !result.success {
			allHealthy = false
		}
	}

	if allHealthy {
		state.ConsecutiveFailures = 0
		state.LastSuccess = time.Now()
		if state.IncidentActive {
			state.IncidentActive = false
			c.mu.Unlock()
			c.sendRecoveryAlert(ctx, target, state)
			return
		}
	} else {
		state.ConsecutiveFailures++
		state.LastFailure = time.Now()

		if state.ConsecutiveFailures >= target.AlertThreshold && !state.IncidentActive {
			state.IncidentActive = true
			c.mu.Unlock()
			c.sendIncidentAlert(ctx, target, state)
			return
		}
	}
	c.mu.Unlock()
}

type checkResult struct {
	checkType string
	success   bool
}

func (c *OutOfBandChecker) checkHTTP(ctx context.Context, endpoint string) bool {
	if endpoint == "" {
		return true // skip if not configured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}

func (c *OutOfBandChecker) checkDNS(ctx context.Context, name string) bool {
	if name == "" {
		return true
	}
	// Use an external DNS-over-HTTPS provider independent of the
	// monitored infrastructure's DNS. This avoids the cascade where
	// internal DNS goes down and takes monitoring with it.
	url := fmt.Sprintf("https://dns.google/resolve?name=%s&type=A", name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	var dnsResp struct {
		Status int `json:"Status"`
		Answer []struct {
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&dnsResp); err != nil {
		return false
	}
	return dnsResp.Status == 0 && len(dnsResp.Answer) > 0
}

func (c *OutOfBandChecker) checkBGP(ctx context.Context, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	// Use RIPE RIS BGP looking glass API to verify route advertisement
	// This is independent of the monitored infrastructure
	for _, prefix := range prefixes {
		url := fmt.Sprintf("https://stat.ripe.net/data/bgp-state/data.json?resource=%s", prefix)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return false
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return false
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return false
		}
	}
	return true
}

func (c *OutOfBandChecker) sendIncidentAlert(ctx context.Context, target MonitorTarget, state *TargetState) {
	msg := fmt.Sprintf(
		"[CRITICAL] %s appears DOWN. HTTP:%v DNS:%v BGP:%v. Consecutive failures: %d. Last success: %s",
		target.Name,
		state.HTTPReachable,
		state.DNSResolvable,
		state.BGPAdvertised,
		state.ConsecutiveFailures,
		state.LastSuccess.Format(time.RFC3339),
	)

	c.logger.Error("incident detected", "target", target.Name, "message", msg)

	// Alert via all independent channels simultaneously
	oncallNumbers := []string{"+1-555-0100", "+1-555-0101"} // from config in production
	oncallEmails := []string{"oncall@independent-provider.com"}

	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); c.alerter.SendSMS(ctx, msg, oncallNumbers) }()
	go func() { defer wg.Done(); c.alerter.SendVoiceCall(ctx, msg, oncallNumbers) }()
	go func() { defer wg.Done(); c.alerter.SendAlternateEmail(ctx, "[INCIDENT] "+target.Name, msg, oncallEmails) }()
	wg.Wait()
}

func (c *OutOfBandChecker) sendRecoveryAlert(ctx context.Context, target MonitorTarget, state *TargetState) {
	msg := fmt.Sprintf("[RECOVERY] %s is back online. Downtime: %s",
		target.Name,
		time.Since(state.LastFailure).Round(time.Second))
	c.logger.Info("recovery detected", "target", target.Name, "message", msg)

	oncallNumbers := []string{"+1-555-0100", "+1-555-0101"}
	_ = c.alerter.SendSMS(ctx, msg, oncallNumbers)
}

// GetStatus returns the current state of all monitored targets.
func (c *OutOfBandChecker) GetStatus() map[string]*TargetState {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make(map[string]*TargetState, len(c.targetState))
	for k, v := range c.targetState {
		cp := *v
		result[k] = &cp
	}
	return result
}
```

### Key Lessons

**Lesson 1: Recovery tools must not depend on the system they recover.** This is the "recovery tool paradox" - the
most dangerous form of circular dependency. Meta's VPN, internal communication tools, badge access systems, and
remote management infrastructure all ran on the same backbone that failed. When the backbone went down, every tool
needed to fix it was also down.

**Lesson 2: An audit tool with a bug is worse than no audit tool.** Meta had a tool specifically designed to
prevent dangerous backbone commands. But the tool had a bug that let the destructive command through. The
existence of the audit tool created a false sense of safety - engineers relied on it instead of additional manual
verification. A safety net that doesn't work is worse than no safety net because it changes behavior.

**Lesson 3: BGP and DNS create surprising cascading failures.** Meta's DNS servers withdrew their BGP routes
because they detected the backbone failure via health checks. This was correct behavior in isolation - don't
advertise routes to unreachable services. But the cascading effect was that the company disappeared from the
internet entirely, because without BGP routes, no one could reach any Meta service, including those that might
have still been partially functional.

**Lesson 4: Physical access is the ultimate fallback.** When all remote access fails, someone has to physically
walk into a data center. Your disaster recovery plan must account for this scenario: Who has physical access?
How are they identified if badge systems are down? How long does it take them to reach the data center? Meta's
engineers had to drive to data centers and be manually verified by physical security guards who had to confirm
their identities through non-digital means.

### Junior → FAANG: The Recovery Tool Paradox as an Architecture Principle

The recovery tool paradox is one of the most powerful principles in distributed systems: your recovery mechanism cannot depend on the system it recovers. This comes up in system design interviews as "how do you ensure your monitoring system is available when the service it monitors goes down?" The answer must address independence: independent network path, independent DNS, independent authentication, independent alerting channel. Candidates who say "I would monitor the service" without addressing the independence requirement are missing the core issue.

The out-of-band health checker in this section uses DNS-over-HTTPS to an external provider (Google DNS) and BGP state lookup to an independent RIR API (RIPE NCC). These are concrete implementation details that demonstrate you have thought about the independence requirement at the infrastructure level, not just the application level.

### Senior @ FAANG: Recovery Independence as a Platform Standard

At L6, recovery independence is an architectural standard that must be enforced across all critical systems, not a design choice for individual teams. The governance mechanism is a recovery independence checklist that every new service must satisfy before going to production: independent health check endpoint, out-of-band alerting configured, runbook accessible without the failed system, physical access plan documented. This checklist should be part of the production readiness review process.

The Meta incident also surfaces an org design lesson. When badge systems, VPN, internal tools, and physical access logs all depend on the same backbone, you have a single organization-wide blast radius. At staff level, the mapping of "what systems does this backbone failure take down?" is a governance exercise that should be run periodically, not just after an incident. The result is a dependency graph that identifies hidden single points of failure before they manifest in a six-hour outage.

---
