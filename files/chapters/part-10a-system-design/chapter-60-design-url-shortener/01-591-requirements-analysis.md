## 60.1 Requirements Analysis

### Functional Requirements

1. **URL Shortening**: Given a long URL, generate a unique short URL
2. **URL Redirection**: Redirect short URL to original long URL
3. **Custom Aliases**: Allow users to create custom short URLs (optional)
4. **Expiration**: URLs can have optional expiration dates
5. **Analytics**: Track click counts and basic analytics

### Non-Functional Requirements

1. **High Availability**: 99.9% uptime
2. **Low Latency**: < 100ms for redirection
3. **Scalability**: Handle 100M URLs, 10K writes/sec, 100K reads/sec
4. **Durability**: URLs should never be lost

### Capacity Estimation

Before choosing a storage engine or sharding strategy, you need hard numbers: how many writes per second the system must sustain, how much disk the URL records will consume over the retention period, and how large a cache is needed to absorb the dominant read traffic. The calculation below models 100 million new URLs per month with a 100:1 read-to-write ratio, the results show that a 7-character Base62 key provides 3.5 trillion unique addresses (enough for centuries of growth) and that caching just 20% of URLs under the 80/20 access distribution fits comfortably in memory.

```go
// capacity/estimation.go
package main

import "fmt"

// Estimation calculates system capacity requirements
type Estimation struct {
    // Traffic
    WritesPerMonth int64
    ReadWriteRatio int64

    // Storage
    URLLength      int // Average URL length
    MetadataSize   int // Additional metadata per URL
    RetentionYears int
}

func (e *Estimation) Calculate() {
    // Traffic calculations
    writesPerSecond := e.WritesPerMonth / (30 * 24 * 3600)
    readsPerSecond := writesPerSecond * e.ReadWriteRatio

    fmt.Printf("Writes/second: %d\n", writesPerSecond)
    fmt.Printf("Reads/second: %d\n", readsPerSecond)

    // Storage calculations
    urlsPerYear := e.WritesPerMonth * 12
    totalURLs := urlsPerYear * int64(e.RetentionYears)
    storagePerURL := e.URLLength + e.MetadataSize + 7 // 7 bytes for short URL
    totalStorageGB := (totalURLs * int64(storagePerURL)) / (1024 * 1024 * 1024)

    fmt.Printf("Total URLs (5 years): %d\n", totalURLs)
    fmt.Printf("Storage required: %d GB\n", totalStorageGB)

    // Short URL length calculation
    // Base62: 62^n >= total URLs
    // n=7: 62^7 = 3.5 trillion URLs
    fmt.Printf("Short URL length: 7 characters (3.5T unique URLs)\n")

    // Cache estimation (80/20 rule - cache 20% of URLs for 80% of traffic)
    cacheEntries := totalURLs / 5
    cacheSize := (cacheEntries * int64(e.URLLength+7)) / (1024 * 1024 * 1024)
    fmt.Printf("Cache size (20%% of URLs): %d GB\n", cacheSize)
}

func main() {
    est := Estimation{
        WritesPerMonth: 100_000_000, // 100M new URLs/month
        ReadWriteRatio: 100,          // 100 reads per write
        URLLength:      200,          // Average URL length
        MetadataSize:   100,          // Metadata (timestamps, user, etc.)
        RetentionYears: 5,
    }

    est.Calculate()
}
```

---

### Junior → FAANG: Requirements Analysis as a Structured Skill

Requirements gathering is the first thing an interviewer evaluates, and most junior candidates either skip it or treat it as a formality. The goal of requirements analysis in a system design interview is not to collect a complete spec. It is to demonstrate that you think in terms of constraints before jumping to solutions.

**Learn to distinguish functional from non-functional requirements.** Functional requirements describe what the system does: shorten a URL, redirect a short code, expire a link. Non-functional requirements describe how well it does it: 99.9% uptime, sub-100ms redirect latency, horizontal scalability to 100K reads per second. Interviewers notice when candidates conflate these because it signals that they have not internalized the difference between correctness and performance properties.

**Capacity estimation must be driven by the requirements, not made up.** The calculation in this section is the correct pattern: start from a monthly write rate, derive per-second throughput, then compute storage and cache requirements. Practice deriving the Base62 key length on the spot: 62^6 = 56 billion (probably enough), 62^7 = 3.5 trillion (definitely enough), and the 7-character choice is justified by the five-year retention requirement at 100M URLs per month. Being able to derive this without memorizing it is what FAANG interviewers reward.

**Ask about the analytics requirement early.** Analytics changes the architecture significantly. If click tracking is required, you need an asynchronous write path (channel, Kafka, or similar) on the redirect endpoint. If you learn about analytics late, you may have already committed to a design where the redirect path is synchronous. This is a common junior mistake.

**Entry-point interview framing.** When an interviewer says "design a URL shortener," spend the first three to five minutes on requirements. A simple checklist: expected read and write volume, retention period, whether custom aliases are needed, whether analytics is required, whether multi-tenancy (per-user URLs) is in scope, and what the expected latency SLA is. This structured opening signals seniority regardless of experience level.

---

### Senior @ FAANG: Governance, SLO Definition, and Capacity Planning as an Ongoing Practice

At L6/L7, requirements analysis is not a one-time activity at the start of a design. It is a living contract between the service and its consumers, maintained through SLO documentation, capacity reviews, and deprecation processes.

**SLO definition requires explicit error budget reasoning.** The 99.9% uptime requirement translates to 8.7 hours of allowable downtime per year, or 43.8 minutes per month. For a redirect service at FAANG scale, this is the aggregate budget across all failure modes: database unavailability, cache eviction cascades, deployment incidents, and dependency failures. A senior engineer does not just state "99.9% uptime." They decompose the error budget: how much is allocated to planned maintenance, unplanned Redis failures, downstream database latency spikes, and deployment rollouts. They then map each failure mode to a mitigation strategy (circuit breakers, local cache fallback, blue-green deployment) and verify that the mitigations keep the aggregate downtime within the budget.

**Capacity planning is a continuous operational discipline.** The one-time estimation in this section is correct for an initial design conversation. In production, capacity is reviewed quarterly against actual traffic trends. Key signals: write-path queue depth (is Kafka consumer lag growing?), Redis memory utilization against eviction policy thresholds, database read replica lag under peak load, and p99 redirect latency against the SLA. At L6+, you own the capacity review process for your service, not just the initial estimate.

**Functional requirements evolve and break downstream consumers.** When the shortener adds a new field to its API response (say, a `category` field on the ShortenResponse), consuming teams may depend on the exact serialization. Staff-level engineers establish a versioning policy: additive changes (new optional fields) are non-breaking, field removals and renames require a major version with a deprecation timeline. Document the API surface in an OpenAPI spec or protobuf schema, checked into source control and reviewed as part of the design process, not added as an afterthought after consumers are already integrated.

**Non-functional requirements need measurable acceptance criteria.** "Low latency" is not a requirement. "p99 redirect latency below 50ms as measured at the load balancer, under a sustained load of 100K requests per second, excluding CDN-served requests" is a requirement. The distinction matters because it specifies the measurement point, the percentile, the load condition, and the scope. Without this specificity, you cannot write a meaningful load test, cannot define an alerting threshold, and cannot argue definitively whether a change regressed the service. Establishing measurable acceptance criteria is one of the clearest L6 signals in a design review.
