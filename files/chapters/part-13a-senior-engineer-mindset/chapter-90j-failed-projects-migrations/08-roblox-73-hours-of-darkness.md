## 90J.7 Roblox: 73 Hours of Darkness (2021)

### The Incident

On October 28, 2021, Roblox went offline for 73 hours - over three full days. At the time, Roblox had
approximately 50 million daily active users, most of them children. The outage was caused by a subtle
interaction between Consul (HashiCorp's service discovery tool) and BoltDB (an embedded key-value store
used by Consul) that nobody had anticipated.

### The Timeline

**October 28, 2021: The Trigger**

Roblox was running a test of a new feature that inadvertently increased the write load on their Consul
cluster. Consul uses BoltDB as its underlying storage engine. BoltDB is designed for read-heavy workloads
and uses a B+ tree structure that requires periodic compaction. Under the increased write load, BoltDB's
internal data files grew significantly, and the compaction process could not keep up.

**The Cascading Failure**

As Consul's performance degraded, the service discovery system became slow and eventually unreliable. In
Roblox's architecture, virtually every service depended on Consul for service discovery - finding other
services, looking up configuration, managing leader election, and distributing work. When Consul became
unreliable, services could not find each other, health checks failed, and the entire platform entered a
death spiral.

**The Recovery Challenge**

The Roblox engineering team quickly identified Consul as the source of the problem, but recovery was
extraordinarily difficult:

1. **Consul depended on itself**: To restart Consul, you needed Consul to be working - a classic circular
   dependency
2. **BoltDB compaction**: The BoltDB files had grown so large that compaction took hours
3. **Scale**: Roblox's Consul cluster was one of the largest in the world, making standard recovery
   procedures inadequate
4. **Cascading state**: Even after Consul was restored, the dependent services had accumulated so much
   stale state that they needed to be restarted in a specific order

**October 31, 2021: Recovery**

After 73 hours of around-the-clock work, Roblox's engineering team restored service. The root fix involved
working with HashiCorp to optimize BoltDB's behavior under write-heavy loads and redesigning Roblox's
Consul deployment to handle the load patterns.

### Root Cause Analysis

1. **Unexpected interaction**: BoltDB's behavior under write-heavy loads was not anticipated
2. **Circular dependency**: Consul depended on itself for recovery
3. **Single point of failure**: All services depended on one Consul cluster
4. **No independent monitoring**: The monitoring system also depended on Consul
5. **Untested failure mode**: Nobody had tested what happens when Consul goes down completely

### Go Code: Independent Monitoring System

The Roblox disaster shows the danger of circular dependencies in monitoring. Here is an independent
monitoring system that does not depend on the infrastructure it monitors:

```go
package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Independent monitoring system - does not depend on service discovery,
// message queues, or any infrastructure component it monitors
// -----------------------------------------------------------------------

// Target represents a service or component being monitored. Each
// target is checked independently using direct IP addresses, not
// service discovery.
type Target struct {
	Name        string        `json:"name"`
	DirectIP    string        `json:"direct_ip"` // No service discovery dependency
	Port        int           `json:"port"`
	HealthPath  string        `json:"health_path"`
	Interval    time.Duration `json:"interval"`
	Timeout     time.Duration `json:"timeout"`
	Critical    bool          `json:"critical"` // Is this a foundational service?
}

// CheckResult captures the outcome of a health check.
type CheckResult struct {
	Target    string        `json:"target"`
	Healthy   bool          `json:"healthy"`
	Latency   time.Duration `json:"latency"`
	StatusCode int          `json:"status_code,omitempty"`
	Error     string        `json:"error,omitempty"`
	Timestamp time.Time     `json:"timestamp"`
}

// ServiceHealth tracks the rolling health status of a service.
type ServiceHealth struct {
	mu              sync.RWMutex
	Name            string
	LastCheck       CheckResult
	ConsecutiveFails int
	ConsecutiveOK   int
	History         []CheckResult // Ring buffer of recent checks
	historyMax      int
}

// AlertChannel is an interface for sending alerts through channels
// that are INDEPENDENT of the monitored infrastructure.
type AlertChannel interface {
	Send(ctx context.Context, alert Alert) error
	Name() string
}

// Alert represents a monitoring alert.
type Alert struct {
	Severity  string    `json:"severity"` // "critical", "warning", "info"
	Service   string    `json:"service"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
	Details   map[string]string `json:"details,omitempty"`
}

// IndependentMonitor watches services using direct connections,
// with no dependency on service discovery, message queues, or
// the monitored infrastructure.
type IndependentMonitor struct {
	targets     []Target
	health      map[string]*ServiceHealth
	alerts      []AlertChannel
	mu          sync.RWMutex
	client      *http.Client
	statusFile  string // Writes status to a local file - no remote dependencies
}

// NewIndependentMonitor creates a monitor that uses only direct IP
// connections and local storage.
func NewIndependentMonitor(targets []Target, statusFile string) *IndependentMonitor {
	// Create HTTP client with direct dialer - no DNS dependency.
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		// No proxy - direct connections only.
		Proxy: nil,
	}

	m := &IndependentMonitor{
		targets:    targets,
		health:     make(map[string]*ServiceHealth),
		client:     &http.Client{Transport: transport},
		statusFile: statusFile,
	}

	for _, t := range targets {
		m.health[t.Name] = &ServiceHealth{
			Name:       t.Name,
			History:    make([]CheckResult, 0, 100),
			historyMax: 100,
		}
	}

	return m
}

// AddAlertChannel adds an independent alerting channel.
func (m *IndependentMonitor) AddAlertChannel(ch AlertChannel) {
	m.alerts = append(m.alerts, ch)
}

// Start begins monitoring all targets.
func (m *IndependentMonitor) Start(ctx context.Context) {
	var wg sync.WaitGroup

	for _, target := range m.targets {
		wg.Add(1)
		go func(t Target) {
			defer wg.Done()
			m.monitorTarget(ctx, t)
		}(target)
	}

	// Periodic status file writer.
	go m.writeStatusLoop(ctx)

	wg.Wait()
}

// monitorTarget continuously checks a single target's health.
func (m *IndependentMonitor) monitorTarget(ctx context.Context, target Target) {
	ticker := time.NewTicker(target.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result := m.checkTarget(ctx, target)
			m.recordResult(target, result)
		}
	}
}

// checkTarget performs a health check using a direct IP connection.
func (m *IndependentMonitor) checkTarget(ctx context.Context, target Target) CheckResult {
	url := fmt.Sprintf("http://%s:%d%s", target.DirectIP, target.Port, target.HealthPath)

	reqCtx, cancel := context.WithTimeout(ctx, target.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "GET", url, nil)
	if err != nil {
		return CheckResult{
			Target:    target.Name,
			Healthy:   false,
			Error:     fmt.Sprintf("request creation failed: %v", err),
			Timestamp: time.Now(),
		}
	}

	start := time.Now()
	resp, err := m.client.Do(req)
	latency := time.Since(start)

	if err != nil {
		return CheckResult{
			Target:    target.Name,
			Healthy:   false,
			Latency:   latency,
			Error:     fmt.Sprintf("health check failed: %v", err),
			Timestamp: time.Now(),
		}
	}
	defer resp.Body.Close()

	healthy := resp.StatusCode >= 200 && resp.StatusCode < 300
	result := CheckResult{
		Target:     target.Name,
		Healthy:    healthy,
		Latency:    latency,
		StatusCode: resp.StatusCode,
		Timestamp:  time.Now(),
	}

	if !healthy {
		result.Error = fmt.Sprintf("unhealthy status: %d", resp.StatusCode)
	}

	return result
}

// recordResult updates the service health state and triggers alerts
// if necessary.
func (m *IndependentMonitor) recordResult(target Target, result CheckResult) {
	sh := m.health[target.Name]
	sh.mu.Lock()
	defer sh.mu.Unlock()

	sh.LastCheck = result

	// Update ring buffer.
	if len(sh.History) >= sh.historyMax {
		sh.History = sh.History[1:]
	}
	sh.History = append(sh.History, result)

	if result.Healthy {
		sh.ConsecutiveOK++
		if sh.ConsecutiveFails > 0 {
			// Service recovered.
			fmt.Printf("[MONITOR] %s recovered after %d failed checks\n",
				target.Name, sh.ConsecutiveFails)
			m.sendAlert(Alert{
				Severity:  "info",
				Service:   target.Name,
				Message:   fmt.Sprintf("%s recovered after %d consecutive failures", target.Name, sh.ConsecutiveFails),
				Timestamp: time.Now(),
			})
		}
		sh.ConsecutiveFails = 0
	} else {
		sh.ConsecutiveFails++
		sh.ConsecutiveOK = 0

		// Alert thresholds.
		if sh.ConsecutiveFails == 3 && target.Critical {
			m.sendAlert(Alert{
				Severity:  "critical",
				Service:   target.Name,
				Message:   fmt.Sprintf("CRITICAL: %s has failed %d consecutive health checks", target.Name, sh.ConsecutiveFails),
				Timestamp: time.Now(),
				Details: map[string]string{
					"last_error": result.Error,
					"direct_ip":  target.DirectIP,
				},
			})
		} else if sh.ConsecutiveFails == 3 {
			m.sendAlert(Alert{
				Severity:  "warning",
				Service:   target.Name,
				Message:   fmt.Sprintf("WARNING: %s has failed %d consecutive health checks", target.Name, sh.ConsecutiveFails),
				Timestamp: time.Now(),
			})
		}
	}
}

// sendAlert sends an alert through all configured channels.
func (m *IndependentMonitor) sendAlert(alert Alert) {
	for _, ch := range m.alerts {
		go func(c AlertChannel) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := c.Send(ctx, alert); err != nil {
				// Log locally - cannot depend on remote logging.
				fmt.Fprintf(os.Stderr, "[MONITOR] Alert send failed via %s: %v\n",
					c.Name(), err)
			}
		}(ch)
	}
}

// writeStatusLoop periodically writes the full status to a local file.
// This ensures status is available even if all remote systems are down.
func (m *IndependentMonitor) writeStatusLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.writeStatusFile()
		}
	}
}

// writeStatusFile writes current status to a local JSON file.
func (m *IndependentMonitor) writeStatusFile() {
	status := make(map[string]any)

	for name, sh := range m.health {
		sh.mu.RLock()
		status[name] = map[string]any{
			"healthy":           sh.LastCheck.Healthy,
			"consecutive_fails": sh.ConsecutiveFails,
			"consecutive_ok":    sh.ConsecutiveOK,
			"last_check":        sh.LastCheck.Timestamp,
			"last_latency":      sh.LastCheck.Latency.String(),
			"last_error":        sh.LastCheck.Error,
		}
		sh.mu.RUnlock()
	}

	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "[MONITOR] Failed to marshal status: %v\n", err)
		return
	}

	if err := os.WriteFile(m.statusFile, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "[MONITOR] Failed to write status file: %v\n", err)
	}
}

// GetHealthSummary returns a snapshot of all monitored services.
func (m *IndependentMonitor) GetHealthSummary() map[string]bool {
	summary := make(map[string]bool)
	for name, sh := range m.health {
		sh.mu.RLock()
		summary[name] = sh.LastCheck.Healthy
		sh.mu.RUnlock()
	}
	return summary
}
```

### Engineering Lessons

1. **Your monitoring must not depend on the thing being monitored** - use independent channels.
2. **Service discovery is a single point of failure** - have a fallback using direct IPs.
3. **Test failure modes of foundational services** - what happens when Consul goes down?
4. **Circular dependencies create unrecoverable situations** - map your dependency graph.
5. **Write-heavy workloads can destroy read-optimized databases** - understand your storage engine.
6. **73 hours is unacceptable** - the recovery time was a consequence of having no plan for this failure.

---

### Junior → FAANG: Service Discovery Failure Modes and Independent Monitoring as Interview Topics

Roblox is the interview answer to "what happens when your service discovery system fails?" Service discovery is a foundational dependency: if it fails, services cannot find each other, and depending on how clients behave, the entire system can cascade into a state that is worse than a clean outage. For FAANG interviews, the Roblox incident illustrates two key points. First, service discovery must have a fallback path: if Consul is unavailable, clients should use a cached copy of the last known service locations rather than failing immediately. A 30-second cache expiry during normal operation becomes a 5-minute emergency cache during a discovery outage. Second, monitoring must be independent of the service being monitored. Roblox's monitoring depended on the same Consul cluster that was failing, so the monitoring showed false positives that delayed diagnosis. For any system where a single component's failure could cascade, that component's monitoring must use an independent path.

### Senior @ FAANG: Foundational Service Resilience as a Platform Architecture Standard

At L6, Roblox reveals the danger of treating foundational infrastructure services as reliable black boxes. Consul, etcd, ZooKeeper, and similar consensus systems are foundational, which means their failure mode is the failure mode of the entire platform. The staff engineer's approach to foundational service resilience has three parts. First, every client of a foundational service must implement graceful degradation: define explicitly what the service does when the foundational dependency is unavailable (serve from cache, use static configuration, shed load with an explicit error), and test that behavior under fault injection. A client that throws a null pointer exception when the discovery service returns empty is not gracefully degrading. Second, capacity changes to foundational services must be tested for write-amplification effects before production deployment. The Roblox incident was triggered by a configuration change that caused Consul to generate substantially more gossip traffic than anticipated. Load testing a consensus system requires understanding how configuration changes affect internal traffic, not just external request volume. Third, recovery procedures for foundational service failures must be documented, tested, and executed under fire drill conditions annually. The 73-hour recovery was largely a consequence of encountering an unfamiliar failure mode for the first time during an actual outage. Familiarity with recovery procedures, built through regular drills, reduces recovery time by an order of magnitude. For an organization running at Roblox's scale, that difference between 73 hours and 7 hours translates directly to user trust and revenue.

---
