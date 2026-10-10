## Common Mistakes and How to Avoid Them

### 1. Not Handling Collision Properly

ID collision is an infrequent but catastrophic failure mode: two different long URLs map to the same short code, causing one URL to silently override the other. The probability is low with 62-character Base62 encoding over 6 characters (56 billion combinations), but under high concurrency or when using timestamp-based generation it becomes a real risk. The correct approach always checks for an existing record before inserting and retries with a different ID on conflict, relying on a unique database constraint as the authoritative guard.

```go
// Wrong: Assuming generated ID is always unique
func generateShortID() string {
    id := generator.Generate()
    return encoder.Encode(id)
}

// Correct: Always check for collision
func generateUniqueShortID(ctx context.Context) (string, error) {
    for i := 0; i < maxRetries; i++ {
        id := generator.Generate()
        shortID := encoder.Encode(id)

        exists, err := repo.ShortIDExists(ctx, shortID)
        if err != nil {
            return "", err
        }
        if !exists {
            return shortID, nil
        }
    }
    return "", errors.New("collision limit exceeded")
}
```

### 2. Cache Stampede

A cache stampede occurs when many concurrent requests for the same short URL all experience a cache miss simultaneously, flooding the database with identical queries. This is especially severe after a cache flush or when a previously cold URL suddenly goes viral. The `singleflight` package solves this by collapsing all concurrent requests for the same key into a single database call, so only one goroutine performs the lookup while all others wait and share the result.

```go
// Wrong: Multiple requests hit DB on cache miss
func GetLongURL(shortID string) string {
    if cached := cache.Get(shortID); cached != "" {
        return cached
    }
    url := db.Get(shortID) // Many requests hit this
    cache.Set(shortID, url)
    return url
}

// Correct: Use singleflight to deduplicate
var group singleflight.Group

func GetLongURL(shortID string) string {
    if cached := cache.Get(shortID); cached != "" {
        return cached
    }

    result, _, _ := group.Do(shortID, func() (any, error) {
        url := db.Get(shortID)
        cache.Set(shortID, url)
        return url, nil
    })

    return result.(string)
}
```

### 3. Not Validating URLs

Accepting arbitrary strings as long URLs creates security vulnerabilities: attackers can create short links pointing to `javascript:` URIs, internal network addresses (`http://192.168.1.1`), or malware distribution sites. URL validation must check the scheme, parse the host component, and optionally verify the domain against a block list. Skipping this step turns your URL shortener into a phishing and SSRF attack enabler.

```go
// Wrong: Accepting any string as URL
func (s *URLService) CreateShortURL(longURL string) error {
    return s.repo.Create(shortID, longURL) // Could be malicious
}

// Correct: Validate URL properly
func (s *URLService) CreateShortURL(longURL string) error {
    // Parse and validate
    u, err := url.Parse(longURL)
    if err != nil {
        return ErrInvalidURL
    }

    // Check scheme
    if u.Scheme != "http" && u.Scheme != "https" {
        return ErrInvalidScheme
    }

    // Check for blocked domains
    if s.isBlocked(u.Host) {
        return ErrBlockedDomain
    }

    return s.repo.Create(shortID, longURL)
}
```

### 4. Sequential ID Exposure

Sequential short codes like `abcd1`, `abcd2`, `abcd3` allow competitors to enumerate every URL in your system and calculate your growth rate by comparing the highest code at two points in time. An attacker can also systematically scrape the full URL database by iterating through all possible codes. The fix is a Snowflake-style ID that encodes timestamp, node ID, and sequence number into a 64-bit integer, producing codes that appear random to observers but remain time-ordered and collision-free across distributed nodes.

```go
// ❌ Wrong: Sequential IDs leak business information
type BadIDGenerator struct {
    counter uint64
}

func (g *BadIDGenerator) Next() string {
    g.counter++
    return base62Encode(g.counter)
}

// Competitor can enumerate all URLs and track growth rate
// URL abcd1 → abcd2 → abcd3 (predictable)
```

```go
// ✅ Correct: Use random or timestamp-based IDs
type SecureIDGenerator struct {
    nodeID    uint16
    sequence  uint16
    lastTime  int64
}

func (g *SecureIDGenerator) Generate() uint64 {
    // Snowflake-like: timestamp + nodeID + sequence
    timestamp := time.Now().UnixMilli() - epoch
    g.sequence++

    id := (uint64(timestamp) << 22) |
          (uint64(g.nodeID) << 12) |
          uint64(g.sequence&0xFFF)

    return id
}

// IDs are random-looking but still sortable
// 7HzJ8k → 9mKp2q → BnR4wX (unpredictable)
```

### 5. Not Implementing Graceful Degradation

A URL shortener that returns 503 when Redis is unavailable completely breaks redirection for all users, even though the canonical data still exists in the database. The `ResilientService` solves this with a three-tier lookup: an in-process local cache that survives Redis outages, a circuit-breaker-guarded Redis layer, and a direct database fallback. This layered approach keeps redirect latency low in the happy path while ensuring the service degrades gracefully under partial failures rather than failing entirely.

```go
// ❌ Wrong: Hard failure when cache is down
func (s *BadService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    // If Redis fails, entire service fails
    longURL, err := s.redis.Get(ctx, "url:"+shortCode).Result()
    if err != nil {
        return "", err // Fails even for DB-backed URLs
    }
    return longURL, nil
}
```

```go
// ✅ Correct: Graceful degradation with fallbacks
type ResilientService struct {
    localCache  *LocalCache
    redis       *redis.Client
    db          *sql.DB
    circuitBreaker *CircuitBreaker
}

func (s *ResilientService) GetLongURL(ctx context.Context, shortCode string) (string, error) {
    // 1. Try local cache (always available)
    if url, ok := s.localCache.Get(shortCode); ok {
        return url, nil
    }

    // 2. Try Redis with circuit breaker
    if s.circuitBreaker.Allow() {
        url, err := s.redis.Get(ctx, "url:"+shortCode).Result()
        if err == nil {
            s.localCache.Set(shortCode, url, 5*time.Minute)
            s.circuitBreaker.RecordSuccess()
            return url, nil
        }
        s.circuitBreaker.RecordFailure()
        // Continue to database fallback
    }

    // 3. Fallback to database
    var url string
    err := s.db.QueryRowContext(ctx,
        "SELECT long_url FROM urls WHERE short_code = ?", shortCode,
    ).Scan(&url)
    if err != nil {
        return "", ErrURLNotFound
    }

    // Cache in local cache (skip Redis if circuit is open)
    s.localCache.Set(shortCode, url, 5*time.Minute)
    return url, nil
}
```

---

### Junior → FAANG: Building the Habit of Correctness-First Thinking

The mistakes documented in this section are not just coding errors. They are reasoning failures that happen when you jump to implementation before fully understanding the failure modes. Building correctness-first thinking is the single most transferable habit from this section.

**Collision detection is required by the algorithm, not optional.** Every ID generation strategy that produces a finite output space has a nonzero collision probability. Sequential counter with database unique constraint and retry is not defensive paranoia: it is the correct algorithm. The unique constraint is the authoritative guard. The pre-check (`ShortIDExists`) is a performance optimization to avoid a database write that would fail. Know the distinction.

**`singleflight` is the canonical Go solution to thundering herd.** The `singleflight.Group` from the `golang.org/x/sync/singleflight` package is designed exactly for the cache stampede problem. Multiple concurrent calls with the same key are deduplicated to a single in-flight call. All callers receive the same result when it completes. The only gotcha: if the single in-flight call returns an error, all callers receive that error. Make sure your error handling on the first call is correct, because it propagates to all waiting callers.

**URL validation is a security requirement, not input validation.** Accepting `javascript:alert(1)` as a URL and creating a short code for it turns your service into an XSS vector. Accepting `http://192.168.1.1` or `http://169.254.169.254` creates an SSRF (Server-Side Request Forgery) vulnerability if any part of your system fetches the URL to preview it or check its health. The URL validator must check scheme, parse and resolve the host, and verify the host does not resolve to a private IP range. This must happen at write time (before storing the URL), not at redirect time.

---

### Senior @ FAANG: Systematic Failure Mode Analysis and Defense-in-Depth

At L6/L7, the common mistakes section of a design document is replaced by a formal threat model: a systematic enumeration of failure modes, their probability and impact, and the mitigations in place for each.

**SSRF via URL validation is a high-severity vulnerability.** The scheme and blocklist checks in the Mistake 3 fix are necessary but not sufficient: a complete validator must also resolve the hostname and reject URLs whose resolved IPs are private. This is necessary because an attacker can register a public domain that points to a private IP (`evil.com` resolves to `192.168.1.1`) to bypass hostname-based checks. The validator must resolve the hostname and check the resulting IPs at write time. It must also handle the case where DNS resolution changes after the URL was stored: a domain that pointed to a public IP at creation time may later be updated to point to a private IP, creating a stored SSRF vulnerability. The mitigation is to re-validate the URL on redirect, or to use an allowlist of trusted domains rather than a blocklist of private IPs.

**The hot partition problem is a distributed systems design error, not just a performance issue.** Sequential short codes hash to adjacent buckets, and recent URLs (which are the hottest, because newly shared links receive the most traffic) all land on the same shard. This makes the "most recently created" shard the hottest, creating a feedback loop. Bit-reversal permutation or XOR scrambling of sequential IDs before sharding distributes recent URLs uniformly across shards. This must be done before the sharding key is computed, not after: the shard must be a function of the scrambled ID, not the sequential ID. Document this as a data layout invariant that must not be changed without a full data migration.

**Graceful degradation must be tested in production conditions, not just unit tests.** The `ResilientService` circuit breaker works correctly in unit tests with a mock Redis client that returns errors on demand. It may not work correctly in production if the circuit breaker threshold is tuned for a test environment where failures are instantaneous, while production Redis failures may present as high latency rather than immediate errors. The `context.WithTimeout` in the health check probe must be set to a value that represents actual acceptable latency, not an artificially short value. Validate the circuit breaker behavior under realistic failure conditions: use Toxiproxy to inject 100ms latency on Redis connections and verify that the circuit opens within the expected number of slow requests, and that the local fallback handles the traffic without causing GC pressure from unbounded key growth.
