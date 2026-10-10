## 37D.9 MongoDB Atlas & Vector Search

### Atlas Search (Full-Text)

MongoDB Atlas Search runs an Apache Lucene engine alongside the database, exposed through the `$search` aggregation stage. This gives you full-text search with fuzzy matching, autocomplete, faceted counts, and relevance scoring without deploying a separate Elasticsearch cluster. The example below builds a compound search query with category filtering, price range constraints, and result highlighting.

```go
package mongodb

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// AtlasSearchService uses Atlas Search aggregation operators
type AtlasSearchService struct {
	collection *mongo.Collection
}

// SearchProducts performs Atlas full-text search with facets
func (s *AtlasSearchService) SearchProducts(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	pipeline := mongo.Pipeline{
		// Atlas $search stage
		{{Key: "$search", Value: bson.D{
			{Key: "index", Value: "product_search"},
			{Key: "compound", Value: bson.D{
				{Key: "must", Value: bson.A{
					bson.D{{Key: "text", Value: bson.D{
						{Key: "query", Value: req.Query},
						{Key: "path", Value: bson.A{"name", "description", "tags"}},
						{Key: "fuzzy", Value: bson.D{{Key: "maxEdits", Value: 1}}},
					}}},
				}},
				{Key: "filter", Value: func() bson.A {
					filters := bson.A{}
					if req.Category != "" {
						filters = append(filters, bson.D{{Key: "equals", Value: bson.D{
							{Key: "value", Value: req.Category},
							{Key: "path", Value: "category"},
						}}})
					}
					if req.MinPriceCents > 0 {
						filters = append(filters, bson.D{{Key: "range", Value: bson.D{
							{Key: "path", Value: "price_cents"},
							{Key: "gte", Value: req.MinPriceCents},
							{Key: "lte", Value: req.MaxPriceCents},
						}}})
					}
					return filters
				}()},
			}},
			// Autocomplete highlighting
			{Key: "highlight", Value: bson.D{
				{Key: "path", Value: "name"},
			}},
		}}},

		// Add search score
		{{Key: "$addFields", Value: bson.D{
			{Key: "score", Value: bson.D{{Key: "$meta", Value: "searchScore"}}},
			{Key: "highlights", Value: bson.D{{Key: "$meta", Value: "searchHighlights"}}},
		}}},

		// Facet: get results + category counts
		{{Key: "$facet", Value: bson.D{
			{Key: "results", Value: bson.A{
				bson.D{{Key: "$skip", Value: req.Offset}},
				bson.D{{Key: "$limit", Value: req.Limit}},
				bson.D{{Key: "$project", Value: bson.D{
					{Key: "name", Value: 1},
					{Key: "price_cents", Value: 1},
					{Key: "category", Value: 1},
					{Key: "score", Value: 1},
					{Key: "highlights", Value: 1},
				}}},
			}},
			{Key: "total", Value: bson.A{
				bson.D{{Key: "$count", Value: "count"}},
			}},
			{Key: "categories", Value: bson.A{
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$category"},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
				bson.D{{Key: "$sort", Value: bson.D{{Key: "count", Value: -1}}}},
				bson.D{{Key: "$limit", Value: 10}},
			}},
		}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fmt.Errorf("atlas search: %w", err)
	}
	defer cursor.Close(ctx)

	var raw []struct {
		Results    []ProductResult `bson:"results"`
		Total      []struct{ Count int `bson:"count"` } `bson:"total"`
		Categories []struct {
			ID    string `bson:"_id"`
			Count int    `bson:"count"`
		} `bson:"categories"`
	}

	if err := cursor.All(ctx, &raw); err != nil {
		return nil, err
	}

	result := &SearchResult{}
	if len(raw) > 0 {
		result.Products = raw[0].Results
		if len(raw[0].Total) > 0 {
			result.Total = raw[0].Total[0].Count
		}
		for _, cat := range raw[0].Categories {
			result.Facets = append(result.Facets, FacetItem{Name: cat.ID, Count: cat.Count})
		}
	}
	return result, nil
}

// Vector search for AI/semantic search
// Atlas Vector Search uses approximate nearest neighbor (ANN) algorithms
// to find documents whose embedding vectors are closest to the query vector.
func (s *AtlasSearchService) SemanticSearch(ctx context.Context, embedding []float32, limit int) ([]Product, error) {
	pipeline := mongo.Pipeline{
		{{Key: "$vectorSearch", Value: bson.D{
			{Key: "index", Value: "product_embedding"},
			{Key: "path", Value: "embedding"},
			{Key: "queryVector", Value: embedding},
			{Key: "numCandidates", Value: limit * 10}, // oversampling for accuracy
			{Key: "limit", Value: limit},
			// Optional: pre-filter
			{Key: "filter", Value: bson.D{{Key: "active", Value: true}}},
		}}},
		{{Key: "$addFields", Value: bson.D{
			{Key: "similarity_score", Value: bson.D{{Key: "$meta", Value: "vectorSearchScore"}}},
		}}},
		{{Key: "$project", Value: bson.D{
			{Key: "name", Value: 1},
			{Key: "description", Value: 1},
			{Key: "price_cents", Value: 1},
			{Key: "similarity_score", Value: 1},
			{Key: "embedding", Value: 0}, // exclude vector from results
		}}},
	}

	cursor, err := s.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var products []Product
	return products, cursor.All(ctx, &products)
}

type SearchRequest struct {
	Query         string
	Category      string
	MinPriceCents int64
	MaxPriceCents int64
	Offset        int64
	Limit         int64
}

type SearchResult struct {
	Products []ProductResult
	Total    int
	Facets   []FacetItem
}

type ProductResult struct {
	ID         bson.ObjectID `bson:"_id"`
	Name       string        `bson:"name"`
	PriceCents int64         `bson:"price_cents"`
	Category   string        `bson:"category"`
	Score      float64       `bson:"score"`
	Highlights []bson.M      `bson:"highlights"`
}

type FacetItem struct {
	Name  string
	Count int
}
```

### Atlas Vector Search Internals (HNSW) and Hybrid Search

Atlas Vector Search is built on Lucene's HNSW (Hierarchical Navigable Small World) graph index, giving sub-linear approximate-nearest-neighbor retrieval over millions or billions of embedding vectors. The `numCandidates` parameter controls the HNSW exploration factor: higher values increase recall (closer to exact nearest neighbors) at proportional latency cost. A rule of thumb is `numCandidates = 10 * limit` for balanced quality, and `20-50 * limit` for high-recall use cases like RAG grounding.

MongoDB 8.0 expanded vector search with scalar quantization (4x memory reduction versus float32 with minimal recall loss) and BSON binary vector types (`bson.Binary` with `SubtypeBinary = 9`). For production RAG workloads at scale, quantize embeddings at ingestion and rely on the HNSW graph to preserve recall.

**Hybrid search** combines BM25 lexical scoring ($search) with vector similarity ($vectorSearch) to recover results that pure semantic search misses (exact keyword matches, product SKUs, proper nouns). As of 2025, Atlas provides two native score-combination stages:

- **`$rankFusion`** - reciprocal-rank fusion. Works well out of the box without tuning.
- **`$scoreFusion`** - normalized weighted average. gives finer control when you understand your relevance signals.

```go
// Hybrid search combining lexical + vector with $rankFusion (Atlas 2025+)
func (s *AtlasSearchService) HybridSearch(ctx context.Context, query string, embedding []float32, limit int) ([]ProductResult, error) {
    pipeline := mongo.Pipeline{
        {{Key: "$rankFusion", Value: bson.D{
            {Key: "input", Value: bson.D{
                {Key: "pipelines", Value: bson.D{
                    // Branch 1: full-text search (BM25)
                    {Key: "lexical", Value: bson.A{
                        bson.D{{Key: "$search", Value: bson.D{
                            {Key: "index", Value: "product_search"},
                            {Key: "text", Value: bson.D{
                                {Key: "query", Value: query},
                                {Key: "path", Value: bson.A{"name", "description"}},
                            }},
                        }}},
                        bson.D{{Key: "$limit", Value: limit * 5}},
                    }},
                    // Branch 2: vector search (HNSW)
                    {Key: "semantic", Value: bson.A{
                        bson.D{{Key: "$vectorSearch", Value: bson.D{
                            {Key: "index", Value: "product_embedding"},
                            {Key: "path", Value: "embedding"},
                            {Key: "queryVector", Value: embedding},
                            {Key: "numCandidates", Value: limit * 20},
                            {Key: "limit", Value: limit * 5},
                        }}},
                    }},
                }},
            }},
            {Key: "combination", Value: bson.D{
                {Key: "weights", Value: bson.D{
                    {Key: "lexical", Value: 0.4},
                    {Key: "semantic", Value: 0.6},
                }},
            }},
        }}},
        {{Key: "$limit", Value: limit}},
        {{Key: "$project", Value: bson.D{
            {Key: "name", Value: 1},
            {Key: "price_cents", Value: 1},
            {Key: "embedding", Value: 0},
        }}},
    }

    cursor, err := s.collection.Aggregate(ctx, pipeline)
    if err != nil {
        return nil, fmt.Errorf("hybrid search: %w", err)
    }
    defer cursor.Close(ctx)

    var results []ProductResult
    return results, cursor.All(ctx, &results)
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

Before you can use `$vectorSearch` meaningfully you need three prerequisites. First, an embedding model. OpenAI `text-embedding-3-small` (1536 dims) and `text-embedding-3-large` (3072 dims), Cohere `embed-v3` (1024 dims), and open models like `bge-large` (1024 dims) are the common choices in 2026. Second, a place to compute the embeddings, usually a worker that reads documents, calls the model, and writes the vector back. Third, an Atlas Search index definition with `type: "vector"`, a path, a dimension count, and a similarity function (`cosine`, `euclidean`, or `dotProduct`). Without that index the `$vectorSearch` stage returns nothing with a cryptic error.

A first-job pattern: a product team wants "search that understands synonyms". You embed every product name and description at ingest time, store the vector in a `embedding` field, and expose a `/semantic-search` endpoint that embeds the user's query and runs `$vectorSearch`. Within a week the team asks "why does searching for a SKU return unrelated products". That is the moment you learn hybrid search exists. Pure vector search is bad at exact tokens. You combine `$search` (BM25, exact) with `$vectorSearch` (semantic) using `$rankFusion`. This is the canonical junior-to-mid progression and a staple interview story.

Entry-level interview questions in 2026 usually cover: what is `numCandidates` versus `limit`, why is a vector index different from a regular index, and why would you pre-filter with `filter` inside `$vectorSearch` rather than a downstream `$match`. The answer to the last one is that pre-filtering inside the HNSW traversal preserves the `limit` semantics, while a post-`$match` can return fewer than `limit` documents because HNSW already selected only `limit` nearest neighbors.

### Senior at FAANG: Staff and Principal Material

**HNSW internals and the numCandidates knob.** HNSW is a layered proximity graph. Search starts at the top sparse layer and descends, greedily following edges that reduce distance to the query vector. `numCandidates` is the beam width at the bottom layer. Too small and recall collapses. Too large and latency grows linearly. The staff-level approach is to measure recall against a held-out ground-truth set (usually 1,000 queries with known exact neighbors computed via brute force) and tune `numCandidates` to hit a target recall, typically 0.95. Log the measured recall per deployment so re-indexing does not silently regress it.

**Filter-then-vector versus vector-then-filter.** `$vectorSearch` supports `filter` as a pre-filter applied during graph traversal. Pre-filtering is correct when the filter is selective enough that HNSW can still find `numCandidates` matching neighbors inside the graph. When the filter is extremely selective (say one percent of corpus), HNSW wastes effort and may fall back to brute force. In that regime a ranged index on the filter field plus a `$match` followed by brute-force cosine is often faster. Atlas exposes `$vectorSearch` explain output. Always inspect it before shipping a filter-heavy vector query.

**Vector dimension trade-offs.** 768 dimensions (BERT-class) use half the RAM of 1536-dim OpenAI small and roughly two-thirds the query latency, at the cost of typically two to five points of MRR on retrieval benchmarks. 1024 is the sweet spot for most RAG deployments in production today. 1536 and 3072 give marginal quality gains for markedly higher cost. At principal level you quantify the gain per dollar: how much does going from 1024 to 1536 move your downstream LLM answer-correctness metric, divided by the extra RAM, index build time, and query latency.

**Quantization.** MongoDB 8.0 supports scalar quantization (int8) and binary quantization. int8 gives roughly 4x memory reduction with under one percent recall loss on most embedding distributions. Binary quantization gives 32x reduction with larger recall loss, usable as a coarse first-stage retrieval followed by a float32 re-rank over the top-k. The BSON binary-vector subtype 9 stores vectors compactly, avoids array decoding overhead, and is the default since Go driver v2.

**Atlas-only features you should know exist.** Atlas Search, Atlas Vector Search, Atlas Stream Processing (managed Kafka-equivalent with MongoDB-native aggregation), Triggers (function-as-a-service on change events), Data Lake (federated queries across Atlas clusters and S3), Online Archive (tiered storage moving cold data to cheaper object storage with transparent query), and Queryable Encryption. None of these run on self-hosted MongoDB. If you build on them you accept Atlas lock-in. At principal level this is a documented ADR with an exit-cost section.

**Hybrid search scoring.** `$rankFusion` uses reciprocal rank fusion, `score_i = sum(1 / (k + rank_i))` with default k=60. It is parameter-free and reliable when you do not know the relative strength of your signals. `$scoreFusion` normalizes raw scores (BM25 and cosine live in different ranges) and takes weights. Prefer `$rankFusion` until you have offline evaluation data that tells you which signal to weight higher. For agentic RAG the common pipeline is: embed the query, run hybrid search with pre-filter on tenant and document-type, take top 50, re-rank with a cross-encoder (Cohere Rerank or an in-house model), pass top 10 to the LLM. Each stage is a separate SLI.

**Cost and index rebuild.** Atlas Vector Search indexes rebuild online, but rebuild time scales with corpus size and HNSW parameters (`numConnections`, `dimensions`). A one-billion-vector index can take days to build and gigabytes of memory per shard. Budget index builds as infrastructure operations, version your index definitions in code, and make rebuilds blue-green with a read alias rather than dropping and recreating.

---
