## 60.3 Short URL Generation

### Base62 Encoding

Base62 encoding maps numeric IDs to URL-safe alphanumeric strings using the character set `[0-9A-Za-z]`, producing shorter representations than hexadecimal while remaining readable in URLs without percent-encoding. A 7-character base62 string provides 62^7 ≈ 3.5 trillion unique combinations, sufficient for any realistic URL shortener scale. The choice to encode sequential database IDs rather than using random strings makes the generation deterministic and avoids collision checks, at the cost of exposing sequential patterns that could allow enumeration.

```go
// encoding/base62.go
package encoding

import (
    "errors"
    "math"
    "strings"
)

const (
    base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    base        = 62
)

var (
    ErrInvalidCharacter = errors.New("invalid base62 character")
)

// Base62Encoder handles encoding/decoding
type Base62Encoder struct {
    charMap map[rune]int
}

// NewBase62Encoder creates a new encoder
func NewBase62Encoder() *Base62Encoder {
    charMap := make(map[rune]int)
    for i, c := range base62Chars {
        charMap[c] = i
    }
    return &Base62Encoder{charMap: charMap}
}

// Encode converts a number to base62 string
func (e *Base62Encoder) Encode(num uint64) string {
    if num == 0 {
        return string(base62Chars[0])
    }

    var result strings.Builder
    for num > 0 {
        remainder := num % base
        result.WriteByte(base62Chars[remainder])
        num /= base
    }

    // Reverse the string
    encoded := result.String()
    runes := []rune(encoded)
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }

    return string(runes)
}

// EncodeWithPadding encodes with minimum length padding
func (e *Base62Encoder) EncodeWithPadding(num uint64, minLength int) string {
    encoded := e.Encode(num)
    if len(encoded) >= minLength {
        return encoded
    }

    padding := strings.Repeat(string(base62Chars[0]), minLength-len(encoded))
    return padding + encoded
}

// Decode converts a base62 string to number
func (e *Base62Encoder) Decode(s string) (uint64, error) {
    var result uint64

    for _, c := range s {
        val, ok := e.charMap[c]
        if !ok {
            return 0, ErrInvalidCharacter
        }
        result = result*base + uint64(val)
    }

    return result, nil
}

// MaxValue returns the maximum value for a given length
func (e *Base62Encoder) MaxValue(length int) uint64 {
    return uint64(math.Pow(float64(base), float64(length))) - 1
}
```

### ID Generation Strategies

Four distinct strategies are provided because no single approach is universally optimal: a simple Redis counter works for single-node deployments but becomes a bottleneck at scale. range-based allocation amortizes Redis round trips by reserving a block of IDs locally. Snowflake-style IDs embed a timestamp and node identifier directly in the 64-bit integer so multiple servers generate non-colliding IDs without coordination. And hash-based generation makes the short ID a deterministic function of the URL content, naturally deduplicating repeated submissions of the same URL without a database lookup. Choose based on whether your deployment is single-node or distributed and whether predictable ID sequences are a security concern.

```go
// generator/id.go
package generator

import (
    "context"
    "crypto/sha256"
    "encoding/binary"
    "errors"
    "strconv"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"

    "yourproject/encoding"
)

var ErrInvalidNodeID = errors.New("node ID exceeds the 10-bit maximum")

// IDGenerator generates unique IDs for short URLs
type IDGenerator interface {
    Generate(ctx context.Context) (uint64, error)
}

// ========================================
// Strategy 1: Counter-Based (Simple)
// ========================================

type CounterGenerator struct {
    redis   *redis.Client
    key     string
}

func NewCounterGenerator(redis *redis.Client, key string) *CounterGenerator {
    return &CounterGenerator{redis: redis, key: key}
}

func (g *CounterGenerator) Generate(ctx context.Context) (uint64, error) {
    val, err := g.redis.Incr(ctx, g.key).Result()
    if err != nil {
        return 0, err
    }
    return uint64(val), nil
}

// ========================================
// Strategy 2: Range-Based (Scalable)
// ========================================

type RangeGenerator struct {
    redis     *redis.Client
    rangeKey  string
    rangeSize int64

    mu        sync.Mutex
    current   int64
    max       int64
}

func NewRangeGenerator(redis *redis.Client, rangeKey string, rangeSize int64) *RangeGenerator {
    return &RangeGenerator{
        redis:     redis,
        rangeKey:  rangeKey,
        rangeSize: rangeSize,
    }
}

func (g *RangeGenerator) Generate(ctx context.Context) (uint64, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    // Check if we need a new range
    if g.current >= g.max {
        if err := g.fetchNewRange(ctx); err != nil {
            return 0, err
        }
    }

    id := g.current
    g.current++
    return uint64(id), nil
}

func (g *RangeGenerator) fetchNewRange(ctx context.Context) error {
    // Atomically reserve a range
    newMax, err := g.redis.IncrBy(ctx, g.rangeKey, g.rangeSize).Result()
    if err != nil {
        return err
    }

    g.current = newMax - g.rangeSize
    g.max = newMax
    return nil
}

// ========================================
// Strategy 3: Snowflake-like (Distributed)
// ========================================

type SnowflakeGenerator struct {
    nodeID    uint64
    sequence  uint64
    lastTime  int64

    mu        sync.Mutex
}

const (
    nodeBits     = 10
    sequenceBits = 12
    maxNodeID    = (1 << nodeBits) - 1
    maxSequence  = (1 << sequenceBits) - 1
    epoch        = 1609459200000 // 2021-01-01 00:00:00 UTC in milliseconds
)

func NewSnowflakeGenerator(nodeID uint64) (*SnowflakeGenerator, error) {
    if nodeID > maxNodeID {
        return nil, ErrInvalidNodeID
    }
    return &SnowflakeGenerator{nodeID: nodeID}, nil
}

func (g *SnowflakeGenerator) Generate(ctx context.Context) (uint64, error) {
    g.mu.Lock()
    defer g.mu.Unlock()

    now := time.Now().UnixMilli() - epoch

    if now == g.lastTime {
        g.sequence = (g.sequence + 1) & maxSequence
        if g.sequence == 0 {
            // Sequence exhausted, wait for next millisecond
            for now <= g.lastTime {
                now = time.Now().UnixMilli() - epoch
            }
        }
    } else {
        g.sequence = 0
    }

    g.lastTime = now

    // ID structure: timestamp (41 bits) | node (10 bits) | sequence (12 bits)
    id := uint64(now)<<(nodeBits+sequenceBits) |
          g.nodeID<<sequenceBits |
          g.sequence

    return id, nil
}

// ========================================
// Strategy 4: Hash-Based (Content-Addressable)
// ========================================

type HashGenerator struct {
    encoder *encoding.Base62Encoder
}

func NewHashGenerator() *HashGenerator {
    return &HashGenerator{encoder: encoding.NewBase62Encoder()}
}

func (g *HashGenerator) GenerateFromURL(url string) string {
    hash := sha256.Sum256([]byte(url))
    // Take first 8 bytes and convert to uint64
    num := binary.BigEndian.Uint64(hash[:8])
    // Encode to base62, use 7 characters
    return g.encoder.EncodeWithPadding(num, 7)
}

func (g *HashGenerator) GenerateWithSalt(url string, salt int) string {
    data := url + strconv.Itoa(salt)
    hash := sha256.Sum256([]byte(data))
    num := binary.BigEndian.Uint64(hash[:8])
    return g.encoder.EncodeWithPadding(num, 7)
}
```

---

### Junior → FAANG: Understanding ID Generation Trade-offs

ID generation for a URL shortener is a topic interviewers probe because it forces you to think about distributed systems primitives: atomicity, coordination, collision probability, and predictability. Most candidates mention "use a counter" or "use a hash" and stop there. The follow-up questions reveal whether you understand why each choice matters.

**Counter-based generation has a coordination problem.** A single global Redis counter (`INCR url:id`) works perfectly on one node. On ten nodes, it is still correct because Redis `INCR` is atomic. The hidden cost is that every write requires a round trip to Redis, and Redis `INCR` throughput tops out around 100K operations per second on a single instance. Range-based allocation (reserve 1000 IDs at once with `INCRBY 1000`, serve them locally) reduces this by three orders of magnitude. Know this optimization and be able to explain its failure mode: if the process crashes after reserving a range but before using all IDs, those IDs are lost. That is acceptable, since they are simply skipped in the sequence, but you must acknowledge it.

**Hash-based generation enables URL deduplication.** If two users submit the same long URL, a counter generator creates two distinct short codes. A hash generator produces the same short code for both, naturally deduplicating. This matters for storage efficiency but requires a collision check: two different long URLs might hash to the same 7-character code with a small probability. The salt-and-retry pattern (try the URL hash, if it exists try `url + "1"`, etc.) handles this correctly.

**Sequential IDs expose business intelligence.** A public shortener that uses sequential IDs lets competitors measure your growth by comparing the highest ID at two points in time. This is not a theoretical concern: it has happened to real companies. Snowflake-style IDs are time-ordered but appear random because the timestamp bits are in the high positions, making enumeration impractical. Know this trade-off and why Bitly explicitly chose non-sequential IDs.

**Base62 encoding is pure math.** Practice encoding and decoding a small number by hand before an interview. Take the number 12345: 12345 mod 62 = 7 (character '7'), 12345 div 62 = 199. 199 mod 62 = 13 (character 'D'). 199 div 62 = 3. 3 mod 62 = 3 (character '3'). Result: '3D7'. Being able to do this manually proves you understand the algorithm rather than having memorized code.

---

### Senior @ FAANG: Correctness Guarantees and Production Failure Modes in ID Generation

At L6/L7, ID generation is evaluated not just for correctness in the happy path but for correctness under every production failure scenario: clock drift, process crashes, Redis partitions, and multi-datacenter deployments.

**Snowflake clock drift is a production correctness bug, not a theoretical one.** The Snowflake generator in this section uses `time.Now().UnixMilli()` and compares it to `lastTime` to detect same-millisecond requests. If the system clock drifts backward (NTP correction, VM live migration, hypervisor time adjustment), `now < lastTime` and the standard implementation panics or enters a busy-wait loop. Twitter's original Snowflake documented this in their failure scenarios and added a `clock_is_backwards` metric. Production-grade implementations should log the backward-clock event, wait for the clock to catch up, and continue rather than panicking (which would cause a pod restart loop in Kubernetes). Document your chosen behavior in the component's runbook.

**Range reservation and crash consistency.** The `RangeGenerator` allocates 1000 IDs by calling `IncrBy(1000)` on Redis, then serves them locally from `current` to `max`. If the process crashes at `current = 500`, IDs 500-999 are abandoned. This means the ID sequence has gaps, which is fine for a URL shortener (short codes are not required to be contiguous). However, if you later want to audit "which IDs were ever generated," gaps complicate the audit. Document this property. A better pattern for auditable systems is to mark ranges as "in use" in a separate Redis key and reclaim unused ranges on startup.

**Cross-datacenter ID uniqueness requires careful node ID management.** The Snowflake node ID field (10 bits = 1024 nodes) must be globally unique across all generator instances in all datacenters. This is typically managed by a coordination service (ZooKeeper, etcd, or a database row with a unique constraint) that assigns node IDs at startup. If the coordination service is unavailable at startup, the generator must not proceed with a default node ID of 0 (which would collide with the primary node). The startup failure mode for node ID allocation must be documented: fail-fast with a clear error message, not silent fallback to a shared ID.

**Content-addressable vs counter-based: a platform governance question.** For a single-tenant shortener, counter-based IDs are simpler and produce shorter codes. For a multi-tenant platform where the same URL might be shortened by different customers, content-addressable hashing enables cross-tenant deduplication, reducing storage and simplifying analytics (all clicks for a given destination URL map to the same short code). The decision between these approaches has downstream consequences for the analytics schema, billing model (per-unique-URL vs per-click), and storage optimization. At L7, you would write an ADR for this choice, documenting the business requirements that drove it and the architectural consequences, so that future teams understand why the system works the way it does.
