## 5. Cloudflare: Edge Computing at Scale

### 5.1 Why Cloudflare Uses Go

Cloudflare serves roughly a fifth of all websites. Go is used for:
- High-performance proxies and load balancers
- DNS and DDoS mitigation
- TLS/SSL termination
- Edge computing platform (Workers)

### 5.2 What Cloudflare Built with Go

#### High-Performance HTTP Proxy

Cloudflare's edge proxy handles each request through a pipeline: rate limiting, WAF inspection, cache lookup, and origin proxying. The following shows this layered approach.
```go
package proxy

// Cloudflare's edge proxy pattern
type EdgeProxy struct {
    upstream   *url.URL
    transport  *http.Transport
    cache      *Cache
    rateLimit  *RateLimiter
    firewall   *WAF
}

func (ep *EdgeProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // 1. DDoS protection
    if !ep.rateLimit.Allow(r.RemoteAddr) {
        http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
        return
    }

    // 2. Web Application Firewall
    if blocked, reason := ep.firewall.Check(r); blocked {
        http.Error(w, reason, http.StatusForbidden)
        return
    }

    // 3. Cache lookup
    cacheKey := generateCacheKey(r)
    if cached, ok := ep.cache.Get(cacheKey); ok {
        w.Header().Set("CF-Cache-Status", "HIT")
        w.Write(cached)
        return
    }

    // 4. Proxy to origin
    resp, err := ep.proxyToOrigin(r)
    if err != nil {
        http.Error(w, "Bad Gateway", http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    // 5. Read and cache response
    body, _ := io.ReadAll(resp.Body)

    if resp.StatusCode == http.StatusOK {
        ep.cache.Set(cacheKey, body, getCacheTTL(resp))
    }

    // 6. Return response
    w.Header().Set("CF-Cache-Status", "MISS")
    for k, v := range resp.Header {
        w.Header()[k] = v
    }
    w.WriteHeader(resp.StatusCode)
    w.Write(body)
}

func (ep *EdgeProxy) proxyToOrigin(r *http.Request) (*http.Response, error) {
    proxyReq := &http.Request{
        Method: r.Method,
        URL: &url.URL{
            Scheme: ep.upstream.Scheme,
            Host:   ep.upstream.Host,
            Path:   r.URL.Path,
        },
        Header: r.Header.Clone(),
        Body:   r.Body,
    }

    return ep.transport.RoundTrip(proxyReq)
}
```

#### DNS Over HTTPS (DoH)

Cloudflare's 1.1.1.1 resolver accepts DNS queries over HTTPS (the resolver service itself is built on Knot Resolver and Rust, not Go). A Go client that talks to it marshals DNS messages to wire format, sends them as HTTP POST bodies, and caches results based on TTL.
```go
package doh

// DNS-over-HTTPS client for a resolver like 1.1.1.1
type DoHResolver struct {
    cache     *DNSCache
    upstream  []string
    transport *http.Transport
}

func (d *DoHResolver) Resolve(ctx context.Context, domain string, qtype uint16) ([]net.IP, error) {
    // Check cache
    cacheKey := fmt.Sprintf("%s:%d", domain, qtype)
    if ips, ok := d.cache.Get(cacheKey); ok {
        return ips, nil
    }

    // Create DNS query
    msg := &dns.Msg{}
    msg.SetQuestion(dns.Fqdn(domain), qtype)

    // Marshal to wire format
    wire, err := msg.Pack()
    if err != nil {
        return nil, err
    }

    // Send over HTTPS
    req, _ := http.NewRequestWithContext(ctx, "POST", d.upstream[0], bytes.NewReader(wire))
    req.Header.Set("Content-Type", "application/dns-message")

    resp, err := d.transport.RoundTrip(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // Parse response
    respWire, _ := io.ReadAll(resp.Body)
    respMsg := &dns.Msg{}
    respMsg.Unpack(respWire)

    // Extract IPs
    var ips []net.IP
    for _, ans := range respMsg.Answer {
        if a, ok := ans.(*dns.A); ok {
            ips = append(ips, a.A)
        }
    }

    // Cache result
    d.cache.Set(cacheKey, ips, time.Duration(respMsg.Answer[0].Header().Ttl)*time.Second)

    return ips, nil
}
```

#### DDoS Mitigation

The DDoS mitigation layer tracks connection rates per source IP. If an IP exceeds the threshold within a sliding time window, further connections are blocked.
```go
package ddos

// SYN flood protection
type SYNDefense struct {
    connTracker *ConnectionTracker
    threshold   int
}

type ConnectionTracker struct {
    mu    sync.RWMutex
    conns map[string]*connState
}

type connState struct {
    count     int
    firstSeen time.Time
    lastSeen  time.Time
}

func (sd *SYNDefense) CheckConnection(ip string) bool {
    sd.connTracker.mu.Lock()
    defer sd.connTracker.mu.Unlock()

    now := time.Now()
    state, exists := sd.connTracker.conns[ip]

    if !exists {
        sd.connTracker.conns[ip] = &connState{
            count:     1,
            firstSeen: now,
            lastSeen:  now,
        }
        return true
    }

    // Reset if window expired
    if now.Sub(state.firstSeen) > 10*time.Second {
        state.count = 1
        state.firstSeen = now
        state.lastSeen = now
        return true
    }

    state.count++
    state.lastSeen = now

    // Block if threshold exceeded
    return state.count <= sd.threshold
}

// Cleanup old entries
func (sd *SYNDefense) cleanup() {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        sd.connTracker.mu.Lock()
        cutoff := time.Now().Add(-1 * time.Minute)

        for ip, state := range sd.connTracker.conns {
            if state.lastSeen.Before(cutoff) {
                delete(sd.connTracker.conns, ip)
            }
        }
        sd.connTracker.mu.Unlock()
    }
}
```

### 5.3 Cloudflare Workers Architecture

Workers execute user-supplied JavaScript in V8 isolates at the edge. The Go orchestration layer manages an isolate pool, enforces execution timeouts, and handles request routing.
```go
package workers

// Serverless function execution at the edge
type WorkerRuntime struct {
    isolates *IsolatePool
    kvStore  *KVStore
}

type Isolate struct {
    vm      *v8.Context
    timeout time.Duration
}

func (wr *WorkerRuntime) Execute(ctx context.Context, script string, req *http.Request) (*http.Response, error) {
    // Get isolate from pool
    isolate := wr.isolates.Get()
    defer wr.isolates.Put(isolate)

    // Set timeout
    execCtx, cancel := context.WithTimeout(ctx, isolate.timeout)
    defer cancel()

    // Execute JavaScript
    result := make(chan *http.Response, 1)
    errCh := make(chan error, 1)

    go func() {
        resp, err := isolate.run(script, req)
        if err != nil {
            errCh <- err
        } else {
            result <- resp
        }
    }()

    select {
    case resp := <-result:
        return resp, nil
    case err := <-errCh:
        return nil, err
    case <-execCtx.Done():
        isolate.terminate()
        return nil, ErrExecutionTimeout
    }
}
```

### 5.4 Go 1.25/1.26 Features Relevant to Cloudflare

Cloudflare operates on the extreme latency and memory-efficiency frontier - every microsecond of GC pause at the edge affects millions of concurrent connections:

- **Green Tea GC** (Go 1.26): Cloudflare's edge proxies handle millions of simultaneous TLS connections. Even a 1ms GC pause on a Go process handling 100K connections can manifest as thousands of temporarily stalled requests. Green Tea GC's reduced pause times (default in 1.26) are directly relevant to `cloudflared` and Cloudflare's DDoS mitigation pipeline, which are among the most latency-sensitive Go programs deployed at scale globally.
- **Self-referential types in generics** (Go 1.26): Cloudflare's internal packet processing and routing rule engines use tree-structured data (tries for IP prefix matching, rule trees for WAF). Self-referential generic types allow type-safe recursive data structure definitions, replacing the `interface{}`-heavy trie implementations used previously in `cfssl` and related tools.
- **`testing/synctest`** (Go 1.25): Cloudflare Workers' Go runtime layer involves complex goroutine-per-isolate concurrency. Reliable concurrent tests for edge worker scheduling logic - previously requiring careful `time.Sleep` hacks - become deterministic with `testing/synctest`.

### 5.5 Cloudflare Interview Expectations

**Focus Areas:**
- Network programming and protocols
- High-performance systems
- Security (DDoS, WAF, TLS)
- Distributed caching

**Sample Problem:**
```go
package cache

// Implement a distributed cache with TTL
type DistributedCache struct {
    nodes  []*CacheNode
    ring   *HashRing
}

type CacheNode struct {
    addr   string
    client *http.Client
}

func (dc *DistributedCache) Set(key string, value []byte, ttl time.Duration) error {
    node := dc.ring.GetNode(key)

    req := &SetRequest{
        Key:   key,
        Value: value,
        TTL:   ttl,
    }

    data, _ := json.Marshal(req)

    resp, err := node.client.Post(
        fmt.Sprintf("http://%s/cache/set", node.addr),
        "application/json",
        bytes.NewReader(data),
    )
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("cache set failed: %d", resp.StatusCode)
    }

    return nil
}

func (dc *DistributedCache) Get(key string) ([]byte, error) {
    node := dc.ring.GetNode(key)

    resp, err := node.client.Get(
        fmt.Sprintf("http://%s/cache/get?key=%s", node.addr, url.QueryEscape(key)),
    )
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusNotFound {
        return nil, ErrCacheMiss
    }

    return io.ReadAll(resp.Body)
}
```

---
