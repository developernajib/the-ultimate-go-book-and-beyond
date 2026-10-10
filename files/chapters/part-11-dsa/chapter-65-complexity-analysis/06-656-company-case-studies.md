## 65.5 Company Case Studies

### Google's Algorithm Efficiency Standards

At search-engine scale (billions of queries per day), algorithmic efficiency is a hiring bar, not a nicety. Here is what the discipline looks like in code:

```go
// Search-engine-style ranking: how complexity discipline looks at scale

// GOOD: O(n log n) sorting for search results
// At Google's scale (billions of queries/day), every millisecond matters
func rankSearchResults(results []SearchResult, query string) []SearchResult {
    // Pre-compute relevance scores O(n)
    for i := range results {
        results[i].score = calculateRelevance(results[i], query)
    }

    // Sort by relevance - O(n log n)
    sort.Slice(results, func(i, j int) bool {
        return results[i].score > results[j].score
    })

    return results
}

// BAD at scale: O(n²) would be catastrophic
func badRankResults(results []SearchResult, query string) []SearchResult {
    // Bubble sort - O(n²) - with billions of documents, this is impossible
    for i := 0; i < len(results); i++ {
        for j := i + 1; j < len(results); j++ {
            if calculateRelevance(results[j], query) > calculateRelevance(results[i], query) {
                results[i], results[j] = results[j], results[i]
            }
        }
    }
    return results
}
```

### Netflix Recommendation Engine Complexity

A recommendation engine must balance time and space: scoring is per-user work repeated millions of times per hour, so both dimensions of complexity show up directly in the infrastructure bill:

```go
// Recommendation-engine-style candidate scoring
// modeled on the trade-offs a Netflix-scale service faces

type RecommendationEngine struct {
    // Pre-computed similarity matrix - space trade-off for time
    // O(n²) space but O(1) lookup
    similarityCache map[string]map[string]float64
}

// GOOD: O(k) where k is number of recommendations
// Uses pre-computed similarities
func (r *RecommendationEngine) GetRecommendations(userID string, count int) []Movie {
    // O(1) - Get user's watch history from cache
    history := r.getUserHistory(userID)

    // O(h) where h is history size - typically small
    candidates := make(map[string]float64)
    for _, watched := range history {
        // O(1) - Lookup pre-computed similarities
        for movieID, similarity := range r.similarityCache[watched.MovieID] {
            candidates[movieID] += similarity * watched.Rating
        }
    }

    // O(c log k) - Find top k from candidates
    // Using heap is more efficient than full sort when c >> k
    return r.topK(candidates, count)
}

// Heap-based top-k selection - O(n log k) instead of O(n log n) sort
func (r *RecommendationEngine) topK(scores map[string]float64, k int) []Movie {
    h := &minHeap{}
    heap.Init(h)

    for movieID, score := range scores {
        heap.Push(h, &movieScore{movieID, score})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    // O(k log k) to extract in order
    result := make([]Movie, h.Len())
    for i := h.Len() - 1; i >= 0; i-- {
        ms := heap.Pop(h).(*movieScore)
        result[i] = r.getMovie(ms.movieID)
    }
    return result
}
```

### Amazon's Database Query Optimization

A marketplace-scale product catalog turns query complexity into money: the difference between an indexed lookup and a scan is the difference between milliseconds and minutes:

```go
// Marketplace-style product search
// modeled on the index layering an Amazon-scale catalog requires

// Index structure for O(1) lookups
type ProductIndex struct {
    byID       map[string]*Product           // O(1) by ID
    byCategory map[string][]*Product         // O(1) by category
    byPriceRange *IntervalTree               // O(log n) range queries
    searchTrie   *Trie                        // O(m) prefix search
}

// O(1) direct lookup
func (idx *ProductIndex) GetByID(id string) *Product {
    return idx.byID[id]
}

// O(n log k) where n is category size and k is the limit
func (idx *ProductIndex) GetByCategory(category string, sortBy string, limit int) []*Product {
    products := idx.byCategory[category] // O(1)

    // Sort only top-k using heap - O(n log k) instead of O(n log n)
    return idx.topKSorted(products, sortBy, limit)
}

// O(log n + k) range query
func (idx *ProductIndex) GetByPriceRange(minCents, maxCents int64) []*Product {
    return idx.byPriceRange.Query(minCents, maxCents)
}

// O(m + k) where m is prefix length, k is matches
func (idx *ProductIndex) SearchByPrefix(prefix string, limit int) []*Product {
    return idx.searchTrie.GetWithPrefix(prefix, limit)
}
```

### Junior → FAANG: Learning from Production Code Patterns

These case studies expose a pattern that is invisible in textbook examples: real systems compose multiple algorithms with different complexity classes, and the overall system complexity is determined by the bottleneck component. In the Amazon index, the O(1) ID lookup is not the bottleneck. The O(n log k) sort for top-k results is. Understanding which component dominates is the key skill.

For interviews with a system design component, use this compositional thinking explicitly. "The recommendation engine has three phases: O(h) history retrieval, O(h times c) candidate scoring where c is candidates per watched item, and O(c log k) heap selection for top-k results. The bottleneck is the scoring phase, so any optimization should target that component." This analysis is exactly what Google and Netflix interviewers are looking for in senior-track rounds.

Heap-based top-k selection (O(n log k) instead of O(n log n) full sort) is a concrete optimization that every candidate should know. When k is much smaller than n, the savings are substantial. Mention it proactively whenever a problem asks for the "top k" of anything.

### Senior @ FAANG: Complexity at Planetary Scale

The case studies in this section describe systems operating at billions of events per day. At that scale, even O(n) algorithms require careful design. A single-pass O(n) scan over a billion-item corpus takes different wall-clock time depending on whether the data fits in cache, fits in RAM, or requires disk I/O. Algorithmic complexity class is necessary but not sufficient for reasoning about performance at this scale.

**Data locality and cache efficiency.** Large ranking pipelines process documents in batches sized to fit in CPU cache. An O(n log n) sort with good cache locality can outperform an O(n) algorithm that accesses memory in random order, because the cache miss penalty at modern memory speeds dwarfs the difference in operation count for practical input sizes. Senior engineers working on data-intensive systems profile cache miss rates alongside algorithmic complexity.

**Distributed complexity.** When a system is sharded across hundreds of machines, the relevant complexity includes the network round trips. An O(n) algorithm that requires a scatter-gather across 500 shards pays one round trip of added latency when the fan-out is parallelized, and multiplies its latency by the shard count when it is not. The recommendation engine sketched above avoids this by pre-computing similarity matrices and serving recommendations from a single in-memory lookup, trading O(n squared) precomputation space for O(1) online query cost.

**Governance of complexity at scale.** Staff engineers at these companies are responsible for setting standards that prevent complexity regressions in large codebases. This means defining performance budgets for each tier of the stack, requiring benchmarks for any change to a hot path, and reviewing capacity projections when the data growth rate changes. When a product catalog grows by double-digit percentages in a year, the complexity of every index operation must be re-evaluated against the new baseline. That review is a staff engineering responsibility, not a junior one.

---
