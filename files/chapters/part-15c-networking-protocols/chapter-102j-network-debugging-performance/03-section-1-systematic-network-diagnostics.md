## 102J.1 Systematic Network Diagnostics

### 1.1 DNS Debugging

DNS failures and latency are frequently the root cause of unexplained connection timeouts in microservice environments. The `DNSProbe` below measures resolution latency per query, heuristically detects OS-level cache hits when latency is under 1ms, and runs multiple iterations to expose intermittent NXDOMAIN errors or high variance. A companion `DNSCache` wraps the standard resolver with a TTL-aware in-process cache to reduce external DNS load for services that perform many lookups to the same set of hostnames.

```go
package netdebug

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// DNSProbe tests DNS resolution latency, NXDOMAIN, and TTL.
type DNSProbe struct {
	resolver *net.Resolver
	timeout  time.Duration
}

// NewDNSProbe creates a probe using the default system resolver.
func NewDNSProbe(timeout time.Duration) *DNSProbe {
	return &DNSProbe{
		resolver: net.DefaultResolver,
		timeout:  timeout,
	}
}

// NewCustomDNSProbe creates a probe using a specific DNS server.
func NewCustomDNSProbe(dnsAddr string, timeout time.Duration) *DNSProbe {
	return &DNSProbe{
		resolver: &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: timeout}
				return d.DialContext(ctx, "udp", dnsAddr)
			},
		},
		timeout: timeout,
	}
}

// DNSResult contains resolution outcome.
type DNSResult struct {
	Host      string
	Addrs     []string
	Latency   time.Duration
	CacheTTL  time.Duration // estimated
	Error     error
}

// LookupHost resolves a hostname and measures round-trip time.
func (p *DNSProbe) LookupHost(ctx context.Context, host string) DNSResult {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()

	start := time.Now()
	addrs, err := p.resolver.LookupHost(ctx, host)
	latency := time.Since(start)

	result := DNSResult{
		Host:    host,
		Latency: latency,
		Error:   err,
	}

	for _, addr := range addrs {
		result.Addrs = append(result.Addrs, addr)
	}

	// Heuristic: if latency < 1ms, likely served from local OS cache
	if latency < time.Millisecond {
		result.CacheTTL = 60 * time.Second // probably cached
	}

	return result
}

// DNSTrace runs multiple lookups to test caching behavior.
func (p *DNSProbe) DNSTrace(ctx context.Context, host string, iterations int) []DNSResult {
	results := make([]DNSResult, iterations)
	for i := 0; i < iterations; i++ {
		results[i] = p.LookupHost(ctx, host)
		time.Sleep(10 * time.Millisecond) // small delay between queries
	}
	return results
}

// AnalyzeDNS prints a diagnostic summary of DNS results.
func AnalyzeDNS(results []DNSResult) string {
	if len(results) == 0 {
		return "no results"
	}

	var minLat, maxLat, totalLat time.Duration
	errors := 0
	cached := 0

	minLat = results[0].Latency
	maxLat = results[0].Latency

	for _, r := range results {
		if r.Error != nil {
			errors++
			continue
		}
		totalLat += r.Latency
		if r.Latency < minLat {
			minLat = r.Latency
		}
		if r.Latency > maxLat {
			maxLat = r.Latency
		}
		if r.CacheTTL > 0 {
			cached++
		}
	}

	n := len(results) - errors
	avgLat := time.Duration(0)
	if n > 0 {
		avgLat = totalLat / time.Duration(n)
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "DNS Analysis for %s:\n", results[0].Host)
	fmt.Fprintf(&sb, "  Queries: %d, Errors: %d, Cache hits: %d\n", len(results), errors, cached)
	fmt.Fprintf(&sb, "  Latency: min=%v avg=%v max=%v\n", minLat, avgLat, maxLat)
	if len(results[0].Addrs) > 0 {
		fmt.Fprintf(&sb, "  Resolved to: %s\n", strings.Join(results[0].Addrs, ", "))
	}

	if avgLat > 50*time.Millisecond {
		fmt.Fprintf(&sb, "  ⚠ HIGH DNS latency - consider using a closer resolver or DNS caching\n")
	}
	if errors > len(results)/4 {
		fmt.Fprintf(&sb, "  ⚠ HIGH DNS error rate - check resolver availability\n")
	}

	return sb.String()
}

// DNSCache wraps a resolver with TTL-aware caching.
type DNSCache struct {
	resolver *net.Resolver
	cache    sync.Map // host → *dnsCacheEntry
	ttl      time.Duration
}

type dnsCacheEntry struct {
	addrs    []string
	expiry   time.Time
}

func NewDNSCache(ttl time.Duration) *DNSCache {
	return &DNSCache{
		resolver: net.DefaultResolver,
		ttl:      ttl,
	}
}

func (c *DNSCache) LookupHost(ctx context.Context, host string) ([]string, error) {
	if v, ok := c.cache.Load(host); ok {
		entry := v.(*dnsCacheEntry)
		if time.Now().Before(entry.expiry) {
			return entry.addrs, nil
		}
	}

	addrs, err := c.resolver.LookupHost(ctx, host)
	if err != nil {
		return nil, err
	}

	c.cache.Store(host, &dnsCacheEntry{
		addrs:  addrs,
		expiry: time.Now().Add(c.ttl),
	})

	return addrs, nil
}

// InvalidateCache removes a host from the DNS cache.
func (c *DNSCache) InvalidateCache(host string) {
	c.cache.Delete(host)
}
```

### 1.2 TCP Connection State Analysis

High `TIME_WAIT` counts signal that the application is closing connections faster than the OS can recycle them, while elevated `CLOSE_WAIT` counts indicate a resource leak where response bodies are not being fully read and closed. Parsing `/proc/net/tcp` directly on Linux reads the kernel connection table without requiring root privileges or external tools. The `DiagnoseConnectionTable` function translates raw counts into actionable warnings with specific remediation guidance.

```go
package netdebug

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// TCPConnState mirrors /proc/net/tcp states.
type TCPConnState int

const (
	TCPEstablished TCPConnState = 1
	TCPSynSent     TCPConnState = 2
	TCPSynRecv     TCPConnState = 3
	TCPFinWait1    TCPConnState = 4
	TCPFinWait2    TCPConnState = 5
	TCPTimeWait    TCPConnState = 6
	TCPClose       TCPConnState = 7
	TCPCloseWait   TCPConnState = 8
	TCPLastAck     TCPConnState = 9
	TCPListen      TCPConnState = 10
	TCPClosing     TCPConnState = 11
)

func (s TCPConnState) String() string {
	states := map[TCPConnState]string{
		TCPEstablished: "ESTABLISHED",
		TCPSynSent:     "SYN_SENT",
		TCPSynRecv:     "SYN_RECV",
		TCPFinWait1:    "FIN_WAIT1",
		TCPFinWait2:    "FIN_WAIT2",
		TCPTimeWait:    "TIME_WAIT",
		TCPClose:       "CLOSE",
		TCPCloseWait:   "CLOSE_WAIT",
		TCPLastAck:     "LAST_ACK",
		TCPListen:      "LISTEN",
		TCPClosing:     "CLOSING",
	}
	if s, ok := states[s]; ok {
		return s
	}
	return "UNKNOWN"
}

// TCPEntry represents a connection from /proc/net/tcp.
type TCPEntry struct {
	LocalAddr  string
	RemoteAddr string
	State      TCPConnState
	TxQueue    uint64
	RxQueue    uint64
	UID        int
	INode      uint64
}

// ParseProcNetTCP reads and parses /proc/net/tcp on Linux.
// This provides the raw connection table without requiring root.
func ParseProcNetTCP() ([]TCPEntry, error) {
	f, err := os.Open("/proc/net/tcp")
	if err != nil {
		return nil, fmt.Errorf("open /proc/net/tcp: %w (Linux only)", err)
	}
	defer f.Close()

	var entries []TCPEntry
	scanner := bufio.NewScanner(f)
	scanner.Scan() // skip header line

	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 12 {
			continue
		}

		localAddr := hexToAddr(fields[1])
		remoteAddr := hexToAddr(fields[2])
		stateHex, _ := strconv.ParseInt(fields[3], 16, 32)
		txqrxq := strings.Split(fields[4], ":")
		txq, _ := strconv.ParseUint(txqrxq[0], 16, 64)
		rxq, _ := strconv.ParseUint(txqrxq[1], 16, 64)
		uid, _ := strconv.Atoi(fields[7])
		inode, _ := strconv.ParseUint(fields[9], 10, 64)

		entries = append(entries, TCPEntry{
			LocalAddr:  localAddr,
			RemoteAddr: remoteAddr,
			State:      TCPConnState(stateHex),
			TxQueue:    txq,
			RxQueue:    rxq,
			UID:        uid,
			INode:      inode,
		})
	}

	return entries, scanner.Err()
}

// hexToAddr converts hex-encoded little-endian IP:port to "x.x.x.x:port".
func hexToAddr(hexStr string) string {
	parts := strings.Split(hexStr, ":")
	if len(parts) != 2 {
		return hexStr
	}

	// IPv4 address is stored in hex little-endian
	ipHex := parts[0]
	portHex := parts[1]

	if len(ipHex) == 8 {
		b, _ := strconv.ParseUint(ipHex, 16, 32)
		// little-endian byte order
		ip := net.IP{byte(b), byte(b >> 8), byte(b >> 16), byte(b >> 24)}
		port, _ := strconv.ParseUint(portHex, 16, 16)
		return fmt.Sprintf("%s:%d", ip, port)
	}

	return hexStr
}

// TCPStatSummary counts connections by state.
type TCPStatSummary struct {
	ByState     map[string]int
	TimeWaits   int
	CloseWaits  int
	Established int
}

// SummarizeTCP aggregates connection states.
func SummarizeTCP(entries []TCPEntry) TCPStatSummary {
	summary := TCPStatSummary{ByState: make(map[string]int)}
	for _, e := range entries {
		state := e.State.String()
		summary.ByState[state]++
		switch e.State {
		case TCPTimeWait:
			summary.TimeWaits++
		case TCPCloseWait:
			summary.CloseWaits++
		case TCPEstablished:
			summary.Established++
		}
	}
	return summary
}

// DiagnoseConnectionTable prints warnings for common problems.
func DiagnoseConnectionTable(summary TCPStatSummary) []string {
	var warnings []string

	if summary.TimeWaits > 1000 {
		warnings = append(warnings, fmt.Sprintf(
			"HIGH TIME_WAIT: %d connections - consider SO_REUSEADDR, shorter FIN timeout (net.ipv4.tcp_fin_timeout), or HTTP keep-alive",
			summary.TimeWaits))
	}

	if summary.CloseWaits > 100 {
		warnings = append(warnings, fmt.Sprintf(
			"HIGH CLOSE_WAIT: %d connections - likely a resource leak; check that response bodies are fully read and closed",
			summary.CloseWaits))
	}

	if summary.Established > 10000 {
		warnings = append(warnings, fmt.Sprintf(
			"HIGH ESTABLISHED: %d connections - ensure connection pooling is effective",
			summary.Established))
	}

	return warnings
}
```

### 1.3 HTTP Client Request Tracing

A request waterfall that breaks total latency into DNS, TCP connect, TLS handshake, request send, server processing, and response read phases immediately reveals which component to optimize. The `TraceRequest` function below uses `httptrace.ClientTrace` hooks to timestamp each phase boundary, then renders the results as a percentage bar chart so relative proportions are immediately obvious alongside absolute durations.

```go
package netdebug

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"
)

// RequestTimings captures timing for each phase of an HTTP request.
type RequestTimings struct {
	URL             string
	Method          string
	StatusCode      int

	// Connection phase
	DNSLookup       time.Duration
	TCPConnect      time.Duration
	TLSHandshake    time.Duration

	// Request/response phase
	RequestSend     time.Duration
	ServerProcess   time.Duration // time from request written to first byte
	ResponseRead    time.Duration
	Total           time.Duration

	// Metadata
	RemoteAddr      string
	TLSVersion      uint16
	DidResume       bool
	ConnReused      bool
}

// WaterfallLine formats timing as a visual waterfall bar.
func (t *RequestTimings) WaterfallLine(name string, dur time.Duration, total time.Duration) string {
	if total == 0 || dur == 0 {
		return fmt.Sprintf("  %-20s:  -", name)
	}
	pct := float64(dur) / float64(total)
	barWidth := 40
	filled := int(pct * float64(barWidth))
	bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
	return fmt.Sprintf("  %-20s: [%s] %v (%.1f%%)", name, bar, dur.Round(time.Microsecond), pct*100)
}

// Waterfall returns a human-readable timing breakdown.
func (t *RequestTimings) Waterfall() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Request: %s %s → %d\n", t.Method, t.URL, t.StatusCode)
	fmt.Fprintf(&sb, "Remote: %s, TLS: %s, Resumed: %v, Reused: %v\n",
		t.RemoteAddr, tlsVersionStr(t.TLSVersion), t.DidResume, t.ConnReused)
	fmt.Fprintf(&sb, "Timeline (total: %v):\n", t.Total)
	fmt.Fprintln(&sb, t.WaterfallLine("DNS Lookup", t.DNSLookup, t.Total))
	fmt.Fprintln(&sb, t.WaterfallLine("TCP Connect", t.TCPConnect, t.Total))
	fmt.Fprintln(&sb, t.WaterfallLine("TLS Handshake", t.TLSHandshake, t.Total))
	fmt.Fprintln(&sb, t.WaterfallLine("Request Send", t.RequestSend, t.Total))
	fmt.Fprintln(&sb, t.WaterfallLine("Server Process", t.ServerProcess, t.Total))
	fmt.Fprintln(&sb, t.WaterfallLine("Response Read", t.ResponseRead, t.Total))
	return sb.String()
}

func tlsVersionStr(v uint16) string {
	switch v {
	case tls.VersionTLS10:
		return "TLS1.0"
	case tls.VersionTLS11:
		return "TLS1.1"
	case tls.VersionTLS12:
		return "TLS1.2"
	case tls.VersionTLS13:
		return "TLS1.3"
	case 0:
		return "none"
	default:
		return fmt.Sprintf("0x%04X", v)
	}
}

// TraceRequest executes a traced HTTP request and returns timings.
func TraceRequest(ctx context.Context, client *http.Client, method, url string) (*RequestTimings, error) {
	t := &RequestTimings{URL: url, Method: method}

	var (
		dnsStart       time.Time
		connectStart   time.Time
		tlsStart       time.Time
		wroteHeaders   time.Time
		gotFirstByte   time.Time
		requestStart   = time.Now()
	)

	trace := &httptrace.ClientTrace{
		DNSStart:  func(_ httptrace.DNSStartInfo) { dnsStart = time.Now() },
		DNSDone:   func(_ httptrace.DNSDoneInfo) {
			if !dnsStart.IsZero() {
				t.DNSLookup = time.Since(dnsStart)
			}
		},
		ConnectStart: func(_, _ string) { connectStart = time.Now() },
		ConnectDone:  func(_, _ string, _ error) {
			if !connectStart.IsZero() {
				t.TCPConnect = time.Since(connectStart)
			}
		},
		TLSHandshakeStart: func() { tlsStart = time.Now() },
		TLSHandshakeDone: func(state tls.ConnectionState, _ error) {
			if !tlsStart.IsZero() {
				t.TLSHandshake = time.Since(tlsStart)
			}
			t.TLSVersion = state.Version
			t.DidResume = state.DidResume
		},
		GotConn: func(info httptrace.GotConnInfo) {
			t.RemoteAddr = info.Conn.RemoteAddr().String()
			t.ConnReused = info.Reused
		},
		WroteHeaders: func() { wroteHeaders = time.Now() },
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if !wroteHeaders.IsZero() {
				t.RequestSend = time.Since(wroteHeaders)
			}
		},
		GotFirstResponseByte: func() {
			gotFirstByte = time.Now()
			if !wroteHeaders.IsZero() {
				t.ServerProcess = gotFirstByte.Sub(wroteHeaders) - t.RequestSend
			}
		},
	}

	req, err := http.NewRequestWithContext(
		httptrace.WithClientTrace(ctx, trace), method, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		t.Total = time.Since(requestStart)
		return t, err
	}
	defer resp.Body.Close()

	// Drain body to get accurate response read timing
	responseStart := time.Now()
	io.Copy(io.Discard, resp.Body)
	t.ResponseRead = time.Since(responseStart)

	t.StatusCode = resp.StatusCode
	t.Total = time.Since(requestStart)

	return t, nil
}

// MultiEndpointTracer runs concurrent traces across multiple endpoints.
type MultiEndpointTracer struct {
	client *http.Client
	mu     sync.Mutex
}

func NewMultiEndpointTracer(client *http.Client) *MultiEndpointTracer {
	return &MultiEndpointTracer{client: client}
}

// TraceAll probes all endpoints concurrently.
func (m *MultiEndpointTracer) TraceAll(ctx context.Context, urls []string) []*RequestTimings {
	results := make([]*RequestTimings, len(urls))
	var wg sync.WaitGroup

	for i, url := range urls {
		wg.Add(1)
		go func(idx int, u string) {
			defer wg.Done()
			t, err := TraceRequest(ctx, m.client, "GET", u)
			if t == nil {
				t = &RequestTimings{URL: u, Method: "GET"}
			}
			if err != nil {
				t.URL = fmt.Sprintf("%s (ERROR: %v)", u, err)
			}
			results[idx] = t
		}(i, url)
	}

	wg.Wait()
	return results
}
```

### Junior → FAANG: DNS as the Overlooked Latency Source

DNS latency is the most commonly overlooked network latency source in Go services. When an HTTP client makes a request to a hostname, the first step is DNS resolution. If the DNS resolver is slow (high latency, overloaded), or if the Go runtime's DNS caching is not configured correctly, DNS adds hundreds of milliseconds to every request that opens a new connection. The symptom is high p99 latency with p50 that looks normal (because most requests reuse a cached connection).

The diagnostic: use `httptrace` and look at the `DNSStart` and `DNSDone` events. If DNS is taking more than 10 milliseconds, investigate: is the Go DNS resolver using the system resolver or the pure Go resolver? Is the DNS server responding slowly? Is there a negative caching entry causing repeated resolver queries for a name that previously failed?

First-job habit: add `httptrace` instrumentation to your service's health check endpoint. If DNS resolution takes more than 5ms on the health check, investigate before it affects production latency.

### Senior @ FAANG: DNS at Scale: Resolver Architecture and Cache Poisoning Defense

At FAANG scale, DNS resolution is a platform infrastructure problem. Each container in a fleet makes DNS queries. At high scale, the DNS server itself becomes a bottleneck if queries are not cached locally. The correct architecture is a local DNS caching resolver in each pod (CoreDNS sidecar or `dnsmasq`) that caches responses and dramatically reduces the load on the cluster DNS service.

The security concern: DNS cache poisoning attacks (Kaminsky attack and variants) can redirect traffic to malicious servers by poisoning the resolver's cache. The defense is DNSSEC (cryptographic signing of DNS responses) at the authoritative server, validated by the resolver. FAANG companies operating their own authoritative DNS must implement DNSSEC or document the accepted risk. For services that rely on external DNS (cloud provider or public DNS), DNSSEC validation at the resolver is the defense.

The L6 platform concern: DNS-over-HTTPS (DoH) and DNS-over-TLS (DoT) are increasingly deployed to prevent DNS interception on the network path. Deciding whether internal service DNS should use encrypted transport requires balancing security (prevents eavesdropping on which internal services are resolving which hostnames) against operational complexity (DoH requires an HTTP client at the DNS layer).

---
