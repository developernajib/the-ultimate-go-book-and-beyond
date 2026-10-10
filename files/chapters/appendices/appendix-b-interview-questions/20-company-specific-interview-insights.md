## Company-Specific Interview Insights

### Google Interview Process for Go Positions

**What Google Looks For:**

```go
// Google emphasizes: Scalability, code clarity, and thorough testing
// Example question: Design a concurrent URL validator

package validator

import (
    "context"
    "net/http"
    "net/url"
    "sync"
    "time"
)

// URLValidator validates URLs concurrently with rate limiting
type URLValidator struct {
    client      *http.Client
    maxWorkers  int
    rateLimit   time.Duration
    timeout     time.Duration
}

type ValidationResult struct {
    URL       string
    Valid     bool
    Status    int
    Latency   time.Duration
    Error     error
}

// ValidateURLs validates multiple URLs with controlled concurrency
// Google interviews focus on: proper context usage, graceful handling
func (v *URLValidator) ValidateURLs(ctx context.Context, urls []string) []ValidationResult {
    results := make([]ValidationResult, len(urls))
    jobs := make(chan int, len(urls))

    var wg sync.WaitGroup

    // Worker pool - Google likes to see bounded concurrency
    for i := 0; i < v.maxWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()

            ticker := time.NewTicker(v.rateLimit)
            defer ticker.Stop()

            for idx := range jobs {
                select {
                case <-ctx.Done():
                    results[idx] = ValidationResult{
                        URL:   urls[idx],
                        Error: ctx.Err(),
                    }
                    continue
                case <-ticker.C:
                }

                results[idx] = v.validateSingle(ctx, urls[idx])
            }
        }()
    }

    // Send jobs
    for i := range urls {
        jobs <- i
    }
    close(jobs)

    wg.Wait()
    return results
}

func (v *URLValidator) validateSingle(ctx context.Context, urlStr string) ValidationResult {
    start := time.Now()
    result := ValidationResult{URL: urlStr}

    // Validate URL format first
    if _, err := url.Parse(urlStr); err != nil {
        result.Error = err
        return result
    }

    ctx, cancel := context.WithTimeout(ctx, v.timeout)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "HEAD", urlStr, nil)
    if err != nil {
        result.Error = err
        return result
    }

    resp, err := v.client.Do(req)
    if err != nil {
        result.Error = err
        return result
    }
    defer resp.Body.Close()

    result.Status = resp.StatusCode
    result.Valid = resp.StatusCode >= 200 && resp.StatusCode < 400
    result.Latency = time.Since(start)

    return result
}
```

**Google Interview Tips:**
- Always clarify requirements before coding
- Discuss time and space complexity explicitly
- Consider edge cases and error handling
- Write tests as part of your solution

### Meta/Facebook Interview Process

**System Design Focus:**

```go
// Meta emphasizes: Large-scale distributed systems, data modeling
// Common question: Design a News Feed ranking system

package newsfeed

import (
    "context"
    "sort"
    "time"
)

// Post represents a social media post
type Post struct {
    ID           string
    AuthorID     string
    Content      string
    CreatedAt    time.Time
    Engagements  Engagements
    MediaType    MediaType
}

type Engagements struct {
    Likes    int64
    Comments int64
    Shares   int64
    Views    int64
}

type MediaType int

const (
    MediaText MediaType = iota
    MediaImage
    MediaVideo
    MediaLink
)

// FeedRanker ranks posts for a user's feed
type FeedRanker struct {
    socialGraph  SocialGraphClient
    mlPredictor  MLPredictorClient
    userFeatures UserFeaturesClient
}

type RankedPost struct {
    Post
    Score float64
}

// RankFeed ranks posts for a user (Meta interview typical question)
func (r *FeedRanker) RankFeed(ctx context.Context, userID string, posts []Post) []RankedPost {
    // Fetch user context in parallel - Meta likes to see parallel fetching
    userCtx := r.fetchUserContext(ctx, userID)

    ranked := make([]RankedPost, len(posts))

    for i, post := range posts {
        score := r.calculateScore(userCtx, post)
        ranked[i] = RankedPost{Post: post, Score: score}
    }

    // Sort by score descending
    sort.Slice(ranked, func(i, j int) bool {
        return ranked[i].Score > ranked[j].Score
    })

    return ranked
}

func (r *FeedRanker) calculateScore(userCtx *UserContext, post Post) float64 {
    var score float64

    // Affinity: How close is the author to the user?
    affinity := r.calculateAffinity(userCtx, post.AuthorID)
    score += affinity * 0.3

    // Recency decay
    age := time.Since(post.CreatedAt)
    recency := 1.0 / (1.0 + age.Hours()/24)
    score += recency * 0.2

    // Engagement quality
    engagement := r.calculateEngagement(post.Engagements)
    score += engagement * 0.25

    // Content type preference
    typePreference := userCtx.MediaPreferences[post.MediaType]
    score += typePreference * 0.15

    // ML prediction for user interest
    mlScore := r.mlPredictor.Predict(userCtx, post)
    score += mlScore * 0.1

    return score
}
```

**Meta Interview Tips:**
- Focus on scale: billions of users, millions of QPS
- Discuss data consistency vs availability trade-offs
- Show understanding of caching strategies
- Be ready to discuss experimentation and A/B testing

### Amazon Interview Process (Leadership Principles)

**Amazon's Approach:**

```go
// Amazon combines coding with Leadership Principles
// Example: "Bias for Action" - Build quickly, iterate

package inventory

import (
    "context"
    "sync"
    "time"
)

// InventoryService manages product inventory
// Amazon interview: Show how to handle high-volume, low-latency requirements
type InventoryService struct {
    cache     sync.Map
    db        InventoryDB
    pubsub    PubSub
    lockMgr   DistributedLock
}

type InventoryItem struct {
    SKU          string
    WarehouseID  string
    Quantity     int64
    ReservedQty  int64
    LastUpdated  time.Time
}

// ReserveInventory atomically reserves inventory with optimistic locking
// Amazon focuses on: correctness under concurrency, handling edge cases
func (s *InventoryService) ReserveInventory(ctx context.Context, req ReserveRequest) (*Reservation, error) {
    // Acquire distributed lock - Amazon cares about race conditions
    lockKey := fmt.Sprintf("inv:%s:%s", req.SKU, req.WarehouseID)
    lock, err := s.lockMgr.Acquire(ctx, lockKey, 5*time.Second)
    if err != nil {
        return nil, fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer lock.Release(ctx)

    // Get current inventory
    item, err := s.db.GetInventory(ctx, req.SKU, req.WarehouseID)
    if err != nil {
        return nil, fmt.Errorf("failed to get inventory: %w", err)
    }

    // Check availability
    available := item.Quantity - item.ReservedQty
    if available < req.Quantity {
        return nil, ErrInsufficientInventory{
            Requested: req.Quantity,
            Available: available,
        }
    }

    // Create reservation
    reservation := &Reservation{
        ID:          generateID(),
        SKU:         req.SKU,
        WarehouseID: req.WarehouseID,
        Quantity:    req.Quantity,
        CustomerID:  req.CustomerID,
        ExpiresAt:   time.Now().Add(15 * time.Minute),
        Status:      ReservationPending,
    }

    // Update inventory and create reservation atomically
    err = s.db.WithTransaction(ctx, func(tx Transaction) error {
        if err := tx.IncrementReserved(req.SKU, req.WarehouseID, req.Quantity); err != nil {
            return err
        }
        return tx.CreateReservation(reservation)
    })
    if err != nil {
        return nil, fmt.Errorf("failed to create reservation: %w", err)
    }

    // Invalidate cache
    s.cache.Delete(lockKey)

    // Publish event for downstream systems
    s.pubsub.Publish(ctx, "inventory.reserved", reservation)

    return reservation, nil
}
```

**Amazon Interview Tips:**
- Prepare STAR stories for each Leadership Principle
- "Customer Obsession": Always mention the customer impact
- "Ownership": Discuss end-to-end ownership of features
- "explore": Show ability to go into technical details

### Uber Interview Process

**Real-time Systems Focus:**

```go
// Uber interview emphasizes: Low latency, real-time processing, geospatial
// Example: Driver matching system

package matching

import (
    "context"
    "math"
    "sort"
    "time"
)

// MatchingService matches riders with nearby drivers
type MatchingService struct {
    geoIndex    GeoSpatialIndex
    driverState DriverStateService
    pricing     PricingService
    ml          MLRankingService
}

type MatchRequest struct {
    RiderID     string
    PickupLat   float64
    PickupLng   float64
    DestLat     float64
    DestLng     float64
    RideType    RideType
}

type MatchResult struct {
    DriverID    string
    ETA         time.Duration
    Distance    float64
    Score       float64
    Price       Money
}

// FindBestDrivers finds and ranks available drivers
// Uber cares about: Latency, fairness, efficiency
func (s *MatchingService) FindBestDrivers(ctx context.Context, req MatchRequest) ([]MatchResult, error) {
    // Find nearby drivers within radius (geospatial query)
    nearbyDrivers, err := s.geoIndex.FindNearby(ctx, req.PickupLat, req.PickupLng, 5000) // 5km
    if err != nil {
        return nil, fmt.Errorf("geo query failed: %w", err)
    }

    if len(nearbyDrivers) == 0 {
        return nil, ErrNoDriversAvailable
    }

    // Filter to available drivers only (parallel state check)
    available := s.filterAvailableDrivers(ctx, nearbyDrivers)
    if len(available) == 0 {
        return nil, ErrNoDriversAvailable
    }

    // Calculate ETA and scores for each driver
    results := make([]MatchResult, 0, len(available))

    for _, driver := range available {
        eta := s.calculateETA(driver.Lat, driver.Lng, req.PickupLat, req.PickupLng)

        // Skip if ETA too long
        if eta > 15*time.Minute {
            continue
        }

        distance := haversineDistance(driver.Lat, driver.Lng, req.PickupLat, req.PickupLng)

        // ML-based ranking score
        score := s.ml.PredictAcceptance(ctx, driver.ID, req)

        // Factor in driver rating and acceptance rate
        score *= driver.Rating / 5.0
        score *= driver.AcceptanceRate

        // Fairness: Boost drivers who have waited longer
        waitBoost := math.Min(float64(time.Since(driver.LastRideEnd).Minutes())/10.0, 1.5)
        score *= waitBoost

        results = append(results, MatchResult{
            DriverID: driver.ID,
            ETA:      eta,
            Distance: distance,
            Score:    score,
        })
    }

    // Sort by score descending
    sort.Slice(results, func(i, j int) bool {
        return results[i].Score > results[j].Score
    })

    // Return top 3 candidates
    if len(results) > 3 {
        results = results[:3]
    }

    return results, nil
}

func haversineDistance(lat1, lng1, lat2, lng2 float64) float64 {
    const R = 6371e3 // Earth's radius in meters

    φ1 := lat1 * math.Pi / 180
    φ2 := lat2 * math.Pi / 180
    Δφ := (lat2 - lat1) * math.Pi / 180
    Δλ := (lng2 - lng1) * math.Pi / 180

    a := math.Sin(Δφ/2)*math.Sin(Δφ/2) +
         math.Cos(φ1)*math.Cos(φ2)*math.Sin(Δλ/2)*math.Sin(Δλ/2)
    c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))

    return R * c
}
```

**Uber Interview Tips:**
- Focus on real-time systems with millisecond latency
- Understand geospatial indexing (R-tree, S2, H3)
- Discuss failure handling in mobile/distributed systems
- Be ready to design dispatch, pricing, or ETA systems

### Interview Process Comparison

| Aspect | Google | Meta | Amazon | Uber |
|--------|--------|------|--------|------|
| **Focus** | Algorithms, Scale | Systems, ML | Leadership + Code | Real-time, Geo |
| **Rounds** | 4-5 coding + 1 behavior | 2-3 coding, 2 system design | 4-5 (LP heavy) | 3-4 technical |
| **Go Emphasis** | General CS | Distributed systems | Ownership | Low latency |
| **Key Topics** | Concurrency, Trees | Feed ranking, Caching | Inventory, Payments | Matching, ETA |
| **Expected Level** | Strong algorithms | System thinking | Leadership stories | Domain knowledge |

---
