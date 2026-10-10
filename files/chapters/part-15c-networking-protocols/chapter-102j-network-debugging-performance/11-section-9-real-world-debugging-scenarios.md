## 102J.9 Real-World Debugging Scenarios

### 9.1 Scenario Playbook

Production network incidents rarely present clean error messages, they appear as elevated latency, intermittent timeouts, or mysterious request drops that do not reproduce locally. The playbook below catalogs the most common failure patterns, their distinguishing symptoms (what metrics or logs look abnormal), and the sequence of diagnostic steps and code fixes that resolve them. Having these scenarios documented accelerates incident response significantly.

```go
package netdebug

import "fmt"

// Scenario describes a real-world networking problem and its solution.
type Scenario struct {
	Name      string
	Symptoms  []string
	Diagnosis []string
	Fix       []string
}

// CommonScenarios is a playbook of real-world network debugging cases.
var CommonScenarios = []Scenario{
	{
		Name: "Connection Pool Exhaustion",
		Symptoms: []string{
			"HTTP requests hang or timeout under load",
			"context deadline exceeded after N seconds of wait",
			"Goroutine count grows, many in 'net/http.(*persistConn).writeLoop'",
		},
		Diagnosis: []string{
			"Check MaxIdleConnsPerHost vs. concurrency: if concurrency >> MaxIdleConnsPerHost, pool is too small",
			"Check for response body not being drained/closed: CLOSE_WAIT count in /proc/net/tcp",
			"pprof goroutine profile: look for goroutines blocked on (*Transport).getIdleConn",
		},
		Fix: []string{
			"Increase MaxIdleConnsPerHost to match expected concurrency",
			"Ensure all response bodies are read fully then closed: defer resp.Body.Close() AND io.Copy(io.Discard, resp.Body)",
			"Use http.Client.Timeout to prevent eternal waits",
		},
	},
	{
		Name: "TIME_WAIT Exhaustion",
		Symptoms: []string{
			"bind: address already in use (short-lived services)",
			"Thousands of TIME_WAIT in ss -s output",
			"Port exhaustion errors when making outbound requests",
		},
		Diagnosis: []string{
			"ss -tan | grep TIME-WAIT | wc -l",
			"cat /proc/sys/net/ipv4/ip_local_port_range",
			"Check if short-lived HTTP clients without keep-alive are used",
		},
		Fix: []string{
			"Enable HTTP keep-alive: DisableKeepAlives: false (default)",
			"sysctl net.ipv4.tcp_tw_reuse=1 (allows reuse for outbound connections)",
			"Widen ephemeral port range: net.ipv4.ip_local_port_range = 10000 65535",
			"Use a shared http.Client per service rather than per-request clients",
		},
	},
	{
		Name: "Slow TLS Handshake",
		Symptoms: []string{
			"TLS phase in httptrace > 500ms",
			"First request slow, subsequent requests fast (no session reuse)",
		},
		Diagnosis: []string{
			"Check TLS version: TLS 1.3 should be used",
			"OCSP stapling disabled? Requires live OCSP check",
			"Certificate chain length > 3? Each cert validated with network call",
			"Session tickets not working: check TLS session cache on client",
		},
		Fix: []string{
			"Enforce TLS 1.3: MinVersion: tls.VersionTLS13",
			"Enable OCSP stapling on server to avoid client-side OCSP round-trips",
			"Use LRU session cache: tls.NewLRUClientSessionCache(128)",
			"Prefer X25519 curve for faster key exchange",
		},
	},
	{
		Name: "Retry Storm",
		Symptoms: []string{
			"Cascading service failures when one downstream is slow",
			"Error rate spikes then stabilizes at high level",
			"Downstream logs show request rate 10x normal during recovery",
		},
		Diagnosis: []string{
			"Count retries in outbound requests vs. first attempts",
			"Check if all services retry simultaneously with same backoff",
			"Look for thundering herd: multiple services retry immediately after timeout",
		},
		Fix: []string{
			"Add exponential backoff with jitter to all retry logic",
			"Implement retry budget: limit total retries per second (token bucket)",
			"Add circuit breaker: stop retrying after N consecutive failures",
			"Use context cancellation to propagate deadlines and stop retries",
		},
	},
	{
		Name: "Head-of-Line Blocking on HTTP/1.1",
		Symptoms: []string{
			"Fast requests blocked behind slow requests in browser waterfall",
			"p99 latency much higher than p50 despite low server processing time",
			"Goroutines blocked on http.(*persistConn).writeLoop",
		},
		Diagnosis: []string{
			"Check HTTP version in requests: r.Proto == 'HTTP/1.1'",
			"Verify HTTP/2 ALPN negotiation: curl --http2 -v logs 'Using HTTP2, server supports multi-use'",
		},
		Fix: []string{
			"Enable HTTP/2 on server: http2.ConfigureServer(srv, nil)",
			"Enable HTTP/2 on client: http2.ConfigureTransport(transport) or ForceAttemptHTTP2: true",
			"For internal services, use h2c (HTTP/2 cleartext) to avoid TLS overhead",
		},
	},
	{
		Name: "DNS Cache Stampede",
		Symptoms: []string{
			"Periodic latency spikes every 5-60 seconds",
			"Multiple goroutines blocked in resolver.LookupHost simultaneously",
			"Go's DNS cache TTL expired during high load",
		},
		Diagnosis: []string{
			"GODEBUG=netdns=go+1 to see DNS resolver activity",
			"Check if all goroutines hit DNS simultaneously (no client-side cache)",
		},
		Fix: []string{
			"Implement DNS caching with TTL in application layer",
			"Use SingleFlight to deduplicate concurrent DNS lookups",
			"For k8s: use CoreDNS with positive caching and stale TTL",
		},
	},
}

// PrintPlaybook formats and prints the debugging playbook.
func PrintPlaybook() {
	for i, s := range CommonScenarios {
		fmt.Printf("Scenario %d: %s\n", i+1, s.Name)
		fmt.Println("  Symptoms:")
		for _, sym := range s.Symptoms {
			fmt.Printf("    - %s\n", sym)
		}
		fmt.Println("  Diagnosis:")
		for _, d := range s.Diagnosis {
			fmt.Printf("    → %s\n", d)
		}
		fmt.Println("  Fix:")
		for _, f := range s.Fix {
			fmt.Printf("    ✓ %s\n", f)
		}
		fmt.Println()
	}
}
```

### Junior → FAANG: Postmortems as Study Material

Each scenario in this playbook represents a real class of production incident. The most valuable study practice is to read the scenario, close the section, and attempt to reproduce the diagnostic steps independently: what metrics would you look at first? What commands would you run? What would the output tell you? Then read the playbook and compare.

This active-recall approach builds debugging intuition faster than reading the playbook passively. The first time you encounter a `CLOSE_WAIT` accumulation in production, your brain should immediately pattern-match to "undrained response bodies" rather than requiring fresh research. That pattern match is built through practice, not passive reading.

For interviews: "describe a network debugging scenario you have encountered" is a common question. Having worked through these playbook scenarios gives you concrete, detailed answers even without direct production experience.

### Senior @ FAANG: Converting Playbooks to Automated Runbooks

At FAANG scale, human-executed playbooks are too slow for incidents that require sub-minute response. The high-value investment is converting playbook steps to automated runbooks: scripts that execute the diagnostic commands, parse their output, and produce a structured diagnosis with remediation recommendations.

An automated runbook for the `CLOSE_WAIT` scenario: (1) check `ss -tan state close-wait | wc -l` against threshold, (2) if above threshold, pull the goroutine dump from `/debug/pprof/goroutine`, (3) look for `net/http` goroutines blocked in `(*Response).Body.Read`, (4) correlate with the service version that introduced the problematic code path, (5) generate a Jira ticket with the goroutine dump and suspected code location. This reduces diagnosis time from 20 minutes (human following the playbook) to 30 seconds (automation).

The organizational value: automated runbooks allow on-call engineers to delegate the initial diagnosis to automation, freeing them to focus on the remediation decision rather than the diagnostic process. This is one of the most valuable investments for reducing mean time to resolution (MTTR) for recurring incident types.

---
