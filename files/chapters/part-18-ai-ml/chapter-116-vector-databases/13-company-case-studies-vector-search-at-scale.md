## 116.12 Case Studies: Vector Search at Scale

As in the LLM chapter, read these as **illustrative architecture sketches organized by problem shape**, not as transcriptions of any company's internal code. Nobody outside these organizations has their source, and inventing it would teach you fiction dressed as authority. The patterns are real and widely deployed - the structs are this book's rendering, written to be read rather than compiled, and they reference helper types that are declared nowhere. Where a company has published an engineering blog post or a paper, go read the primary source, and cite *that* in an interview rather than a plausible-sounding detail you absorbed second-hand.

### Pattern: Managed Vector Search on a Cloud Platform

The first sketch is the managed-service shape, where the platform owns the index and you own the schema and the queries:

```go
// Google Vertex AI-style vector search
package vertexai

import (
    "context"
    "fmt"
    "time"
)

// MatchingEngineClient interfaces with Vertex AI Vector Search
type MatchingEngineClient struct {
    projectID    string
    location     string
    indexID      string
    endpoint     string
    credentials  *Credentials
}

type IndexConfig struct {
    Dimensions       int
    ApproximateNeighborsCount int
    DistanceMeasureType string // DOT_PRODUCT, COSINE, L2_SQUARED
    ShardSize        string    // SHARD_SIZE_SMALL, MEDIUM, LARGE
    Algorithm        string    // TREE_AH, BRUTE_FORCE
}

// CreateIndex creates a new vector index
func (c *MatchingEngineClient) CreateIndex(
    ctx context.Context,
    name string,
    config IndexConfig,
) (*Index, error) {
    // Vertex AI index creation
    index := &Index{
        Name:       name,
        Dimensions: config.Dimensions,
        Config:     config,
        Status:     "CREATING",
        CreatedAt:  time.Now(),
    }

    // Deploy to endpoint for serving
    endpoint, err := c.deployIndex(ctx, index)
    if err != nil {
        return nil, err
    }

    index.Endpoint = endpoint
    return index, nil
}

// Query performs approximate nearest neighbor search
func (c *MatchingEngineClient) Query(
    ctx context.Context,
    vector []float32,
    topK int,
    filters map[string]any,
) ([]QueryResult, error) {
    // Build query request
    req := QueryRequest{
        DeployedIndexID: c.indexID,
        Queries: []QueryVector{{
            DatapointID: "query",
            Vector:      vector,
        }},
        ReturnFullDatapoint: true,
    }

    // Apply filters
    if len(filters) > 0 {
        req.Restricts = buildRestricts(filters)
    }

    // Execute query
    resp, err := c.executeQuery(ctx, req)
    if err != nil {
        return nil, err
    }

    return resp.Results, nil
}

// StreamingUpdate enables real-time index updates
func (c *MatchingEngineClient) StreamingUpdate(
    ctx context.Context,
    datapoints []Datapoint,
) error {
    // Stream datapoints for real-time indexing
    stream, err := c.openUpdateStream(ctx)
    if err != nil {
        return err
    }
    defer stream.Close()

    for _, dp := range datapoints {
        if err := stream.Send(dp); err != nil {
            return err
        }
    }

    return stream.Finish()
}
```

### Pinecone: Enterprise Vector Database

Pinecone provides managed vector database at scale:

```go
// Pinecone enterprise patterns
package pinecone

import (
    "context"
    "sync"
    "time"
)

// PineconeService provides production-ready vector search
type PineconeService struct {
    client      *Client
    namespace   string
    cache       *QueryCache
    batcher     *UpsertBatcher
    metrics     *MetricsCollector
}

// UpsertBatcher batches upsert operations for efficiency
type UpsertBatcher struct {
    mu        sync.Mutex
    batch     []Vector
    batchSize int
    flushInterval time.Duration
    client    *Client
    namespace string
}

func NewUpsertBatcher(client *Client, namespace string, batchSize int) *UpsertBatcher {
    b := &UpsertBatcher{
        batch:         make([]Vector, 0, batchSize),
        batchSize:     batchSize,
        flushInterval: time.Second,
        client:        client,
        namespace:     namespace,
    }

    // Start background flusher
    go b.backgroundFlush()

    return b
}

func (b *UpsertBatcher) Add(vector Vector) {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.batch = append(b.batch, vector)

    if len(b.batch) >= b.batchSize {
        b.flush()
    }
}

func (b *UpsertBatcher) flush() {
    if len(b.batch) == 0 {
        return
    }

    // Copy and reset batch
    toFlush := make([]Vector, len(b.batch))
    copy(toFlush, b.batch)
    b.batch = b.batch[:0]

    // Upsert in background
    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        b.client.Upsert(ctx, b.namespace, toFlush)
    }()
}

// HybridQuery combines vector and metadata search
func (s *PineconeService) HybridQuery(
    ctx context.Context,
    vector []float32,
    sparseVector *SparseVector,
    filters map[string]any,
    topK int,
) ([]QueryMatch, error) {
    // Check cache
    cacheKey := s.buildCacheKey(vector, filters)
    if cached, ok := s.cache.Get(cacheKey); ok {
        s.metrics.RecordCacheHit()
        return cached, nil
    }

    start := time.Now()

    // Build query
    query := QueryRequest{
        Namespace:      s.namespace,
        Vector:         vector,
        SparseVector:   sparseVector,
        Filter:         filters,
        TopK:           topK,
        IncludeMetadata: true,
        IncludeValues:  false,
    }

    // Execute query
    resp, err := s.client.Query(ctx, query)
    if err != nil {
        s.metrics.RecordError()
        return nil, err
    }

    s.metrics.RecordLatency(time.Since(start))

    // Cache result
    s.cache.Set(cacheKey, resp.Matches, 5*time.Minute)

    return resp.Matches, nil
}
```

### Weaviate: Knowledge Graph + Vectors

Weaviate combines vector search with graph capabilities:

```go
// Weaviate enterprise integration
package weaviate

import (
    "context"
    "fmt"
)

// WeaviateService provides semantic search with relationships
type WeaviateService struct {
    client       *Client
    schema       *SchemaManager
    vectorizer   Vectorizer
    graphTraversal *GraphTraversal
}

// SemanticSearch performs vector search with context enrichment
func (s *WeaviateService) SemanticSearch(
    ctx context.Context,
    query string,
    className string,
    limit int,
) ([]SearchResult, error) {
    // Get vector for query
    vector := s.vectorizer.Vectorize(query)

    // Search with vector
    gql := fmt.Sprintf(`{
        Get {
            %s(
                nearVector: {
                    vector: %v
                }
                limit: %d
            ) {
                _additional {
                    id
                    distance
                    certainty
                }
                ... on %s {
                    %s
                }
            }
        }
    }`, className, vector, limit, className, s.schema.GetProperties(className))

    resp, err := s.client.GraphQL(ctx, gql)
    if err != nil {
        return nil, err
    }

    return parseResults(resp, className), nil
}

// GraphEnrichedSearch combines vector search with graph traversal
func (s *WeaviateService) GraphEnrichedSearch(
    ctx context.Context,
    query string,
    className string,
    depth int,
) ([]EnrichedResult, error) {
    // Initial vector search
    baseResults, err := s.SemanticSearch(ctx, query, className, 10)
    if err != nil {
        return nil, err
    }

    // Enrich with related objects
    enriched := make([]EnrichedResult, len(baseResults))
    for i, result := range baseResults {
        related, err := s.graphTraversal.Traverse(ctx, result.ID, depth)
        if err != nil {
            continue
        }

        enriched[i] = EnrichedResult{
            SearchResult: result,
            Related:      related,
        }
    }

    return enriched, nil
}
```

### Pattern: Personalized Retrieval

The next sketch is personalized recommendation: blend a user-preference vector with an item index so that "similar" is relative to *this* user rather than absolute. Media and commerce catalogues are the archetype.

Carry one caveat from the introduction into this pattern, because it is where the idea usually goes wrong: an embedding space built for semantic *retrieval* is not automatically a good *recommendation* space. Semantic similarity says two items are alike; collaborative signal says two items are enjoyed by the same people, and those are different claims. Items with near-identical descriptions are often substitutes nobody consumes together. Recommenders built purely on content similarity therefore tend to produce eerily narrow suggestions: more of exactly what the user just consumed, and nothing they would not have found alone. Production systems generally blend content embeddings with collaborative signal for this reason.

```go
// Illustrative sketch: personalized retrieval with a user preference vector.
package recommendations

import (
    "context"
    "sync"
    "time"
	"sort"
)

// PersonalizedSearch combines user preferences with content vectors
type PersonalizedSearch struct {
    contentVectors   *VectorStore
    userProfiles     *UserProfileStore
    realtimeSignals  *RealtimeSignalStore
}

type SearchContext struct {
    UserID       string
    Query        string
    DeviceType   string
    TimeOfDay    time.Time
    ViewHistory  []string
}

// Search returns personalized results
func (s *PersonalizedSearch) Search(
    ctx context.Context,
    searchCtx SearchContext,
    limit int,
) ([]ContentResult, error) {
    // Get user embedding
    userEmbed, err := s.userProfiles.GetEmbedding(searchCtx.UserID)
    if err != nil {
        // Cold start: use query embedding only
        userEmbed = nil
    }

    // Get query embedding
    queryEmbed := s.contentVectors.EncodeQuery(searchCtx.Query)

    // Combine user and query vectors
    var searchVector []float32
    if userEmbed != nil {
        searchVector = combineVectors(queryEmbed, userEmbed, 0.7, 0.3)
    } else {
        searchVector = queryEmbed
    }

    // Apply real-time signals (recently watched, device preferences)
    signals := s.realtimeSignals.Get(searchCtx.UserID)

    // Search with personalized vector
    results, err := s.contentVectors.Search(ctx, searchVector, limit*2)
    if err != nil {
        return nil, err
    }

    // Re-rank with signals
    reranked := s.rerank(results, signals, searchCtx)

    return reranked[:limit], nil
}

func (s *PersonalizedSearch) rerank(
    results []ContentResult,
    signals *UserSignals,
    ctx SearchContext,
) []ContentResult {
    for i := range results {
        score := results[i].Score

        // Boost content matching user's genre preferences
        for _, genre := range results[i].Genres {
            if preference, ok := signals.GenrePreferences[genre]; ok {
                score *= (1 + preference*0.2)
            }
        }

        // Penalize recently watched
        if contains(ctx.ViewHistory, results[i].ContentID) {
            score *= 0.5
        }

        // Time-of-day adjustment
        if isAppropriateForTime(results[i], ctx.TimeOfDay) {
            score *= 1.1
        }

        results[i].PersonalizedScore = score
    }

    // Sort by personalized score
    sort.Slice(results, func(i, j int) bool {
        return results[i].PersonalizedScore > results[j].PersonalizedScore
    })

    return results
}
```

### Pattern: Geospatial Constraint Plus Vector Similarity

The last sketch combines a hard geographic constraint with semantic similarity, which is the marketplace and local-search shape.

This pattern is the filtering problem from the fundamentals section in its sharpest form, and it is worth recognising why. A radius constraint is highly selective (a few hundred candidates out of millions) and it is *non-negotiable*: a beautifully matching result on another continent is not a slightly worse answer, it is a wrong one. That combination is the worst case for pre-filtering a graph index, since the surviving nodes may not be reachable from one another and recall silently collapses. It is also the worst case for post-filtering, which will hand you an empty result set.

The right architecture usually inverts the problem: shard or partition by geography (a geohash or H3 cell), so location becomes a routing decision that selects which small index to search, and the vector search then runs unfiltered inside a candidate set that is already guaranteed to be geographically valid. Constraint first, similarity second. That is the general lesson worth taking from this pattern: when a filter is both highly selective and mandatory, make it part of your partitioning scheme rather than part of your query.

```go
// Illustrative sketch: geo constraint + vector similarity.
package matching

import (
    "context"
    "time"
	"sort"
)

// DriverMatcher combines geospatial and preference vectors
type DriverMatcher struct {
    driverVectors    *VectorStore
    geoIndex         *GeoIndex
    preferenceModel  *PreferenceModel
}

type RideRequest struct {
    UserID       string
    PickupLat    float64
    PickupLng    float64
    DropoffLat   float64
    DropoffLng   float64
    VehicleType  string
    Preferences  map[string]any
}

type DriverMatch struct {
    DriverID      string
    Distance      float64
    ETA           time.Duration
    Score         float64
    Compatibility float64
}

// FindMatches finds best driver matches
func (m *DriverMatcher) FindMatches(
    ctx context.Context,
    request RideRequest,
    maxResults int,
) ([]DriverMatch, error) {
    // Get nearby drivers
    nearbyDrivers := m.geoIndex.GetNearby(
        request.PickupLat,
        request.PickupLng,
        5.0, // 5km radius
    )

    if len(nearbyDrivers) == 0 {
        return nil, fmt.Errorf("no drivers available")
    }

    // Get request preference vector
    requestVector := m.preferenceModel.Encode(request)

    // Score each driver
    matches := make([]DriverMatch, 0, len(nearbyDrivers))
    for _, driver := range nearbyDrivers {
        // Get driver preference vector
        driverVector, err := m.driverVectors.Get(driver.DriverID)
        if err != nil {
            continue
        }

        // Calculate compatibility score
        compatibility := cosineSimilarity(requestVector, driverVector)

        // Combine with distance
        score := calculateMatchScore(driver.Distance, compatibility)

        matches = append(matches, DriverMatch{
            DriverID:      driver.DriverID,
            Distance:      driver.Distance,
            ETA:           estimateETA(driver.Distance),
            Score:         score,
            Compatibility: compatibility,
        })
    }

    // Sort by score
    sort.Slice(matches, func(i, j int) bool {
        return matches[i].Score > matches[j].Score
    })

    if len(matches) > maxResults {
        matches = matches[:maxResults]
    }

    return matches, nil
}

func calculateMatchScore(distance, compatibility float64) float64 {
    // Weight factors
    distanceWeight := 0.6
    compatibilityWeight := 0.4

    // Normalize distance (closer is better)
    normalizedDistance := 1.0 / (1.0 + distance)

    return distanceWeight*normalizedDistance + compatibilityWeight*compatibility
}
```

### Junior → FAANG: Case Studies as Scale Intuition

The scale intuition worth carrying is that billion-scale vector search is a solved engineering problem, not a research frontier. FAISS, Meta's open-source similarity search library, is the most useful concrete anchor here precisely because it is public: you can read the source, read the papers, and run it yourself, which is worth more than any anecdote about an internal system you cannot inspect. It underpins a great deal of the industry's large-scale vector search, directly or by influence, and the techniques it implements (IVF, product quantization, and their compositions) are the same ones the managed services use under their APIs.

At that scale the challenges are index sharding, distributed query execution, and continuous index updates, and they all have known solutions. Be precise about what "solved" means, though: solved *at a recall and latency target you accept, for a cost you can pay*. Nobody does billion-scale exact search. They pick a point on the recall-latency-memory surface and engineer to it, which is the same tradeoff from the fundamentals section, just with more zeroes.

The key lesson from the Google Vertex AI case study for junior engineers is the separation of the online serving path (low latency, pre-built index, approximate search) from the offline index building path (high throughput, exact computation, generates the index used by the online path). This separation is the architectural pattern that enables billion-scale vector search: the expensive computation happens offline, and the online path serves from a pre-computed index that fits in memory. Any vector search system you design should incorporate this separation.

Visual search is instructive for the multimodal angle: searching a catalogue of product images with a text query ("red sneakers") requires an embedding model that maps both text and images into the *same* vector space, so that the text embedding for "red sneakers" lands near the image embeddings of actual red sneakers. CLIP (Contrastive Language-Image Pre-training) is the architecture that made this mainstream, and it and its successors are deployed technology rather than a research curiosity.

The infrastructure consequence is the part worth internalizing: a joint space means one index serves both modalities, and text-to-image search is then just a nearest-neighbour query like any other. The cross-modal magic lives entirely in the model, and by the time the vectors reach your database it is an ordinary ANN problem. That is a good instinct to have generally, since most of what looks exotic about AI infrastructure resolves, at the storage layer, into a familiar retrieval problem.

### Senior @ FAANG: Case Studies as Infrastructure Benchmark

At senior level, these case studies are the benchmarks against which you evaluate your organization's vector search infrastructure. Google's Vertex AI Vector Search provides sub-100 ms P99 latency on billion-scale indexes through a combination of HNSW-based approximate search, distributed query execution, and hardware acceleration. If your organization's vector search system serves 10 million vectors but has P99 latency of 500 ms, there is a significant gap relative to the industry benchmark, and the case study gives you the vocabulary to describe the gap and the directions to investigate (index algorithm, hardware provisioning, query routing, caching).

FAISS is particularly instructive because it is open-source and the implementation details are accessible. Meta's engineering blog posts on FAISS describe the Product Quantization implementation, the inverted file index structure, and the GPU acceleration strategy. Studying these posts gives you a deeper understanding of the algorithms underlying commercial vector databases than most engineers have, and this depth is perceptible in interview discussions.

At L6, these case studies support the business case for vector search infrastructure investment. "Google searches billions of images with sub-100 ms latency using the same class of technology we are proposing to invest in" is a more compelling argument than abstract claims about search quality improvement. The case studies provide third-party validation of the technology's maturity and scale, which is often the decisive factor in getting investment approved by engineering leadership.

---
