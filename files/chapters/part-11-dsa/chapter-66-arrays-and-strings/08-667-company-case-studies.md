## 66.7 Company Case Studies

### Google: Search Query Processing

Search-engine query processing is string and array algorithms under a microsecond budget, normalization, tokenization, and matching run billions of times per day:

```go
// Google-style search query processing
// Handles autocomplete, spelling correction, and query expansion
package search

import (
    "strings"
    "sync"
    "unicode"
)

// QueryProcessor handles search query preprocessing
type QueryProcessor struct {
    trie           *AutocompleteTrie
    spellingIndex  map[string][]string  // Word -> corrections
    synonyms       map[string][]string
    stopWords      map[string]bool

    mu sync.RWMutex
}

// AutocompleteTrie for fast prefix matching
type AutocompleteTrie struct {
    children map[rune]*AutocompleteTrie
    isEnd    bool
    weight   int64  // Search frequency
    suggestions []string
}

// ProcessQuery normalizes and expands a search query
// Time: O(n * m) where n is query length, m is average word expansions
func (qp *QueryProcessor) ProcessQuery(query string) *ProcessedQuery {
    // Step 1: Tokenize using two-pointer technique
    tokens := qp.tokenize(query)

    // Step 2: Remove stop words using sliding window
    filtered := qp.removeStopWords(tokens)

    // Step 3: Apply spelling correction
    corrected := qp.correctSpelling(filtered)

    // Step 4: Expand with synonyms
    expanded := qp.expandSynonyms(corrected)

    return &ProcessedQuery{
        Original:  query,
        Tokens:    tokens,
        Corrected: corrected,
        Expanded:  expanded,
    }
}

// tokenize splits query into tokens efficiently
func (qp *QueryProcessor) tokenize(query string) []string {
    var tokens []string
    var current strings.Builder

    // Two-pointer approach for tokenization
    for _, r := range query {
        if unicode.IsLetter(r) || unicode.IsDigit(r) {
            current.WriteRune(unicode.ToLower(r))
        } else if current.Len() > 0 {
            tokens = append(tokens, current.String())
            current.Reset()
        }
    }

    if current.Len() > 0 {
        tokens = append(tokens, current.String())
    }

    return tokens
}

// AutoComplete returns top-k suggestions for prefix
// Uses trie with frequency-weighted results
func (qp *QueryProcessor) AutoComplete(prefix string, k int) []string {
    qp.mu.RLock()
    defer qp.mu.RUnlock()

    // Navigate to prefix node
    node := qp.trie
    for _, r := range prefix {
        if node.children == nil || node.children[r] == nil {
            return nil
        }
        node = node.children[r]
    }

    // BFS to find top-k weighted suggestions
    return qp.getTopSuggestions(node, prefix, k)
}

// EditDistance for spelling correction (dynamic programming)
func EditDistance(s1, s2 string) int {
    m, n := len(s1), len(s2)

    // Space optimization: only need two rows
    prev := make([]int, n+1)
    curr := make([]int, n+1)

    for j := 0; j <= n; j++ {
        prev[j] = j
    }

    for i := 1; i <= m; i++ {
        curr[0] = i
        for j := 1; j <= n; j++ {
            if s1[i-1] == s2[j-1] {
                curr[j] = prev[j-1]
            } else {
                curr[j] = 1 + min(prev[j-1], min(prev[j], curr[j-1]))
            }
        }
        prev, curr = curr, prev
    }

    return prev[n]
}

type ProcessedQuery struct {
    Original  string
    Tokens    []string
    Corrected []string
    Expanded  [][]string
}
```

### Meta: News Feed Deduplication

A social feed at Meta's scale must deduplicate content across billions of posts, an array-and-hashing problem where the algorithm choice decides feasibility:

```go
// Meta-style content deduplication
// Handles near-duplicate detection in news feed
package newsfeed

import (
    "hash/fnv"
)

// ContentDeduplicator removes duplicate/near-duplicate content
type ContentDeduplicator struct {
    shingleSize   int
    hashBuckets   int
    minHashFuncs  int
    seenHashes    map[uint64][]string  // LSH buckets
}

// NewContentDeduplicator creates deduplicator with LSH parameters
func NewContentDeduplicator() *ContentDeduplicator {
    return &ContentDeduplicator{
        shingleSize:  3,           // 3-word shingles
        hashBuckets:  100,         // LSH buckets
        minHashFuncs: 100,         // MinHash signatures
        seenHashes:   make(map[uint64][]string),
    }
}

// IsDuplicate checks if content is duplicate using MinHash + LSH
// Time: O(n) where n is content length
func (cd *ContentDeduplicator) IsDuplicate(contentID, text string) (bool, string) {
    // Step 1: Create shingles using sliding window
    shingles := cd.createShingles(text)

    // Step 2: Compute MinHash signature
    signature := cd.computeMinHash(shingles)

    // Step 3: Check LSH buckets for similar content
    for band := 0; band < 20; band++ {
        bucketHash := cd.hashBand(signature, band)

        if existing, found := cd.seenHashes[bucketHash]; found {
            for _, existingID := range existing {
                // Verify similarity with Jaccard
                if cd.verifySimilarity(contentID, existingID) {
                    return true, existingID
                }
            }
        }

        // Add to bucket
        cd.seenHashes[bucketHash] = append(cd.seenHashes[bucketHash], contentID)
    }

    return false, ""
}

// createShingles using sliding window technique
func (cd *ContentDeduplicator) createShingles(text string) map[uint64]bool {
    words := tokenize(text)
    shingles := make(map[uint64]bool)

    // Sliding window of size shingleSize
    for i := 0; i <= len(words)-cd.shingleSize; i++ {
        shingle := words[i : i+cd.shingleSize]
        hash := hashShingle(shingle)
        shingles[hash] = true
    }

    return shingles
}

// computeMinHash creates signature for LSH
func (cd *ContentDeduplicator) computeMinHash(shingles map[uint64]bool) []uint64 {
    signature := make([]uint64, cd.minHashFuncs)

    for i := range signature {
        signature[i] = ^uint64(0) // Max value
    }

    for shingle := range shingles {
        for i := 0; i < cd.minHashFuncs; i++ {
            hash := hashWithSeed(shingle, uint64(i)+1) // seed 0 would zero out the hash
            if hash < signature[i] {
                signature[i] = hash
            }
        }
    }

    return signature
}

// RollingHash for efficient substring matching
type RollingHash struct {
    hash   uint64
    base   uint64
    mod    uint64
    window []byte
    power  uint64  // base^(windowSize-1) for removal
    size   int     // fixed window size
}

func NewRollingHash(windowSize int) *RollingHash {
    rh := &RollingHash{
        base:   256,
        mod:    1000000007,
        window: make([]byte, 0, windowSize),
        size:   windowSize,
    }

    // Precompute power for window removal
    rh.power = 1
    for i := 0; i < windowSize-1; i++ {
        rh.power = (rh.power * rh.base) % rh.mod
    }

    return rh
}

// Add adds byte to window, returns old byte if window was full
func (rh *RollingHash) Add(b byte) (byte, bool) {
    var removed byte
    var wasRemoved bool

    if len(rh.window) == rh.size {
        // Remove first byte
        removed = rh.window[0]
        wasRemoved = true
        rh.hash = (rh.hash - uint64(removed)*rh.power%rh.mod + rh.mod) % rh.mod
        rh.window = rh.window[1:]
    }

    // Add new byte
    rh.hash = (rh.hash*rh.base + uint64(b)) % rh.mod
    rh.window = append(rh.window, b)

    return removed, wasRemoved
}

func hashShingle(words []string) uint64 {
    h := fnv.New64a()
    for _, w := range words {
        h.Write([]byte(w))
    }
    return h.Sum64()
}

func hashWithSeed(val, seed uint64) uint64 {
    return (val*seed + seed) % (1 << 61)
}

func tokenize(text string) []string {
    // Simplified tokenization
    var words []string
    // ... implementation
    return words
}

func (cd *ContentDeduplicator) hashBand(signature []uint64, band int) uint64 {
    // Hash a band of the signature for LSH
    h := fnv.New64a()
    bandSize := len(signature) / 20
    start := band * bandSize
    for i := start; i < start+bandSize && i < len(signature); i++ {
        h.Write([]byte{byte(signature[i])})
    }
    return h.Sum64()
}

func (cd *ContentDeduplicator) verifySimilarity(id1, id2 string) bool {
    // Verify with actual Jaccard similarity
    return true // Placeholder
}
```

### Amazon: Product Search Ranking

Product search and ranking in a large marketplace lean on exactly the array techniques from this chapter:

```go
// Amazon-style product search with relevance ranking
package productsearch

import (
    "container/heap"
    "math"
    "sort"
    "strings"
)

// ProductRanker ranks products based on multiple signals
type ProductRanker struct {
    invertedIndex map[string][]ProductPosting
    products      map[string]*Product
}

type Product struct {
    ID           string
    Title        string
    Description  string
    PriceCents   int64
    Rating       float64
    SalesRank    int
    ReviewCount  int
}

type ProductPosting struct {
    ProductID    string
    TermFreq     int
    Positions    []int  // For phrase matching
    FieldWeight  float64
}

type ScoredProduct struct {
    Product *Product
    Score   float64
}

// Search finds and ranks products for query
// Uses inverted index + multiple ranking signals
func (pr *ProductRanker) Search(query string, limit int) []*ScoredProduct {
    terms := pr.tokenize(query)

    // Step 1: Find candidate products using inverted index
    candidates := pr.findCandidates(terms)

    // Step 2: Score candidates using multiple signals
    scored := make([]*ScoredProduct, 0, len(candidates))
    for productID := range candidates {
        product := pr.products[productID]
        score := pr.calculateScore(product, terms, candidates[productID])
        scored = append(scored, &ScoredProduct{
            Product: product,
            Score:   score,
        })
    }

    // Step 3: Use partial sort for top-k (more efficient than full sort)
    return pr.topK(scored, limit)
}

// findCandidates uses posting list intersection
// Time: O(n * m) where n is postings, m is terms
func (pr *ProductRanker) findCandidates(terms []string) map[string]map[string]ProductPosting {
    candidates := make(map[string]map[string]ProductPosting)

    for _, term := range terms {
        postings := pr.invertedIndex[term]
        for _, posting := range postings {
            if candidates[posting.ProductID] == nil {
                candidates[posting.ProductID] = make(map[string]ProductPosting)
            }
            candidates[posting.ProductID][term] = posting
        }
    }

    return candidates
}

// calculateScore combines multiple ranking signals
func (pr *ProductRanker) calculateScore(p *Product, terms []string, postings map[string]ProductPosting) float64 {
    // BM25 text relevance score
    textScore := pr.bm25Score(p, terms, postings)

    // Popularity signals
    popularityScore := pr.popularityScore(p)

    // Price competitiveness
    priceScore := pr.priceScore(p)

    // Weighted combination (A/B tested weights)
    return 0.5*textScore + 0.3*popularityScore + 0.2*priceScore
}

// bm25Score calculates BM25 relevance
func (pr *ProductRanker) bm25Score(p *Product, terms []string, postings map[string]ProductPosting) float64 {
    k1 := 1.2
    b := 0.75
    avgDocLen := 100.0
    docLen := float64(len(strings.Fields(p.Title + " " + p.Description)))

    score := 0.0
    for _, term := range terms {
        posting, found := postings[term]
        if !found {
            continue
        }

        // IDF component
        totalDocs := float64(len(pr.products))
        docsWithTerm := float64(len(pr.invertedIndex[term]))
        idf := logBase2((totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5))

        // TF component with length normalization
        tf := float64(posting.TermFreq)
        tfNorm := (tf * (k1 + 1)) / (tf + k1*(1-b+b*docLen/avgDocLen))

        // Apply field weight boost (title matches worth more)
        score += idf * tfNorm * posting.FieldWeight
    }

    return score
}

// topK uses a min-heap for efficient top-k selection
// Time: O(n * log k) instead of O(n * log n) for full sort
func (pr *ProductRanker) topK(products []*ScoredProduct, k int) []*ScoredProduct {
    if len(products) <= k {
        sort.Slice(products, func(i, j int) bool {
            return products[i].Score > products[j].Score
        })
        return products
    }

    // Min-heap of size k
    h := &productHeap{}
    heap.Init(h)

    for _, p := range products {
        if h.Len() < k {
            heap.Push(h, p)
        } else if p.Score > (*h)[0].Score {
            heap.Pop(h)
            heap.Push(h, p)
        }
    }

    // Extract and reverse for descending order
    result := make([]*ScoredProduct, h.Len())
    for i := len(result) - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).(*ScoredProduct)
    }

    return result
}

// Min-heap implementation for top-k
type productHeap []*ScoredProduct

func (h productHeap) Len() int           { return len(h) }
func (h productHeap) Less(i, j int) bool { return h[i].Score < h[j].Score } // Min-heap
func (h productHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *productHeap) Push(x any)        { *h = append(*h, x.(*ScoredProduct)) }
func (h *productHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}

func (pr *ProductRanker) tokenize(query string) []string {
    return strings.Fields(strings.ToLower(query))
}

func (pr *ProductRanker) popularityScore(p *Product) float64 {
    // Combine rating and review count
    return p.Rating * logBase2(float64(p.ReviewCount+1))
}

func (pr *ProductRanker) priceScore(p *Product) float64 {
    // Lower price = higher score (normalized against 10,000 cents / $100 baseline)
    return 1.0 / (1.0 + float64(p.PriceCents)/10000.0)
}

func logBase2(x float64) float64 {
    if x <= 0 {
        return 0
    }
    return math.Log2(x)
}
```

### Junior → FAANG: Reading Production Code with an Algorithm Eye

These case studies contain more production complexity than a typical interview problem, but the algorithmic cores are directly from the chapter. The query tokenizer is a same-direction two-pointer through the query string. The edit distance function is standard dynamic programming with a space optimization to O(n) using two rows. The shingle generator is a fixed-window sliding window. The BM25 scoring is a weighted sum over inverted index postings.

When reading production code like this, your job is to identify the algorithm inside the engineering wrapper: the struct fields that are the algorithm's state, the method that corresponds to the preprocessing step, and the method that performs the query. This decomposition skill transfers directly to design interviews, where you are expected to identify the algorithmic core of a system and reason about its complexity.

### Senior @ FAANG: The Engineering Decisions Around the Algorithm

At senior level, the algorithm is the easy part. The hard part is everything around it. In the query processor example, the concurrency design (`sync.RWMutex` protecting the trie) is more consequential than the trie traversal itself, because incorrect locking causes data races or deadlocks under concurrent request load. The frequency-weighted BFS for autocomplete is a performance optimization, but the ordering policy (serve most frequent suggestions first, break ties alphabetically) is a product decision that affects user experience.

In the feed deduplication example, the MinHash plus LSH design trades exact duplicate detection for approximate near-duplicate detection. The false positive rate (flagging non-duplicates as duplicates) and false negative rate (missing actual duplicates) are controlled by the number of hash functions and the LSH band parameters. Setting these parameters is a product and data science decision, not an engineering one, but the senior engineer needs to understand the trade-off well enough to implement the correct parameterization and to alert stakeholders when the false positive rate exceeds the acceptable threshold.

In the product ranking example, the weighted combination of text relevance, popularity, and price (0.5, 0.3, 0.2) stands in for weights that a real marketplace derives from A/B testing and behavioral analysis. The engineering responsibility is to make these weights configurable and hot-reloadable without a service restart, so that product managers can tune the ranking without engineering involvement. Designing for that operational flexibility is a staff-level engineering concern that the algorithm alone does not address.

---
