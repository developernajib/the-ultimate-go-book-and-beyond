## 116.2 Vector Database Fundamentals

### What are Embeddings?

Embeddings are numerical representations of data (text, images, audio) as vectors in high-dimensional space. Similar items are positioned close together in this space, enabling semantic similarity search.

```go
// pkg/vectordb/types.go
package vectordb

import (
	"context"
	"time"
)

// Vector represents a high-dimensional embedding
type Vector []float32

// Metadata contains additional information about a vector
type Metadata map[string]any

// Document represents an item with its vector embedding
type Document struct {
	ID        string    `json:"id"`
	Vector    Vector    `json:"vector"`
	Metadata  Metadata  `json:"metadata"`
	Text      string    `json:"text,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// SearchResult represents a single result from similarity search
type SearchResult struct {
	ID       string   `json:"id"`
	Score    float32  `json:"score"`
	Metadata Metadata `json:"metadata"`
	Text     string   `json:"text,omitempty"`
}

// SearchResponse contains multiple search results
type SearchResponse struct {
	Results   []SearchResult `json:"results"`
	QueryTime time.Duration  `json:"query_time"`
}

// VectorStore defines the interface all vector databases must implement
type VectorStore interface {
	// Upsert inserts or updates documents
	Upsert(ctx context.Context, docs []Document) error

	// Query performs similarity search
	Query(ctx context.Context, vector Vector, topK int, filter Metadata) (*SearchResponse, error)

	// Delete removes documents by ID
	Delete(ctx context.Context, ids []string) error

	// Fetch retrieves documents by ID
	Fetch(ctx context.Context, ids []string) ([]Document, error)

	// Close closes the connection
	Close() error
}
```

### Distance Metrics

Different distance metrics measure similarity in different ways. Before the code, fix the relationship between them in your head, because it is the single most misunderstood point in this entire field:

**Cosine similarity equals the dot product only when both vectors are unit length.** Cosine is defined as the dot product divided by both magnitudes. Normalize, and those divisors become 1, and the two are the same number. Do not normalize, and dot product rewards long vectors regardless of direction, so a verbose document with a large-magnitude embedding can outrank a precisely relevant short one. That failure is silent: no error, no warning, just worse results.

The same normalization collapses L2 too. For unit vectors, squared Euclidean distance equals `2 - 2·cos`, a strictly decreasing function of cosine similarity. A monotonic transform cannot change the *order* of results, so **on normalized vectors, cosine, dot product, and L2 all return the same top-k, in the same order.** The choice among them is then purely about compute cost, and dot product wins because it skips the square roots. The moment vectors are not normalized, all three diverge and the choice becomes a correctness decision.

Practical rule: normalize at write time, and use the metric your embedding model's authors specify.

```go
// pkg/vectordb/metrics.go
package vectordb

import (
	"math"
)

// DistanceMetric represents different ways to measure vector similarity
type DistanceMetric int

const (
	Cosine DistanceMetric = iota
	Euclidean
	DotProduct
	Manhattan
)

// CosineSimilarity computes cosine similarity between two vectors
// Returns value between -1 (opposite) and 1 (identical)
func CosineSimilarity(a, b Vector) float32 {
	if len(a) != len(b) {
		return 0
	}

	var dotProduct, normA, normB float32
	for i := range a {
		dotProduct += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}

	if normA == 0 || normB == 0 {
		return 0
	}

	return dotProduct / (float32(math.Sqrt(float64(normA))) * float32(math.Sqrt(float64(normB))))
}

// CosineDistance converts cosine similarity to distance (0 = identical, 2 = opposite).
//
// Note the naming trap that this pair illustrates: similarity and distance run
// in OPPOSITE directions. Higher similarity is better - LOWER distance is better.
// Mixing them up sorts your results backwards, and because the top result is
// still a plausible-looking document, nothing crashes and nobody notices until
// someone measures recall. Whenever a vector API returns a "score", find out
// which of the two it is before you sort by it.
func CosineDistance(a, b Vector) float32 {
	return 1 - CosineSimilarity(a, b)
}

// EuclideanDistance computes L2 distance between vectors
// Smaller values indicate more similar vectors
func EuclideanDistance(a, b Vector) float32 {
	if len(a) != len(b) {
		return float32(math.MaxFloat32)
	}

	var sum float32
	for i := range a {
		diff := a[i] - b[i]
		sum += diff * diff
	}

	return float32(math.Sqrt(float64(sum)))
}

// DotProductSimilarity computes dot product between vectors
// Higher values indicate more similar vectors (for normalized vectors)
func DotProductSimilarity(a, b Vector) float32 {
	if len(a) != len(b) {
		return 0
	}

	var sum float32
	for i := range a {
		sum += a[i] * b[i]
	}

	return sum
}

// ManhattanDistance computes L1 distance between vectors
func ManhattanDistance(a, b Vector) float32 {
	if len(a) != len(b) {
		return float32(math.MaxFloat32)
	}

	var sum float32
	for i := range a {
		sum += float32(math.Abs(float64(a[i] - b[i])))
	}

	return sum
}

// Normalize converts a vector to unit length
func Normalize(v Vector) Vector {
	var norm float32
	for _, val := range v {
		norm += val * val
	}
	norm = float32(math.Sqrt(float64(norm)))

	if norm == 0 {
		return v
	}

	normalized := make(Vector, len(v))
	for i, val := range v {
		normalized[i] = val / norm
	}

	return normalized
}

// Distance computes distance using the specified metric
func Distance(a, b Vector, metric DistanceMetric) float32 {
	switch metric {
	case Cosine:
		return CosineDistance(a, b)
	case Euclidean:
		return EuclideanDistance(a, b)
	case DotProduct:
		return -DotProductSimilarity(a, b) // Negate so smaller = more similar
	case Manhattan:
		return ManhattanDistance(a, b)
	default:
		return CosineDistance(a, b)
	}
}
```

### Approximate Nearest Neighbor (ANN) Algorithms

Exact nearest neighbor search is computationally expensive for high-dimensional vectors. ANN algorithms trade some accuracy for massive speed improvements.

```go
// pkg/vectordb/ann.go
package vectordb

import (
	"container/heap"
	"encoding/json"
	"math"
	"reflect"
	"sync"
)

// ANN Algorithm Overview:
//
// 1. HNSW (Hierarchical Navigable Small World)
//    - Graph-based algorithm with hierarchical layers
//    - Best recall/latency tradeoff of the three - the usual default
//    - COSTS: high memory (graph + vectors are held in RAM), slow to build,
//      and no true delete (removals are tombstoned, so the graph degrades
//      until it is rebuilt)
//    - Used by: Pinecone, Weaviate, Milvus, pgvector
//
// 2. IVF (Inverted File Index)
//    - Partitions space into clusters (Voronoi cells) and probes only the
//      nearest nProbe of them
//    - Cheaper to build and lighter than HNSW - recall is usually lower at a
//      comparable latency
//    - COSTS: requires a training step over a representative sample, so it
//      cannot index an empty table, and its clusters go stale as data drifts
//    - Used by: FAISS, Milvus, pgvector (ivfflat)
//
// 3. PQ (Product Quantization)
//    - A COMPRESSION scheme, not a search structure. It splits each vector
//      into sub-vectors and replaces each with a codebook centroid ID.
//    - Large memory reduction, paid for in precision. Usually layered onto a
//      search structure (IVF-PQ) rather than used alone.

// SimpleANN demonstrates a basic ANN implementation
// In production, use optimized libraries (hnswlib, faiss)
type SimpleANN struct {
	mu        sync.RWMutex
	documents []Document
	index     map[string]int
	metric    DistanceMetric
}

// NewSimpleANN creates a new in-memory ANN index
func NewSimpleANN(metric DistanceMetric) *SimpleANN {
	return &SimpleANN{
		documents: make([]Document, 0),
		index:     make(map[string]int),
		metric:    metric,
	}
}

// Add adds documents to the index
func (ann *SimpleANN) Add(docs []Document) error {
	ann.mu.Lock()
	defer ann.mu.Unlock()

	for _, doc := range docs {
		if idx, exists := ann.index[doc.ID]; exists {
			// Update existing document
			ann.documents[idx] = doc
		} else {
			// Add new document
			ann.index[doc.ID] = len(ann.documents)
			ann.documents = append(ann.documents, doc)
		}
	}

	return nil
}

// resultHeap implements a max-heap for top-K results
type resultHeap []SearchResult

func (h resultHeap) Len() int           { return len(h) }
func (h resultHeap) Less(i, j int) bool { return h[i].Score < h[j].Score } // Min-heap (root is smallest score)
func (h resultHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *resultHeap) Push(x any) {
	*h = append(*h, x.(SearchResult))
}

func (h *resultHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[0 : n-1]
	return x
}

// Search performs brute-force nearest neighbor search
// This is O(n) but accurate - real ANN algorithms are O(log n) approximate
func (ann *SimpleANN) Search(query Vector, topK int, filter Metadata) []SearchResult {
	ann.mu.RLock()
	defer ann.mu.RUnlock()

	h := &resultHeap{}
	heap.Init(h)

	for _, doc := range ann.documents {
		// Apply metadata filter
		if !matchesFilter(doc.Metadata, filter) {
			continue
		}

		distance := Distance(query, doc.Vector, ann.metric)

		// Convert distance (lower is better) to a score (higher is better).
		//
		// The obvious formula, score := 1.0 / (1.0 + distance), is broken and
		// worth understanding rather than just avoiding. Distance is not always
		// non-negative: for the DotProduct metric, Distance returns -dot. A
		// perfect match on normalized vectors gives dot == 1, so distance == -1,
		// so the denominator is exactly zero and the score is +Inf. Worse, with
		// unnormalized vectors dot can exceed 1, making the denominator negative
		// and the score negative, which silently inverts the ranking: the best
		// matches sort last.
		//
		// Negating is monotonic, total, and cannot divide by zero. Top-k
		// ordering is all we need, and negation preserves it exactly.
		score := -distance

		result := SearchResult{
			ID:       doc.ID,
			Score:    score,
			Metadata: doc.Metadata,
			Text:     doc.Text,
		}

		if h.Len() < topK {
			heap.Push(h, result)
		} else if score > (*h)[0].Score {
			heap.Pop(h)
			heap.Push(h, result)
		}
	}

	// Convert heap to sorted slice
	results := make([]SearchResult, h.Len())
	for i := h.Len() - 1; i >= 0; i-- {
		results[i] = heap.Pop(h).(SearchResult)
	}

	return results
}

// matchesFilter checks if document metadata matches filter.
//
// Two traps live in comparing `any` values, and both bite in production.
//
// First, `metaValue != filterValue` PANICS at runtime if either side holds an
// uncomparable type (a slice, a map, or a func). Metadata is user-supplied by
// definition, so one document with a []string tag takes down the query path.
// reflect.DeepEqual is total: it returns false where != would panic.
//
// Second, and more insidious because it fails silently: metadata that has made
// a round trip through JSON has had every number decoded into float64. A filter
// written in Go as {"year": 2024} carries an int, the stored metadata holds
// float64(2024), and int(2024) != float64(2024) as `any` values because the
// dynamic TYPES differ. The filter matches nothing, no error is raised, and the
// search just quietly returns an empty result set. This is the same root cause
// as the classic `.(int)` assertion panic on JSON- or Redis-sourced data.
//
// normalizeNumber collapses every numeric type to float64 so that comparison
// is on value rather than on incidental encoding.
func matchesFilter(metadata, filter Metadata) bool {
	if filter == nil {
		return true
	}

	for key, filterValue := range filter {
		metaValue, exists := metadata[key]
		if !exists {
			return false
		}
		if !valuesEqual(metaValue, filterValue) {
			return false
		}
	}

	return true
}

func valuesEqual(a, b any) bool {
	an, aok := normalizeNumber(a)
	bn, bok := normalizeNumber(b)
	if aok && bok {
		return an == bn
	}
	// reflect.DeepEqual never panics, unlike ==, and handles slices/maps.
	return reflect.DeepEqual(a, b)
}

// normalizeNumber reports a canonical float64 for any numeric dynamic type.
func normalizeNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case float32:
		return float64(n), true
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// Delete removes documents by ID
func (ann *SimpleANN) Delete(ids []string) error {
	ann.mu.Lock()
	defer ann.mu.Unlock()

	// Mark deletions
	toDelete := make(map[string]bool)
	for _, id := range ids {
		toDelete[id] = true
	}

	// Rebuild index without deleted documents
	newDocs := make([]Document, 0, len(ann.documents))
	newIndex := make(map[string]int)

	for _, doc := range ann.documents {
		if !toDelete[doc.ID] {
			newIndex[doc.ID] = len(newDocs)
			newDocs = append(newDocs, doc)
		}
	}

	ann.documents = newDocs
	ann.index = newIndex

	return nil
}

// HNSW Parameters
type HNSWParams struct {
	M              int     // Number of bi-directional links per node (typically 16-64)
	EfConstruction int     // Size of dynamic candidate list (typically 100-400)
	EfSearch       int     // Size of search beam (typically 100-500)
	MaxLevel       int     // Maximum layer (auto-calculated if 0)
	LevelMult      float64 // Level generation multiplier
}

// DefaultHNSWParams returns typical HNSW parameters
func DefaultHNSWParams() HNSWParams {
	return HNSWParams{
		M:              16,
		EfConstruction: 200,
		EfSearch:       200,
		MaxLevel:       0,
		LevelMult:      1.0 / math.Log(2.0),
	}
}

// IVFParams represents Inverted File Index parameters
type IVFParams struct {
	NClusters int // Number of clusters (typically sqrt(N) to N/100)
	NProbe    int // Number of clusters to search (typically 1-100)
}

// DefaultIVFParams returns typical IVF parameters
func DefaultIVFParams(nVectors int) IVFParams {
	nClusters := int(math.Sqrt(float64(nVectors)))
	if nClusters < 10 {
		nClusters = 10
	}

	return IVFParams{
		NClusters: nClusters,
		NProbe:    10,
	}
}

// PQParams represents Product Quantization parameters
type PQParams struct {
	NSubvectors int // Number of sub-vectors (typically 8-64)
	NBits       int // Bits per sub-vector (typically 8)
}

// DefaultPQParams returns typical PQ parameters
func DefaultPQParams() PQParams {
	return PQParams{
		NSubvectors: 8,
		NBits:       8,
	}
}
```

### Junior → FAANG: ANN Algorithms as Interview Vocabulary

Approximate nearest neighbor (ANN) algorithms are the engineering solution to the computational intractability of exact nearest neighbor search in high dimensions. Knowing the three main algorithm families positions you well for vector database architecture questions: HNSW (Hierarchical Navigable Small World, a graph-based algorithm that builds a multi-layer proximity graph and navigates it during search), IVF (Inverted File Index, a clustering-based algorithm that partitions the vector space into clusters and searches only the relevant clusters), and product quantization (compresses vectors to reduce memory footprint at the cost of some precision). HNSW is the default choice for most production deployments because it offers the best recall-latency tradeoff. Be precise about what it costs, though, because this is a favourite follow-up: HNSW is *memory-hungry*, and it wants the graph and the vectors resident in RAM. Its speed comes from cheap random access while traversing the graph, and random access to disk is exactly what HNSW is bad at. Saying that HNSW "does not require the dataset to fit in memory" gets the algorithm's defining weakness backwards. Memory pressure is precisely why teams reach for quantization, for IVF variants, or for disk-aware indexes once a dataset outgrows one machine's RAM.

The recall-versus-latency tradeoff is the most common tradeoff discussion in vector database engineering interviews. Exact search guarantees 100% recall but scans everything. ANN search reduces latency at the cost of some recall. Three parameters tune it, and you should know which axis each one moves:

- **`M`** (edges per node) is set at build time and cannot be changed without rebuilding. It raises recall and raises memory roughly linearly.
- **`ef_construction`** (candidate list size during build) buys a better-quality graph with longer build time. It costs nothing at query time. Free recall later, paid for once, which is why it is usually worth setting generously.
- **`ef_search`** (search beam width) is the *runtime* knob, tunable per query without touching the index. It trades latency for recall directly and must be at least `k`.

The asymmetry is the insight: `ef_search` is the dial you turn in production, `M` and `ef_construction` are decisions you live with until the next rebuild. Quote recall figures only alongside the dataset and parameters that produced them - "HNSW gets 95-99% recall" is meaningless without saying at what `ef_search`, on which data, at what dimensionality.

The curse of dimensionality is the mathematical reason why vector search is not trivially solved by traditional indexing structures like B-trees or hash maps. In high-dimensional spaces, data points become increasingly equidistant from each other, making the nearest neighbor problem statistically challenging. Understanding this principle, and why it motivates the ANN algorithm families rather than adapting exact search techniques, demonstrates mathematical sophistication that differentiates strong vector database candidates.

### Senior @ FAANG: Index Design as Production Engineering

Index design for a production vector database requires understanding the full parameter space and its impact on the system's SLOs. HNSW's M parameter (graph connectivity) has a linear impact on memory consumption: doubling M doubles the memory required by the graph structure. The ef parameter (search beam width) has a roughly linear impact on query latency: increasing ef from 50 to 200 may quadruple search latency while improving recall from 90% to 99%. These relationships must be measured on your specific data distribution, not assumed from benchmarks on different datasets.

Index update dynamics are a critical production concern. HNSW does not support efficient vector deletion: deleted vectors are marked as deleted but remain in the graph, consuming memory and degrading search precision over time. Production systems that require frequent updates must plan for periodic index rebuilds to remove deleted vectors and reclaim memory. The rebuild frequency and the latency impact of rebuilding (or switching to a new index while the old one serves traffic) must be designed into the operational model.

At L6, index governance includes the policy for index versioning and compatibility. When the embedding model changes (a new model version produces different vector dimensions or different semantic representations), the index must be rebuilt from scratch because the new vectors are not comparable to the old ones. This rebuild may require generating new embeddings for the entire corpus (significant API cost and time), and the transition from the old index to the new one must be done with zero downtime (using blue-green index deployment). Designing and documenting this migration procedure before the first model upgrade saves significant operational pain and is a staff-level forward-planning contribution.

Metadata filtering efficiency is a production concern that many teams discover too late, and the two naive strategies each fail in a different, instructive way.

**Post-filtering** runs the ANN search first and discards non-matching results afterwards. Its failure is under-return: ask for the top 10 documents belonging to one tenant, and if none of the global top 10 belong to that tenant, you get zero results. Not wrong results, *no* results, from a search over a corpus that contains thousands of matching documents. Over-fetching (retrieve 10×k and hope) makes this less likely without fixing it, and its cost scales inversely with filter selectivity, so it collapses exactly when the filter is most selective.

**Pre-filtering** restricts the candidate set first, so it cannot under-return. Its failure is subtler and more interesting: it breaks the graph. HNSW navigates by hopping between connected neighbours, and if most nodes are filtered out, the surviving nodes may not be reachable from each other. The traversal stalls in a disconnected fragment and recall silently collapses, even though the answer was sitting in the index. This is why highly selective filters are the pathological case for graph indexes, and why a brute-force scan over the filtered subset is often genuinely faster and always more accurate once the filter is selective enough.

Real systems therefore do neither in the naive form. They integrate the filter *into* the traversal, evaluating predicates as the search walks the graph so the beam only ever considers eligible nodes, and they fall back to an exact scan when the filter is selective enough to make that cheaper. When you evaluate a vector database, "how does filtering interact with the index" is the question that separates the mature engines from the ones that will surprise you, and "we post-filter" is a red flag worth pushing on.

For the common multi-tenant case there is a fourth answer that beats all of this: partition by tenant, so the filter becomes a routing decision rather than a predicate, and every search runs against an index that contains only eligible vectors.
