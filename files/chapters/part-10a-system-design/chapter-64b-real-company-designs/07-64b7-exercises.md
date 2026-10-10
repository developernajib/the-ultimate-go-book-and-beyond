## Exercises with Complete Solutions

### Exercise 1: Design a Simple News Feed System

Build a basic news feed with post creation and feed retrieval. This exercise reinforces the fan-out architecture pattern by implementing the core write path (post creation → fan-out to follower feeds) and read path (feed retrieval from cache or storage) in a simplified but structurally realistic way. The solution demonstrates how to handle the trade-off between write amplification and read latency that defines every social feed system's architecture.

**Solution:**

```go
package newsfeed

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "sort"
    "sync"
    "time"
)

func generateID() string {
    b := make([]byte, 16)
    _, _ = rand.Read(b)
    return hex.EncodeToString(b)
}

type Post struct {
    ID        string
    UserID    string
    Content   string
    CreatedAt time.Time
    Likes     int
}

type NewsFeedService struct {
    posts       map[string]*Post
    userPosts   map[string][]string // userID -> postIDs
    following   map[string][]string // userID -> followingIDs
    feeds       map[string][]*Post  // userID -> cached feed
    mu          sync.RWMutex
}

func NewNewsFeedService() *NewsFeedService {
    return &NewsFeedService{
        posts:     make(map[string]*Post),
        userPosts: make(map[string][]string),
        following: make(map[string][]string),
        feeds:     make(map[string][]*Post),
    }
}

func (s *NewsFeedService) CreatePost(ctx context.Context, userID, content string) (*Post, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    post := &Post{
        ID:        generateID(),
        UserID:    userID,
        Content:   content,
        CreatedAt: time.Now(),
    }

    s.posts[post.ID] = post
    s.userPosts[userID] = append(s.userPosts[userID], post.ID)

    // Fan-out to followers
    s.fanOutPost(post)

    return post, nil
}

func (s *NewsFeedService) fanOutPost(post *Post) {
    // Get users who follow the post author
    for userID, followings := range s.following {
        for _, followingID := range followings {
            if followingID == post.UserID {
                s.feeds[userID] = append(s.feeds[userID], post)
                // Keep feed sorted by time
                sort.Slice(s.feeds[userID], func(i, j int) bool {
                    return s.feeds[userID][i].CreatedAt.After(s.feeds[userID][j].CreatedAt)
                })
                // Trim to 100 posts
                if len(s.feeds[userID]) > 100 {
                    s.feeds[userID] = s.feeds[userID][:100]
                }
            }
        }
    }
}

func (s *NewsFeedService) GetFeed(ctx context.Context, userID string, limit int) ([]*Post, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    feed := s.feeds[userID]
    if len(feed) == 0 {
        // Generate feed on-demand if not cached
        feed = s.generateFeed(userID)
    }

    if limit > len(feed) {
        limit = len(feed)
    }

    return feed[:limit], nil
}

func (s *NewsFeedService) generateFeed(userID string) []*Post {
    var feed []*Post

    // Get posts from followed users
    for _, followingID := range s.following[userID] {
        for _, postID := range s.userPosts[followingID] {
            if post, exists := s.posts[postID]; exists {
                feed = append(feed, post)
            }
        }
    }

    // Sort by time
    sort.Slice(feed, func(i, j int) bool {
        return feed[i].CreatedAt.After(feed[j].CreatedAt)
    })

    return feed
}

func (s *NewsFeedService) Follow(ctx context.Context, userID, targetID string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.following[userID] = append(s.following[userID], targetID)

    // Add target's recent posts to user's feed
    for _, postID := range s.userPosts[targetID] {
        if post, exists := s.posts[postID]; exists {
            s.feeds[userID] = append(s.feeds[userID], post)
        }
    }

    return nil
}

func (s *NewsFeedService) LikePost(ctx context.Context, postID string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if post, exists := s.posts[postID]; exists {
        post.Likes++
    }

    return nil
}
```

### Exercise 2: Build a Simple Ride Matching System

Implement a driver-rider matching service that maintains a set of registered drivers with live locations, filters by availability and distance, and selects the best match using a combined distance-and-rating score. This exercise focuses on the core matching logic without the complexity of S2 cell indexing, a linear scan over all drivers is acceptable at this scale.

**Solution:**

```go
package ridematching

import (
    "context"
    "errors"
    "math"
    "sort"
    "sync"
)

type Location struct {
    Lat float64
    Lng float64
}

type Driver struct {
    ID       string
    Name     string
    Location Location
    Status   string // available, busy
    Rating   float64
}

type Rider struct {
    ID       string
    Name     string
    Location Location
}

type RideRequest struct {
    RiderID  string
    Pickup   Location
    Dropoff  Location
}

type Match struct {
    Driver   *Driver
    ETA      float64 // minutes
    Distance float64 // km
}

type RideMatchingService struct {
    drivers map[string]*Driver
    mu      sync.RWMutex
}

func NewRideMatchingService() *RideMatchingService {
    return &RideMatchingService{
        drivers: make(map[string]*Driver),
    }
}

func (s *RideMatchingService) RegisterDriver(ctx context.Context, driver *Driver) error {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.drivers[driver.ID] = driver
    return nil
}

func (s *RideMatchingService) UpdateDriverLocation(ctx context.Context, driverID string, loc Location) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if driver, exists := s.drivers[driverID]; exists {
        driver.Location = loc
    }

    return nil
}

func (s *RideMatchingService) SetDriverStatus(ctx context.Context, driverID, status string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if driver, exists := s.drivers[driverID]; exists {
        driver.Status = status
    }

    return nil
}

func (s *RideMatchingService) FindMatch(ctx context.Context, req *RideRequest) (*Match, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    // Find available drivers within radius
    maxDistance := 5.0 // km
    var candidates []struct {
        driver   *Driver
        distance float64
    }

    for _, driver := range s.drivers {
        if driver.Status != "available" {
            continue
        }

        distance := haversineDistance(driver.Location, req.Pickup)
        if distance <= maxDistance {
            candidates = append(candidates, struct {
                driver   *Driver
                distance float64
            }{driver, distance})
        }
    }

    if len(candidates) == 0 {
        return nil, ErrNoDriversAvailable
    }

    // Sort by score (distance + rating)
    sort.Slice(candidates, func(i, j int) bool {
        scoreI := candidates[i].distance - candidates[i].driver.Rating
        scoreJ := candidates[j].distance - candidates[j].driver.Rating
        return scoreI < scoreJ
    })

    best := candidates[0]
    return &Match{
        Driver:   best.driver,
        Distance: best.distance,
        ETA:      best.distance * 2, // Rough estimate: 30 km/h average
    }, nil
}

// Haversine formula for distance between two points
func haversineDistance(from, to Location) float64 {
    const earthRadius = 6371 // km

    lat1 := from.Lat * math.Pi / 180
    lat2 := to.Lat * math.Pi / 180
    dLat := (to.Lat - from.Lat) * math.Pi / 180
    dLng := (to.Lng - from.Lng) * math.Pi / 180

    a := math.Sin(dLat/2)*math.Sin(dLat/2) +
        math.Cos(lat1)*math.Cos(lat2)*
            math.Sin(dLng/2)*math.Sin(dLng/2)

    c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))

    return earthRadius * c
}

var ErrNoDriversAvailable = errors.New("no drivers available")
```

---

### Junior -> FAANG: Turning Exercise Solutions Into Interview Preparation

Exercise 1 (news feed) is the canonical fan-out exercise. Before running the solution, implement it yourself and then answer: "What is the worst-case latency for GetFeed?" (it is O(n) in the number of followed users if the feed cache is empty). "What happens if two CreatePost calls arrive simultaneously for users who follow each other?" (the solution has a lock, so they serialize, but at high concurrency this becomes the bottleneck). These are the follow-up questions you will face in an interview.

Exercise 2 (ride matching) is intentionally simplified: it uses a linear scan over all drivers. The interview follow-up is "How do you scale this to 1 million active drivers?" The answer is the S2 cell index described in the Uber section. Practice describing the transition from the linear scan to the cell index without looking at the Uber code, then verify your description against it.

The `haversineDistance` formula appears in both exercises. Memorize the formula structure (it is three lines of trigonometry), not the exact coefficients. If an interviewer asks you to implement it on a whiteboard, the point is not the formula, it is that you know to use great-circle distance rather than Euclidean distance for geographic coordinates.

### Senior @ FAANG: Production Gaps in Each Exercise Solution

The news feed solution uses a global mutex (`sync.RWMutex`) for all operations. At 10,000 posts per second across 1 million users, this mutex is the single bottleneck: all reads and writes serialize through it. The production fix is to shard the feed cache by user ID (16 shards, each with its own mutex) and shard the follow graph by user ID. This reduces lock contention by 16x with no change to correctness. Document the sharding strategy as an ADR: the shard count must be chosen before launch because resharding an in-memory structure requires stopping the world or using a consistent-hashing ring that supports virtual nodes.

The ride matching solution's `FindMatch` uses the haversine distance formula on every driver in the candidate set. This is correct but ignores road-network reachability. A driver who is 0.5 km away as the crow flies but separated by a highway, a river, or a one-way street system may have an actual ETA of 15 minutes. For an exercise, haversine is fine. For a production matching system, the final ETA calculation must use a road-network routing engine (OSRM, Valhalla, or Google Maps Platform Routes API) for the top N candidates selected by haversine, trading the cost of N routing calls for a more accurate match.

Both exercises lack observability: no latency metrics, no error rates, no dependency health checks. The production version of each service exports at minimum: `feed_assembly_latency_ms` (histogram), `match_latency_ms` (histogram), `fanout_messages_per_second` (counter), and `active_driver_count` (gauge). These four metrics together tell the operator whether the service is performing correctly and at what scale it is currently operating.