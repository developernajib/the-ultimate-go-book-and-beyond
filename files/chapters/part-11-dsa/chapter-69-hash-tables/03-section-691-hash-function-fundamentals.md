## 69.1 Hash Function Fundamentals

### Properties of Good Hash Functions

A hash function maps arbitrary keys to a bounded integer index, and its quality directly determines hash table performance. The polynomial rolling hash multiplies each character by a prime base to create positional sensitivity, while FNV-1a uses XOR-fold operations to achieve strong avalanche behavior with minimal computation.

```go
package hashtable

import (
    "hash/fnv"
)

// A good hash function should have:
// 1. Deterministic: same input always produces same output
// 2. Uniform distribution: spreads values evenly across buckets
// 3. Fast computation: O(1) or O(k) where k is key length
// 4. Avalanche effect: small input change causes large output change

// SimpleHash demonstrates a basic string hash function
func SimpleHash(key string) uint64 {
    var hash uint64 = 0
    for _, ch := range key {
        hash = hash*31 + uint64(ch) // polynomial rolling hash
    }
    return hash
}

// DJB2Hash is a classic string hash function
func DJB2Hash(key string) uint64 {
    var hash uint64 = 5381
    for _, ch := range key {
        hash = ((hash << 5) + hash) + uint64(ch) // hash * 33 + ch
    }
    return hash
}

// FNVHash uses Go's built-in FNV-1a hash
func FNVHash(key string) uint64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    return h.Sum64()
}

// IntHash for integer keys
func IntHash(key int) uint64 {
    // Multiplicative hashing using golden ratio
    const goldenRatio = 0x9e3779b97f4a7c15
    return uint64(key) * goldenRatio
}

// CombineHash combines multiple hash values
func CombineHash(h1, h2 uint64) uint64 {
    return h1 ^ (h2 + 0x9e3779b97f4a7c15 + (h1 << 6) + (h1 >> 2))
}
```

### Hash Collision Analysis

Collision analysis measures how uniformly a hash function distributes keys across buckets by tracking the minimum, maximum, and empty-bucket counts after hashing a sample dataset. A well-distributed function keeps the max bucket size close to the average, ensuring O(1) average-case lookup even under heavy load.

```go
package hashtable

import (
    "fmt"
    "math/rand/v2"
)

// AnalyzeCollisions tests hash function distribution
func AnalyzeCollisions(hashFunc func(string) uint64, keys []string, buckets int) {
    distribution := make([]int, buckets)

    for _, key := range keys {
        bucket := int(hashFunc(key) % uint64(buckets))
        distribution[bucket]++
    }

    // Calculate statistics
    minCount, maxCount := distribution[0], distribution[0]
    totalCollisions := 0

    for _, count := range distribution {
        if count < minCount {
            minCount = count
        }
        if count > maxCount {
            maxCount = count
        }
        if count > 1 {
            totalCollisions += count - 1
        }
    }

    emptyBuckets := 0
    for _, count := range distribution {
        if count == 0 {
            emptyBuckets++
        }
    }

    fmt.Printf("Keys: %d, Buckets: %d\n", len(keys), buckets)
    fmt.Printf("Min bucket size: %d, Max bucket size: %d\n", minCount, maxCount)
    fmt.Printf("Empty buckets: %d (%.1f%%)\n", emptyBuckets, float64(emptyBuckets)*100/float64(buckets))
    fmt.Printf("Total collisions: %d\n", totalCollisions)
}

// GenerateRandomStrings creates test data
func GenerateRandomStrings(n, length int) []string {
    result := make([]string, n)
    for i := 0; i < n; i++ {
        b := make([]byte, length)
        for j := 0; j < length; j++ {
            b[j] = byte('a' + rand.IntN(26))
        }
        result[i] = string(b)
    }
    return result
}
```

### Junior -> FAANG: Understanding Why Hash Functions Matter for Interviews

You will not be asked to implement FNV-1a from scratch in most FAANG interviews, but you will be asked to explain why hash functions must distribute keys uniformly. The key interview talking point: a poor hash function that maps many keys to the same bucket degrades O(1) average lookups to O(n) worst-case lookups. When interviewers ask "what is the worst case for a hash map?", the correct answer is "O(n), when all keys collide into a single bucket, reducing the structure to a linear scan of a linked list."

A secondary talking point: the `CombineHash` function using XOR and golden-ratio mixing is the standard way to create composite keys from multiple fields. This pattern appears in interview problems where you need a map keyed by a pair of values, for example tracking (row, col) coordinates in a grid problem. Knowing to use `h1 ^ (h2 + constant + shifts)` rather than `h1 + h2` (which has poor distribution) distinguishes candidates who understand hashing from those who only use it.

### Senior @ FAANG: Hash Function Selection as a Security and Performance Decision

At the staff level, hash function selection is an architectural decision with security consequences. The three hash functions shown (polynomial rolling, DJB2, FNV-1a) are all non-cryptographic: they are fast but not resistant to length-extension or preimage attacks. Never use them for security-sensitive purposes like HMAC-signed tokens, checksums that must detect tampering, or any context where an adversary controls the input and can observe output.

Go's runtime map seeds its hash function with a fresh random value per map instance, not merely once per process, and it reseeds a map that shows signs of adversarial collision pressure. This makes the effective hash function unpredictable to external attackers, providing practical resistance to hash-flooding DOS without the cost of a cryptographic hash. For your own data structures, `hash/maphash` exposes the same seeded-hash primitive: create one `maphash.Seed` with `maphash.MakeSeed()` and hash with `maphash.String` or `maphash.Bytes`. Do not hardcode a seed, because a fixed seed hands the attacker back exactly the predictability the randomization exists to remove.

The `AnalyzeCollisions` function is an example of a load-distribution test that should exist in any performance-critical hash table deployment. For a service handling 100K requests per second through a hash-based router, a biased hash function that sends 30% of traffic to one bucket is an incident waiting to happen. Measuring min/max/empty bucket statistics under realistic key distributions should be part of the pre-production checklist for any novel hash-based component, not just the initial design phase.
