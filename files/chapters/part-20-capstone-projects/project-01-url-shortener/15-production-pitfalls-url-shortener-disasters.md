## Production Pitfalls: URL Shortener Disasters

Even well-designed URL shorteners can fail catastrophically in production if you overlook certain edge cases. This section presents five real-world failure scenarios that have brought down actual services, complete with the dangerous code patterns that caused them and the safer alternatives you should use instead. Study these pitfalls carefully -- they represent hard-won lessons from companies that learned them the expensive way.

### Pitfall 1: The Short Code Collision Catastrophe

**Real Incident Report**: A URL shortener used MD5 hash truncation for short codes. Two popular URLs collided to the same short code, causing 50% of clicks to redirect to the wrong destination for 6 hours before detection.

**The Anti-Pattern**:
```go
// DANGEROUS: Hash truncation leads to collisions
func generateShortCode(url string) string {
    hash := md5.Sum([]byte(url))
    return hex.EncodeToString(hash[:])[:6] // High collision probability!
}
```

**The Better Approach**:
```go
type ShortCodeGenerator struct {
    counter  *atomic.Uint64
    nodeID   uint16
    alphabet string
}

func NewShortCodeGenerator(nodeID uint16) *ShortCodeGenerator {
    return &ShortCodeGenerator{
        counter:  &atomic.Uint64{},
        nodeID:   nodeID,
        alphabet: "0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz", // No confusing chars
    }
}

func (g *ShortCodeGenerator) Generate() string {
    // Combine timestamp, node ID, and counter for uniqueness
    ts := uint64(time.Now().UnixMilli())
    count := g.counter.Add(1)

    // 42 bits timestamp + 10 bits node + 12 bits counter = 64 bits
    id := (ts << 22) | (uint64(g.nodeID) << 12) | (count & 0xFFF)

    return g.encode(id)
}

func (g *ShortCodeGenerator) encode(num uint64) string {
    if num == 0 {
        return string(g.alphabet[0])
    }

    base := uint64(len(g.alphabet))
    var result []byte

    for num > 0 {
        result = append([]byte{g.alphabet[num%base]}, result...)
        num /= base
    }

    // Pad to minimum length
    for len(result) < 7 {
        result = append([]byte{g.alphabet[0]}, result...)
    }

    return string(result)
}
```

**Key Insight**: Use time-based unique IDs (like Snowflake) instead of hash truncation. Include node ID for distributed generation without coordination.

---

### Pitfall 2: The Redirect Loop Trap

**Real Incident Report**: Users created short URLs pointing to other short URLs on the same service. Malicious actors created circular redirect chains that crashed browsers and exhausted server resources.

**The Anti-Pattern**:
```go
// DANGEROUS: No loop detection
func (s *Shortener) CreateShortURL(ctx context.Context, targetURL string) (string, error) {
    shortCode := s.generator.Generate()

    // Just stores it without validation
    return s.store.Save(ctx, shortCode, targetURL)
}
```

**The Better Approach**:
```go
func (s *Shortener) CreateShortURL(ctx context.Context, targetURL string) (string, error) {
    // Validate URL
    parsedURL, err := url.Parse(targetURL)
    if err != nil {
        return "", ErrInvalidURL
    }

    // Block self-referential URLs
    if s.isSelfReferential(parsedURL) {
        return "", ErrSelfReferentialURL
    }

    // Check redirect chain depth
    depth, err := s.checkRedirectChain(ctx, targetURL, 10)
    if err != nil {
        return "", err
    }
    if depth > 5 {
        return "", ErrRedirectChainTooLong
    }

    shortCode := s.generator.Generate()
    return s.store.Save(ctx, shortCode, targetURL)
}

func (s *Shortener) isSelfReferential(u *url.URL) bool {
    for _, domain := range s.ownDomains {
        if strings.HasSuffix(u.Host, domain) {
            return true
        }
    }
    return false
}

func (s *Shortener) checkRedirectChain(ctx context.Context, targetURL string, maxHops int) (int, error) {
    visited := make(map[string]bool)
    current := targetURL
    depth := 0

    client := &http.Client{
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            return http.ErrUseLastResponse // Don't follow redirects automatically
        },
        Timeout: 5 * time.Second,
    }

    for depth < maxHops {
        if visited[current] {
            return depth, ErrCircularRedirect
        }
        visited[current] = true

        req, _ := http.NewRequestWithContext(ctx, "HEAD", current, nil)
        resp, err := client.Do(req)
        if err != nil {
            return depth, nil // Can't check further, assume OK
        }
        resp.Body.Close()

        if resp.StatusCode < 300 || resp.StatusCode >= 400 {
            return depth, nil // Not a redirect
        }

        location := resp.Header.Get("Location")
        if location == "" {
            return depth, nil
        }

        current = location
        depth++
    }

    return depth, nil
}
```

**Key Insight**: Block self-referential URLs and detect redirect chains. Set maximum hop limits and detect circular redirects before saving.

---

### Pitfall 3: The Cache Stampede Storm

**Real Incident Report**: A viral link expired from cache and got 10,000 simultaneous requests. Each request hit the database to reload, causing a cascading failure that took down the entire service.

**The Anti-Pattern**:
```go
// DANGEROUS: Cache stampede on expiration
func (s *Shortener) Resolve(ctx context.Context, shortCode string) (string, error) {
    // Check cache
    if url, found := s.cache.Get(shortCode); found {
        return url, nil
    }

    // Cache miss - ALL concurrent requests hit DB
    url, err := s.db.GetURL(ctx, shortCode)
    if err != nil {
        return "", err
    }

    s.cache.Set(shortCode, url, 5*time.Minute)
    return url, nil
}
```

**The Better Approach**:
```go
type StampedeProtectedCache struct {
    cache      *cache.Cache
    db         *DB
    locks      sync.Map // Per-key locks
    singleflight singleflight.Group
}

func (c *StampedeProtectedCache) GetURL(ctx context.Context, shortCode string) (string, error) {
    // Check cache first
    if url, found := c.cache.Get(shortCode); found {
        return url.(string), nil
    }

    // Use singleflight to coalesce concurrent requests
    result, err, _ := c.singleflight.Do(shortCode, func() (any, error) {
        // Double-check cache (might have been populated by another goroutine)
        if url, found := c.cache.Get(shortCode); found {
            return url, nil
        }

        // Load from DB
        url, err := c.db.GetURL(ctx, shortCode)
        if err != nil {
            return "", err
        }

        // Cache with jittered expiration to prevent thundering herd
        ttl := 5*time.Minute + time.Duration(rand.IntN(60))*time.Second
        c.cache.Set(shortCode, url, ttl)

        return url, nil
    })

    if err != nil {
        return "", err
    }
    return result.(string), nil
}

// Proactive cache warming for popular links
func (c *StampedeProtectedCache) WarmCache(ctx context.Context) {
    // Get top N links by click count
    topLinks, _ := c.db.GetTopLinks(ctx, 1000)

    for _, link := range topLinks {
        ttl := 10*time.Minute + time.Duration(rand.IntN(120))*time.Second
        c.cache.Set(link.ShortCode, link.TargetURL, ttl)
    }
}
```

**Key Insight**: Use `singleflight` to coalesce concurrent cache misses. Add jitter to TTLs and proactively warm cache for hot keys.

---

### Pitfall 4: The Analytics Data Loss

**Real Incident Report**: A shortener lost 2 weeks of click analytics because the analytics pipeline backed up during a traffic spike. The buffer filled up and started dropping events silently.

**The Anti-Pattern**:
```go
// DANGEROUS: Unbuffered channel that blocks or drops
func (s *Shortener) RecordClick(ctx context.Context, shortCode string, metadata ClickMetadata) {
    select {
    case s.analyticsChannel <- Click{shortCode, metadata, time.Now()}:
        // Sent successfully
    default:
        // Channel full, silently drop! NO LOGGING!
    }
}
```

**The Better Approach**:
```go
type AnalyticsPipeline struct {
    buffer      chan Click
    overflow    *DiskQueue // Overflow to disk when memory full
    batcher     *ClickBatcher
    dropped     atomic.Uint64
    metrics     *prometheus.CounterVec
}

func NewAnalyticsPipeline(bufferSize int, overflowPath string) *AnalyticsPipeline {
    p := &AnalyticsPipeline{
        buffer:   make(chan Click, bufferSize),
        overflow: NewDiskQueue(overflowPath, 1e9), // 1GB overflow
        metrics: prometheus.NewCounterVec(
            prometheus.CounterOpts{Name: "analytics_events_total"},
            []string{"status"},
        ),
    }

    go p.processBatches()
    go p.drainOverflow()

    return p
}

func (p *AnalyticsPipeline) RecordClick(click Click) {
    select {
    case p.buffer <- click:
        p.metrics.WithLabelValues("buffered").Inc()
    default:
        // Buffer full, write to overflow
        if err := p.overflow.Push(click); err != nil {
            p.dropped.Add(1)
            p.metrics.WithLabelValues("dropped").Inc()
            log.Error("Analytics overflow failed", "error", err)
        } else {
            p.metrics.WithLabelValues("overflow").Inc()
        }
    }
}

func (p *AnalyticsPipeline) processBatches() {
    batch := make([]Click, 0, 1000)
    ticker := time.NewTicker(time.Second)

    for {
        select {
        case click := <-p.buffer:
            batch = append(batch, click)
            if len(batch) >= 1000 {
                p.flush(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                p.flush(batch)
                batch = batch[:0]
            }
        }
    }
}

func (p *AnalyticsPipeline) drainOverflow() {
    for {
        // Process overflow when buffer has capacity
        if len(p.buffer) < cap(p.buffer)/2 {
            click, err := p.overflow.Pop()
            if err == nil {
                p.buffer <- click
            }
        }
        time.Sleep(100 * time.Millisecond)
    }
}
```

**Key Insight**: Implement disk-backed overflow for analytics during spikes. Monitor drop rates and alert when overflow is being used.

---

### Pitfall 5: The Database Connection Exhaustion

**Real Incident Report**: A URL shortener ran out of database connections during peak traffic. The connection pool was exhausted, and new redirect requests started timing out en masse.

**The Anti-Pattern**:
```go
// DANGEROUS: No connection pool limits
func NewDB() *sql.DB {
    db, _ := sql.Open("postgres", connString)
    // No pool configuration!
    return db
}

func (s *Shortener) Resolve(ctx context.Context, shortCode string) (string, error) {
    // Each request potentially creates a new connection
    row := s.db.QueryRowContext(ctx, "SELECT target_url FROM urls WHERE short_code = $1", shortCode)
    // ...
}
```

**The Better Approach**:
```go
func NewDB(maxConns int) *sql.DB {
    db, err := sql.Open("postgres", connString)
    if err != nil {
        log.Fatal(err)
    }

    // Configure pool based on expected traffic
    db.SetMaxOpenConns(maxConns)
    db.SetMaxIdleConns(maxConns / 2)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(1 * time.Minute)

    return db
}

type DBWithMetrics struct {
    *sql.DB
    waitDuration prometheus.Histogram
    activeConns  prometheus.Gauge
}

func (d *DBWithMetrics) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
    start := time.Now()

    // Add timeout to prevent indefinite waits
    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    row := d.DB.QueryRowContext(ctx, query, args...)

    d.waitDuration.Observe(time.Since(start).Seconds())

    return row
}

// Monitor connection pool health
func (d *DBWithMetrics) MonitorPool() {
    ticker := time.NewTicker(5 * time.Second)
    for range ticker.C {
        stats := d.Stats()
        d.activeConns.Set(float64(stats.InUse))

        // Alert if pool is nearly exhausted
        utilization := float64(stats.InUse) / float64(stats.MaxOpenConnections)
        if utilization > 0.9 {
            log.Warn("DB connection pool nearly exhausted",
                "inUse", stats.InUse,
                "max", stats.MaxOpenConnections,
                "waiting", stats.WaitCount)
        }
    }
}
```

**Key Insight**: Configure connection pool limits explicitly. Add timeouts to prevent queue buildup and monitor pool utilization.

---

### Quick Reference: URL Shortener Pitfalls

| Pitfall | Impact | Prevention |
|---------|--------|------------|
| Hash collision | Wrong redirects | Use time-based unique IDs |
| Redirect loops | Browser crashes, resource exhaustion | Detect chains, block self-references |
| Cache stampede | Database overload | Singleflight, jittered TTL |
| Analytics loss | Missing business data | Disk-backed overflow, monitoring |
| Connection exhaustion | Service outage | Pool limits, timeouts, metrics |

---

### Junior → FAANG: Learning from Incidents Before You Have Them

Production pitfalls are worth studying before you write production code because they are far cheaper to prevent than to fix under pressure. The five pitfalls in this chapter are all real incident patterns. Memorize the antipattern and the fix for each.

Collision catastrophe and cache stampede are particularly common interview topics. For the interview version: "what happens when your Redis cluster is unavailable and all 1000 RPS hits the database simultaneously?" The answer involves singleflight (collapses duplicate requests for the same key into one database call) and circuit breakers (shed load rather than overwhelming the database). Both patterns are worth knowing by name.

For your first job, the habit of asking "what is the failure mode of this code?" before checking it in is more valuable than any specific pattern. Most production incidents happen in code that was written without considering the failure path.

### Senior @ FAANG: Postmortems as Organizational Learning Artifacts

At senior level, every significant production incident produces a postmortem. The postmortem is not a blame document. It is a learning artifact that captures the timeline, the root cause, the contributing factors, and the action items. The goal is to prevent the incident from recurring and to improve the system's overall resilience.

Each pitfall in this chapter represents a class of incidents that should generate a corresponding detection mechanism. Cache stampede should generate an alert on database connection pool saturation alongside an alert on cache hit rate drop. Redirect loops should generate an alert on hop count distribution and on redirect chain depth. Analytics loss should generate an alert on analytics queue depth and processing lag. If you cannot alert on the failure mode, you cannot detect the incident before users do.

The connection exhaustion pattern is a systemic concern, not a per-service one. At FAANG scale, hundreds of services share the same database clusters. A single service with a connection pool misconfiguration can starve neighboring services of connections. Platform-level connection proxy (PgBouncer, ProxySQL) with per-service connection limits is the standard mitigation. Enforcing connection pool limits via platform policy rather than trusting each team to configure them correctly is a governance decision.

Runbooks are the operational complement to postmortems. For each pitfall, the runbook should describe: the alert that fires, the initial diagnostic steps (what metrics to check, what logs to search), the mitigation procedure (how to reduce immediate impact), and the longer-term fix. Writing the runbook at the time you implement the fix (not months later) ensures it is accurate. Reviewing runbooks as part of the incident postmortem keeps them current.

---
