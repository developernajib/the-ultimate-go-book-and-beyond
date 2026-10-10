## Interview Questions

### Question 1: How would you design Instagram's feed?

**What FAANG expects:** Fan-out-on-write vs fan-out-on-read vs hybrid. Regular users: push (precomputed timeline). Celebrities: pull (fetch at read time). Threshold around 10k-1M followers. Bonus for citing Twitter's original "Rockdove" (push) → hybrid evolution, Instagram's ML-ranked feed (not chronological since 2016), and the real cost of push-on-write for a user with 1M followers (1M Redis writes per post).

**Answer:**

Instagram's feed faces the classic social feed design challenge: balancing the latency of read-time computation (expensive for users with many followees) against the storage and write amplification of push-on-write (expensive for users with many followers). The hybrid approach maintains precomputed feed caches for regular users using fan-out on write, while falling back to fan-out on read for celebrity accounts whose write amplification would be prohibitive. The following implementation models this dual-path architecture, showing how a follower count threshold gates the routing decision.

```go
// Instagram feed architecture
type InstagramFeedService struct {
    feedCache      *redis.ClusterClient
    postStore      *PostStore
    followGraph    *FollowGraphService
    rankingService *FeedRankingService
    mediaService   *MediaService
}

// Hybrid approach: Pre-compute for most users, compute on-read for celebrities
func (s *InstagramFeedService) GetFeed(ctx context.Context, userID string, cursor string, limit int) (*FeedResponse, error) {
    // 1. Get pre-computed feed from cache
    feedKey := fmt.Sprintf("feed:%s", userID)
    cachedPosts, _ := s.feedCache.ZRevRangeByScore(ctx, feedKey, &redis.ZRangeBy{
        Min:    "-inf",
        Max:    cursor,
        Offset: 0,
        Count:  int64(limit),
    }).Result()

    // 2. Get posts from celebrity accounts (fan-out on read)
    celebrities := s.followGraph.GetCelebrityFollowings(ctx, userID)
    celebrityPosts := s.getRecentPostsFromUsers(ctx, celebrities, limit)

    // 3. Merge and rank
    allPosts := s.mergePosts(cachedPosts, celebrityPosts)
    rankedPosts := s.rankingService.Rank(ctx, userID, allPosts)

    // 4. Enrich with media URLs
    enrichedPosts := s.enrichWithMedia(ctx, rankedPosts[:limit])

    return &FeedResponse{
        Posts:      enrichedPosts,
        NextCursor: s.getNextCursor(rankedPosts, limit),
    }, nil
}

// Fan-out on write for regular users
func (s *InstagramFeedService) OnNewPost(ctx context.Context, post *Post) error {
    followers := s.followGraph.GetFollowers(ctx, post.UserID)

    // Skip fan-out for celebrity accounts
    if len(followers) > 10000 {
        return nil // These will be fetched on-read
    }

    // Fan-out to follower feeds
    pipe := s.feedCache.Pipeline()
    score := float64(post.Timestamp.UnixNano())

    for _, followerID := range followers {
        feedKey := fmt.Sprintf("feed:%s", followerID)
        pipe.ZAdd(ctx, feedKey, redis.Z{Score: score, Member: post.ID})
        pipe.ZRemRangeByRank(ctx, feedKey, 0, -1001) // Keep last 1000
    }

    _, err := pipe.Exec(ctx)
    return err
}
```

**Key design decisions:**
- Hybrid fan-out: write for regular users, read for celebrities
- Redis sorted sets for feed storage (score = timestamp)
- Feed ranking considers engagement, recency, and relationship
- Media served from CDN with signed URLs

**Follow-ups:**
- *Where does the 10k threshold come from?* Rough break-even between write cost (one Redis write per follower) and read cost (one extra fetch per session). The exact number depends on your write capacity and session rate. Many systems tune this per-tier.
- *How do you rank the merged celebrity + cache feed?* ML model with features: recency, affinity (how often user interacts with author), engagement on the post (likes/comments), content type bias. Instagram moved from chronological to ranked in 2016.
- *What breaks when a regular user crosses the celebrity threshold?* Their backlog of fan-out writes has to be re-materialized (or not, and accept a transition window). Shopify and Instagram handle this via a bi-directional migration job.

### Question 2: Design a system like Google Docs with real-time collaboration

**What FAANG expects:** OT (Google Docs uses this) vs CRDT (newer, no central authority needed). OT requires a central server. CRDTs work peer-to-peer. Know that Figma runs on a bespoke CRDT, Notion uses a custom OT-like scheme, and Yjs/Automerge are the open-source defaults. Bonus for acknowledging that writing these correctly is research-grade. Production systems use libraries.

**Answer:**

Real-time collaborative editing requires resolving concurrent modifications from multiple users without a central lock. Conflict-free Replicated Data Types (CRDTs) solve this by defining data structures where all concurrent operations commute, any ordering produces the same final state. The Replicated Growable Array (RGA) models a document as a linked list of characters, each identified by a globally unique ID derived from a vector clock. Insertions and deletions are broadcast to all connected clients over WebSockets, and each client applies them locally using the CRDT merge rules.

```go
// Real-time collaborative editing using CRDTs
type CollaborativeDocument struct {
    id          string
    sequence    *RGASequence // Replicated Growable Array
    connections map[string]*websocket.Conn
    operations  chan Operation
    mu          sync.RWMutex
}

// Operation represents an edit
type Operation struct {
    ID        string
    Type      string // insert, delete
    Position  *VectorClock
    Character rune
    UserID    string
    Timestamp time.Time
}

// CRDT-based sequence for conflict-free editing
type RGASequence struct {
    nodes    map[string]*RGANode
    head     *RGANode
    vectorClock map[string]uint64
}

type RGANode struct {
    id        string
    character rune
    deleted   bool
    left      *RGANode
    right     *RGANode
    timestamp *VectorClock
}

func (d *CollaborativeDocument) ApplyOperation(op Operation) {
    d.mu.Lock()
    defer d.mu.Unlock()

    switch op.Type {
    case "insert":
        d.sequence.Insert(op.Position, op.Character, op.ID)
    case "delete":
        d.sequence.Delete(op.ID)
    }

    // Broadcast to all connected clients
    d.broadcastOperation(op)
}

func (d *CollaborativeDocument) HandleClientOperation(ctx context.Context, userID string, localOp *LocalOperation) {
    // Transform local operation to global operation
    op := d.transformOperation(localOp, userID)

    // Apply locally
    d.ApplyOperation(op)

    // Persist to operation log
    d.persistOperation(ctx, op)

    // Sync to other servers (for multi-datacenter)
    d.syncToReplicas(ctx, op)
}

// Server handles WebSocket connections
type CollaborationServer struct {
    documents map[string]*CollaborativeDocument
    hub       *ConnectionHub
}

func (s *CollaborationServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    docID := r.URL.Query().Get("doc")
    userID := r.Context().Value("user_id").(string)

    conn, _ := upgrader.Upgrade(w, r, nil)

    doc := s.getOrCreateDocument(docID)
    doc.AddConnection(userID, conn)

    // Send current state
    conn.WriteJSON(doc.GetState())

    // Handle incoming operations
    for {
        var op LocalOperation
        if err := conn.ReadJSON(&op); err != nil {
            break
        }
        doc.HandleClientOperation(r.Context(), userID, &op)
    }
}
```

**Key design decisions:**
- CRDTs ensure eventual consistency without coordination
- Vector clocks track causality for ordering
- WebSocket for real-time bidirectional communication
- Operation transformation for handling concurrent edits

**Follow-ups:**
- *When do you pick OT over CRDT?* OT with a central server has lower metadata overhead and simpler undo/redo semantics. CRDT wins for local-first, offline, and peer-to-peer scenarios. Google Docs and Notion stuck with OT for its simplicity in their server-authoritative model.
- *How do CRDTs handle large documents?* Metadata overhead grows per operation (tombstones for deletes). Compaction (garbage collection of tombstones older than the slowest replica's sync point) is non-trivial. Yjs handles it well. hand-rolled RGA often does not.
- *How do you model presence (cursor position, selection) with CRDTs?* Ephemeral state layer on top: presence channel over WebSocket (awareness protocol in Yjs). Do not try to CRDT the cursors. They are not part of the durable document.

### Question 3: Design a ride-sharing matching system like Uber

**What FAANG expects:** Geospatial indexing via S2 (Google, Uber) or H3 (Uber's newer hex-based index, open source). Know the level trade-off (S2 level 12 ≈ 3-6 km² cells). Multi-factor scoring beyond distance (driver rating, heading, preferred ride type, surge). Bonus for mentioning Uber's real pipeline: Ringpop for sharded matchers, DISCO for dispatch, Jaeger for trace-based debugging, and Kepler.gl for visualization.

**Answer:**

The ride-sharing matching problem requires a geospatial index that can answer "find the nearest available drivers to this point" in single-digit milliseconds. Google's S2 geometry library partitions the Earth into hierarchical cells. drivers are indexed by their current cell, and a ride request queries the target cell plus its neighbors to find candidates. A multi-factor scoring function weighs proximity, driver rating, and heading direction to select the best match. Dynamic pricing adjusts fares based on local supply-demand imbalance.

```go
// Ride matching system
type RideMatchingService struct {
    driverIndex   *S2CellIndex
    demandPredict *DemandPredictor
    routingEngine *RoutingEngine
    priceEngine   *DynamicPricing
}

// S2CellIndex provides geospatial indexing
type S2CellIndex struct {
    redis *redis.ClusterClient
    level int // S2 cell level (precision)
}

func (s *RideMatchingService) MatchRider(ctx context.Context, req *RideRequest) (*MatchResult, error) {
    // 1. Find nearby drivers using S2 cells
    cell := s2.CellIDFromLatLng(s2.LatLngFromDegrees(req.Pickup.Lat, req.Pickup.Lng))
    neighbors := cell.AllNeighbors(s.driverIndex.level)

    var candidates []*Driver
    for _, c := range append(neighbors, cell) {
        drivers := s.driverIndex.GetDriversInCell(ctx, c)
        candidates = append(candidates, drivers...)
    }

    // 2. Filter and rank candidates
    eligible := s.filterEligible(ctx, candidates, req)
    ranked := s.rankDrivers(ctx, eligible, req)

    // 3. Calculate pricing
    surge := s.priceEngine.GetSurgeMultiplier(ctx, req.Pickup, req.Dropoff)
    priceCents := s.priceEngine.CalculatePriceCents(ctx, req, surge)

    // 4. Return best match
    if len(ranked) == 0 {
        return nil, ErrNoDriversAvailable
    }

    return &MatchResult{
        Driver:     ranked[0],
        ETA:        s.routingEngine.GetETA(ctx, ranked[0].Location, req.Pickup),
        PriceCents: priceCents,
        SurgeLevel: surge,
    }, nil
}

func (s *RideMatchingService) rankDrivers(ctx context.Context, drivers []*Driver, req *RideRequest) []*Driver {
    // The slice must not share the type's name: `var scored []*scored`
    // would shadow the type and break the composite literal below.
    type scoredDriver struct {
        driver *Driver
        score  float64
    }

    var results []*scoredDriver
    for _, d := range drivers {
        // Calculate multi-factor score
        eta := s.routingEngine.GetETA(ctx, d.Location, req.Pickup)
        score := s.calculateMatchScore(d, req, eta)
        results = append(results, &scoredDriver{d, score})
    }

    sort.Slice(results, func(i, j int) bool {
        return results[i].score > results[j].score
    })

    ranked := make([]*Driver, len(results))
    for i, sd := range results {
        ranked[i] = sd.driver
    }
    return ranked
}

func (s *RideMatchingService) calculateMatchScore(d *Driver, req *RideRequest, eta time.Duration) float64 {
    score := 100.0

    // Penalize longer ETAs
    score -= float64(eta.Minutes()) * 2

    // Bonus for higher-rated drivers
    score += d.Rating * 5

    // Bonus if driver is heading toward pickup
    if s.isHeadingToward(d, req.Pickup) {
        score += 10
    }

    // Consider driver preferences
    if req.RideType == d.PreferredRideType {
        score += 5
    }

    return score
}

// Real-time driver location updates
func (s *RideMatchingService) UpdateDriverLocation(ctx context.Context, driverID string, loc *Location) error {
    driver, _ := s.getDriver(ctx, driverID)

    // Remove from old cell
    oldCell := s2.CellIDFromLatLng(s2.LatLngFromDegrees(driver.Location.Lat, driver.Location.Lng))
    s.driverIndex.RemoveFromCell(ctx, oldCell, driverID)

    // Add to new cell
    newCell := s2.CellIDFromLatLng(s2.LatLngFromDegrees(loc.Lat, loc.Lng))
    s.driverIndex.AddToCell(ctx, newCell, driverID, loc)

    return nil
}
```

**Key design decisions:**
- S2 geometry for efficient geospatial indexing
- Multi-factor scoring for driver ranking
- Dynamic pricing based on supply/demand
- Real-time location tracking with cell-based indexing

**Follow-ups:**
- *S2 vs H3, which do you pick?* H3 (hexagonal) has equal adjacency (6 neighbors, always same distance), which is nicer for routing and uniform search radii. S2 (quads) is simpler and Google-native. Uber uses both. H3 for analytics, S2 for low-level matching.
- *How do you avoid the "no driver within 1km" thrash during peak demand?* Progressive radius expansion with an SLO timeout, surge pricing to pull in distant drivers, and predictive dispatch (send drivers toward predicted demand, not reactively).
- *What breaks at Uber's scale that this sketch hides?* Multi-region sharding by city, cross-region dispatch for border zones, driver state machine with at-least-once delivery, and fraud detection on both sides. Ringpop and DISCO internally handle matcher sharding and failover.

---

### Junior -> FAANG: Structuring Your Answer for Each Question Type

These three questions represent the three most common large-scale system design interview formats. Practice answering each one using a consistent structure: requirements clarification (2 minutes), high-level design (5 minutes), deep dive on one component (10 minutes), trade-offs and failure modes (3 minutes).

For the Instagram feed question, the key clarification to ask first is: "Is the feed ranked by time or by relevance?" This changes the architecture significantly. A chronological feed can be assembled from a sorted set. A ranked feed requires a real-time ML inference step that adds latency and complexity. Interviewers appreciate candidates who surface this ambiguity before designing.

For Google Docs collaboration, clarify the offline editing requirement. If users must be able to edit while disconnected, you need CRDTs or an operation log with conflict resolution on sync. If users are always connected, a simpler operational transformation server is sufficient. Most interviewers expect you to design for the connected case and describe the offline extension as a follow-up.

For the Uber matching system, clarify the ETA requirement. "Find the nearest driver" is a simpler problem than "find the driver with the best estimated arrival time," which requires road-network routing rather than haversine distance. At a FAANG interview, the interviewer expects you to mention the distinction and propose haversine as the approximation for a first pass, with road-network routing as the production improvement.

### Senior @ FAANG: What the Follow-Up Questions Are Actually Testing

The follow-up questions in this section are the real interview, not the initial answer. They test whether the candidate understands the production implications of their design choices.

For Instagram, "What breaks when a regular user crosses the celebrity threshold?" is testing whether you understand that fan-out strategies are not per-user fixed properties, they are dynamic classifications that must be migrated. A user with 9,999 followers today may have 10,001 tomorrow. The system must detect the crossing, stop new fan-out writes, and backfill or not backfill the historical followers (the "backfill decision" is a correctness and capacity trade-off). Candidates who say "just check the count at write time" have not thought through the migration path.

For Google Docs, "How do CRDTs handle large documents?" is testing whether you understand that CRDTs accrue metadata over time (tombstones for deleted characters, vector clock entries per participant) and that this metadata must eventually be garbage collected. Without compaction, a long-lived document that has been heavily edited accumulates megabytes of tombstone metadata that must be transmitted to every new participant who opens it. The production systems that handle this (Yjs, Automerge) implement compaction at the cost of a brief coordination window that pauses edits.

For Uber matching, "What breaks at Uber's scale that this sketch hides?" is testing whether you understand the gap between a clean architectural diagram and a production system. The expected answer covers multi-region sharding (dispatch must work even if a region loses connectivity), cross-border matching (drivers and riders near city boundaries can cross municipal zones mid-trip), and the driver state machine (a driver who is accepting a ride must not be offered another ride simultaneously). Each of these is a distributed consistency problem that requires explicit design, not an emergent property of the matching algorithm.