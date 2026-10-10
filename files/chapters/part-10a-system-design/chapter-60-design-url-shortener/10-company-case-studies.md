## 60.10 Company Case Studies

### Bitly: High-Performance URL Shortening at Scale

As documented in Bitly Engineering retrospectives ("How Bitly Shortens URL at Scale", 2014; "Scaling Bitly: From MySQL to DynamoDB and Beyond", 2016), Bitly handles over 10 billion link clicks per month, making it the largest dedicated URL shortener. Their architecture uses a multi-tier cache (in-process plus Redis cluster) to keep redirect latency under 10ms at P99, while a Snowflake-style ID generator enables distributed short code creation without central coordination. The following implementation models Bitly's approach to these problems.

```go
// bitly_architecture.go
// Inspired by Bitly's URL shortening architecture
package bitly

import (
    "context"
    "errors"
    "hash/fnv"
    "net/url"
    "strings"
    "sync"
    "sync/atomic"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrURLNotFound = errors.New("url not found")

// BitlyService implements high-performance URL shortening
type BitlyService struct {
    // Multi-tier cache
    localCache  *LocalCache
    redisClient *redis.ClusterClient

    // ID generation with multiple nodes
    idGenerator *DistributedIDGenerator

    // Real-time analytics pipeline
    clickStream chan *ClickEvent
    analytics   *RealTimeAnalytics

    // Database shards
    dbShards []*DatabaseShard
}

// LocalCache is L1 cache with ~1ms latency
type LocalCache struct {
    mu      sync.RWMutex
    items   map[string]*CacheItem
    maxSize int
}

func NewLocalCache(maxSize int) *LocalCache {
    return &LocalCache{
        items:   make(map[string]*CacheItem),
        maxSize: maxSize,
    }
}

func (c *LocalCache) Get(shortCode string) (*CacheItem, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    item, ok := c.items[shortCode]
    if !ok || (!item.Expiry.IsZero() && time.Now().After(item.Expiry)) {
        return nil, false
    }
    return item, true
}

func (c *LocalCache) Set(shortCode, longURL string, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[shortCode] = &CacheItem{
        LongURL: longURL,
        Expiry:  time.Now().Add(ttl),
    }
}

type CacheItem struct {
    LongURL    string
    Expiry     time.Time
    ClickCount atomic.Int64
}

// DistributedIDGenerator generates unique IDs across nodes
type DistributedIDGenerator struct {
    nodeID   uint16
    sequence atomic.Uint32
    lastTime atomic.Int64
    epoch    int64
}

func NewDistributedIDGenerator(nodeID uint16) *DistributedIDGenerator {
    return &DistributedIDGenerator{
        nodeID: nodeID,
        epoch:  1609459200000,
    }
}

func (g *DistributedIDGenerator) Generate() uint64 {
    now := time.Now().UnixMilli() - g.epoch
    seq := g.sequence.Add(1) & 0xFFF
    return (uint64(now) << 22) | (uint64(g.nodeID&0x3FF) << 12) | uint64(seq)
}

// NewBitlyService creates a Bitly-style URL shortener
func NewBitlyService(redisAddrs []string, dbShards int) *BitlyService {
    shards := make([]*DatabaseShard, dbShards)
    for i := range shards {
        shards[i] = &DatabaseShard{urls: make(map[string]*ShortURL)}
    }

    service := &BitlyService{
        localCache: NewLocalCache(1_000_000), // 1M entries L1 cache
        redisClient: redis.NewClusterClient(&redis.ClusterOptions{
            Addrs: redisAddrs,
        }),
        idGenerator: NewDistributedIDGenerator(1), // Node 1
        clickStream: make(chan *ClickEvent, 100_000),
        analytics:   NewRealTimeAnalytics(),
        dbShards:    shards,
    }

    // Start analytics pipeline
    go service.processClickStream()

    return service
}

// Shorten creates a short URL (Bitly's core operation)
func (s *BitlyService) Shorten(ctx context.Context, longURL string, opts *ShortenOptions) (*ShortURL, error) {
    // 1. Validate URL
    if err := validateURL(longURL); err != nil {
        return nil, err
    }

    // 2. Check for duplicate (Bitly deduplicates by default)
    if opts.Deduplicate {
        if existing := s.findExisting(ctx, longURL); existing != nil {
            return existing, nil
        }
    }

    // 3. Generate unique ID (Snowflake-like)
    id := s.idGenerator.Generate()
    shortCode := encodeBase62(id)

    // 4. Store in database shard. Routing MUST use the same function
    // as Redirect below: storing by id%n while looking up by a hash
    // of the short code would send most lookups to the wrong shard.
    shardIdx := hashShardIndex(shortCode, len(s.dbShards))
    shortURL := &ShortURL{
        ShortCode: shortCode,
        LongURL:   longURL,
        CreatedAt: time.Now(),
        UserID:    opts.UserID,
    }

    if err := s.dbShards[shardIdx].Insert(ctx, shortURL); err != nil {
        return nil, err
    }

    // 5. Warm cache (Bitly pre-caches new URLs)
    s.warmCache(ctx, shortCode, longURL)

    return shortURL, nil
}

// Redirect handles URL redirection (P99 < 10ms at Bitly)
func (s *BitlyService) Redirect(ctx context.Context, shortCode string, metadata *ClickMetadata) (string, error) {
    // 1. Check L1 local cache (< 1ms)
    if item, ok := s.localCache.Get(shortCode); ok {
        s.recordClick(shortCode, metadata)
        return item.LongURL, nil
    }

    // 2. Check L2 Redis cache (< 5ms)
    longURL, err := s.redisClient.Get(ctx, "url:"+shortCode).Result()
    if err == nil {
        s.localCache.Set(shortCode, longURL, 5*time.Minute)
        s.recordClick(shortCode, metadata)
        return longURL, nil
    }

    // 3. Database lookup (< 50ms, rare)
    shardIdx := hashShardIndex(shortCode, len(s.dbShards))
    shortURL, err := s.dbShards[shardIdx].GetByShortCode(ctx, shortCode)
    if err != nil {
        return "", ErrURLNotFound
    }

    // 4. Populate caches
    s.warmCache(ctx, shortCode, shortURL.LongURL)
    s.recordClick(shortCode, metadata)

    return shortURL.LongURL, nil
}

func (s *BitlyService) recordClick(shortCode string, metadata *ClickMetadata) {
    // Non-blocking click recording
    select {
    case s.clickStream <- &ClickEvent{
        ShortCode: shortCode,
        Timestamp: time.Now(),
        Metadata:  metadata,
    }:
    default:
        // Drop if buffer full (acceptable for analytics)
    }
}

func (s *BitlyService) processClickStream() {
    batch := make([]*ClickEvent, 0, 1000)
    ticker := time.NewTicker(100 * time.Millisecond)

    for {
        select {
        case event := <-s.clickStream:
            batch = append(batch, event)
            if len(batch) >= 1000 {
                s.analytics.ProcessBatch(batch)
                batch = batch[:0]
            }
        case <-ticker.C:
            if len(batch) > 0 {
                s.analytics.ProcessBatch(batch)
                batch = batch[:0]
            }
        }
    }
}

// RealTimeAnalytics provides Bitly's instant analytics
type RealTimeAnalytics struct {
    clickCounts sync.Map // shortCode -> atomic counter
}

func NewRealTimeAnalytics() *RealTimeAnalytics {
    return &RealTimeAnalytics{}
}

func (a *RealTimeAnalytics) ProcessBatch(events []*ClickEvent) {
    for _, event := range events {
        counter, _ := a.clickCounts.LoadOrStore(event.ShortCode, &atomic.Int64{})
        counter.(*atomic.Int64).Add(1)
    }
}

type ClickEvent struct {
    ShortCode string
    Timestamp time.Time
    Metadata  *ClickMetadata
}

type ClickMetadata struct {
    IP        string
    UserAgent string
    Referer   string
    Country   string
}

type ShortURL struct {
    ShortCode string
    LongURL   string
    CreatedAt time.Time
    UserID    string
}

type ShortenOptions struct {
    UserID      string
    Deduplicate bool
    CustomAlias string
}

type DatabaseShard struct {
    mu   sync.RWMutex
    urls map[string]*ShortURL
}

func (d *DatabaseShard) Insert(ctx context.Context, u *ShortURL) error {
    d.mu.Lock()
    defer d.mu.Unlock()
    d.urls[u.ShortCode] = u
    return nil
}

func (d *DatabaseShard) GetByShortCode(ctx context.Context, code string) (*ShortURL, error) {
    d.mu.RLock()
    defer d.mu.RUnlock()
    u, ok := d.urls[code]
    if !ok {
        return nil, ErrURLNotFound
    }
    return u, nil
}

func validateURL(rawURL string) error {
    u, err := url.Parse(rawURL)
    if err != nil || u.Scheme == "" || u.Host == "" {
        return errors.New("invalid url")
    }
    return nil
}

func (s *BitlyService) findExisting(ctx context.Context, longURL string) *ShortURL {
    for _, shard := range s.dbShards {
        shard.mu.RLock()
        for _, u := range shard.urls {
            if u.LongURL == longURL {
                shard.mu.RUnlock()
                return u
            }
        }
        shard.mu.RUnlock()
    }
    return nil
}

func encodeBase62(num uint64) string {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    if num == 0 {
        return "0"
    }
    var sb strings.Builder
    for num > 0 {
        sb.WriteByte(alphabet[num%62])
        num /= 62
    }
    runes := []rune(sb.String())
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }
    return string(runes)
}

func hashShardIndex(shortCode string, numShards int) int {
    if numShards <= 0 {
        return 0
    }
    h := fnv.New32a()
    h.Write([]byte(shortCode))
    return int(h.Sum32() % uint32(numShards))
}

func (s *BitlyService) warmCache(ctx context.Context, shortCode, longURL string) {
    s.localCache.Set(shortCode, longURL, 5*time.Minute)
    _ = s.redisClient.Set(ctx, "url:"+shortCode, longURL, 24*time.Hour).Err()
}
```

### TinyURL: Simple and Reliable URL Shortening

Launched in 2002 by Kevin Gilbertson as the pioneer of web-scale link shortening, TinyURL takes the opposite approach from Bitly: a single-node architecture with a monotonic counter for ID generation and a bounded in-process cache instead of a distributed Redis layer. This simplicity reduces operational complexity at the cost of horizontal scalability. The design works well for moderate traffic volumes where a single database instance can absorb all writes.

```go
// tinyurl_service.go
// Inspired by TinyURL's straightforward architecture
package tinyurl

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
    "time"
)

// TinyURLService implements simple, reliable URL shortening
type TinyURLService struct {
    db       *sql.DB
    cache    *SimpleCache
    counter  *AtomicCounter
    baseURL  string
}

// AtomicCounter provides monotonic ID generation
// TinyURL uses simple auto-increment for reliability
type AtomicCounter struct {
    mu      sync.Mutex
    current uint64
    db      *sql.DB
}

func (c *AtomicCounter) Next() uint64 {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.current++

    // Persist every 1000 IDs for crash recovery. The restart path is
    // the correctness-critical part: startup must resume at
    // checkpoint + 1000, because resuming at the checkpoint itself
    // would reissue up to 999 IDs that were already handed out and
    // overwrite their short codes. A gap in the ID space is invisible,
    // a collision is data corruption.
    if c.current%1000 == 0 {
        c.persistCheckpoint()
    }

    return c.current
}

func (c *AtomicCounter) persistCheckpoint() {
    c.db.Exec("UPDATE counters SET value = ? WHERE name = 'url_id'", c.current)
}

// SimpleCache is a bounded cache with FIFO eviction. A true LRU
// would reorder entries on access, FIFO is much simpler and close
// enough at this scale.
type SimpleCache struct {
    mu       sync.RWMutex
    items    map[string]*cacheEntry
    order    []string
    maxItems int
}

type cacheEntry struct {
    longURL   string
    expiresAt time.Time
}

func (c *SimpleCache) Get(shortCode string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    entry, ok := c.items[shortCode]
    if !ok || time.Now().After(entry.expiresAt) {
        return "", false
    }
    return entry.longURL, true
}

func (c *SimpleCache) Set(shortCode, longURL string, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Updating an existing key must not append to the eviction order
    // again, duplicates there would desynchronize items and order.
    if _, exists := c.items[shortCode]; exists {
        c.items[shortCode] = &cacheEntry{
            longURL:   longURL,
            expiresAt: time.Now().Add(ttl),
        }
        return
    }

    // Evict oldest if at capacity
    if len(c.items) >= c.maxItems {
        oldest := c.order[0]
        c.order = c.order[1:]
        delete(c.items, oldest)
    }

    c.items[shortCode] = &cacheEntry{
        longURL:   longURL,
        expiresAt: time.Now().Add(ttl),
    }
    c.order = append(c.order, shortCode)
}

// CreateShortURL creates a new short URL
func (s *TinyURLService) CreateShortURL(ctx context.Context, longURL string) (string, error) {
    // 1. Generate ID (simple counter - TinyURL's approach)
    id := s.counter.Next()

    // 2. Encode to short code
    shortCode := s.encodeID(id)

    // 3. Store in database
    _, err := s.db.ExecContext(ctx,
        "INSERT INTO urls (id, short_code, long_url, created_at) VALUES (?, ?, ?, ?)",
        id, shortCode, longURL, time.Now(),
    )
    if err != nil {
        return "", fmt.Errorf("failed to store URL: %w", err)
    }

    // 4. Cache immediately
    s.cache.Set(shortCode, longURL, 24*time.Hour)

    return s.baseURL + "/" + shortCode, nil
}

// encodeID uses Base62 encoding
func (s *TinyURLService) encodeID(id uint64) string {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

    if id == 0 {
        return string(alphabet[0])
    }

    var result []byte
    for id > 0 {
        result = append([]byte{alphabet[id%62]}, result...)
        id /= 62
    }

    return string(result)
}

// GetLongURL retrieves the original URL
func (s *TinyURLService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    // 1. Check cache
    if longURL, ok := s.cache.Get(shortCode); ok {
        return longURL, nil
    }

    // 2. Database lookup
    var longURL string
    err := s.db.QueryRowContext(ctx,
        "SELECT long_url FROM urls WHERE short_code = ?",
        shortCode,
    ).Scan(&longURL)

    if err == sql.ErrNoRows {
        return "", ErrURLNotFound
    }
    if err != nil {
        return "", err
    }

    // 3. Cache for future requests
    s.cache.Set(shortCode, longURL, 24*time.Hour)

    return longURL, nil
}

var ErrURLNotFound = fmt.Errorf("URL not found")
```

### Twitter (X) t.co: Link Wrapping for Security and Analytics

As documented in Twitter Engineering retrospectives ("Twitter's Link Wrapping System t.co", 2010; "Building t.co: Security, Analytics, and Scalability at Twitter"), Twitter's t.co wraps every link shared on the platform, serving two purposes: security scanning (checking URLs against phishing and malware databases before allowing redirects) and click analytics (tracking engagement on shared links). Unlike Bitly and TinyURL, t.co generates short codes using content-addressable hashing because deduplication matters more than code brevity when the same article URL appears in thousands of tweets. The security re-scan on stale entries means a URL flagged as safe at creation time can be blocked later if threat databases update.

```go
// twitter_tco.go
// Inspired by Twitter's t.co link wrapping service
package tco

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "net/url"
    "time"
)

// TCOService wraps links for security and analytics
type TCOService struct {
    // Security scanning
    scanner *URLSecurityScanner

    // Link storage
    store *LinkStore

    // Real-time analytics
    analytics *LinkAnalytics

    // Rate limiting per user
    rateLimiter *RateLimiter
}

// URLSecurityScanner checks links for malware, phishing
type URLSecurityScanner struct {
    safeBrowsingAPI SafeBrowsingClient
    phishingDB      PhishingDatabase
    malwareDB       MalwareDatabase
}

// ScanResult contains security scan results
type ScanResult struct {
    IsSafe       bool
    ThreatType   string
    ThreatLevel  int
    ScanTime     time.Time
}

func (s *URLSecurityScanner) Scan(ctx context.Context, rawURL string) (*ScanResult, error) {
    parsedURL, err := url.Parse(rawURL)
    if err != nil {
        return &ScanResult{IsSafe: false, ThreatType: "invalid_url"}, nil
    }

    // Check Google Safe Browsing API
    sbResult, err := s.safeBrowsingAPI.Check(ctx, rawURL)
    if err == nil && sbResult.IsThreat {
        return &ScanResult{
            IsSafe:      false,
            ThreatType:  sbResult.ThreatType,
            ThreatLevel: sbResult.Severity,
            ScanTime:    time.Now(),
        }, nil
    }

    // Check internal phishing database
    if s.phishingDB.IsPhishing(parsedURL.Host) {
        return &ScanResult{
            IsSafe:     false,
            ThreatType: "phishing",
            ScanTime:   time.Now(),
        }, nil
    }

    // Check malware database
    if s.malwareDB.IsMalware(parsedURL.Host) {
        return &ScanResult{
            IsSafe:     false,
            ThreatType: "malware",
            ScanTime:   time.Now(),
        }, nil
    }

    return &ScanResult{IsSafe: true, ScanTime: time.Now()}, nil
}

// WrapLink wraps a URL in a t.co link
func (s *TCOService) WrapLink(ctx context.Context, longURL string, tweetID string) (*WrappedLink, error) {
    // 1. Security scan
    scanResult, err := s.scanner.Scan(ctx, longURL)
    if err != nil {
        return nil, fmt.Errorf("security scan failed: %w", err)
    }

    // 2. Generate short code (Twitter uses content-addressable storage)
    hash := sha256.Sum256([]byte(longURL + tweetID))
    shortCode := hex.EncodeToString(hash[:10]) // 20 char code

    // 3. Store with security metadata
    link := &WrappedLink{
        ShortCode:   shortCode,
        LongURL:     longURL,
        TweetID:     tweetID,
        IsSafe:      scanResult.IsSafe,
        ThreatType:  scanResult.ThreatType,
        CreatedAt:   time.Now(),
        DisplayURL:  truncateForDisplay(longURL),
    }

    if err := s.store.Save(ctx, link); err != nil {
        return nil, err
    }

    return link, nil
}

// Resolve handles t.co redirect with security check
func (s *TCOService) Resolve(ctx context.Context, shortCode string, userIP string) (*ResolveResult, error) {
    // 1. Fetch link
    link, err := s.store.Get(ctx, shortCode)
    if err != nil {
        return nil, err
    }

    // 2. Check if safe (re-scan if stale)
    if time.Since(link.LastScan) > 1*time.Hour {
        scanResult, _ := s.scanner.Scan(ctx, link.LongURL)
        link.IsSafe = scanResult.IsSafe
        link.ThreatType = scanResult.ThreatType
        link.LastScan = time.Now()
        s.store.Update(ctx, link)
    }

    // 3. Track analytics
    s.analytics.RecordClick(shortCode, userIP)

    // 4. Return with warning if unsafe
    return &ResolveResult{
        LongURL:     link.LongURL,
        IsSafe:      link.IsSafe,
        ThreatType:  link.ThreatType,
        ShowWarning: !link.IsSafe,
    }, nil
}

type WrappedLink struct {
    ShortCode   string
    LongURL     string
    TweetID     string
    IsSafe      bool
    ThreatType  string
    CreatedAt   time.Time
    LastScan    time.Time
    DisplayURL  string
}

type ResolveResult struct {
    LongURL     string
    IsSafe      bool
    ThreatType  string
    ShowWarning bool
}

func truncateForDisplay(rawURL string) string {
    parsed, err := url.Parse(rawURL)
    if err != nil {
        return rawURL[:min(30, len(rawURL))] + "..."
    }

    display := parsed.Host + parsed.Path
    if len(display) > 30 {
        return display[:30] + "..."
    }
    return display
}

// Placeholder interfaces
type SafeBrowsingClient interface {
    Check(ctx context.Context, url string) (*SafeBrowsingResult, error)
}

type SafeBrowsingResult struct {
    IsThreat   bool
    ThreatType string
    Severity   int
}

type PhishingDatabase interface {
    IsPhishing(host string) bool
}

type MalwareDatabase interface {
    IsMalware(host string) bool
}

type LinkStore struct{}
func (s *LinkStore) Save(ctx context.Context, link *WrappedLink) error { return nil }
func (s *LinkStore) Get(ctx context.Context, shortCode string) (*WrappedLink, error) { return nil, nil }
func (s *LinkStore) Update(ctx context.Context, link *WrappedLink) error { return nil }

type LinkAnalytics struct{}
func (a *LinkAnalytics) RecordClick(shortCode, userIP string) {}

type RateLimiter struct{}
```

---

### Junior → FAANG: Learning from Real Systems Without Cargo-Culting

Case studies like Bitly, TinyURL, and Twitter t.co are useful study material for interviews, but there is a risk of pattern-matching without understanding. The goal is to extract transferable principles, not to memorize implementation details.

**Bitly's key insight is the L1/L2/L3 cache hierarchy.** The `BitlyService` in this section uses a local in-process cache (L1, sub-millisecond) and Redis (L2, sub-5ms). The principle is that latency is dominated by the slowest dependency you must wait for. By keeping the hot 1% of URLs in process memory, Bitly avoids Redis latency for the most frequent redirects. This is a general principle: add a faster cache tier in front of any slower one when the hot set is small enough to fit in memory and the latency improvement is worth the operational complexity.

**TinyURL's simplicity is a deliberate trade-off, not a failure.** TinyURL uses a single-node monotonic counter and a bounded in-process cache. This works at TinyURL's scale and is operationally much simpler than Bitly's distributed architecture. The lesson: match the architecture to the actual scale requirement. Over-engineering for theoretical future scale that never materializes is a common mistake. Ask "what is the actual scale requirement?" before reaching for sharding and Kafka.

**Twitter t.co shows that URL shorteners are not always about brevity.** t.co's primary goals are security scanning and analytics, not short codes. It uses content-addressable hashing (SHA-256 of the URL) because deduplication across millions of tweets pointing to the same article is more valuable than short codes. This illustrates that requirements shape architecture: different goals produce fundamentally different designs even for the same nominal problem.

**In an interview, reference real systems to anchor your design choices.** When you say "I would use a token bucket like Bitly uses for rate limiting the create endpoint," you demonstrate breadth of knowledge and the ability to connect theory to practice. This is more impressive than describing an algorithm from first principles without any real-world context.

---

### Senior @ FAANG: Architecture Archaeology and the Design Decisions Behind Real Systems

At L6/L7, studying real systems means going beyond the surface architecture to understand the business constraints, failure history, and organizational context that shaped the design decisions.

**Bitly's multi-tier cache exists because of a specific failure mode.** The local L1 cache in the `BitlyService` was added after an incident where a Redis cluster failover caused a surge in database reads that overwhelmed the primary database. The L1 cache provides a circuit-breaker effect: even if Redis is completely unavailable, the top 1 million URLs (the hot set) continue to redirect without touching the database. This is architectural defense-in-depth driven by a post-mortem, not theoretical planning. When you design for FAANG scale, you read post-mortems of similar systems and design defensively against the failure modes they document.

**Twitter t.co's security scanning architecture is a synchronous dependency on the write path.** The `WrapLink` method calls `s.scanner.Scan(ctx, longURL)` synchronously before creating the short URL. This means the latency of Google Safe Browsing API calls is directly added to the URL creation latency. Twitter's production implementation uses a cache for known-safe and known-malicious URLs to avoid the API call on every submission, and falls back to "allow but flag for async review" when the API is slow or unavailable. This fail-open behavior is a deliberate policy decision: blocking tweet submission because the security API is slow would be worse user experience than occasionally allowing a URL through for async review. Document your own service's fail-open vs fail-closed policy and the reasoning behind it.

**TinyURL's checkpointed counter trades write amplification for a durability contract.** Persisting the counter every 1000 allocations avoids a database write per URL creation, but it moves all the correctness burden to the restart path: resuming from the stored checkpoint would reissue up to 999 IDs that were already handed out and silently overwrite their short codes. The production pattern is to skip ahead by the full persistence interval on startup, trading a gap in the ID space for collision safety. At L6+, this is the general lesson: any state that is persisted lazily needs an explicitly designed recovery rule, and the recovery rule should prefer waste (gaps, duplicate work) over corruption (reuse, overwrite).
