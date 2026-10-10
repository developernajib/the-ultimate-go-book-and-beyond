## 116.9 Semantic Search Implementation

Vector embeddings represent semantic meaning as high-dimensional floating-point arrays, enabling similarity search and document clustering without keyword matching. The code below demonstrates embedding generation, cosine similarity computation, and efficient nearest-neighbor lookup for document retrieval.

```go
// pkg/search/semantic.go
package search

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/yourusername/gobook/pkg/embeddings"
	"github.com/yourusername/gobook/pkg/vectordb"
)

// SemanticSearchConfig configures semantic search
type SemanticSearchConfig struct {
	TopK           int
	ScoreThreshold float32
	CacheSize      int
	CacheTTL       time.Duration
}

// DefaultSemanticSearchConfig returns default configuration
func DefaultSemanticSearchConfig() SemanticSearchConfig {
	return SemanticSearchConfig{
		TopK:           10,
		ScoreThreshold: 0.7,
		CacheSize:      1000,
		CacheTTL:       1 * time.Hour,
	}
}

// SemanticSearch provides semantic search functionality
type SemanticSearch struct {
	config   SemanticSearchConfig
	embedder embeddings.Embedder
	store    vectordb.VectorStore
	cache    *ResultCache
}

// NewSemanticSearch creates a new semantic search engine
func NewSemanticSearch(config SemanticSearchConfig, embedder embeddings.Embedder, store vectordb.VectorStore) *SemanticSearch {
	return &SemanticSearch{
		config:   config,
		embedder: embedder,
		store:    store,
		cache:    NewResultCache(config.CacheSize, config.CacheTTL),
	}
}

// Search performs semantic search
func (s *SemanticSearch) Search(ctx context.Context, query string, filters map[string]any) ([]SearchResult, error) {
	// Check cache
	cacheKey := s.cache.Key(query, filters)
	if cached, ok := s.cache.Get(cacheKey); ok {
		return cached, nil
	}

	// Generate query embedding
	embedding, err := s.embedder.EmbedSingle(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embedding query: %w", err)
	}

	// Search vector store
	resp, err := s.store.Query(ctx, embedding, s.config.TopK, filters)
	if err != nil {
		return nil, fmt.Errorf("querying vector store: %w", err)
	}

	// Convert to search results
	results := make([]SearchResult, 0)
	for _, r := range resp.Results {
		if r.Score >= s.config.ScoreThreshold {
			results = append(results, SearchResult{
				ID:       r.ID,
				Text:     r.Text,
				Score:    r.Score,
				Metadata: r.Metadata,
			})
		}
	}

	// Cache results
	s.cache.Set(cacheKey, results)

	return results, nil
}

// SearchResult represents a search result
type SearchResult struct {
	ID       string
	Text     string
	Score    float32
	Metadata map[string]any
}

// ResultCache caches search results
type ResultCache struct {
	mu      sync.RWMutex
	cache   map[string]cacheEntry
	maxSize int
	ttl     time.Duration
}

type cacheEntry struct {
	results   []SearchResult
	expiresAt time.Time
}

// NewResultCache creates a new result cache
func NewResultCache(maxSize int, ttl time.Duration) *ResultCache {
	cache := &ResultCache{
		cache:   make(map[string]cacheEntry),
		maxSize: maxSize,
		ttl:     ttl,
	}

	// Start cleanup goroutine
	go cache.cleanup()

	return cache
}

// Key generates a cache key
func (c *ResultCache) Key(query string, filters map[string]any) string {
	// Simple implementation - production should use better hashing
	key := query
	for k, v := range filters {
		key += fmt.Sprintf("_%s=%v", k, v)
	}
	return key
}

// Get retrieves cached results
func (c *ResultCache) Get(key string) ([]SearchResult, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, ok := c.cache[key]
	if !ok {
		return nil, false
	}

	if time.Now().After(entry.expiresAt) {
		return nil, false
	}

	return entry.results, true
}

// Set stores results in cache
func (c *ResultCache) Set(key string, results []SearchResult) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Simple eviction: if at max size, clear everything
	// Production should use LRU or similar
	if len(c.cache) >= c.maxSize {
		c.cache = make(map[string]cacheEntry)
	}

	c.cache[key] = cacheEntry{
		results:   results,
		expiresAt: time.Now().Add(c.ttl),
	}
}

// cleanup removes expired entries
func (c *ResultCache) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for key, entry := range c.cache {
			if now.After(entry.expiresAt) {
				delete(c.cache, key)
			}
		}
		c.mu.Unlock()
	}
}

// MultiSearch searches across multiple indices/namespaces
func (s *SemanticSearch) MultiSearch(ctx context.Context, query string, namespaces []string) (map[string][]SearchResult, error) {
	// Generate query embedding once
	embedding, err := s.embedder.EmbedSingle(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("embedding query: %w", err)
	}

	// Search each namespace in parallel
	type namespaceResult struct {
		namespace string
		results   []SearchResult
		err       error
	}

	resultsChan := make(chan namespaceResult, len(namespaces))

	for _, ns := range namespaces {
		go func(namespace string) {
			// Note: actual implementation depends on vector store's namespace support
			resp, err := s.store.Query(ctx, embedding, s.config.TopK, map[string]any{"namespace": namespace})

			if err != nil {
				resultsChan <- namespaceResult{namespace: namespace, err: err}
				return
			}

			results := make([]SearchResult, 0)
			for _, r := range resp.Results {
				if r.Score >= s.config.ScoreThreshold {
					results = append(results, SearchResult{
						ID:       r.ID,
						Text:     r.Text,
						Score:    r.Score,
						Metadata: r.Metadata,
					})
				}
			}

			resultsChan <- namespaceResult{namespace: namespace, results: results}
		}(ns)
	}

	// Collect results
	allResults := make(map[string][]SearchResult)
	for i := 0; i < len(namespaces); i++ {
		result := <-resultsChan
		if result.err != nil {
			return nil, fmt.Errorf("searching namespace %s: %w", result.namespace, result.err)
		}
		allResults[result.namespace] = result.results
	}

	return allResults, nil
}
```

### Junior → FAANG: Semantic Search as a Practical Portfolio Project

Semantic search is one of the most interview-demonstrable AI capabilities because the value is immediately visible: search for "email authentication setup" and retrieve documents about SMTP configuration, SPF records, and DKIM signing even if none of those exact words appear in the query. Building a semantic search system over a corpus you care about (your company's internal documentation, a public technical Q&A dataset, a product catalog) and deploying it as a small web application gives you a concrete demonstration for interviews.

The implementation in this section shows the core pattern: embed the query, find the nearest neighbors, return the results with their similarity scores. The key details to add for production quality are: query-time embedding caching (cache the embedding for frequently repeated queries to avoid redundant API calls), result reranking (use a cross-encoder model or the LLM itself to rerank the top-k results for improved precision), and hybrid search (combine vector results with BM25 keyword results for better coverage of specific terms).

For interviews, practice computing cosine similarity from scratch in Go without a library: compute the dot product of the two vectors (sum of element-wise products), divide by the product of their norms (sqrt of sum of squares). This 10-line function demonstrates mathematical understanding and practical Go skills simultaneously. An interviewer who sees this implemented correctly and concisely knows you understand what the vector database is doing internally.

### Senior @ FAANG: Semantic Search Quality at Scale

Retrieval quality evaluation for semantic search requires a labeled benchmark dataset: a set of (query, set of relevant documents) pairs where the relevant documents have been identified by human judgment or proxy metrics (clicks, positive feedback). The standard metrics are Precision@k (fraction of top-k results that are relevant), Recall@k (fraction of relevant documents that appear in top-k), and NDCG (normalized discounted cumulative gain, which weights highly-ranked relevant results more than lower-ranked ones). Building this benchmark and running it automatically on each system configuration change is the only reliable way to measure and improve retrieval quality.

Query understanding preprocessing can significantly improve retrieval quality for noisy or ambiguous queries. A user query "how do I fix the error I keep getting when I try to login?" is semantically imprecise and likely to retrieve suboptimal results. Preprocessing the query with an LLM (expand acronyms, resolve pronouns, reformulate as a declarative statement: "fix login authentication error") before embedding often improves retrieval recall by 10-20%. This query preprocessing pipeline adds latency (an additional LLM call) but can be made fast with a small, fast model and query-level caching.

At L6, semantic search infrastructure includes access control at the retrieval layer. In a multi-tenant enterprise search system, user A should only be able to search documents they have permission to read. Implementing access control in the vector database (using metadata filters to restrict search to documents the user is authorized to read) requires that document permissions are stored as metadata alongside the vector, and that the metadata filter is applied at query time based on the authenticated user's access level. This access-controlled retrieval is a security requirement for any enterprise search system and must be designed into the architecture from the start.
