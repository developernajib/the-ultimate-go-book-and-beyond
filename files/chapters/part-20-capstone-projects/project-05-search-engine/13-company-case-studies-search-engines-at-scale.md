## Company Case Studies: Search Engines at Scale

The concepts you built in the previous sections are the same ones that power search at the world's largest companies. The case studies below show how Elasticsearch, Algolia, Google, and Pinterest each solve search at massive scale using distributed sharding, typo-tolerant instant search, PageRank-enhanced web retrieval, and CNN-based visual similarity. Studying these real-world architectures will deepen your understanding of when to apply each technique and how the pieces fit together in production systems handling billions of queries.

### Elasticsearch: Distributed Search Infrastructure

Elasticsearch powers billions of searches at major tech companies:

```go
// Elasticsearch-style distributed search service
package elasticsearch

import (
    "context"
    "encoding/json"
    "sync"
    "time"
)

// ClusterService manages distributed search cluster
type ClusterService struct {
    nodes         map[string]*Node
    shardRouter   *ShardRouter
    replicaPolicy *ReplicaPolicy
    healthCheck   *HealthChecker
}

// Node represents an Elasticsearch data node
type Node struct {
    ID          string   `json:"id"`
    Host        string   `json:"host"`
    Role        []string `json:"role"` // master, data, ingest, coordinating
    Shards      []*Shard `json:"shards"`
    HeapUsed    int64    `json:"heap_used"`
    HeapMax     int64    `json:"heap_max"`
    DiskUsed    int64    `json:"disk_used"`
    DiskTotal   int64    `json:"disk_total"`
}

// Shard represents a Lucene index shard
type Shard struct {
    ID          int    `json:"id"`
    Index       string `json:"index"`
    Primary     bool   `json:"primary"`
    State       string `json:"state"` // STARTED, RELOCATING, INITIALIZING
    Node        string `json:"node"`
    DocCount    int64  `json:"doc_count"`
    SizeBytes   int64  `json:"size_bytes"`
}

// SearchRequest represents an ES query
type SearchRequest struct {
    Index       []string               `json:"index"`
    Query       map[string]any `json:"query"`
    From        int                    `json:"from"`
    Size        int                    `json:"size"`
    Sort        []map[string]string    `json:"sort,omitempty"`
    Aggregations map[string]any `json:"aggs,omitempty"`
    Highlight   *HighlightConfig       `json:"highlight,omitempty"`
    Source      []string               `json:"_source,omitempty"`
    Timeout     time.Duration          `json:"timeout"`
}

// Search executes distributed search across shards
func (c *ClusterService) Search(ctx context.Context, req *SearchRequest) (*SearchResponse, error) {
    // Determine target shards
    shards := c.shardRouter.GetShards(req.Index)

    // Execute search on each shard in parallel
    var wg sync.WaitGroup
    results := make(chan *ShardSearchResult, len(shards))
    errors := make(chan error, len(shards))

    for _, shard := range shards {
        wg.Add(1)
        go func(s *Shard) {
            defer wg.Done()
            node := c.nodes[s.Node]
            result, err := node.ExecuteSearch(ctx, s, req)
            if err != nil {
                errors <- err
                return
            }
            results <- result
        }(shard)
    }

    // Wait with timeout
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
    case <-ctx.Done():
        return nil, ctx.Err()
    case <-time.After(req.Timeout):
        return nil, ErrSearchTimeout
    }

    close(results)
    close(errors)

    // Check for errors
    for err := range errors {
        if err != nil {
            return nil, err
        }
    }

    // Merge and rank results
    return c.mergeResults(results, req)
}

// mergeResults combines shard results with global ranking
func (c *ClusterService) mergeResults(results <-chan *ShardSearchResult, req *SearchRequest) (*SearchResponse, error) {
    var allHits []*SearchHit
    var totalHits int64
    aggregations := make(map[string]any)

    for result := range results {
        allHits = append(allHits, result.Hits...)
        totalHits += result.TotalHits

        // Merge aggregations
        for k, v := range result.Aggregations {
            c.mergeAggregation(aggregations, k, v)
        }
    }

    // Sort all hits
    sortHits(allHits, req.Sort)

    // Apply pagination
    start := req.From
    end := start + req.Size
    if end > len(allHits) {
        end = len(allHits)
    }

    return &SearchResponse{
        TotalHits:    totalHits,
        Hits:         allHits[start:end],
        Aggregations: aggregations,
        Took:         time.Since(time.Now()),
    }, nil
}
```

### Algolia: Low-Latency Search as a Service

Algolia delivers sub-50ms search globally:

```go
// Algolia-style instant search service
package algolia

import (
    "context"
    "sync"
    "time"
)

// InstantSearchService handles typo-tolerant instant search
type InstantSearchService struct {
    indices      map[string]*SearchIndex
    analytics    *AnalyticsService
    personalize  *PersonalizationEngine
    caching      *QueryCache
}

// SearchIndex represents an Algolia index
type SearchIndex struct {
    Name           string                 `json:"name"`
    Records        int64                  `json:"records"`
    Settings       *IndexSettings         `json:"settings"`
    Synonyms       map[string][]string    `json:"synonyms"`
    Rules          []*QueryRule           `json:"rules"`
    TypoTolerance  *TypoToleranceConfig   `json:"typo_tolerance"`
}

// IndexSettings configures search behavior
type IndexSettings struct {
    SearchableAttributes []string `json:"searchableAttributes"`
    AttributesForFaceting []string `json:"attributesForFaceting"`
    CustomRanking        []string `json:"customRanking"`
    Ranking              []string `json:"ranking"`
    HighlightPreTag      string   `json:"highlightPreTag"`
    HighlightPostTag     string   `json:"highlightPostTag"`
}

// InstantSearchRequest for search-as-you-type
type InstantSearchRequest struct {
    Query               string              `json:"query"`
    IndexName           string              `json:"indexName"`
    HitsPerPage         int                 `json:"hitsPerPage"`
    Page                int                 `json:"page"`
    Filters             string              `json:"filters,omitempty"`
    FacetFilters        [][]string          `json:"facetFilters,omitempty"`
    OptionalFilters     []string            `json:"optionalFilters,omitempty"`
    AroundLatLng        string              `json:"aroundLatLng,omitempty"`
    DistinctLevel       int                 `json:"distinct,omitempty"`
    PersonalizationImpact int               `json:"personalizationImpact,omitempty"`
    UserToken           string              `json:"userToken,omitempty"`
}

// Search performs instant search with typo tolerance
func (s *InstantSearchService) Search(ctx context.Context, req *InstantSearchRequest) (*InstantSearchResponse, error) {
    start := time.Now()

    // Check query cache
    cacheKey := s.caching.BuildKey(req)
    if cached, ok := s.caching.Get(cacheKey); ok {
        return cached.(*InstantSearchResponse), nil
    }

    index := s.indices[req.IndexName]
    if index == nil {
        return nil, ErrIndexNotFound
    }

    // Process query with typo tolerance
    processedQuery := s.processQuery(req.Query, index.TypoTolerance)

    // Apply synonyms
    expandedQueries := s.expandSynonyms(processedQuery, index.Synonyms)

    // Apply query rules
    modifiedReq := s.applyRules(req, index.Rules)

    // Execute search
    hits, totalHits, facets, err := index.Search(ctx, expandedQueries, modifiedReq)
    if err != nil {
        return nil, err
    }

    // Apply personalization if user token provided
    if req.UserToken != "" && req.PersonalizationImpact > 0 {
        hits = s.personalize.ReRank(ctx, req.UserToken, hits, req.PersonalizationImpact)
    }

    // Highlight matching terms
    s.highlightHits(hits, req.Query, index.Settings)

    response := &InstantSearchResponse{
        Hits:        hits,
        NbHits:      totalHits,
        Page:        req.Page,
        NbPages:     (totalHits + int64(req.HitsPerPage) - 1) / int64(req.HitsPerPage),
        HitsPerPage: req.HitsPerPage,
        Facets:      facets,
        Query:       req.Query,
        ProcessingTimeMS: int(time.Since(start).Milliseconds()),
    }

    // Cache response
    s.caching.Set(cacheKey, response, time.Minute)

    // Track analytics async
    go s.analytics.TrackSearch(ctx, req, response)

    return response, nil
}

// processQuery handles typo tolerance
func (s *InstantSearchService) processQuery(query string, config *TypoToleranceConfig) *ProcessedQuery {
    words := tokenize(query)
    processed := &ProcessedQuery{
        Original: query,
        Tokens:   words,
    }

    for _, word := range words {
        // Generate typo variations based on word length
        var maxTypos int
        switch {
        case len(word) <= 3:
            maxTypos = 0
        case len(word) <= 7:
            maxTypos = 1
        default:
            maxTypos = 2
        }

        if config.MinWordSizefor1Typo > 0 && len(word) < config.MinWordSizefor1Typo {
            maxTypos = 0
        }

        variations := generateTypoVariations(word, maxTypos)
        processed.Variations = append(processed.Variations, variations)
    }

    return processed
}
```

### Google: Distributed Search at Planet Scale

Google's search infrastructure patterns:

```go
// Google-style distributed search architecture
package google

import (
    "context"
    "sync"
    "time"
)

// WebSearchService handles web-scale search
type WebSearchService struct {
    indexShards    []*IndexShard
    docServers     []*DocServer
    rankingService *RankingService
    spellChecker   *SpellChecker
    knowledgeGraph *KnowledgeGraph
}

// IndexShard represents a partition of the index
type IndexShard struct {
    ID          int
    DocRange    [2]uint64 // [start, end] doc IDs
    InvertedIndex *InvertedIndex
    TermStats   *TermStatistics
}

// SearchResult from web search
type SearchResult struct {
    URL         string    `json:"url"`
    Title       string    `json:"title"`
    Snippet     string    `json:"snippet"`
    DisplayURL  string    `json:"display_url"`
    PageRank    float64   `json:"page_rank"`
    Freshness   time.Time `json:"freshness"`
    Features    []string  `json:"features,omitempty"` // sitelinks, images, etc.
}

// WebSearch performs distributed search with ranking
func (s *WebSearchService) WebSearch(ctx context.Context, query string, page int) (*WebSearchResponse, error) {
    start := time.Now()

    // Spell check and query suggestion
    correctedQuery, suggestions := s.spellChecker.Check(query)

    // Parse and expand query
    parsedQuery := s.parseQuery(correctedQuery)

    // Check knowledge graph for direct answers
    knowledgeCard := s.knowledgeGraph.Query(ctx, parsedQuery)

    // Phase 1: Scatter query to all index shards
    var wg sync.WaitGroup
    shardResults := make(chan *ShardResult, len(s.indexShards))

    for _, shard := range s.indexShards {
        wg.Add(1)
        go func(sh *IndexShard) {
            defer wg.Done()
            result := sh.Search(ctx, parsedQuery)
            shardResults <- result
        }(shard)
    }

    wg.Wait()
    close(shardResults)

    // Collect candidate doc IDs from all shards
    var candidates []uint64
    termFreqs := make(map[uint64]*DocTermFreq)

    for result := range shardResults {
        for _, docID := range result.DocIDs {
            candidates = append(candidates, docID)
            termFreqs[docID] = result.TermFreqs[docID]
        }
    }

    // Phase 2: Fetch document metadata
    docMeta := s.fetchDocMetadata(ctx, candidates)

    // Phase 3: Apply ranking (PageRank + relevance + freshness)
    rankedResults := s.rankingService.Rank(ctx, parsedQuery, candidates, termFreqs, docMeta)

    // Pagination
    pageSize := 10
    startIdx := page * pageSize
    endIdx := startIdx + pageSize
    if endIdx > len(rankedResults) {
        endIdx = len(rankedResults)
    }

    // Build response
    results := make([]*SearchResult, 0, pageSize)
    for _, docID := range rankedResults[startIdx:endIdx] {
        meta := docMeta[docID]
        results = append(results, &SearchResult{
            URL:        meta.URL,
            Title:      meta.Title,
            Snippet:    s.generateSnippet(meta.Content, parsedQuery),
            DisplayURL: formatDisplayURL(meta.URL),
            PageRank:   meta.PageRank,
            Freshness:  meta.LastCrawled,
        })
    }

    return &WebSearchResponse{
        Query:          query,
        CorrectedQuery: correctedQuery,
        Suggestions:    suggestions,
        KnowledgeCard:  knowledgeCard,
        Results:        results,
        TotalResults:   int64(len(rankedResults)),
        Page:           page,
        Took:           time.Since(start),
    }, nil
}
```

### Pinterest: Visual Search Engine

Pinterest's visual search for images:

```go
// Pinterest-style visual search
package pinterest

import (
    "context"
    "sync"
)

// VisualSearchService handles image-based search
type VisualSearchService struct {
    featureExtractor *CNNFeatureExtractor
    vectorIndex      *ANNIndex
    objectDetector   *ObjectDetector
    textIndex        *TextIndex
}

// VisualSearchRequest for image queries
type VisualSearchRequest struct {
    ImageURL    string    `json:"image_url,omitempty"`
    ImageData   []byte    `json:"image_data,omitempty"`
    CropBox     *CropBox  `json:"crop_box,omitempty"`
    TextQuery   string    `json:"text_query,omitempty"`
    Filters     *Filters  `json:"filters,omitempty"`
    Limit       int       `json:"limit"`
}

// Pin represents a Pinterest pin
type Pin struct {
    ID          string   `json:"id"`
    ImageURL    string   `json:"image_url"`
    Title       string   `json:"title"`
    Description string   `json:"description"`
    Board       string   `json:"board"`
    Creator     string   `json:"creator"`
    Objects     []string `json:"objects"` // detected objects
    Similarity  float32  `json:"similarity"`
}

// VisualSearch finds similar images
func (s *VisualSearchService) VisualSearch(ctx context.Context, req *VisualSearchRequest) (*VisualSearchResponse, error) {
    var imageData []byte
    var err error

    if req.ImageURL != "" {
        imageData, err = fetchImage(req.ImageURL)
        if err != nil {
            return nil, err
        }
    } else {
        imageData = req.ImageData
    }

    // Crop to region of interest if specified
    if req.CropBox != nil {
        imageData = cropImage(imageData, req.CropBox)
    }

    // Detect objects in image
    objects := s.objectDetector.Detect(ctx, imageData)

    // Extract visual features using CNN
    features := s.featureExtractor.Extract(ctx, imageData)

    // Search for similar images using ANN
    neighbors, err := s.vectorIndex.Search(ctx, features, req.Limit*2)
    if err != nil {
        return nil, err
    }

    // If text query provided, combine with text search
    var textMatches []string
    if req.TextQuery != "" {
        textMatches, _ = s.textIndex.Search(ctx, req.TextQuery, req.Limit)
    }

    // Combine visual and text results
    pins := s.combineResults(ctx, neighbors, textMatches, req.Filters)

    // Apply object-based filtering
    if len(objects) > 0 {
        pins = s.filterByObjects(pins, objects)
    }

    if len(pins) > req.Limit {
        pins = pins[:req.Limit]
    }

    return &VisualSearchResponse{
        Pins:            pins,
        DetectedObjects: objects,
        Query:           req.TextQuery,
    }, nil
}

// combineResults merges visual and text search results
func (s *VisualSearchService) combineResults(ctx context.Context, visual []*VectorMatch, textIDs []string, filters *Filters) []*Pin {
    // Score combination
    scores := make(map[string]float32)

    // Visual similarity scores
    for _, match := range visual {
        scores[match.ID] = match.Similarity * 0.7 // 70% weight for visual
    }

    // Text relevance scores
    for i, id := range textIDs {
        textScore := float32(len(textIDs)-i) / float32(len(textIDs))
        if existing, ok := scores[id]; ok {
            scores[id] = existing + textScore*0.3 // 30% weight for text
        } else {
            scores[id] = textScore * 0.3
        }
    }

    // Fetch pin metadata and apply filters
    var pins []*Pin
    for id, score := range scores {
        pin, err := s.fetchPin(ctx, id)
        if err != nil {
            continue
        }

        if filters != nil && !s.matchesFilters(pin, filters) {
            continue
        }

        pin.Similarity = score
        pins = append(pins, pin)
    }

    // Sort by combined score
    sort.Slice(pins, func(i, j int) bool {
        return pins[i].Similarity > pins[j].Similarity
    })

    return pins
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Elasticsearch | Distributed sharding, Lucene-based | Petabytes of data |
| Algolia | Typo tolerance, instant search | 1.5T+ queries/year |
| Google | PageRank, distributed indexing | Billions of web pages |
| Pinterest | Visual search, CNN features | 200B+ pins indexed |

---

### Junior → FAANG: Learning Scale from Case Studies

Elasticsearch's approach (sharded inverted index with near-real-time segment refresh) and Algolia's approach (in-memory index with typo tolerance by default) represent two ends of the search design spectrum: Elasticsearch optimizes for scale and flexibility, Algolia optimizes for developer experience and instant results. Knowing both approaches and understanding their tradeoffs is useful for system design interviews where the first question is always "what are your requirements?"

Google's PageRank (ranked pages by the number of quality inbound links, treating links as votes) is a historical lesson in feature engineering: the most powerful ranking signal turned out to be a graph property of the web, not a term frequency measure. For a product search engine, the equivalent insight is that past purchase data is more predictive of relevance than text similarity. The lesson is to look for external signals that are not contained in the document itself.

Pinterest's visual search (using CNN features to find visually similar images) is the ML extension of keyword search. For structured corpora (images, audio, code), embedding-based search (converting each item to a vector and finding nearest neighbors) often outperforms term-based search. Know that approximate nearest neighbor algorithms (HNSW, FAISS) are the production solution for large-scale vector search.

### Senior @ FAANG: Case Studies as Architecture Pattern Libraries

At senior level, each case study represents a specific architectural pattern. Elasticsearch's segment-based index with NRT (Near Real Time) refresh represents the "immutable segments with periodic compaction" pattern. Algolia's in-memory index with typo tolerance represents the "correctness-first with fast enumeration" pattern. Google's distributed crawl-and-index pipeline represents the "write-heavy offline processing with read-heavy online serving" pattern.

Each pattern has a specific applicability range. The immutable segments pattern is appropriate for write-heavy workloads where consistency can be eventual. The in-memory index pattern is appropriate for corpora that fit in RAM with strict latency requirements. The crawl-and-index pattern is appropriate for corpus sizes that exceed any single machine's resources.

Multi-modal search (combining text, image, and structured data signals in a single ranking function) is the frontier of production search at companies like Pinterest and Amazon. The technical challenges (representing different modalities in a common embedding space, weighting modalities based on query type, handling missing modalities gracefully) are research-grade problems that staff engineers at search companies work on. Understanding the problem space, even without implementing the solution, is valuable context for technical leadership discussions.

---
