## Section 4: Synthetic Monitoring

The cardinal rule of synthetic monitoring: **probes must run in an independent failure domain from the service they monitor**. A probe that runs in the same Kubernetes cluster, behind the same load balancer, or via the same DNS resolver as the production service will silently go dark together with the thing it is supposed to observe. The 2021 Fastly outage, the 2021 Facebook BGP incident, and the 2025 AWS us-east-1 DNS outage all had the same pathology: internal monitoring said "green" because it depended on the broken infrastructure. External probes, running on different clouds, different DNS, different networks, are the only reliable source of truth.

The managed landscape in 2026:

- **Datadog Synthetics**, multi-location HTTP, browser, and API tests integrated with RUM, APM, and incident management. The default choice when you are already on Datadog.
- **Grafana Cloud Synthetic Monitoring**, now backed by **k6 scripted checks** and k6 browser checks, so the same JavaScript test script that runs in your CI load test can run as a synthetic monitor across global probes. Strong integration with Prometheus and Grafana SLO alerting.
- **Checkly.** Playwright-based browser checks plus multi-step API monitoring with a monitoring-as-code workflow (tests live in your repo). The specialist choice when synthetic fidelity matters more than integration with a broader observability suite.
- **Pingdom, Uptrends, StatusCake**, simple uptime plus page-load timing, lower cost, less depth.

The in-process Go probes below are what you run **in addition to** external probes, not as a replacement. They give you probe customization (domain-specific assertions, internal auth flows, deep business-logic checks) that SaaS probes cannot express, but they MUST be deployed outside the cluster they observe.

### 4.1 Probe-Based Health Checks

Probe-based synthetic monitoring continuously exercises critical user journeys from external locations, detecting availability and correctness degradations that infrastructure health checks miss, a service can have healthy containers and a working database yet still return incorrect responses due to a configuration change or data corruption. Probes are Go programs that perform real API calls using a dedicated synthetic user account and assert both HTTP response codes and response body properties. The probe below tests the authentication, task creation, and real-time update flows of the task management application every 30 seconds from three geographic regions, emitting a Prometheus gauge per assertion that drives the on-call alerting policy.

```go
package synthetic

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Probe defines a synthetic test that runs on a schedule.
type Probe interface {
	Name() string
	Run(ctx context.Context) ProbeResult
}

// ProbeResult captures the outcome of a synthetic test.
type ProbeResult struct {
	Name      string
	Success   bool
	Latency   time.Duration
	Error     string
	Timestamp time.Time
	Labels    map[string]string
}

// HTTPProbe makes an HTTP request and checks response criteria.
type HTTPProbe struct {
	name       string
	method     string
	url        string
	wantStatus int
	wantBody   string     // substring to check
	headers    map[string]string
	timeout    time.Duration
	client     *http.Client
}

func NewHTTPProbe(name, method, url string, wantStatus int, timeout time.Duration) *HTTPProbe {
	return &HTTPProbe{
		name:       name,
		method:     method,
		url:        url,
		wantStatus: wantStatus,
		timeout:    timeout,
		headers:    make(map[string]string),
		client: &http.Client{
			Timeout: timeout,
		},
	}
}

func (p *HTTPProbe) Name() string { return p.name }

func (p *HTTPProbe) Run(ctx context.Context) ProbeResult {
	start := time.Now()
	result := ProbeResult{
		Name:      p.name,
		Timestamp: start,
		Labels:    map[string]string{"url": p.url, "method": p.method},
	}

	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, p.method, p.url, nil)
	if err != nil {
		result.Error = fmt.Sprintf("build request: %v", err)
		return result
	}
	for k, v := range p.headers {
		req.Header.Set(k, v)
	}

	resp, err := p.client.Do(req)
	result.Latency = time.Since(start)
	if err != nil {
		result.Error = fmt.Sprintf("request failed: %v", err)
		return result
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != p.wantStatus {
		result.Error = fmt.Sprintf("got status %d, want %d", resp.StatusCode, p.wantStatus)
		return result
	}

	if p.wantBody != "" && !strings.Contains(string(body), p.wantBody) {
		result.Error = fmt.Sprintf("body does not contain %q", p.wantBody)
		return result
	}

	result.Success = true
	return result
}

// DNSProbe checks DNS resolution latency.
type DNSProbe struct {
	name     string
	host     string
	timeout  time.Duration
	resolver *net.Resolver
}

func NewDNSProbe(name, host string, timeout time.Duration) *DNSProbe {
	return &DNSProbe{
		name:     name,
		host:     host,
		timeout:  timeout,
		resolver: net.DefaultResolver,
	}
}

func (p *DNSProbe) Name() string { return p.name }

func (p *DNSProbe) Run(ctx context.Context) ProbeResult {
	start := time.Now()
	result := ProbeResult{Name: p.name, Timestamp: start, Labels: map[string]string{"host": p.host}}

	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	addrs, err := p.resolver.LookupHost(ctx, p.host)
	result.Latency = time.Since(start)
	if err != nil {
		result.Error = fmt.Sprintf("DNS lookup failed: %v", err)
		return result
	}
	if len(addrs) == 0 {
		result.Error = "DNS returned no addresses"
		return result
	}
	result.Success = true
	return result
}

// TCPProbe checks TCP connectivity.
type TCPProbe struct {
	name    string
	addr    string
	timeout time.Duration
}

func NewTCPProbe(name, addr string, timeout time.Duration) *TCPProbe {
	return &TCPProbe{name: name, addr: addr, timeout: timeout}
}

func (p *TCPProbe) Name() string { return p.name }

func (p *TCPProbe) Run(ctx context.Context) ProbeResult {
	start := time.Now()
	result := ProbeResult{Name: p.name, Timestamp: start, Labels: map[string]string{"addr": p.addr}}

	conn, err := net.DialTimeout("tcp", p.addr, p.timeout)
	result.Latency = time.Since(start)
	if err != nil {
		result.Error = fmt.Sprintf("TCP connect failed: %v", err)
		return result
	}
	conn.Close()
	result.Success = true
	return result
}

// SyntheticMonitor runs probes on a schedule and exports metrics.
type SyntheticMonitor struct {
	probes    []scheduledProbe
	results   sync.Map // probe name → *ProbeResult
	histStore sync.Map // probe name → []ProbeResult (recent history)
	histMax   int
	onFailure func(ProbeResult)
	mu        sync.Mutex
}

type scheduledProbe struct {
	probe    Probe
	interval time.Duration
}

func NewSyntheticMonitor(histMax int, onFailure func(ProbeResult)) *SyntheticMonitor {
	return &SyntheticMonitor{histMax: histMax, onFailure: onFailure}
}

// AddProbe registers a probe to run on the given interval.
func (m *SyntheticMonitor) AddProbe(probe Probe, interval time.Duration) {
	m.probes = append(m.probes, scheduledProbe{probe: probe, interval: interval})
}

// Start runs all probes on their schedules.
func (m *SyntheticMonitor) Start(ctx context.Context) {
	for _, sp := range m.probes {
		go m.runProbe(ctx, sp)
	}
}

func (m *SyntheticMonitor) runProbe(ctx context.Context, sp scheduledProbe) {
	// Run immediately then on interval
	m.execute(ctx, sp.probe)

	ticker := time.NewTicker(sp.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.execute(ctx, sp.probe)
		case <-ctx.Done():
			return
		}
	}
}

func (m *SyntheticMonitor) execute(ctx context.Context, probe Probe) {
	result := probe.Run(ctx)

	// Store latest result
	m.results.Store(probe.Name(), &result)

	// Append to history
	m.histStore.LoadOrStore(probe.Name(), &sync.Mutex{})
	raw, _ := m.histStore.LoadOrStore(probe.Name()+"_hist", &[]ProbeResult{})
	mu, _ := m.histStore.Load(probe.Name())
	mu.(*sync.Mutex).Lock()
	hist := raw.(*[]ProbeResult)
	*hist = append(*hist, result)
	if len(*hist) > m.histMax {
		*hist = (*hist)[len(*hist)-m.histMax:]
	}
	mu.(*sync.Mutex).Unlock()

	if !result.Success && m.onFailure != nil {
		m.onFailure(result)
	}
}

// GetResult returns the most recent result for a probe.
func (m *SyntheticMonitor) GetResult(probeName string) *ProbeResult {
	if v, ok := m.results.Load(probeName); ok {
		return v.(*ProbeResult)
	}
	return nil
}

// Availability returns the success rate over recent results.
func (m *SyntheticMonitor) Availability(probeName string) float64 {
	raw, ok := m.histStore.Load(probeName + "_hist")
	if !ok {
		return 0
	}
	mu, _ := m.histStore.Load(probeName)
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()

	hist := *raw.(*[]ProbeResult)
	if len(hist) == 0 {
		return 0
	}
	success := 0
	for _, r := range hist {
		if r.Success {
			success++
		}
	}
	return float64(success) / float64(len(hist))
}

// ProbeMetricsHandler serves a Prometheus-compatible metrics endpoint.
func (m *SyntheticMonitor) ProbeMetricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		m.results.Range(func(k, v any) bool {
			name := k.(string)
			result := v.(*ProbeResult)
			avail := m.Availability(name)
			success := 0
			if result.Success {
				success = 1
			}
			fmt.Fprintf(w, "probe_success{probe=%q} %d\n", name, success)
			fmt.Fprintf(w, "probe_latency_seconds{probe=%q} %f\n", name, result.Latency.Seconds())
			fmt.Fprintf(w, "probe_availability{probe=%q} %f\n", name, avail)
			return true
		})
	})
}
```

### 4.2 What to probe vs what to leave alone

Synthetic probes cost something to run (CPU, network, time to interpret their alerts) and if you probe everything the alerts become noise. Four categories worth probing. **Critical user journeys**: the two or three flows that matter most to the business (sign-in, checkout, search). If these are broken, the company is broken. **External-facing endpoints**: any API consumed by customers or partners. **Cross-region dependencies**: anything that requires the network between two regions to be healthy. **SLO-critical paths**: any endpoint whose SLO has a blame-assignment in the SLA. Categories to leave alone: internal admin endpoints, rarely-used features, paths that are naturally exercised by real traffic at high volume. Probing low-traffic admin endpoints adds cost without improving the signal, because the real traffic to high-traffic endpoints is already a better probe than any synthetic.

### 4.3 Junior → FAANG: the synthetic probe you run on day one

On your first day on a new service, write one synthetic probe against its most critical endpoint. Deploy it to a separate environment (not the same cluster as the service). Set it to run every minute. Wire the alert to page when it fails two minutes in a row. That single probe catches the most egregious outages, and setting it up teaches you the service's authentication, networking, and basic health contract. It is also a concrete artifact you can point at during team onboarding, "yes, we have at least one end-to-end probe on our critical path." Interviewers love the habit: "my first week on any team, I write a synthetic probe for the most critical endpoint." It signals operational maturity without any drama.

### 4.4 Senior @ FAANG: the failure-domain isolation audit

Synthetic probes that run in the same failure domain as the service they monitor are worse than no probes: they give you confidence that evaporates at the worst possible moment. At staff level, audit every synthetic probe your organization runs. For each one, ask: if the service being probed went down due to a BGP failure, a DNS failure, a cloud provider failure, or a cluster-wide outage, would the probe still accurately report it? If not, move the probe. External SaaS probes (Datadog, Grafana Cloud, Checkly) are the simplest solution and the default recommendation. Self-hosted probes in a different cloud region are viable but require discipline to keep the isolation intact as infrastructure evolves. Document the isolation contract for each probe in its runbook: what failure domain it protects against, what it does not cover. This audit is boring and tedious and saves the career-limiting incident where monitoring was "green" during a real outage.

---
