## Caching Pitfalls

Caching is the primary weapon for achieving sub-millisecond response times in Go services. However, naive cache implementations introduce severe production failure modes: cache stampedes, stale data race conditions, and unbounded memory bloat that can bring down both the caching layer and the underlying primary database.

---

### 1. The Cache Stampede (Thundering Herd)

#### Root Cause Mechanics
When a high-traffic cache key expires (e.g. homepage featured items receiving 20,000 requests per second), all 20,000 concurrent requests miss the cache simultaneously. Every request immediately executes the expensive database query to regenerate the cache entry. This "thundering herd" spikes database CPU to 100%, exhausts connection pools, and can cause a cascading outage across the entire infrastructure.

#### Vulnerable Code
```go
// BUG: Under high concurrency, 10,000 goroutines hit the database when key expires
func GetCatalog(ctx context.Context, key string) (*Catalog, error) {
    if data, ok := cache.Get(key); ok {
        return data, nil
    }

    // Unsynchronized database fetch: Thundering Herd!
    catalog, err := db.FetchCatalog(ctx, key)
    if err != nil {
        return nil, err
    }
    cache.Set(key, catalog, 5*time.Minute)
    return catalog, nil
}
```

#### Production-Grade Solution: `singleflight.Group`
Go's `golang.org/x/sync/singleflight` package suppresses duplicate concurrent function calls. When 10,000 goroutines request the same key, exactly **one** executes the database query, and the other 9,999 wait and share the returned result!

```go
import "golang.org/x/sync/singleflight"

type CatalogService struct {
    db    *Database
    cache *Cache
    sf    singleflight.Group // Coordinates duplicate in-flight requests
}

func (s *CatalogService) GetCatalog(ctx context.Context, key string) (*Catalog, error) {
    // 1. Fast Path: Check in-memory / Redis cache
    if data, ok := s.cache.Get(key); ok {
        return data, nil
    }

    // 2. Coordinated Single-Flight Fetch
    v, err, shared := s.sf.Do(key, func() (any, error) {
        // Double check cache inside singleflight callback
        if data, ok := s.cache.Get(key); ok {
            return data, nil
        }

        catalog, err := s.db.FetchCatalog(ctx, key)
        if err != nil {
            return nil, err
        }
        s.cache.Set(key, catalog, 5*time.Minute)
        return catalog, nil
    })

    if err != nil {
        return nil, err
    }
    return v.(*Catalog), nil
}
```

---

### 2. Probabilistic Early Expiration (XFetch Algorithm)

#### Root Cause Mechanics
Fixed TTLs guarantee that a cache entry will eventually expire, creating brief latency spikes. Using the **XFetch** probabilistic early expiration algorithm, worker goroutines compute the probability of refreshing the cache *before* it expires based on read frequency and computation time:

```go
// Delta: time taken to compute; Beta: aggressiveness parameter; TTL: remaining lifetime
func shouldRefreshEarly(remainingTTL time.Duration, computeDuration time.Duration, beta float64) bool {
    // Probability p = -beta * delta * ln(random())
    // If computed time exceeds remaining TTL, trigger background refresh
    random := rand.Float64()
    if random <= 0 {
        return false
    }
    return float64(computeDuration.Seconds())*beta*(-math.Log(random)) >= remainingTTL.Seconds()
}
```
