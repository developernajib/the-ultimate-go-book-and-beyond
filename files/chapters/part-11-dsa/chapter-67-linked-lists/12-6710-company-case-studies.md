## 67.10 Company Case Studies

### Redis: Skip List Implementation for Sorted Sets

Redis uses skip lists for its sorted sets (ZSET) data structure, providing O(log n) operations:

```go
// Redis-style sorted set using skip list
// Used for leaderboards, rate limiting, and ordered data
package redis

import (
    "math/rand/v2"
    "sync"
)

const (
    maxLevel    = 32
    probability = 0.25  // Redis uses 0.25 for better space efficiency
)

// ZSetNode represents an element in the sorted set
type ZSetNode struct {
    member  string
    score   float64
    forward []*ZSetNode
    span    []int      // Distance to next node at each level
    prev    *ZSetNode  // Backward pointer for range queries
}

// ZSet implements Redis-style sorted set
type ZSet struct {
    head   *ZSetNode
    tail   *ZSetNode
    level  int
    length int

    dict map[string]*ZSetNode  // O(1) member lookup

    mu sync.RWMutex
}

// NewZSet creates a new sorted set
func NewZSet() *ZSet {
    head := &ZSetNode{
        forward: make([]*ZSetNode, maxLevel),
        span:    make([]int, maxLevel),
    }
    return &ZSet{
        head:  head,
        level: 1,
        dict:  make(map[string]*ZSetNode),
    }
}

// randomLevel generates random level with Redis probability
func (z *ZSet) randomLevel() int {
    level := 1
    for level < maxLevel && rand.Float64() < probability {
        level++
    }
    return level
}

// ZAdd adds a member, or moves an existing member to a new score.
// Time: O(log n)
//
// A score update is a delete followed by an insert, and the delete must be
// located using the member's OLD score. This is the subtle part: the search
// path for the new score does not pass through the node's current position,
// so reusing it would unlink the wrong node and corrupt the spans. Redis
// splits this the same way, in zslUpdateScore.
func (z *ZSet) ZAdd(member string, score float64) bool {
    z.mu.Lock()
    defer z.mu.Unlock()

    if existing, found := z.dict[member]; found {
        if existing.score == score {
            return false // already at this score, nothing to move
        }
        z.deleteByScore(existing.member, existing.score)
    }

    z.insertNode(member, score)
    return true
}

// deleteByScore unlinks the node identified by (member, score).
// The (score, member) pair is what orders the list, so both are needed to
// find the node's own search path.
// Time: O(log n)
func (z *ZSet) deleteByScore(member string, score float64) bool {
    update := make([]*ZSetNode, maxLevel)

    x := z.head
    for i := z.level - 1; i >= 0; i-- {
        for x.forward[i] != nil &&
            (x.forward[i].score < score ||
                (x.forward[i].score == score && x.forward[i].member < member)) {
            x = x.forward[i]
        }
        update[i] = x
    }

    target := x.forward[0]
    if target == nil || target.score != score || target.member != member {
        return false
    }

    z.deleteNode(target, update)
    return true
}

// insertNode inserts a new node
func (z *ZSet) insertNode(member string, score float64) bool {
    update := make([]*ZSetNode, maxLevel)
    rank := make([]int, maxLevel)

    x := z.head
    for i := z.level - 1; i >= 0; i-- {
        if i == z.level-1 {
            rank[i] = 0
        } else {
            rank[i] = rank[i+1]
        }

        for x.forward[i] != nil &&
            (x.forward[i].score < score ||
                (x.forward[i].score == score && x.forward[i].member < member)) {
            rank[i] += x.span[i]
            x = x.forward[i]
        }
        update[i] = x
    }

    level := z.randomLevel()
    if level > z.level {
        for i := z.level; i < level; i++ {
            rank[i] = 0
            update[i] = z.head
            update[i].span[i] = z.length
        }
        z.level = level
    }

    // Create new node
    newNode := &ZSetNode{
        member:  member,
        score:   score,
        forward: make([]*ZSetNode, level),
        span:    make([]int, level),
    }

    // Insert node
    for i := 0; i < level; i++ {
        newNode.forward[i] = update[i].forward[i]
        update[i].forward[i] = newNode
        newNode.span[i] = update[i].span[i] - (rank[0] - rank[i])
        update[i].span[i] = rank[0] - rank[i] + 1
    }

    // Update span for higher levels
    for i := level; i < z.level; i++ {
        update[i].span[i]++
    }

    // Set backward pointer
    if update[0] == z.head {
        newNode.prev = nil
    } else {
        newNode.prev = update[0]
    }

    if newNode.forward[0] != nil {
        newNode.forward[0].prev = newNode
    } else {
        z.tail = newNode
    }

    z.length++
    z.dict[member] = newNode
    return true
}

// ZScore returns the score of a member
// Time: O(1) with dict lookup
func (z *ZSet) ZScore(member string) (float64, bool) {
    z.mu.RLock()
    defer z.mu.RUnlock()

    if node, found := z.dict[member]; found {
        return node.score, true
    }
    return 0, false
}

// ZRank returns the rank (0-indexed) of a member
// Time: O(log n)
//
// The traversal must be driven by the (score, member) ordering, exactly as
// in ZAdd. A tempting shortcut walks each level "while forward != node",
// but the node is not present on the upper levels unless its random height
// reaches them, so that loop runs to the end of the level, sails past the
// target, and can never recover on the way down. Compare keys, not pointers.
func (z *ZSet) ZRank(member string) (int, bool) {
    z.mu.RLock()
    defer z.mu.RUnlock()

    node, found := z.dict[member]
    if !found {
        return 0, false
    }
    score := node.score

    rank := 0
    x := z.head
    for i := z.level - 1; i >= 0; i-- {
        // <= on member so we step ONTO the target rather than stopping
        // just before it, which is what lets the check below fire.
        for x.forward[i] != nil &&
            (x.forward[i].score < score ||
                (x.forward[i].score == score && x.forward[i].member <= member)) {
            rank += x.span[i]
            x = x.forward[i]
        }

        // head has no member, so exclude it before comparing.
        if x != z.head && x.member == member {
            return rank - 1, true // spans count from head, so subtract it
        }
    }

    return 0, false
}

// ZRangeByScore returns members with scores in range
// Time: O(log n + m) where m is result count
func (z *ZSet) ZRangeByScore(min, max float64, offset, count int) []string {
    z.mu.RLock()
    defer z.mu.RUnlock()

    var result []string

    // Find first node >= min
    x := z.head
    for i := z.level - 1; i >= 0; i-- {
        for x.forward[i] != nil && x.forward[i].score < min {
            x = x.forward[i]
        }
    }
    x = x.forward[0]

    // Skip offset
    for x != nil && offset > 0 {
        if x.score > max {
            break
        }
        offset--
        x = x.forward[0]
    }

    // Collect results
    for x != nil && x.score <= max && (count < 0 || len(result) < count) {
        result = append(result, x.member)
        x = x.forward[0]
    }

    return result
}

// deleteNode unlinks node given the search path that leads to it.
// Time: O(level)
//
// Span accounting is the whole job here. At levels where update[i] pointed
// at the node, the surviving pointer must now cover the node's own span as
// well, minus the node itself. At levels that merely flew over the node,
// exactly one element left the range, so the span drops by one.
func (z *ZSet) deleteNode(node *ZSetNode, update []*ZSetNode) {
    for i := 0; i < z.level; i++ {
        if update[i].forward[i] == node {
            update[i].span[i] += node.span[i] - 1
            update[i].forward[i] = node.forward[i]
        } else {
            update[i].span[i]--
        }
    }

    // Maintain the backward pointer and the tail.
    if node.forward[0] != nil {
        node.forward[0].prev = node.prev
    } else {
        z.tail = node.prev
    }

    // Drop levels that are now empty so searches do not scan dead levels.
    for z.level > 1 && z.head.forward[z.level-1] == nil {
        z.level--
    }

    z.length--
    delete(z.dict, node.member)
}
```

### Ride-Hailing: LRU Cache for Driver Location

An LRU cache, the classic linked-list-plus-hash-map structure, is a natural fit for hot driver-location lookups in a ride-hailing backend. The design below is a worked illustration of the pattern rather than a description of any particular company's internals:

```go
// Location cache with LRU eviction.
// Caches driver locations for fast matching.
package rideshare

import (
    "sync"
    "time"
)

// DriverLocation stores driver position data
type DriverLocation struct {
    DriverID  string
    Latitude  float64
    Longitude float64
    Timestamp time.Time
    Status    string  // "available", "busy", "offline"
}

// LocationNode for doubly linked list
type LocationNode struct {
    location *DriverLocation
    prev     *LocationNode
    next     *LocationNode
}

// DriverLocationCache implements LRU cache for driver locations
type DriverLocationCache struct {
    capacity int
    cache    map[string]*LocationNode
    head     *LocationNode  // Most recently used
    tail     *LocationNode  // Least recently used

    // Geospatial index for nearby lookups
    geoIndex *GeoHashIndex

    mu sync.RWMutex

    // Metrics
    hits   int64
    misses int64
}

// NewDriverLocationCache creates a new cache
func NewDriverLocationCache(capacity int) *DriverLocationCache {
    head := &LocationNode{}
    tail := &LocationNode{}
    head.next = tail
    tail.prev = head

    return &DriverLocationCache{
        capacity: capacity,
        cache:    make(map[string]*LocationNode),
        head:     head,
        tail:     tail,
        geoIndex: NewGeoHashIndex(),
    }
}

// Update adds or updates a driver's location
// Time: O(1) for cache, O(log n) for geo index
func (c *DriverLocationCache) Update(loc *DriverLocation) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if node, exists := c.cache[loc.DriverID]; exists {
        // Update existing entry
        oldLoc := node.location
        node.location = loc
        c.moveToHead(node)

        // Update geo index
        c.geoIndex.Update(oldLoc, loc)
    } else {
        // Add new entry
        node := &LocationNode{location: loc}
        c.cache[loc.DriverID] = node
        c.addToHead(node)

        // Add to geo index
        c.geoIndex.Add(loc)

        // Evict if over capacity
        if len(c.cache) > c.capacity {
            evicted := c.removeTail()
            delete(c.cache, evicted.location.DriverID)
            c.geoIndex.Remove(evicted.location)
        }
    }
}

// Get retrieves a driver's location
// Time: O(1)
func (c *DriverLocationCache) Get(driverID string) (*DriverLocation, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if node, exists := c.cache[driverID]; exists {
        c.hits++
        c.moveToHead(node)
        return node.location, true
    }

    c.misses++
    return nil, false
}

// GetNearby returns drivers near a location
// Time: O(log n + k) where k is nearby drivers
func (c *DriverLocationCache) GetNearby(lat, lng float64, radiusKm float64, limit int) []*DriverLocation {
    c.mu.RLock()
    defer c.mu.RUnlock()

    candidates := c.geoIndex.SearchRadius(lat, lng, radiusKm)

    // Filter available drivers and limit
    var result []*DriverLocation
    for _, loc := range candidates {
        if loc.Status == "available" {
            result = append(result, loc)
            if len(result) >= limit {
                break
            }
        }
    }

    return result
}

// EvictStale removes drivers with old timestamps
func (c *DriverLocationCache) EvictStale(maxAge time.Duration) int {
    c.mu.Lock()
    defer c.mu.Unlock()

    cutoff := time.Now().Add(-maxAge)
    evicted := 0

    // Start from tail (LRU)
    node := c.tail.prev
    for node != c.head {
        prev := node.prev
        if node.location.Timestamp.Before(cutoff) {
            c.removeNode(node)
            delete(c.cache, node.location.DriverID)
            c.geoIndex.Remove(node.location)
            evicted++
        }
        node = prev
    }

    return evicted
}

// Helper methods
func (c *DriverLocationCache) addToHead(node *LocationNode) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

func (c *DriverLocationCache) removeNode(node *LocationNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (c *DriverLocationCache) moveToHead(node *LocationNode) {
    c.removeNode(node)
    c.addToHead(node)
}

func (c *DriverLocationCache) removeTail() *LocationNode {
    node := c.tail.prev
    c.removeNode(node)
    return node
}

// GeoHashIndex is a placeholder for geospatial indexing
type GeoHashIndex struct {
    // Implementation would use S2 cells or geohash
}

func NewGeoHashIndex() *GeoHashIndex {
    return &GeoHashIndex{}
}

func (g *GeoHashIndex) Add(loc *DriverLocation)                         {}
func (g *GeoHashIndex) Remove(loc *DriverLocation)                      {}
func (g *GeoHashIndex) Update(old, new *DriverLocation)                 {}
func (g *GeoHashIndex) SearchRadius(lat, lng, km float64) []*DriverLocation {
    return nil
}
```

### Social Feed: Activity Feed Implementation

An activity feed with fast insertion at the head and eviction at the tail maps naturally onto a doubly linked list. Again, this is an illustration of the structure, not a claim about how any specific product is built:

```go
// Activity feed using a doubly linked list.
// Supports ordered insertion and deduplication.
package feed

import (
    "sync"
    "time"
)

// Activity represents a feed item
type Activity struct {
    ID        string
    ActorID   string
    Type      string  // "post", "like", "comment", "share"
    ObjectID  string
    Timestamp time.Time
    Score     float64  // Relevance score for ranking
}

// FeedNode for doubly linked list
type FeedNode struct {
    activity *Activity
    prev     *FeedNode
    next     *FeedNode
}

// UserFeed manages a user's activity feed
type UserFeed struct {
    userID   string
    head     *FeedNode  // Most recent/relevant
    tail     *FeedNode  // Oldest/least relevant
    size     int
    maxSize  int

    // Index for O(1) lookup and deduplication
    activityIndex map[string]*FeedNode
    // Track seen objects to dedupe
    seenObjects map[string]bool

    mu sync.RWMutex
}

// NewUserFeed creates a new feed for a user
func NewUserFeed(userID string, maxSize int) *UserFeed {
    head := &FeedNode{}
    tail := &FeedNode{}
    head.next = tail
    tail.prev = head

    return &UserFeed{
        userID:        userID,
        head:          head,
        tail:          tail,
        maxSize:       maxSize,
        activityIndex: make(map[string]*FeedNode),
        seenObjects:   make(map[string]bool),
    }
}

// Insert adds an activity to the feed in sorted order by score
// Time: O(n) worst case, but typically O(1) for recent high-score items
func (f *UserFeed) Insert(activity *Activity) bool {
    f.mu.Lock()
    defer f.mu.Unlock()

    // Check for duplicate
    if _, exists := f.activityIndex[activity.ID]; exists {
        return false
    }

    // Check object deduplication (don't show same post twice)
    if f.seenObjects[activity.ObjectID] && activity.Type != "update" {
        return false
    }

    // Find insertion position (sorted by score descending)
    node := f.head.next
    for node != f.tail && node.activity.Score > activity.Score {
        node = node.next
    }

    // Insert before node
    newNode := &FeedNode{activity: activity}
    newNode.prev = node.prev
    newNode.next = node
    node.prev.next = newNode
    node.prev = newNode

    f.activityIndex[activity.ID] = newNode
    f.seenObjects[activity.ObjectID] = true
    f.size++

    // Evict if over capacity
    if f.size > f.maxSize {
        f.evictLast()
    }

    return true
}

// Remove removes an activity (e.g., when deleted)
// Time: O(1) with index
func (f *UserFeed) Remove(activityID string) bool {
    f.mu.Lock()
    defer f.mu.Unlock()

    node, exists := f.activityIndex[activityID]
    if !exists {
        return false
    }

    f.removeNode(node)
    delete(f.activityIndex, activityID)
    f.size--

    return true
}

// UpdateScore updates an activity's score and repositions it
// Time: O(n) for repositioning
func (f *UserFeed) UpdateScore(activityID string, newScore float64) bool {
    f.mu.Lock()
    defer f.mu.Unlock()

    node, exists := f.activityIndex[activityID]
    if !exists {
        return false
    }

    node.activity.Score = newScore

    // Remove from current position
    f.removeNode(node)

    // Find new position
    curr := f.head.next
    for curr != f.tail && curr.activity.Score > newScore {
        curr = curr.next
    }

    // Insert before curr
    node.prev = curr.prev
    node.next = curr
    curr.prev.next = node
    curr.prev = node

    return true
}

// GetPage returns a page of activities
// Time: O(offset + limit)
func (f *UserFeed) GetPage(offset, limit int) []*Activity {
    f.mu.RLock()
    defer f.mu.RUnlock()

    var result []*Activity
    node := f.head.next

    // Skip offset
    for i := 0; i < offset && node != f.tail; i++ {
        node = node.next
    }

    // Collect limit items
    for i := 0; i < limit && node != f.tail; i++ {
        result = append(result, node.activity)
        node = node.next
    }

    return result
}

// Merge merges another feed into this one (for aggregation)
// Time: O(m + n) where m and n are feed sizes
func (f *UserFeed) Merge(other *UserFeed) {
    f.mu.Lock()
    other.mu.RLock()
    defer f.mu.Unlock()
    defer other.mu.RUnlock()

    // Collect activities from other feed
    activities := make([]*Activity, 0, other.size)
    node := other.head.next
    for node != other.tail {
        activities = append(activities, node.activity)
        node = node.next
    }

    // Insert each (will handle deduplication)
    for _, activity := range activities {
        f.insertUnlocked(activity)
    }
}

func (f *UserFeed) insertUnlocked(activity *Activity) bool {
    if _, exists := f.activityIndex[activity.ID]; exists {
        return false
    }

    if f.seenObjects[activity.ObjectID] {
        return false
    }

    node := f.head.next
    for node != f.tail && node.activity.Score > activity.Score {
        node = node.next
    }

    newNode := &FeedNode{activity: activity}
    newNode.prev = node.prev
    newNode.next = node
    node.prev.next = newNode
    node.prev = newNode

    f.activityIndex[activity.ID] = newNode
    f.seenObjects[activity.ObjectID] = true
    f.size++

    if f.size > f.maxSize {
        f.evictLast()
    }

    return true
}

func (f *UserFeed) removeNode(node *FeedNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (f *UserFeed) evictLast() {
    if f.size == 0 {
        return
    }

    last := f.tail.prev
    f.removeNode(last)
    delete(f.activityIndex, last.activity.ID)
    f.size--
}
```

### Junior -> FAANG: Reading Case Studies as Interview Preparation

These three case studies are the bridge between textbook linked list problems and the system design interviews you will face at FAANG. Each one demonstrates a specific pattern in a production context.

**Redis ZSet (skip list):** The key takeaway is that Redis chose a skip list because it delivers ordered range queries at a fraction of the implementation complexity of a balanced tree, and because span tracking turns rank into an O(log n) query. Do not repeat the common claim that the reason was concurrency: Redis runs commands on one thread. The other half of the design is that a ZSET is two structures, a skip list for order and a hash for member-to-score, which is the same list-plus-map composition as an LRU cache. In a system design interview, if you mention using Redis sorted sets for a leaderboard or rate limiter, be prepared to explain both halves and why neither alone suffices.

**Driver location (LRU cache):** The key takeaway is that the LRU cache is not just a hash map with eviction. The doubly linked list is necessary for O(1) reordering on every access. The `EvictStale` method shows an additional dimension: time-based expiry traversing from the tail (oldest) forward. Note that `EvictStale` is O(n) and walks the whole list, so it belongs on a background ticker, not on the request path. In a system design interview about ride-matching, mentioning that driver location is cached in memory with LRU eviction and time-based expiry demonstrates knowledge of real production patterns.

**Activity feed (insertion sort into doubly linked list):** The key takeaway is that a sorted doubly linked list with O(1) index lookup (via the `activityIndex` map) combines list ordering with hash-map access, the same composite pattern as LRU. The `UpdateScore` method shows O(n) repositioning, which is acceptable for feeds with bounded size and infrequent rescoring. Note also that `Get`-style access here takes a full write lock rather than a read lock, because touching an entry mutates the list order. That is inherent to LRU and is exactly why an LRU cache does not scale by swapping in an `RWMutex`.

**First-job habit:** When you read a case study like these, ask: "What would break first under 10x load?" For the driver location cache, the answer is the `sync.RWMutex` becoming a bottleneck under concurrent writes. For the activity feed, the answer is the O(n) `Insert` scan for score-sorted position. Identifying the scaling bottleneck is a senior engineering behavior you should practice early.

### Senior @ FAANG: Evaluating Case Study Implementations as Production Code

**Redis ZSet span tracking as a design pattern.** The `span` array in `ZSetNode` is a space-for-time trade-off: each node stores an additional integer per level, but rank queries become O(log n) instead of O(n). This is the same trade-off as augmented BSTs (each node stores subtree size). The general principle is: if a derived property of the structure is queried frequently, store it incrementally updated during mutations rather than recomputing it on demand. Formalizing this as an ADR for a team decision: "We store a span alongside every forward pointer to support O(log n) rank queries. Alternative: recompute rank in O(n) time. We choose to store span because rank queries are issued at the same frequency as inserts (every leaderboard update triggers a rank display)." Size the cost correctly in that ADR: a node has 1/(1-p) forward pointers on average, which is about 1.33 at Redis's p of 0.25, so spans add O(n) integers, not O(n log n). The real cost of span tracking is not memory, it is that every insert and delete must now keep the accounting exact, including decrementing spans on levels that merely pass over the changed node. Get that wrong and ranks drift silently while every other operation still looks correct.

**Driver location cache as a goroutine safety audit.** The `Update` method takes a write lock for the entire duration including the geospatial index update. If `geoIndex.Update` is slow (e.g., S2 cell computation is expensive), the write lock is held for a disproportionately long time, blocking all concurrent reads. A production review comment would be: "Consider releasing the main mutex before the geo index update and re-acquiring it if needed, or make the geo index independently lockable." This is the kind of lock scope reduction that distinguishes senior from staff engineering.

**Feed `Merge` as a lock ordering concern.** The `Merge` method acquires `f.mu.Lock()` and then `other.mu.RLock()` simultaneously. If two goroutines call `Merge` on each other's feeds simultaneously, goroutine A acquires f's lock and waits for other's lock, while goroutine B acquires other's lock and waits for f's lock. This is a classic deadlock, and note that Go will not save you: the runtime only panics on "all goroutines are asleep" when *every* goroutine is blocked, so in a live server these two simply hang forever while the rest of the process keeps serving. The production fix is to impose a canonical lock ordering (always lock the feed with the lower memory address first, for example) or to collect the activities under a read lock and release before acquiring the write lock on the destination. `Merge(f, f)` deserves the same scrutiny: self-merge would deadlock instantly on a non-reentrant mutex. Spotting this pattern in a code review is an L5/L6 bar-raiser signal.

**Unbounded `seenObjects` as a slow leak.** `evictLast` and `Remove` both delete from `activityIndex` but neither touches `seenObjects`. That map only ever grows, so a long-lived feed accumulates one entry per object it has ever seen, and an object evicted for age can never re-enter the feed because its dedup marker outlives the node. This is the kind of defect that never shows up in a unit test and surfaces months later as steadily climbing RSS. The fix depends on intent: if dedup should be permanent, the set needs a bounded structure with its own expiry policy, and a Bloom filter or a second LRU is the usual answer. If dedup is only meant to cover items currently in the feed, then eviction must remove the marker, which turns `seenObjects` into a derived index that every mutation path is obliged to maintain. Deciding which of these you meant is the design work.

---
