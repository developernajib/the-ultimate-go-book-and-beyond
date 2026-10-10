## 83B.16 Cloudflare Deep Dive

### Overview for Go Engineers

Cloudflare is one of the heaviest production users of Go, and knowing exactly where Go sits in their stack is itself interview signal. Go powers their authoritative DNS server (RRDNS), the cloudflared tunnel daemon, large parts of the control plane, DDoS mitigation and security systems, and a great deal of internal tooling. The latency-critical data planes are deliberately not Go: the 1.1.1.1 resolver is built on Knot Resolver (C) with a Rust service layer, the Workers serverless runtime (workerd) is C++ on V8, and the newer edge proxies are Rust (Pingora and its descendants). Claiming "Workers runs on Go" in an interview is a credibility hit, while explaining why the control plane is Go and the data plane is Rust or C++ is exactly the systems judgment they hire for. With 300+ edge locations serving roughly a fifth of all web traffic, Cloudflare's engineering challenges are unique: sub-millisecond request routing, globally distributed DNS, rate limiting at the network edge, and running untrusted JavaScript/WebAssembly with millisecond-scale cold starts. Go engineers at Cloudflare are expected to understand networking deeply - TCP/IP, TLS handshakes, HTTP/2, DNS protocol internals, BGP anycast. They also work on security systems that must handle adversarial traffic at multi-Tbps scale. The interview process is technical and networking-heavy, with a strong emphasis on real-world systems over algorithmic puzzles. Cloudflare publishes extensively about their engineering - reading their blog is excellent preparation.

### Interview Process

Cloudflare's loop probes networking and systems fundamentals more deeply than most companies:

```
┌──────────────────────────────────────────────────────────────────┐
│                CLOUDFLARE INTERVIEW PIPELINE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │                                                          │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Networking concepts + coding                          │
│       ▼                                                          │
│  Take-Home Project (3-5 days, common for Go roles)               │
│       │  - Build a small network service or CLI tool             │
│       ▼                                                          │
│  Virtual Onsite (4 rounds, 60 min each)                          │
│       │  - 2 Technical rounds (networking + systems + coding)    │
│       │  - 1 System Design round (CDN/edge/security focus)       │
│       │  - 1 Behavioral/Values round                             │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 3-6 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Cloudflare's take-home projects for Go engineers are genuinely interesting: "build a DNS server," "build a load balancer," "implement an HTTP cache." They test real engineering judgment, not toy puzzles. The technical rounds assume you know TCP/IP well - you may be asked to trace a TLS handshake, explain BGP anycast routing, or describe how a SYN flood works and how to mitigate it.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| Software Engineer | SWE | 0-3 | $145K-$180K | $200K-$310K | Coding + networking fundamentals |
| Senior Engineer | Senior SWE | 3-7 | $185K-$230K | $310K-$470K | System design + security systems |
| Staff Engineer | Staff SWE | 7-12 | $225K-$290K | $470K-$650K | Architecture + cross-product scope |
| Principal Engineer | Principal | 12+ | $275K-$360K | $630K-$900K | Edge platform strategy |

### Representative Interview Problems

#### Problem 1: DNS Resolver (Easy)

*Implement a simplified recursive DNS resolver that can resolve A records.*

```go
package main

import (
	"errors"
	"fmt"
)

type DNSRecord struct {
	Name  string
	Type  string // "A", "CNAME", "NS"
	Value string
	TTL   int
}

// MockDNS simulates a real DNS server's zone data.
type MockDNS struct {
	zones map[string][]DNSRecord
}

func NewMockDNS() *MockDNS {
	return &MockDNS{zones: map[string][]DNSRecord{
		"example.com": {
			{Name: "example.com", Type: "A", Value: "93.184.216.34", TTL: 3600},
			{Name: "www.example.com", Type: "CNAME", Value: "example.com", TTL: 300},
		},
		"cloudflare.com": {
			{Name: "cloudflare.com", Type: "A", Value: "104.16.132.229", TTL: 300},
		},
	}}
}

func (d *MockDNS) Lookup(name, recordType string) ([]DNSRecord, error) {
	for domain, records := range d.zones {
		_ = domain
		for _, r := range records {
			if r.Name == name && r.Type == recordType {
				return []DNSRecord{r}, nil
			}
		}
	}
	return nil, fmt.Errorf("NXDOMAIN: %s %s not found", name, recordType)
}

type DNSResolver struct {
	dns       *MockDNS
	cache     map[string]string
	maxDepth  int
}

func NewDNSResolver(dns *MockDNS) *DNSResolver {
	return &DNSResolver{dns: dns, cache: make(map[string]string), maxDepth: 10}
}

// Resolve resolves a name to an A record, following CNAME chains.
func (r *DNSResolver) Resolve(name string, depth int) (string, error) {
	if depth > r.maxDepth {
		return "", errors.New("CNAME chain too deep (possible loop)")
	}
	if ip, ok := r.cache[name]; ok {
		return ip, nil
	}

	// Try A record
	records, err := r.dns.Lookup(name, "A")
	if err == nil && len(records) > 0 {
		r.cache[name] = records[0].Value
		return records[0].Value, nil
	}

	// Try CNAME
	records, err = r.dns.Lookup(name, "CNAME")
	if err == nil && len(records) > 0 {
		return r.Resolve(records[0].Value, depth+1)
	}

	return "", fmt.Errorf("unable to resolve %s", name)
}

func main() {
	dns := NewMockDNS()
	resolver := NewDNSResolver(dns)

	names := []string{"cloudflare.com", "www.example.com", "example.com", "unknown.io"}
	for _, name := range names {
		ip, err := resolver.Resolve(name, 0)
		if err != nil {
			fmt.Printf("%-25s → ERROR: %v\n", name, err)
		} else {
			fmt.Printf("%-25s → %s\n", name, ip)
		}
	}
}
```

#### Problem 2: HTTP Rate Limiter - Token Bucket per IP (Easy)

*Implement a per-IP rate limiter at the edge - Cloudflare's first line of defense against API abuse.*

```go
package main

import (
	"fmt"
	"net"
	"sync"
	"time"
)

type IPBucket struct {
	tokens    float64
	maxTokens float64
	fillRate  float64 // tokens per second
	lastFill  time.Time
}

func (b *IPBucket) Allow() bool {
	now := time.Now()
	elapsed := now.Sub(b.lastFill).Seconds()
	b.tokens = min(b.maxTokens, b.tokens+elapsed*b.fillRate)
	b.lastFill = now
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

type EdgeRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*IPBucket
	max     float64
	fill    float64
}

func NewEdgeRateLimiter(maxBurst, fillPerSec float64) *EdgeRateLimiter {
	return &EdgeRateLimiter{
		buckets: make(map[string]*IPBucket),
		max:     maxBurst,
		fill:    fillPerSec,
	}
}

func (rl *EdgeRateLimiter) Allow(ip net.IP) (bool, float64) {
	key := ip.String()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if _, ok := rl.buckets[key]; !ok {
		rl.buckets[key] = &IPBucket{
			tokens:    rl.max,
			maxTokens: rl.max,
			fillRate:  rl.fill,
			lastFill:  time.Now(),
		}
	}
	b := rl.buckets[key]
	allowed := b.Allow()
	return allowed, b.tokens
}

func main() {
	limiter := NewEdgeRateLimiter(5, 2) // burst=5, refill 2/sec

	attackerIP := net.ParseIP("1.2.3.4")
	legitimateIP := net.ParseIP("5.6.7.8")

	fmt.Println("Simulating attacker (10 rapid requests):")
	for i := range 10 {
		allowed, remaining := limiter.Allow(attackerIP)
		fmt.Printf("  request %2d: allowed=%-5v tokens_left=%.1f\n", i+1, allowed, remaining)
	}

	fmt.Println("\nLegitimate user (3 spaced requests):")
	for i := range 3 {
		allowed, remaining := limiter.Allow(legitimateIP)
		fmt.Printf("  request %d: allowed=%v tokens_left=%.1f\n", i+1, allowed, remaining)
		time.Sleep(600 * time.Millisecond)
	}
}
```

#### Problem 3: CDN Cache with TTL and Stale-While-Revalidate (Easy)

*Implement an edge cache that supports TTL expiry and stale-while-revalidate - serving stale content while refreshing in background.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type CachedResponse struct {
	Body       string
	CachedAt   time.Time
	TTL        time.Duration
	Revalidating bool
}

func (r *CachedResponse) IsFresh() bool {
	return time.Since(r.CachedAt) < r.TTL
}

func (r *CachedResponse) IsStaleWhileRevalidate(swr time.Duration) bool {
	age := time.Since(r.CachedAt)
	return age >= r.TTL && age < r.TTL+swr
}

type EdgeCache struct {
	mu    sync.Mutex
	store map[string]*CachedResponse
	swr   time.Duration // stale-while-revalidate window
}

func NewEdgeCache(swrWindow time.Duration) *EdgeCache {
	return &EdgeCache{store: make(map[string]*CachedResponse), swr: swrWindow}
}

// fetch simulates an origin request.
func fetch(url string) string {
	return fmt.Sprintf("fresh content from origin for %s at %v", url, time.Now().Format("15:04:05.000"))
}

func (ec *EdgeCache) Get(url string) (string, string) {
	ec.mu.Lock()
	entry, ok := ec.store[url]
	ec.mu.Unlock()

	if !ok {
		// Cache miss - fetch from origin
		body := fetch(url)
		ec.mu.Lock()
		ec.store[url] = &CachedResponse{Body: body, CachedAt: time.Now(), TTL: 2 * time.Second}
		ec.mu.Unlock()
		return body, "MISS"
	}

	if entry.IsFresh() {
		return entry.Body, "HIT"
	}

	if entry.IsStaleWhileRevalidate(ec.swr) && !entry.Revalidating {
		// Serve stale + trigger background revalidation
		ec.mu.Lock()
		entry.Revalidating = true
		ec.mu.Unlock()

		go func() {
			body := fetch(url)
			ec.mu.Lock()
			ec.store[url] = &CachedResponse{Body: body, CachedAt: time.Now(), TTL: 2 * time.Second}
			ec.mu.Unlock()
		}()
		return entry.Body, "STALE (revalidating)"
	}

	// Expired - synchronous fetch
	body := fetch(url)
	ec.mu.Lock()
	ec.store[url] = &CachedResponse{Body: body, CachedAt: time.Now(), TTL: 2 * time.Second}
	ec.mu.Unlock()
	return body, "EXPIRED"
}

func main() {
	cache := NewEdgeCache(1 * time.Second) // 1s stale-while-revalidate window
	url := "https://example.com/api/data"

	fmt.Println("Request 1 (cold):")
	_, status := cache.Get(url)
	fmt.Printf("  Status: %s\n", status)

	fmt.Println("Request 2 (fresh cache):")
	_, status = cache.Get(url)
	fmt.Printf("  Status: %s\n", status)

	time.Sleep(2100 * time.Millisecond) // let TTL expire

	fmt.Println("Request 3 (stale-while-revalidate):")
	_, status = cache.Get(url)
	fmt.Printf("  Status: %s\n", status)

	time.Sleep(200 * time.Millisecond) // let background refresh complete

	fmt.Println("Request 4 (fresh after revalidation):")
	_, status = cache.Get(url)
	fmt.Printf("  Status: %s\n", status)
}
```

#### Problem 4: DDoS SYN Flood Mitigation (Medium)

*Implement SYN cookie validation - Cloudflare's stateless protection against SYN flood attacks.*

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"time"
)

var secretKey = []byte("cloudflare-secret-edge-key")

// GenerateSYNCookie creates a stateless SYN cookie from the connection 4-tuple.
// The cookie is embedded in the TCP sequence number so no state is kept server-side.
func GenerateSYNCookie(srcIP, dstIP [4]byte, srcPort, dstPort uint16, timestamp uint32) uint32 {
	mac := hmac.New(sha256.New, secretKey)
	buf := make([]byte, 16)
	copy(buf[0:4], srcIP[:])
	copy(buf[4:8], dstIP[:])
	binary.BigEndian.PutUint16(buf[8:], srcPort)
	binary.BigEndian.PutUint16(buf[10:], dstPort)
	binary.BigEndian.PutUint32(buf[12:], timestamp)
	_, _ = mac.Write(buf)
	h := mac.Sum(nil)
	// Use bottom 24 bits of HMAC + 8-bit timestamp (for 64-second window)
	cookie := binary.BigEndian.Uint32(h[:4])&0x00FFFFFF | uint32(timestamp&0xFF)<<24
	return cookie
}

// ValidateSYNCookie checks that the ACK number matches what we sent in the SYN-ACK.
func ValidateSYNCookie(srcIP, dstIP [4]byte, srcPort, dstPort uint16, ackNum uint32) bool {
	now := uint32(time.Now().Unix() / 64) // 64-second window

	// Check current and previous time window
	for _, ts := range []uint32{now, now - 1} {
		expected := GenerateSYNCookie(srcIP, dstIP, srcPort, dstPort, ts)
		// ACK number = ISN + 1, so ackNum - 1 = ISN (our cookie)
		if ackNum-1 == expected {
			return true
		}
	}
	return false
}

func main() {
	srcIP := [4]byte{1, 2, 3, 4}
	dstIP := [4]byte{104, 16, 132, 229}
	srcPort, dstPort := uint16(54321), uint16(443)

	// Server generates SYN cookie and embeds in SYN-ACK
	ts := uint32(time.Now().Unix() / 64)
	isn := GenerateSYNCookie(srcIP, dstIP, srcPort, dstPort, ts)
	fmt.Printf("Generated SYN cookie (ISN): %d\n", isn)

	// Legitimate client sends ACK with ackNum = ISN + 1
	ackFromClient := isn + 1
	valid := ValidateSYNCookie(srcIP, dstIP, srcPort, dstPort, ackFromClient)
	fmt.Printf("Legitimate ACK validation: %v\n", valid)

	// Attacker sends random ACK
	attackerACK := uint32(0xDEADBEEF)
	invalid := ValidateSYNCookie(srcIP, dstIP, srcPort, dstPort, attackerACK)
	fmt.Printf("Attacker ACK validation: %v\n", invalid)
}
```

#### Problem 5: Anycast Routing - Nearest Edge Node Selection (Medium)

*Implement anycast-based routing that directs requests to the lowest-latency Cloudflare edge node.*

```go
package main

import (
	"fmt"
	"math/rand/v2"
	"slices"
)

type EdgeNode struct {
	ID       string
	City     string
	Lat, Lng float64
	LoadPct  float64 // 0-100
	Healthy  bool
}

type RoutingDecision struct {
	Node   EdgeNode
	Score  float64
	Reason string
}

// RoutingScore computes a lower-is-better score for an edge node.
// Combines estimated latency (distance proxy) and current load.
func RoutingScore(node EdgeNode, clientLat, clientLng float64) float64 {
	if !node.Healthy {
		return 1e9
	}
	// Approximate degree distance as latency proxy
	dLat := node.Lat - clientLat
	dLng := node.Lng - clientLng
	distProxy := dLat*dLat + dLng*dLng
	loadPenalty := node.LoadPct / 100 * 5 // overloaded nodes cost up to 5 extra units
	return distProxy + loadPenalty
}

func SelectEdgeNode(nodes []EdgeNode, clientLat, clientLng float64) RoutingDecision {
	type scored struct {
		node  EdgeNode
		score float64
	}
	var candidates []scored
	for _, n := range nodes {
		if n.Healthy {
			candidates = append(candidates, scored{n, RoutingScore(n, clientLat, clientLng)})
		}
	}
	if len(candidates) == 0 {
		return RoutingDecision{Reason: "no healthy nodes"}
	}
	slices.SortFunc(candidates, func(a, b scored) int {
		if a.score < b.score {
			return -1
		} else if a.score > b.score {
			return 1
		}
		return 0
	})
	best := candidates[0]
	return RoutingDecision{Node: best.node, Score: best.score, Reason: "lowest latency+load score"}
}

func main() {
	nodes := []EdgeNode{
		{ID: "lax", City: "Los Angeles", Lat: 34.05, Lng: -118.25, LoadPct: 40, Healthy: true},
		{ID: "sfo", City: "San Francisco", Lat: 37.77, Lng: -122.42, LoadPct: 85, Healthy: true},
		{ID: "ord", City: "Chicago", Lat: 41.88, Lng: -87.63, LoadPct: 30, Healthy: true},
		{ID: "jfk", City: "New York", Lat: 40.71, Lng: -74.01, LoadPct: 60, Healthy: false},
	}

	// Client in San Jose, CA
	clientLat, clientLng := 37.33, -121.89
	decision := SelectEdgeNode(nodes, clientLat, clientLng)
	_ = rand.Float64 // prevent import warning
	fmt.Printf("Client (%.2f, %.2f) → routed to %s (%s) score=%.3f\n",
		clientLat, clientLng, decision.Node.ID, decision.Node.City, decision.Score)
	fmt.Printf("Note: JFK unhealthy, SFO penalized for high load (%.0f%%)\n", nodes[1].LoadPct)
}
```

#### Problem 6: TLS Certificate Transparency Log Verifier (Medium)

*Implement a Certificate Transparency log verifier - Cloudflare helps operate CT logs that prevent fraudulent certificates.*

```go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// MerkleTree is a simple binary Merkle tree for Certificate Transparency.
type MerkleTree struct {
	leaves []string // leaf hashes (certificate fingerprints)
}

func hashPair(left, right string) string {
	combined := left + right
	h := sha256.Sum256([]byte(combined))
	return hex.EncodeToString(h[:])
}

func hashLeaf(data string) string {
	h := sha256.Sum256([]byte("leaf:" + data))
	return hex.EncodeToString(h[:])
}

func (mt *MerkleTree) AddCert(certFingerprint string) {
	mt.leaves = append(mt.leaves, hashLeaf(certFingerprint))
}

// RootHash computes the Merkle root of all leaves.
func (mt *MerkleTree) RootHash() string {
	if len(mt.leaves) == 0 {
		return ""
	}
	nodes := make([]string, len(mt.leaves))
	copy(nodes, mt.leaves)

	for len(nodes) > 1 {
		if len(nodes)%2 != 0 {
			nodes = append(nodes, nodes[len(nodes)-1]) // duplicate last
		}
		var next []string
		for i := 0; i < len(nodes); i += 2 {
			next = append(next, hashPair(nodes[i], nodes[i+1]))
		}
		nodes = next
	}
	return nodes[0]
}

// InclusionProof returns the sibling hashes needed to prove a leaf is in the tree.
func (mt *MerkleTree) InclusionProof(certFingerprint string) ([]string, bool) {
	target := hashLeaf(certFingerprint)
	idx := -1
	for i, l := range mt.leaves {
		if l == target {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, false
	}

	nodes := make([]string, len(mt.leaves))
	copy(nodes, mt.leaves)
	var proof []string

	for len(nodes) > 1 {
		if len(nodes)%2 != 0 {
			nodes = append(nodes, nodes[len(nodes)-1])
		}
		siblingIdx := idx ^ 1 // XOR to get sibling
		if siblingIdx < len(nodes) {
			proof = append(proof, nodes[siblingIdx])
		}
		var next []string
		for i := 0; i < len(nodes); i += 2 {
			next = append(next, hashPair(nodes[i], nodes[i+1]))
		}
		nodes = next
		idx /= 2
	}
	return proof, true
}

func main() {
	tree := &MerkleTree{}
	certs := []string{"cloudflare.com:2026", "example.com:2026", "google.com:2026", "github.com:2026"}
	for _, c := range certs {
		tree.AddCert(c)
	}

	root := tree.RootHash()
	fmt.Printf("CT Log Root Hash: %s...\n", root[:16])

	proof, found := tree.InclusionProof("example.com:2026")
	fmt.Printf("Inclusion proof for example.com: found=%v, proof_depth=%d\n", found, len(proof))

	_, notFound := tree.InclusionProof("malicious.com:2026")
	fmt.Printf("Inclusion proof for malicious.com: found=%v\n", notFound)
}
```

#### Problem 7: Edge Worker Request Router (Medium)

*Implement Cloudflare Workers-style request routing - dispatching edge requests to handler functions based on URL patterns.*

```go
package main

import (
	"fmt"
	"regexp"
	"strings"
)

type Request struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    string
}

type Response struct {
	Status  int
	Body    string
	Headers map[string]string
}

type Handler func(req Request, params map[string]string) Response

type Route struct {
	Method  string
	Pattern *regexp.Regexp
	Params  []string
	Handler Handler
}

type Router struct {
	routes []Route
}

// pathToRegex converts "/api/users/:id" to a regex and extracts param names.
func pathToRegex(pattern string) (*regexp.Regexp, []string) {
	var params []string
	re := regexp.MustCompile(`:(\w+)`)
	regexStr := re.ReplaceAllStringFunc(pattern, func(s string) string {
		params = append(params, strings.TrimPrefix(s, ":"))
		return `([^/]+)`
	})
	return regexp.MustCompile("^" + regexStr + "$"), params
}

func (r *Router) Add(method, pattern string, handler Handler) {
	re, params := pathToRegex(pattern)
	r.routes = append(r.routes, Route{method, re, params, handler})
}

func (r *Router) Handle(req Request) Response {
	path := req.URL
	if idx := strings.Index(path, "?"); idx >= 0 {
		path = path[:idx]
	}
	for _, route := range r.routes {
		if route.Method != req.Method {
			continue
		}
		matches := route.Pattern.FindStringSubmatch(path)
		if matches == nil {
			continue
		}
		params := make(map[string]string)
		for i, name := range route.Params {
			if i+1 < len(matches) {
				params[name] = matches[i+1]
			}
		}
		return route.Handler(req, params)
	}
	return Response{Status: 404, Body: "Not Found"}
}

func main() {
	router := &Router{}

	router.Add("GET", "/api/users/:id", func(req Request, params map[string]string) Response {
		return Response{Status: 200, Body: fmt.Sprintf(`{"user_id":"%s"}`, params["id"])}
	})
	router.Add("POST", "/api/users", func(req Request, params map[string]string) Response {
		return Response{Status: 201, Body: `{"created":true}`}
	})
	router.Add("GET", "/health", func(req Request, params map[string]string) Response {
		return Response{Status: 200, Body: `{"status":"ok"}`}
	})

	requests := []Request{
		{Method: "GET", URL: "/api/users/42"},
		{Method: "POST", URL: "/api/users"},
		{Method: "GET", URL: "/health"},
		{Method: "GET", URL: "/api/unknown"},
	}

	for _, req := range requests {
		resp := router.Handle(req)
		fmt.Printf("%-6s %-25s → %d %s\n", req.Method, req.URL, resp.Status, resp.Body)
	}
}
```

#### Problem 8: Distributed Tracing - Trace Context Propagation (Hard)

*Implement W3C Trace Context propagation across Cloudflare edge workers - correlating requests across 300+ PoPs.*

```go
package main

import (
	"context"
	"fmt"
	"math/rand/v2"
)

type TraceContext struct {
	TraceID  string
	SpanID   string
	ParentID string
	Sampled  bool
}

type contextKey string
const traceKey contextKey = "trace"

func newSpanID() string {
	return fmt.Sprintf("%016x", rand.Uint64())
}

func newTraceID() string {
	return fmt.Sprintf("%032x", rand.Uint64())
}

// ParseTraceParent parses a W3C traceparent header.
// Format: "00-{traceID}-{parentSpanID}-{flags}"
func ParseTraceParent(header string) (*TraceContext, error) {
	var version, traceID, spanID, flags string
	n, _ := fmt.Sscanf(header, "%2s-%32s-%16s-%2s", &version, &traceID, &spanID, &flags)
	if n != 4 {
		return nil, fmt.Errorf("invalid traceparent: %q", header)
	}
	return &TraceContext{
		TraceID:  traceID,
		ParentID: spanID,
		SpanID:   newSpanID(), // this node creates a new span
		Sampled:  flags == "01",
	}, nil
}

func (tc TraceContext) Header() string {
	flags := "00"
	if tc.Sampled {
		flags = "01"
	}
	return fmt.Sprintf("00-%s-%s-%s", tc.TraceID, tc.SpanID, flags)
}

func StartSpan(ctx context.Context, name string) (context.Context, *TraceContext) {
	parent, _ := ctx.Value(traceKey).(*TraceContext)

	span := &TraceContext{SpanID: newSpanID(), Sampled: true}
	if parent != nil {
		span.TraceID = parent.TraceID
		span.ParentID = parent.SpanID
	} else {
		span.TraceID = newTraceID()
	}

	fmt.Printf("[%s] trace=%s span=%s parent=%s\n", name, span.TraceID[:8], span.SpanID[:8], span.ParentID)
	return context.WithValue(ctx, traceKey, span), span
}

func main() {
	// Simulate: Incoming request at CDN edge → Worker → Origin
	incomingHeader := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

	tc, err := ParseTraceParent(incomingHeader)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	fmt.Printf("Incoming trace: id=%s parent=%s\n", tc.TraceID[:8], tc.ParentID[:8])

	ctx := context.WithValue(context.Background(), traceKey, tc)

	ctx, _ = StartSpan(ctx, "cdn-edge-worker")
	ctx, _ = StartSpan(ctx, "origin-request")
	_, _ = StartSpan(ctx, "database-query")

	// The traceparent header to forward to origin
	if span, ok := ctx.Value(traceKey).(*TraceContext); ok {
		fmt.Printf("\nForward to origin: %s\n", span.Header())
	}
}
```

#### Problem 9: BGP Anycast Load Balancer with Health Checks (Hard)

*Simulate Cloudflare's anycast load balancer that withdraws unhealthy origin routes via BGP.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type Origin struct {
	ID      string
	IP      string
	Region  string
	Healthy bool
	Weight  int
}

type BGPRoute struct {
	Prefix  string
	Origin  string
	Active  bool
}

type AnycastLoadBalancer struct {
	mu       sync.RWMutex
	origins  map[string]*Origin
	routes   map[string]*BGPRoute
}

func NewAnycastLB() *AnycastLoadBalancer {
	return &AnycastLoadBalancer{
		origins: make(map[string]*Origin),
		routes:  make(map[string]*BGPRoute),
	}
}

func (lb *AnycastLoadBalancer) AddOrigin(o Origin, prefix string) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	lb.origins[o.ID] = &o
	lb.routes[o.ID] = &BGPRoute{Prefix: prefix, Origin: o.ID, Active: true}
	fmt.Printf("[BGP] Announcing route %s via %s\n", prefix, o.ID)
}

func (lb *AnycastLoadBalancer) HealthCheck(originID string, healthy bool) {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	origin, ok := lb.origins[originID]
	if !ok {
		return
	}
	if origin.Healthy == healthy {
		return
	}
	origin.Healthy = healthy
	route := lb.routes[originID]

	if healthy {
		route.Active = true
		fmt.Printf("[BGP] Re-announcing route %s via %s (healthy)\n", route.Prefix, originID)
	} else {
		route.Active = false
		fmt.Printf("[BGP] Withdrawing route %s via %s (unhealthy)\n", route.Prefix, originID)
	}
}

func (lb *AnycastLoadBalancer) ActiveOrigins() []*Origin {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	var active []*Origin
	for id, route := range lb.routes {
		if route.Active {
			active = append(active, lb.origins[id])
		}
	}
	return active
}

func main() {
	lb := NewAnycastLB()
	lb.AddOrigin(Origin{ID: "us-east", IP: "198.51.100.1", Region: "US-East", Healthy: true, Weight: 3}, "198.51.100.0/24")
	lb.AddOrigin(Origin{ID: "us-west", IP: "198.51.101.1", Region: "US-West", Healthy: true, Weight: 3}, "198.51.101.0/24")
	lb.AddOrigin(Origin{ID: "eu-central", IP: "198.51.102.1", Region: "EU", Healthy: true, Weight: 2}, "198.51.102.0/24")

	fmt.Printf("\nActive origins: %d\n", len(lb.ActiveOrigins()))

	time.Sleep(10 * time.Millisecond)
	fmt.Println("\nSimulating us-east failure:")
	lb.HealthCheck("us-east", false)
	fmt.Printf("Active origins after failure: %d\n", len(lb.ActiveOrigins()))

	time.Sleep(10 * time.Millisecond)
	fmt.Println("\nSimulating us-east recovery:")
	lb.HealthCheck("us-east", true)
	fmt.Printf("Active origins after recovery: %d\n", len(lb.ActiveOrigins()))
}
```

#### Problem 10: Zero-Trust Request Validator (Hard)

*Implement Cloudflare Access-style zero-trust validation that verifies JWT-based identity for every request.*

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var jwtSecret = []byte("cloudflare-access-signing-key")

type JWTClaims struct {
	Sub   string   `json:"sub"`
	Email string   `json:"email"`
	Teams []string `json:"teams"`
	Iat   int64    `json:"iat"`
	Exp   int64    `json:"exp"`
}

// signHS256 creates an HMAC-SHA256 signature for JWT.
func signHS256(data string) string {
	mac := hmac.New(sha256.New, jwtSecret)
	_, _ = mac.Write([]byte(data))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// CreateJWT creates a signed JWT token.
func CreateJWT(claims JWTClaims) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claimBytes, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(claimBytes)
	sig := signHS256(header + "." + payload)
	return header + "." + payload + "." + sig
}

// ValidateJWT parses and validates a JWT, returning claims if valid.
func ValidateJWT(token string) (*JWTClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid JWT format")
	}
	expectedSig := signHS256(parts[0] + "." + parts[1])
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSig)) {
		return nil, errors.New("invalid JWT signature")
	}
	claimBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("invalid claims encoding: %w", err)
	}
	var claims JWTClaims
	if err := json.Unmarshal(claimBytes, &claims); err != nil {
		return nil, fmt.Errorf("invalid claims JSON: %w", err)
	}
	if time.Now().Unix() > claims.Exp {
		return nil, errors.New("token expired")
	}
	return &claims, nil
}

type AccessPolicy struct {
	AllowedTeams []string
}

func (p *AccessPolicy) Authorize(claims *JWTClaims) bool {
	for _, allowedTeam := range p.AllowedTeams {
		for _, userTeam := range claims.Teams {
			if userTeam == allowedTeam {
				return true
			}
		}
	}
	return false
}

func main() {
	policy := &AccessPolicy{AllowedTeams: []string{"engineering", "security"}}

	// Create a valid token for an engineer
	token := CreateJWT(JWTClaims{
		Sub:   "user-123",
		Email: "engineer@company.com",
		Teams: []string{"engineering"},
		Iat:   time.Now().Unix(),
		Exp:   time.Now().Add(time.Hour).Unix(),
	})

	claims, err := ValidateJWT(token)
	fmt.Printf("Valid token: err=%v email=%s authorized=%v\n",
		err, claims.Email, policy.Authorize(claims))

	// Test expired token
	expiredToken := CreateJWT(JWTClaims{
		Sub: "old-user", Email: "old@company.com", Teams: []string{"engineering"},
		Iat: time.Now().Add(-2 * time.Hour).Unix(),
		Exp: time.Now().Add(-time.Hour).Unix(),
	})
	_, err = ValidateJWT(expiredToken)
	fmt.Printf("Expired token: err=%v\n", err)

	// Test tampered token
	tampered := token[:len(token)-5] + "XXXXX"
	_, err = ValidateJWT(tampered)
	fmt.Printf("Tampered token: err=%v\n", err)
}
```

---

### System Design Topics

**Top 5 Cloudflare System Design Questions:**

1. **Design Cloudflare's DDoS Mitigation System** - Absorb and filter multi-Tbps attacks at the network edge. Topics: BGP anycast traffic distribution, XDP/eBPF for kernel-bypass packet filtering, SYN cookies, rate limiting tiers (network/transport/application layer), challenge pages (CAPTCHA/Turnstile), automatic vs. manual mitigation.

2. **Design a Global CDN Cache** - Cache web content at 300+ PoPs globally. Topics: cache key design, TTL management, stale-while-revalidate, cache invalidation (purge APIs), cache consistency guarantees, Cloudflare's Tiered Cache (Shield).

3. **Design Cloudflare Workers (Serverless Edge Platform)** - Run JavaScript/WASM at the edge with sub-millisecond cold start. Topics: V8 isolates vs. containers, cold start optimization, CPU/memory limits per request, KV storage, Durable Objects for strong consistency, request routing to nearest PoP.

4. **Design a Global DNS Resolver** - Build 1.1.1.1 - a privacy-first, anycast DNS resolver. Topics: DNS over HTTPS (DoH), DNS over TLS (DoT), DNSSEC validation, anycast with BGP, recursive vs. authoritative resolution, negative caching, response rate limiting.

5. **Design Cloudflare Access (Zero-Trust)** - Replace VPNs with per-request identity verification. Topics: identity provider (IdP) integration, JWT issuance and validation at the edge, per-request authorization, session management, audit logging, ZTNA vs. traditional VPN architecture.

---

### Behavioral Focus

Cloudflare's culture values **"Helping Build a Better Internet," curiosity, and pragmatic problem solving.** Behavioral themes:

- **Security mindset:** "Describe a time you designed a system with a strong adversarial threat model from the start."
- **Scale and resilience:** "Tell me about a system you built that had to handle adversarial or unpredictable traffic."
- **Learning and curiosity:** "Describe a time you learned a new protocol, standard, or technology to solve a real problem."
- **Pragmatism:** "Tell me about a time you chose the simple solution over the sophisticated one and why."
- **Impact:** "How have your engineering decisions contributed to improving the reliability or security of systems used by others?"

---

### Insider Tips

**Common Mistakes:**
- Not knowing TCP/IP deeply - Cloudflare interviewers will probe networking knowledge far beyond most companies.
- In DDoS design: proposing only application-layer mitigations without discussing network/transport-layer defenses.
- Not discussing BGP anycast as the foundation of Cloudflare's global architecture.
- Forgetting that Cloudflare Workers must have sub-millisecond cold start - container-based solutions won't work.

**Strong Hire Signals:**
- Mentioning XDP/eBPF for network packet processing at high throughput.
- Proposing tiered cache architecture (local PoP → regional shield → origin) without prompting.
- Discussing SYN cookies as stateless TCP protection in DDoS design.
- W3C Trace Context for distributed tracing across edge PoPs.

**Red Flags:**
- Designing DDoS protection without mentioning anycast traffic distribution.
- Not discussing privacy implications of DNS resolver design (data retention, DoH/DoT).
- Proposing centralized rate limiting without considering latency at global edge.

---

### 8-Week Preparation Timeline

```
Week 1: Networking Foundations
  Mon-Tue: TCP/IP stack, TLS 1.3 handshake, DNS protocol internals
  Wed-Thu: HTTP/1.1 vs HTTP/2 vs HTTP/3 (QUIC), WebSocket protocol
  Fri:     BGP basics, anycast routing concepts
  Weekend: Implement a simple DNS resolver + HTTP/1.1 server in Go

Week 2: Security Systems
  Mon-Tue: DDoS attack types (SYN flood, amplification, L7 flood), mitigations
  Wed-Thu: SYN cookies, rate limiting algorithms, challenge mechanisms
  Fri:     TLS certificate management, OCSP, Certificate Transparency
  Weekend: Implement SYN cookie generator and edge rate limiter

Week 3: Algorithms - Networking & Security
  Mon-Fri: 2 problems/day - consistent hashing, Bloom filters, sliding window
  Weekend: Implement LRU cache with TTL + stale-while-revalidate

Week 4: System Design - CDN & Edge
  Mon-Tue: Design Cloudflare CDN (whiteboard)
  Wed-Thu: Design DDoS mitigation system
  Fri:     Design Cloudflare Workers platform
  Weekend: Mock system design interview

Week 5: Distributed Systems at the Edge
  Mon-Tue: Distributed rate limiting (token bucket at global edge)
  Wed-Thu: Edge caching consistency, cache invalidation at global scale
  Fri:     Zero-trust architecture, identity federation
  Weekend: Design global DNS resolver

Week 6: Go Networking
  Mon-Tue: net/http, net package, raw TCP/UDP in Go
  Wed-Thu: TLS in Go (crypto/tls), certificate handling
  Fri:     eBPF concepts, AF_XDP for high-performance networking
  Weekend: Build edge router + zero-trust validator in Go

Week 7: Take-Home Project Prep
  Mon-Wed: Build a DNS server or HTTP load balancer from scratch
  Thu:     Code review and polish - edge cases, error handling
  Fri:     Read Cloudflare blog (5 posts on DDoS, Workers, DNS)
  Weekend: Full mock onsite

Week 8: Final Prep
  Mon-Tue: Behavioral stories + networking quiz self-test
  Wed:     Full mock onsite
  Thu:     Rest, logistics
  Fri:     Light review
```

---


### Junior → FAANG: Cloudflare Interview Preparation Basics

Cloudflare's engineering interviews reflect its role as a global network infrastructure provider. Interview preparation should include understanding of BGP routing, DDoS mitigation, CDN architecture, DNS at scale, and TLS certificate management. Cloudflare uses Rust and Go heavily. Go experience is directly relevant. Coding interviews are practical and systems-oriented. Behavioral interviews emphasize ownership, learning from incidents, and customer-first thinking.

### Senior @ FAANG: Cloudflare Senior and Staff: Edge Computing and Global Network Engineering

Cloudflare's edge computing platform (Workers) has introduced a fundamentally different deployment model: code runs in 300+ PoPs globally with a sub-millisecond cold start, which creates engineering constraints not seen in traditional cloud environments. Senior candidates should understand V8 Isolates as the sandboxing mechanism for Workers, the trade-offs of the JavaScript-first execution model for compute-intensive workloads, and the cold start versus warm instance trade-off in the edge model. At the staff level, Cloudflare's network engineering challenges are some of the most advanced in the industry: absorbing terabit-scale DDoS attacks, operating BGP route selection at a global level, and managing certificate issuance and renewal for hundreds of millions of domains (Cloudflare is one of the largest certificate authorities globally). Staff candidates should demonstrate familiarity with these challenges and the engineering culture that prioritizes correctness and security above velocity.

---
