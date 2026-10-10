## Interview Questions

### Question 1: How would you generate unique short URLs without collision?

**What FAANG expects:** Three candidates with trade-offs: counter + base62 (compact but predictable, needs distributed counter), Snowflake-style (distributed, time-sortable, larger), hash + collision-check (deduplicates same long URL but adds DB roundtrip). Bonus for naming real IDs: Twitter's Snowflake, Instagram's 64-bit ID scheme, and knowing that sequential IDs leak total URL count to scrapers.

**Answer:**

There are several approaches, each with trade-offs:

**1. Counter-based with Base62:**
```go
// Pros: Simple, guaranteed unique, compact
// Cons: Predictable, requires distributed counter coordination
type CounterIDGenerator struct {
    redis   *redis.Client
    nodeID  int
    localCounter int64
    batchSize    int64
}

func (g *CounterIDGenerator) GetBatch(ctx context.Context) (start, end int64, err error) {
    // Reserve a batch of IDs from Redis
    end, err = g.redis.IncrBy(ctx, "url:counter", g.batchSize).Result()
    if err != nil {
        return 0, 0, err
    }
    start = end - g.batchSize + 1
    return
}

func (g *CounterIDGenerator) Next() string {
    g.localCounter++
    return base62Encode(uint64(g.localCounter))
}
```

**2. Snowflake-like IDs:**
```go
// Pros: Distributed, time-sorted, no coordination needed
// Cons: Slightly longer (64-bit)
func (g *SnowflakeGenerator) Generate() uint64 {
    timestamp := time.Now().UnixMilli() - g.epoch
    sequence := atomic.AddUint32(&g.seq, 1) & 0xFFF

    return (uint64(timestamp) << 22) |
           (uint64(g.nodeID) << 12) |
           uint64(sequence)
}
```

**3. Hash-based with collision check:**
```go
// Pros: Deterministic for same input, enables deduplication
// Cons: Requires collision checking
func (g *HashGenerator) Generate(ctx context.Context, longURL string) (string, error) {
    for i := 0; i < 10; i++ {
        input := fmt.Sprintf("%s:%d", longURL, i)
        hash := sha256.Sum256([]byte(input))
        shortCode := base62Encode(binary.BigEndian.Uint64(hash[:8]))[:7]

        exists, _ := g.db.Exists(ctx, shortCode)
        if !exists {
            return shortCode, nil
        }
    }
    return "", errors.New("collision limit reached")
}
```

For a production system handling 100M URLs, I'd recommend **Snowflake-like IDs** because:
- No distributed coordination needed
- Time-sortable for debugging
- Scales horizontally
- 7-character Base62 encoding handles 62^7 = 3.5 trillion URLs

**Follow-ups:**
- *Why does bit.ly randomize rather than use a counter?* Counters leak total URL count and enable enumeration attacks (scraping every short URL). Randomized encoding + collision check trades a tiny write-path cost for privacy and anti-scraping.
- *What is the batch-reservation optimization?* Each node reserves a range of IDs from Redis/Postgres in one round-trip (IncrBy 1000), then hands them out locally. Cuts the coordinator traffic 1000x. The cost is unused IDs if a node crashes.
- *How do you handle the collision-check race?* `INSERT ... ON CONFLICT DO NOTHING` with a unique index on `short_code`. Retry with a new candidate if the insert reports zero rows affected. Never check-then-insert (TOCTOU).

### Question 2: How do you handle a URL shortener under heavy read traffic?

**What FAANG expects:** Power-law read distribution means CDN + multi-tier cache is the right tool. Acknowledge that most redirects come from a small fraction of short codes. Mention singleflight/request coalescing for thundering-herd protection on cold keys, and the negative-cache for the "short code does not exist" case so attackers cannot hammer the DB with random lookups. Bonus for citing Bitly's public talks: ~6B clicks/month, heavily CDN-cached.

**Answer:**

URL shorteners are extremely read-heavy (100:1 or 1000:1 read/write ratio). Key strategies:

```go
// Multi-tier caching architecture
type HighPerformanceService struct {
    // L1: In-process cache (< 1ms)
    localCache *freecache.Cache // 500MB in-memory

    // L2: Redis cluster (< 5ms)
    redis *redis.ClusterClient

    // L3: Database with read replicas (< 50ms)
    dbPrimary  *sql.DB
    dbReplicas []*sql.DB
}

func (s *HighPerformanceService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    // L1 check - fastest
    if val, err := s.localCache.Get([]byte(shortCode)); err == nil {
        return string(val), nil
    }

    // L2 check - distributed cache
    if val, err := s.redis.Get(ctx, shortCode).Result(); err == nil {
        s.localCache.Set([]byte(shortCode), []byte(val), 300) // 5 min
        return val, nil
    }

    // L3 check - database replica
    replica := s.dbReplicas[hash(shortCode)%len(s.dbReplicas)]
    var longURL string
    err := replica.QueryRowContext(ctx,
        "SELECT long_url FROM urls WHERE short_code = ?", shortCode,
    ).Scan(&longURL)

    if err == nil {
        // Async cache population
        go s.warmCaches(shortCode, longURL)
    }

    return longURL, err
}

func (s *HighPerformanceService) warmCaches(shortCode, longURL string) {
    ctx := context.Background()
    s.redis.Set(ctx, shortCode, longURL, 24*time.Hour)
    s.localCache.Set([]byte(shortCode), []byte(longURL), 3600)
}
```

Additional optimizations:
- **CDN caching**: For top 1% of URLs (power law distribution)
- **Read replicas**: Scale reads horizontally
- **Cache warming**: Pre-cache new URLs immediately after creation
- **Hot key protection**: Singleflight to deduplicate concurrent cache misses

**Follow-ups:**
- *How do you cache "not found" without enabling a DoS amplifier?* Cache the 404 with a short TTL (60s) and a bloom filter or cuckoo filter in front to reject definitely-unknown codes without hitting cache at all.
- *What is the failure mode if Redis goes down?* Fall through to read replicas with a small local cache floor. Trade hit-rate for availability. Keep CDN caches aggressive so the origin is still protected.
- *How do you invalidate cached redirects when a URL is updated or deleted?* Publish an invalidation event on Redis Pub/Sub or a CDN purge API. In practice, URL shorteners rarely update the target (mostly soft delete), so TTL-only invalidation is common.

### Question 3: How would you implement analytics for click tracking?

**What FAANG expects:** Analytics must never block the redirect. Async pipeline: atomic real-time counter + bounded channel + batched write to Kafka/Kinesis + downstream aggregation (ClickHouse, BigQuery, Druid). Bonus for acknowledging that click analytics is "lossy is okay" and that bot traffic must be filtered (user-agent heuristics, rate limits per IP, reCAPTCHA for suspicious patterns).

**Answer:**

Analytics must be non-blocking to avoid impacting redirect latency:

```go
type ClickAnalytics struct {
    // Async click stream
    clickChan chan *ClickEvent
    batchSize int

    // Real-time counters (for dashboard)
    realTimeCounts sync.Map

    // Kafka writer for persistence (segmentio/kafka-go)
    kafkaWriter *kafka.Writer
}

func NewClickAnalytics() *ClickAnalytics {
    a := &ClickAnalytics{
        clickChan: make(chan *ClickEvent, 100000),
        batchSize: 1000,
    }
    go a.processClicks()
    return a
}

// RecordClick is called during redirect - must be fast
func (a *ClickAnalytics) RecordClick(event *ClickEvent) {
    // Update real-time counter (atomic, ~10ns)
    counter, _ := a.realTimeCounts.LoadOrStore(event.ShortCode, &atomic.Int64{})
    counter.(*atomic.Int64).Add(1)

    // Send to processing pipeline (non-blocking)
    select {
    case a.clickChan <- event:
    default:
        // Buffer full, drop event (acceptable for analytics)
        metrics.IncrementDroppedClicks()
    }
}

func (a *ClickAnalytics) processClicks() {
    batch := make([]*ClickEvent, 0, a.batchSize)
    ticker := time.NewTicker(100 * time.Millisecond)

    for {
        select {
        case event := <-a.clickChan:
            batch = append(batch, event)
            if len(batch) >= a.batchSize {
                a.flushBatch(batch)
                batch = batch[:0]
            }

        case <-ticker.C:
            if len(batch) > 0 {
                a.flushBatch(batch)
                batch = batch[:0]
            }
        }
    }
}

func (a *ClickAnalytics) flushBatch(events []*ClickEvent) {
    // Batch write to Kafka for downstream processing
    messages := make([]kafka.Message, len(events))
    for i, e := range events {
        data, _ := json.Marshal(e)
        messages[i] = kafka.Message{
            Key:   []byte(e.ShortCode),
            Value: data,
        }
    }

    a.kafkaWriter.WriteMessages(context.Background(), messages...)
}

type ClickEvent struct {
    ShortCode   string    `json:"short_code"`
    Timestamp   time.Time `json:"timestamp"`
    IP          string    `json:"ip"`
    UserAgent   string    `json:"user_agent"`
    Referer     string    `json:"referer"`
    Country     string    `json:"country"`
    Device      string    `json:"device"`
}
```

**Follow-ups:**
- *How much click loss is tolerable?* For user-facing analytics, 1-2% drop under load is invisible. For billing (ad clicks), zero tolerance. Use durable buffering (local WAL, Kafka with ack=all). Pick per use case.
- *How do you avoid counting a bot double-click as two?* Fingerprint the request (IP + UA + 5-second bucket) and dedupe server-side, or push the dedupe into the aggregation layer (ClickHouse ReplacingMergeTree, BigQuery window functions).
- *Where does GDPR/PII enter this pipeline?* IP addresses and fingerprints are personal data in EU/UK. Hash or truncate (last octet masked), retain raw only in a short-lived hot tier, and document a data-deletion path per user request.

---

### Junior → FAANG: How to Approach System Design Interview Questions

The three questions in this section represent the core axes that interviewers probe in a URL shortener design: uniqueness (ID generation), scalability (read traffic), and correctness under real-world constraints (analytics). Knowing the answers is necessary but not sufficient. Knowing how to structure and communicate them is equally important.

**State the trade-offs before the interviewer asks.** For ID generation, say "I'll use Snowflake-style IDs because they are distributed and time-sortable, but the trade-off is that clock skew can cause duplicate IDs, so I need to handle backward clock drift." You have now demonstrated that you know the failure mode before being asked. This is a strong signal.

**Use concrete numbers.** "The cache hit rate will be high" is weaker than "with a 20% working set cached (80/20 rule), 80% of redirects hit the cache, meaning only 20% of 100K redirects per second (20K requests/second) reach the database." Concrete numbers show that you are modeling the system, not describing it abstractly.

**Do not skip the follow-up signals.** Each question in this section has follow-ups. These follow-ups are the questions an interviewer asks when they want to see if you have real production experience. "How do you avoid counting a bot double-click as two?" is a follow-up to the analytics question. The answer (fingerprint deduplication, time bucket bucketing, or downstream deduplication in the aggregation layer) reveals whether you have thought about data quality at scale.

**Entry-level interview checklist.** Before an interview on this topic, be able to explain: why 302 not 301, what Base62 encoding is and how to derive the key length, what cache-aside means, what singleflight does, and what asynchronous analytics means for redirect latency. These are the five most common follow-up areas for junior candidates.

---

### Senior @ FAANG: Bar-Raiser Question Patterns and L6/L7 Response Calibration

A bar-raiser interviewer at L6/L7 is not testing whether you know the answers. They are testing whether your reasoning process is the same quality that would be brought to a real architectural decision at the company. The following calibration guide covers what L6 and L7 responses look like for each question in this section.

**Question 1 (ID generation): L6 vs L7 response.** An L6 response correctly describes Snowflake-style IDs, identifies the trade-offs (clock drift, node ID management, sequence overflow), and proposes mitigations (detect backward clock drift and wait). An L7 response additionally addresses the operational governance layer: how node IDs are assigned at startup (coordination service), what happens when the coordination service is unavailable (fail-fast, not silent fallback), how you monitor for clock drift (alert on `clock_is_backwards` counter in Prometheus), and how you handle the case where a process restarts and re-acquires the same node ID while the previous instance is still generating IDs (lease-based node ID assignment with TTL renewal). The L7 response is a complete operational story, not just a correct algorithm.

**Question 2 (read traffic): L6 vs L7 response.** An L6 response correctly identifies multi-tier caching, singleflight, and CDN edge caching. An L7 response additionally covers the CDN invalidation problem (how do you revoke a URL that is cached at the CDN edge with a 5-minute TTL? Answer: CDN purge API, or use short TTLs with the Stale-While-Revalidate directive), the hot key problem (a viral URL that generates 1M requests per second to a single Redis key will overwhelm a single Redis node, requiring key replication across multiple nodes with probabilistic routing), and the capacity model (at what traffic level does each caching tier saturate, and what is the operational trigger for scaling each tier).

**Question 3 (analytics): L6 vs L7 response.** An L6 response correctly identifies asynchronous pipelines, bounded channel buffers, drop-on-overflow for analytics, and the acceptable loss rate for non-billing analytics. An L7 response additionally covers the schema governance layer (versioned event schemas, consumer compatibility matrix), the GDPR compliance layer (IP hashing, retention policy, erasure request handling), the monitoring layer (channel utilization metric, Kafka consumer lag alert, dead-letter queue for malformed events), and the billing separation concern (billing-critical events require durable buffering with `RequireAll` ack, not drop-on-overflow).
