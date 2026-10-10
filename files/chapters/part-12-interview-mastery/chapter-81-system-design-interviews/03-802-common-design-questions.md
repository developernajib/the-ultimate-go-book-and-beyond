## 81.2 Common Design Questions

### URL Shortener

**Requirements Discussion:**

```
Interviewer: "Design a URL shortener like bit.ly"

You: "Let me clarify the requirements first.

Functional:
- Users can create short URLs from long URLs
- Clicking short URL redirects to original
- Analytics on clicks (optional)?
- Custom short codes allowed?
- Expiration policy?

Non-Functional:
- How many URLs created per day? (Assume 1M)
- How many redirects per day? (Assume 100M - 100:1 read:write)
- What latency is acceptable? (< 100ms for redirect)
- Availability requirement? (99.9%)

Data estimates:
- 1M URLs/day × 365 × 5 years = 1.8B URLs
- Average URL length: 100 bytes
- Total storage: 1.8B × 100 bytes ≈ 180GB"
```

**High-Level Design:**

```
┌───────────────────────────────────────────────────────────────────┐
│                     URL SHORTENER ARCHITECTURE                    │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────┐     ┌─────────────┐     ┌─────────────────────┐      │
│  │ Client  │────►│Load Balancer│────►│ API Servers (Go)    │      │
│  └─────────┘     └─────────────┘     └──────────┬──────────┘      │
│                                                  │                │
│                          ┌───────────────────────┼───────────┐    │
│                          │                       │           │    │
│                          ▼                       ▼           ▼    │
│                    ┌──────────┐          ┌──────────┐  ┌──────┐   │
│                    │  Cache   │          │ Database │  │ CDN  │   │
│                    │ (Redis)  │          │(Postgres)│  │      │   │
│                    └──────────┘          └──────────┘  └──────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

API Endpoints:
POST /api/shorten  { "url": "https://example.com/very-long-url" }
                   → { "short_url": "https://short.ly/abc123" }

GET /:code         → 301 Redirect to original URL
```

**Key Design Decisions (with Go implementation):**

```go
package main

import (
    "crypto/md5"
    "encoding/base64"
    "sync/atomic"
    "time"
)

// Epoch timestamp for custom Snowflake ID generation (Twitter snowflake epoch)
const epoch = int64(1288834974657)

// Approach 1: Counter-based (simple, sequential)
var counter uint64

func generateShortCode() string {
    id := atomic.AddUint64(&counter, 1)
    return base62Encode(id)
}

func base62Encode(num uint64) string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    if num == 0 {
        return "0"
    }

    var result []byte
    for num > 0 {
        result = append([]byte{chars[num%62]}, result...)
        num /= 62
    }
    return string(result)
}

// Approach 2: Hash-based (distributed-friendly)
func hashBasedCode(url string) string {
    hash := md5.Sum([]byte(url))
    encoded := base64.URLEncoding.EncodeToString(hash[:])
    return encoded[:7]  // Take first 7 characters
}

// Approach 3: Snowflake ID (distributed, time-ordered)
// 41 bits timestamp | 10 bits machine ID | 12 bits sequence
type Snowflake struct {
    machineID  int64
    sequence   int64
    lastTime   int64
}

func (s *Snowflake) Generate() int64 {
    timestamp := time.Now().UnixMilli()

    if timestamp == s.lastTime {
        s.sequence = (s.sequence + 1) & 0xFFF
        if s.sequence == 0 {
            // Wait for next millisecond
            for timestamp <= s.lastTime {
                timestamp = time.Now().UnixMilli()
            }
        }
    } else {
        s.sequence = 0
    }

    s.lastTime = timestamp

    id := ((timestamp - epoch) << 22) |
          (s.machineID << 12) |
          s.sequence

    return id
}
```

**Trade-offs Discussion:**

```
Counter-based:
+ Simple implementation
+ Sequential, easy to debug
- Single point of failure (need coordination)
- Predictable (security concern)

Hash-based:
+ No coordination needed
+ Same URL → same short code (deduplication)
- Collisions possible (need handling)
- Longer codes for uniqueness

Snowflake:
+ Distributed, no coordination
+ Time-ordered
+ 4096 IDs per millisecond per machine
- More complex implementation
- Clock synchronization matters
```

---

### Distributed Cache (Redis Clone)

**Requirements:**

```
Functional:
- GET/SET/DELETE operations
- TTL support for keys
- Atomic operations (INCR, etc.)

Non-Functional:
- Sub-millisecond latency
- High availability
- Scalable to terabytes
- Handles millions of operations/second
```

**Architecture:**

```
┌───────────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED CACHE DESIGN                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Clients                                                          │
│     │                                                             │
│     ▼                                                             │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                  Consistent Hash Ring                      │   │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │   │
│  │  │ Node A │  │ Node B │  │ Node C │  │ Node D │            │   │
│  │  │Primary │  │Primary │  │Primary │  │Primary │            │   │
│  │  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘            │   │
│  │      │           │           │           │                 │   │
│  │      ▼           ▼           ▼           ▼                 │   │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐            │   │
│  │  │Replica │  │Replica │  │Replica │  │Replica │            │   │
│  │  │(Node B)│  │(Node C)│  │(Node D)│  │(Node A)│            │   │
│  │  └────────┘  └────────┘  └────────┘  └────────┘            │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  Each Node:                                                       │
│  ┌──────────────────────────────────────┐                         │
│  │  ┌─────────────┐  ┌─────────────┐    │                         │
│  │  │ In-Memory   │  │   Event     │    │                         │
│  │  │ Hash Table  │  │   Loop      │    │                         │
│  │  └─────────────┘  └─────────────┘    │                         │
│  │  ┌─────────────┐  ┌─────────────┐    │                         │
│  │  │  TTL Heap   │  │  AOF/RDB    │    │                         │
│  │  │  (expiry)   │  │ (persist)   │    │                         │
│  │  └─────────────┘  └─────────────┘    │                         │
│  └──────────────────────────────────────┘                         │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Go Implementation - Core Cache:**

```go
package cache

import (
    "container/heap"
    "sync"
    "time"
)

type entry struct {
    key       string
    value     []byte
    expiresAt time.Time
    index     int  // For heap operations
}

type Cache struct {
    mu      sync.RWMutex
    data    map[string]*entry
    expHeap expiryHeap
    maxSize int
}

func New(maxSize int) *Cache {
    c := &Cache{
        data:    make(map[string]*entry),
        expHeap: make(expiryHeap, 0),
        maxSize: maxSize,
    }
    go c.expiryLoop()
    return c
}

func (c *Cache) Get(key string) ([]byte, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    e, ok := c.data[key]
    if !ok {
        return nil, false
    }

    if !e.expiresAt.IsZero() && time.Now().After(e.expiresAt) {
        return nil, false  // Lazy expiration
    }

    return e.value, true
}

func (c *Cache) Set(key string, value []byte, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()

    var expiresAt time.Time
    if ttl > 0 {
        expiresAt = time.Now().Add(ttl)
    }

    if e, ok := c.data[key]; ok {
        e.value = value
        e.expiresAt = expiresAt
        heap.Fix(&c.expHeap, e.index)
    } else {
        e := &entry{
            key:       key,
            value:     value,
            expiresAt: expiresAt,
        }
        c.data[key] = e
        if !expiresAt.IsZero() {
            heap.Push(&c.expHeap, e)
        }
    }

    // Eviction if over capacity
    for len(c.data) > c.maxSize {
        c.evictOne()
    }
}

func (c *Cache) Delete(key string) bool {
    c.mu.Lock()
    defer c.mu.Unlock()

    if e, ok := c.data[key]; ok {
        delete(c.data, key)
        if e.index >= 0 {
            heap.Remove(&c.expHeap, e.index)
        }
        return true
    }
    return false
}

func (c *Cache) expiryLoop() {
    ticker := time.NewTicker(100 * time.Millisecond)
    for range ticker.C {
        c.expireKeys()
    }
}

func (c *Cache) expireKeys() {
    c.mu.Lock()
    defer c.mu.Unlock()

    now := time.Now()
    for c.expHeap.Len() > 0 {
        e := c.expHeap[0]
        if e.expiresAt.After(now) {
            break
        }
        heap.Pop(&c.expHeap)
        delete(c.data, e.key)
    }
}

func (c *Cache) evictOne() {
    if c.expHeap.Len() > 0 {
        e := heap.Pop(&c.expHeap).(*entry)
        delete(c.data, e.key)
        return
    }
    for k := range c.data {
        delete(c.data, k)
        break
    }
}

// Min-heap for TTL expiration
type expiryHeap []*entry

func (h expiryHeap) Len() int           { return len(h) }
func (h expiryHeap) Less(i, j int) bool { return h[i].expiresAt.Before(h[j].expiresAt) }
func (h expiryHeap) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].index = i
    h[j].index = j
}

func (h *expiryHeap) Push(x any) {
    e := x.(*entry)
    e.index = len(*h)
    *h = append(*h, e)
}

func (h *expiryHeap) Pop() any {
    old := *h
    n := len(old)
    e := old[n-1]
    old[n-1] = nil
    e.index = -1
    *h = old[:n-1]
    return e
}
```

---

### Rate Limiter

**Requirements:**

```
Functional:
- Limit requests per user/IP/API key
- Multiple rate limit rules (per second, minute, hour)
- Return rate limit headers

Non-Functional:
- Sub-millisecond latency
- Distributed across multiple servers
- Accurate counting (no under-counting)
```

**Algorithm Comparison:**

```
┌─────────────────────────────────────────────────────────────────┐
│                  RATE LIMITING ALGORITHMS                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Token Bucket                                                │
│     ┌─────────────────┐                                         │
│     │  Bucket (10)    │ ← Tokens added at rate R                │
│     │  ●●●●●●●●○○     │                                         │
│     └───────┬─────────┘                                         │
│             │ Request takes 1 token                             │
│             ▼                                                   │
│     + Allows bursts up to bucket size                           │
│     + Smooth rate limiting                                      │
│     - Memory per bucket                                         │
│                                                                 │
│  2. Leaky Bucket                                                │
│     ┌─────────────────┐                                         │
│     │  Queue          │ ← Requests added here                   │
│     │  ■ ■ ■ ■        │                                         │
│     └───────┬─────────┘                                         │
│             │ Processed at fixed rate                           │
│             ▼                                                   │
│     + Smooths output rate                                       │
│     - No burst handling                                         │
│     - Queue memory                                              │
│                                                                 │
│  3. Fixed Window                                                │
│     │←── 1 min ──→│←── 1 min ──→│                               │
│     │ ■■■■■■■■■■ │ ■■■■■■■■■■ │                                 │
│     │   (10)     │   (10)     │                                 │
│     + Simple implementation                                     │
│     - Boundary spike (2x at window edge)                        │
│                                                                 │
│  4. Sliding Window Log                                          │
│     [1:00:00, 1:00:05, 1:00:10, ...]                            │
│     Keep timestamps of all requests                             │
│     + Most accurate                                             │
│     - Memory intensive                                          │
│                                                                 │
│  5. Sliding Window Counter (RECOMMENDED)                        │
│     Weight requests from previous + current window              │
│     Count = prev_count × overlap% + current_count               │
│     + Memory efficient                                          │
│     + Fairly accurate                                           │
│     + Easy to implement                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Go Implementation - Sliding Window Counter:**

```go
package ratelimit

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

type SlidingWindowLimiter struct {
    redis      *redis.Client
    limit      int64
    windowSize time.Duration
}

func NewSlidingWindowLimiter(client *redis.Client, limit int64, window time.Duration) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        redis:      client,
        limit:      limit,
        windowSize: window,
    }
}

func (l *SlidingWindowLimiter) Allow(ctx context.Context, key string) (bool, error) {
    now := time.Now().UnixMilli()
    windowMs := l.windowSize.Milliseconds()

    currentWindow := now / windowMs * windowMs
    previousWindow := currentWindow - windowMs

    currKey := fmt.Sprintf("%s:%d", key, currentWindow)
    prevKey := fmt.Sprintf("%s:%d", key, previousWindow)

    pipe := l.redis.Pipeline()

    // Get counts from both windows
    prevCount := pipe.Get(ctx, prevKey)
    currCount := pipe.Incr(ctx, currKey)
    pipe.Expire(ctx, currKey, l.windowSize*2)

    _, err := pipe.Exec(ctx)
    if err != nil && err != redis.Nil {
        return false, err
    }

    // Calculate weighted count
    prev, _ := prevCount.Int64()
    curr := currCount.Val()

    // Weight = how much of current window has passed
    elapsed := now - currentWindow
    weight := float64(windowMs-elapsed) / float64(windowMs)

    weightedCount := float64(prev)*weight + float64(curr)

    if int64(weightedCount) > l.limit {
        // Undo the increment
        l.redis.Decr(ctx, currKey)
        return false, nil
    }

    return true, nil
}

// Token Bucket implementation
type TokenBucket struct {
    capacity     int64
    refillRate   float64  // Tokens per second
    tokens       float64
    lastRefill   time.Time
    mu           sync.Mutex
}

func NewTokenBucket(capacity int64, refillRate float64) *TokenBucket {
    return &TokenBucket{
        capacity:   capacity,
        refillRate: refillRate,
        tokens:     float64(capacity),
        lastRefill: time.Now(),
    }
}

func (b *TokenBucket) Allow() bool {
    b.mu.Lock()
    defer b.mu.Unlock()

    // Refill tokens based on time elapsed
    now := time.Now()
    elapsed := now.Sub(b.lastRefill).Seconds()
    b.tokens = min(float64(b.capacity), b.tokens+elapsed*b.refillRate)
    b.lastRefill = now

    if b.tokens >= 1 {
        b.tokens--
        return true
    }

    return false
}
```

---

### Junior → FAANG: Treating Common Questions as Thinking Templates

The URL shortener and similar "classic" design questions are studied so frequently that some candidates memorize solutions without understanding the underlying reasoning. Interviewers know this and probe accordingly. When you say "I would use base62 encoding for the short URL," expect the follow-up: "why base62 and not base64, and how does that affect the key length?"

For each common question, practice deriving the answer rather than recalling it. "The core challenge in URL shortener is the read-to-write ratio (high read, lower write) and global distribution requirements, which suggests a cache-heavy, read-optimized design with eventual consistency for URL resolution." Deriving this reasoning live shows understanding that a memorized answer does not.

First-job insight: the same design reasoning applies to real systems. Most backend services are variations of these classic archetypes (the URL shortener is any key-value lookup service at scale, the rate limiter is any quota enforcement system, the feed is any ranked content delivery pipeline). Building the mental model for the archetype makes you effective in real system design discussions, not just interviews.

### Senior @ FAANG: Classic Questions as Regression Tests for Reasoning Quality

For senior candidates, classic questions are the baseline from which the interviewer applies pressure. After your solid URL shortener design, expect: "your design assumes single-region. How does it change for multi-region active-active?" or "your encoding scheme produces short URLs. What happens when the namespace exhausts?" The ability to extend your design under follow-up pressure is the L5/L6 differentiator.

A senior candidate treats common design questions as opportunities to demonstrate architectural judgment rather than architectural knowledge. The classic URL shortener question has many defensible designs. The senior signal is choosing one, defending it, and evolving it under constraints, not producing the theoretically optimal design in isolation.

Platform thinking in common questions: when designing a rate limiter for a FAANG-scale audience, a L6 candidate thinks beyond "how do I count requests" to "how does this rate limiter integrate with the existing API gateway, how are rate limit configurations pushed without service restarts, how do we monitor rate limit hit rates as a signal for capacity planning, and what is the rollback plan if the rate limiter introduces latency regression?" This platform-level thinking is what the interviewer is listening for but rarely states explicitly.
