## URL Shortener Pitfalls: When Short URLs Cause Long Outages

### Pitfall 1: ID Collision in Distributed ID Generation

**Incident Report**: Two URL shorteners running in different regions generated the same short code for different URLs. Investigation revealed both servers started at the same millisecond after a synchronized deployment.

```go
// WRONG: Timestamp-based ID without machine identifier
func generateShortCode() string {
    timestamp := time.Now().UnixNano()
    return base62Encode(timestamp)
    // Problem: Two servers starting at same time = same ID
}

// WRONG: Simple counter without coordination
var counter int64

func generateShortCode() string {
    id := atomic.AddInt64(&counter, 1)
    return base62Encode(id)
    // Problem: Counter resets on restart, collision with previous IDs
}

// CORRECT: Snowflake-style ID with machine identifier
type IDGenerator struct {
    mu        sync.Mutex
    machineID int64  // Unique per instance (0-1023)
    sequence  int64  // Per-millisecond sequence (0-4095)
    lastTime  int64
}

const (
    machineBits  = 10  // 1024 machines
    sequenceBits = 12  // 4096 IDs per ms per machine
    machineShift = sequenceBits
    timeShift    = machineBits + sequenceBits
    sequenceMask = int64(1<<sequenceBits - 1)
)

func NewIDGenerator(machineID int64) *IDGenerator {
    if machineID < 0 || machineID >= 1024 {
        panic("machine ID must be 0-1023")
    }
    return &IDGenerator{machineID: machineID}
}

func (g *IDGenerator) Generate() int64 {
    g.mu.Lock()
    defer g.mu.Unlock()

    now := time.Now().UnixMilli()

    if now == g.lastTime {
        g.sequence = (g.sequence + 1) & sequenceMask
        if g.sequence == 0 {
            // Sequence exhausted, wait for next millisecond
            for now <= g.lastTime {
                now = time.Now().UnixMilli()
            }
        }
    } else {
        g.sequence = 0
    }

    g.lastTime = now

    // epoch: Jan 1, 2024
    epoch := int64(1704067200000)
    id := ((now - epoch) << timeShift) | (g.machineID << machineShift) | g.sequence

    return id
}

func (g *IDGenerator) GenerateShortCode() string {
    return base62Encode(g.Generate())
}

// Verify uniqueness in database as final check
func (s *URLService) CreateShortURL(ctx context.Context, longURL string) (string, error) {
    for attempts := 0; attempts < 5; attempts++ {
        shortCode := s.idGen.GenerateShortCode()

        res, err := s.db.ExecContext(ctx,
            `INSERT INTO urls (short_code, long_url, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (short_code) DO NOTHING`,
            shortCode, longURL)

        if err != nil {
            return "", err
        }

        // RowsAffected tells us directly whether our insert won. A
        // separate SELECT COUNT round-trip would be slower and racy.
        if n, _ := res.RowsAffected(); n > 0 {
            return shortCode, nil
        }

        // Collision occurred, retry with new ID
        log.Printf("ID collision detected for %s, retrying", shortCode)
    }

    return "", errors.New("failed to generate unique short code after 5 attempts")
}
```

### Pitfall 2: Cache Stampede on Popular URLs

**Incident Report**: A viral tweet with a shortened URL caused 100,000 simultaneous cache misses when the cache entry expired. All 100,000 requests hit the database simultaneously, causing a 2-minute outage.

```go
// WRONG: Simple cache-aside with no stampede protection
func (s *URLService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    // Check cache
    longURL, err := s.cache.Get(ctx, "url:"+shortCode)
    if err == nil {
        return longURL, nil
    }

    // Cache miss - ALL concurrent requests hit database
    longURL, err = s.db.QueryRow("SELECT long_url FROM urls WHERE short_code = $1", shortCode)
    if err != nil {
        return "", err
    }

    // All concurrent requests also try to SET cache
    s.cache.Set(ctx, "url:"+shortCode, longURL, 1*time.Hour)

    return longURL, nil
}

// CORRECT: Singleflight to prevent stampede
type URLService struct {
    db    *sql.DB
    cache *redis.Client
    sf    singleflight.Group
}

func (s *URLService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    cacheKey := "url:" + shortCode

    // Check cache first
    longURL, err := s.cache.Get(ctx, cacheKey).Result()
    if err == nil {
        return longURL, nil
    }

    // Use singleflight to deduplicate concurrent requests
    result, err, _ := s.sf.Do(cacheKey, func() (any, error) {
        // Double-check cache (another goroutine may have populated it)
        longURL, err := s.cache.Get(ctx, cacheKey).Result()
        if err == nil {
            return longURL, nil
        }

        // Only ONE database query happens
        var url string
        err = s.db.QueryRowContext(ctx,
            "SELECT long_url FROM urls WHERE short_code = $1",
            shortCode).Scan(&url)
        if err != nil {
            return "", err
        }

        // Populate cache with jittered TTL to prevent synchronized expiry
        jitter := time.Duration(rand.IntN(600)) * time.Second  // 0-10 minutes
        s.cache.Set(ctx, cacheKey, url, 1*time.Hour+jitter)

        return url, nil
    })

    if err != nil {
        return "", err
    }

    return result.(string), nil
}

// For extremely hot URLs, use probabilistic early refresh
func (s *URLService) GetLongURLWithEarlyRefresh(ctx context.Context, shortCode string) (string, error) {
    cacheKey := "url:" + shortCode

    // Get with TTL
    result, ttl, err := s.cache.GetWithTTL(ctx, cacheKey)
    if err == nil {
        // Probabilistic early refresh (XFetch). Refresh when
        // delta * beta * -ln(U) reaches the remaining TTL, where U is
        // uniform in (0,1). -ln(U) is exponentially distributed, so
        // refreshes are rare while the TTL is long and become nearly
        // certain as expiry approaches.
        beta := 1.0   // >1 refreshes earlier, <1 later
        delta := 30.0 // estimated recompute cost in seconds
        if -delta*beta*math.Log(rand.Float64()) >= ttl.Seconds() {
            // Refresh in background
            go s.refreshCache(context.Background(), shortCode)
        }
        return result, nil
    }

    // Cache miss - use singleflight
    return s.getFromDBWithSingleflight(ctx, shortCode)
}
```

### Pitfall 3: Analytics Write Amplification Killing Performance

**Incident Report**: URL redirects taking 500ms+ because each redirect synchronously wrote analytics data. With 100K redirects/sec, the analytics database became the bottleneck.

```go
// WRONG: Synchronous analytics on every redirect
func (s *URLService) Redirect(w http.ResponseWriter, r *http.Request) {
    shortCode := chi.URLParam(r, "code")

    longURL, err := s.GetLongURL(r.Context(), shortCode)
    if err != nil {
        http.NotFound(w, r)
        return
    }

    // Problem: Synchronous analytics write on EVERY request
    s.db.Exec(`INSERT INTO analytics (short_code, timestamp, ip, user_agent, referer)
               VALUES ($1, $2, $3, $4, $5)`,
        shortCode, time.Now(), r.RemoteAddr, r.UserAgent(), r.Referer())

    http.Redirect(w, r, longURL, http.StatusTemporaryRedirect)
}

// CORRECT: Async analytics with batching
type AnalyticsCollector struct {
    buffer   chan *ClickEvent
    db       *sql.DB
    batchSize int
    ticker   *time.Ticker
}

type ClickEvent struct {
    ShortCode string
    Timestamp time.Time
    IP        string
    UserAgent string
    Referer   string
    Country   string
}

func NewAnalyticsCollector(db *sql.DB) *AnalyticsCollector {
    c := &AnalyticsCollector{
        buffer:    make(chan *ClickEvent, 100000),
        db:        db,
        batchSize: 1000,
        ticker:    time.NewTicker(1 * time.Second),
    }

    go c.run()
    return c
}

func (c *AnalyticsCollector) Record(event *ClickEvent) {
    select {
    case c.buffer <- event:
    default:
        // Buffer full, drop event (metrics to track this)
        analyticsDropped.Inc()
    }
}

func (c *AnalyticsCollector) run() {
    batch := make([]*ClickEvent, 0, c.batchSize)

    flush := func() {
        if len(batch) == 0 {
            return
        }

        if err := c.writeBatch(batch); err != nil {
            log.Printf("Failed to write analytics batch: %v", err)
        }

        batch = batch[:0]
    }

    for {
        select {
        case event := <-c.buffer:
            batch = append(batch, event)
            if len(batch) >= c.batchSize {
                flush()
            }

        case <-c.ticker.C:
            flush()
        }
    }
}

func (c *AnalyticsCollector) writeBatch(events []*ClickEvent) error {
    // Use COPY for bulk insert (Postgres)
    stmt, _ := c.db.Prepare(pq.CopyIn("analytics",
        "short_code", "timestamp", "ip", "user_agent", "referer", "country"))

    for _, e := range events {
        stmt.Exec(e.ShortCode, e.Timestamp, e.IP, e.UserAgent, e.Referer, e.Country)
    }

    return stmt.Close()
}

// Updated redirect handler
func (s *URLService) Redirect(w http.ResponseWriter, r *http.Request) {
    shortCode := chi.URLParam(r, "code")

    longURL, err := s.GetLongURL(r.Context(), shortCode)
    if err != nil {
        http.NotFound(w, r)
        return
    }

    // Non-blocking analytics
    s.analytics.Record(&ClickEvent{
        ShortCode: shortCode,
        Timestamp: time.Now(),
        IP:        r.RemoteAddr,
        UserAgent: r.UserAgent(),
        Referer:   r.Referer(),
    })

    // Immediate redirect
    http.Redirect(w, r, longURL, http.StatusTemporaryRedirect)
}
```

### Pitfall 4: URL Validation Bypass Enables Phishing

**Incident Report**: Attackers used the URL shortener to disguise phishing URLs. The shortener only checked if the URL was valid syntactically, not if it was malicious.

```go
// WRONG: Only syntactic validation
func (s *URLService) CreateShortURL(ctx context.Context, longURL string) (string, error) {
    u, err := url.Parse(longURL)
    if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
        return "", errors.New("invalid URL")
    }

    // No content validation - allows phishing URLs
    return s.saveAndGenerate(ctx, longURL)
}

// CORRECT: Multi-layer URL validation
type URLValidator struct {
    safeBrowsingClient *safebrowsing.Client
    domainBlocklist    map[string]bool
    ipBlocklist        *IPBlocklist
}

func (v *URLValidator) Validate(ctx context.Context, rawURL string) error {
    // 1. Parse and normalize
    u, err := url.Parse(rawURL)
    if err != nil {
        return errors.New("invalid URL format")
    }

    // 2. Scheme validation
    if u.Scheme != "http" && u.Scheme != "https" {
        return errors.New("only HTTP/HTTPS URLs allowed")
    }

    // 3. Check for internal/private IPs
    if err := v.checkNotPrivateIP(u.Host); err != nil {
        return err
    }

    // 4. Domain blocklist check
    domain := extractBaseDomain(u.Host)
    if v.domainBlocklist[domain] {
        return errors.New("domain is blocked")
    }

    // 5. Google Safe Browsing API check
    threats, err := v.safeBrowsingClient.LookupURLs([]string{rawURL})
    if err != nil {
        log.Printf("Safe Browsing API error: %v", err)
        // Fail open or closed based on policy
    } else if len(threats[rawURL]) > 0 {
        return fmt.Errorf("URL flagged as malicious: %v", threats[rawURL])
    }

    // 6. Check for URL that looks like another shortener (redirect chains)
    if isKnownShortener(u.Host) {
        return errors.New("cannot shorten URLs from other shorteners")
    }

    return nil
}

func (v *URLValidator) checkNotPrivateIP(host string) error {
    // Resolve hostname
    ips, err := net.LookupIP(host)
    if err != nil {
        // Might be an IP address directly
        ip := net.ParseIP(host)
        if ip != nil {
            ips = []net.IP{ip}
        } else {
            return errors.New("could not resolve hostname")
        }
    }

    for _, ip := range ips {
        if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
            return errors.New("private IP addresses not allowed")
        }

        // Check for cloud metadata IPs
        if ip.String() == "169.254.169.254" {
            return errors.New("cloud metadata IP not allowed")
        }
    }

    return nil
}

var knownShorteners = map[string]bool{
    "bit.ly": true, "t.co": true, "goo.gl": true,
    "tinyurl.com": true, "ow.ly": true, "is.gd": true,
}

func isKnownShortener(host string) bool {
    domain := extractBaseDomain(host)
    return knownShorteners[domain]
}
```

### Pitfall 5: Database Hot Partition from Sequential Short Codes

**Incident Report**: After scaling to 10 database shards, one shard received 90% of writes. Investigation revealed short codes were sequential, and the hash-based sharding put all recent URLs on the same shard.

```go
// WRONG: Sequential short codes cause hot partition
func generateSequentialCode(counter int64) string {
    return base62Encode(counter)
    // counter: 1, 2, 3, 4, 5...
    // codes: 1, 2, 3, 4, 5...
    // All recent codes hash to same shard
}

// CORRECT: Randomized codes for even distribution
func generateRandomizedCode(id int64) string {
    // Bit-reversal permutation
    reversed := reverseBits(id)

    // XOR with random-looking constant
    mixed := reversed ^ 0x5DEECE66D

    return base62Encode(mixed)
}

func reverseBits(n int64) int64 {
    var result int64
    for i := 0; i < 64; i++ {
        result = (result << 1) | (n & 1)
        n >>= 1
    }
    return result
}

// Alternative: Use random component in ID
type ShardAwareIDGenerator struct {
    machineID int64
    sequence  int64
    mu        sync.Mutex
}

func (g *ShardAwareIDGenerator) Generate() string {
    g.mu.Lock()
    defer g.mu.Unlock()

    // NOTE: uniqueness still rests entirely on the sequence suffix,
    // so it needs the same machine-ID and crash-recovery discipline
    // as Pitfall 1, a restart that resets the sequence would collide.
    // The random prefix only spreads codes across shards.
    prefix := make([]byte, 2)
    rand.Read(prefix)

    // Sequential suffix for uniqueness
    g.sequence++
    suffix := base62Encode(g.sequence)

    return fmt.Sprintf("%s%s%s",
        base62Encode(int64(prefix[0])%62),
        base62Encode(int64(prefix[1])%62),
        suffix)
}

// Verify shard distribution
func testShardDistribution(generator *ShardAwareIDGenerator, numCodes, numShards int) map[int]int {
    distribution := make(map[int]int)

    for i := 0; i < numCodes; i++ {
        code := generator.Generate()
        shard := hashToShard(code, numShards)
        distribution[shard]++
    }

    // Should see roughly even distribution
    return distribution
}

func hashToShard(code string, numShards int) int {
    h := fnv.New32a()
    h.Write([]byte(code))
    return int(h.Sum32()) % numShards
}
```

### Quick Reference: URL Shortener Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| ID collision | Duplicate short codes | Snowflake IDs with machine identifier |
| Cache stampede | Database overload on expiry | Singleflight, jittered TTL, early refresh |
| Analytics overhead | Slow redirects | Async batched writes |
| Phishing URLs | Abuse reports, blocks | Safe Browsing API, domain blocklist |
| Hot partition | Uneven shard utilization | Randomized codes, bit-reversal |

---

### Junior → FAANG: Reading Post-Mortems to Accelerate Your Learning

The pitfalls in this section are incident reports: descriptions of real failures that happened in production systems. Learning from them is one of the fastest ways to close the experience gap between someone who has been in production for two years and someone who has been in production for ten.

**Every incident has a root cause and a contributing cause.** The ID collision incident (same millisecond start time) has a contributing cause: the deployment was synchronized, meaning both servers started at exactly the same time. The root cause is missing machine identifier in the ID generator. But the contributing cause tells you where else to look: any system where multiple instances start at exactly the same time is vulnerable to this class of bug. Synchronized deployments, blue-green cutover, and canary rollouts all create windows where multiple instances may initialize with the same state.

**The cache stampede incident teaches you why TTL jitter is required.** If all URLs created in a batch operation are given the same TTL (for example, all URLs created in a bulk import have a 24-hour TTL starting at the same timestamp), they all expire at the same time. A viral link that is shared millions of times in one hour will have its cache expire one hour after it was shortened, causing 1 million concurrent cache misses at the same moment. TTL jitter (adding a random value between 0 and 10 minutes to each URL's TTL) spreads the expiry times and eliminates the synchronized stampede.

**Pitfall 4 (phishing bypass) is a security vulnerability, not just a product issue.** If your URL shortener is used to distribute phishing links, your domain gets flagged by Safe Browsing and all URLs from your domain are shown with security warnings in Chrome, Firefox, and Safari. This is a reputational catastrophe. The SSRF check (rejecting URLs that resolve to private IPs) is equally important: a URL shortener that allows `http://169.254.169.254/latest/meta-data/` can be used to steal cloud credentials from the metadata service on any EC2 instance that uses the shortener.

---

### Senior @ FAANG: Incident Response Maturity and Architectural Defense-in-Depth

At L6/L7, pitfall analysis is translated into a formal incident response playbook and a set of architectural invariants that are enforced through code review, CI checks, and operational monitoring.

**Incident response playbook for ID collision.** The mitigation for ID collision (Snowflake generator with machine identifier) is the prevention. The incident response when collision is detected in production requires: (1) immediate identification of the two URLs sharing the short code (query the database for duplicate short_id values), (2) determination of which URL should own the code (the older one, or the one with more traffic), (3) generation of a new short code for the displaced URL and update of all references, (4) notification of affected users if they can be identified, and (5) post-mortem to identify why the collision was not caught at write time (was the unique constraint missing, or was the retry limit too low?). Document this playbook before shipping the ID generator to production.

**Architectural defense-in-depth for cache stampede.** A defense-in-depth architecture has multiple independent protections against cache stampede: (1) TTL jitter reduces the probability of synchronized expiry, (2) singleflight collapses concurrent cache misses to a single database read, (3) probabilistic early refresh (XFetch) proactively refreshes entries before they expire, and (4) the local L1 in-process cache provides a final layer that is immune to Redis failures. No single protection is sufficient. The combination makes cache stampede extremely unlikely under any realistic traffic pattern. Document which layer catches which type of stampede: synchronized TTL expiry is caught by jitter, viral URL cold-start is caught by singleflight, TTL expiry of the top-10 URLs is caught by early refresh.

**The hot partition pitfall is a shard routing invariant that must be enforced.** The bit-reversal permutation scrambles sequential IDs before routing to shards. This invariant must be documented as a requirement and enforced: if a new engineer writes a direct shard router that uses the sequential ID as the routing key (which seems natural), they will re-introduce the hot partition. Enforce the invariant through a code review checklist item ("shard routing key must use scrambled ID, not sequential ID"), a unit test that verifies uniform distribution across shards for sequentially generated IDs, and a monitoring alert on shard write imbalance (if any shard receives more than 2x the average write rate, alert). Three independent enforcement mechanisms make it very difficult to accidentally reintroduce the pitfall.
