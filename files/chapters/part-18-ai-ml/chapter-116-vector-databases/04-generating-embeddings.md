## 116.3 Generating Embeddings

### OpenAI Embeddings

OpenAI's embedding API converts text into dense floating-point vectors that capture semantic meaning. The client below wraps the API with rate limiting, batching for large document sets, and automatic retries on transient failures.

```go
// pkg/embeddings/openai.go
package embeddings

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/sashabaranov/go-openai"
	"golang.org/x/time/rate"
)

// EmbeddingModel represents different embedding models.
//
// Prices are indicative only and drift - check the provider's pricing page.
// Model IDs belong in configuration, because changing one is not a config tweak
// but a full corpus re-embed (see the versioning discussion below).
type EmbeddingModel string

const (
	// OpenAI models
	TextEmbedding3Small EmbeddingModel = "text-embedding-3-small" // 1536 dims
	TextEmbedding3Large EmbeddingModel = "text-embedding-3-large" // 3072 dims

	// TextEmbeddingAda002 is the previous generation. Do not choose it for new
	// work: the -3 family is both cheaper and better on retrieval benchmarks,
	// and ada-002 does not support dimension reduction. It appears here only
	// because you will meet it in existing indexes that predate the -3 models,
	// and because recognising it tells you an index is due for a re-embed.
	TextEmbeddingAda002 EmbeddingModel = "text-embedding-ada-002" // 1536 dims, legacy
)

// OpenAIConfig configures the OpenAI embedding service
type OpenAIConfig struct {
	APIKey     string
	Model      EmbeddingModel
	MaxRetries int
	RateLimit  int // Requests per minute
	Timeout    time.Duration
	Dimensions int // Optional: reduce dimensions (only for text-embedding-3-*)
}

// OpenAIEmbedder generates embeddings using OpenAI's API
type OpenAIEmbedder struct {
	client  *openai.Client
	config  OpenAIConfig
	limiter *rate.Limiter
}

// NewOpenAIEmbedder creates a new OpenAI embedding service
func NewOpenAIEmbedder(config OpenAIConfig) *OpenAIEmbedder {
	if config.MaxRetries == 0 {
		config.MaxRetries = 3
	}
	if config.RateLimit == 0 {
		config.RateLimit = 3000 // 3000 RPM default
	}
	if config.Timeout == 0 {
		config.Timeout = 30 * time.Second
	}

	client := openai.NewClient(config.APIKey)

	// Rate limiter: allow burst of 10, refill at RateLimit per minute
	limiter := rate.NewLimiter(rate.Limit(float64(config.RateLimit)/60.0), 10)

	return &OpenAIEmbedder{
		client:  client,
		config:  config,
		limiter: limiter,
	}
}

// Embed generates embeddings for multiple texts
func (e *OpenAIEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, fmt.Errorf("no texts provided")
	}

	// Batch size is bounded by TWO limits, not one: a maximum number of inputs
	// per request AND a maximum total tokens per request. Chunking only on the
	// input count silently violates the token ceiling as soon as the documents
	// are long, and the whole batch 400s. A production splitter accumulates
	// estimated tokens and cuts on whichever limit binds first. Verify both
	// numbers against current docs rather than trusting this constant.
	const maxBatchSize = 2048

	var allEmbeddings [][]float32

	for i := 0; i < len(texts); i += maxBatchSize {
		end := i + maxBatchSize
		if end > len(texts) {
			end = len(texts)
		}

		batch := texts[i:end]
		embeddings, err := e.embedBatch(ctx, batch)
		if err != nil {
			return nil, fmt.Errorf("embedding batch %d-%d: %w", i, end, err)
		}

		allEmbeddings = append(allEmbeddings, embeddings...)
	}

	return allEmbeddings, nil
}

// embedBatch embeds a single batch with rate limiting and retries
func (e *OpenAIEmbedder) embedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	// Wait for rate limiter
	if err := e.limiter.Wait(ctx); err != nil {
		return nil, fmt.Errorf("rate limiter: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < e.config.MaxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff
			backoff := time.Duration(attempt*attempt) * time.Second
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		embeddings, err := e.createEmbedding(ctx, texts)
		if err == nil {
			return embeddings, nil
		}

		lastErr = err

		// Don't retry on context cancellation or invalid input
		if ctx.Err() != nil || isNonRetryableError(err) {
			return nil, err
		}
	}

	return nil, fmt.Errorf("failed after %d attempts: %w", e.config.MaxRetries, lastErr)
}

// createEmbedding makes the actual API call
func (e *OpenAIEmbedder) createEmbedding(ctx context.Context, texts []string) ([][]float32, error) {
	ctx, cancel := context.WithTimeout(ctx, e.config.Timeout)
	defer cancel()

	req := openai.EmbeddingRequestStrings{
		Input: texts,
		Model: openai.EmbeddingModel(e.config.Model),
	}

	// Set dimensions if specified (only works with text-embedding-3-*)
	if e.config.Dimensions > 0 {
		req.Dimensions = e.config.Dimensions
	}

	resp, err := e.client.CreateEmbeddings(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("create embeddings: %w", err)
	}

	if len(resp.Data) != len(texts) {
		return nil, fmt.Errorf("expected %d embeddings, got %d", len(texts), len(resp.Data))
	}

	embeddings := make([][]float32, len(resp.Data))
	for i, data := range resp.Data {
		embeddings[i] = data.Embedding
	}

	return embeddings, nil
}

// EmbedSingle embeds a single text (convenience method)
func (e *OpenAIEmbedder) EmbedSingle(ctx context.Context, text string) ([]float32, error) {
	embeddings, err := e.Embed(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	return embeddings[0], nil
}

// GetDimensions returns the embedding dimensions for the configured model
func (e *OpenAIEmbedder) GetDimensions() int {
	if e.config.Dimensions > 0 {
		return e.config.Dimensions
	}

	switch e.config.Model {
	case TextEmbedding3Small, TextEmbeddingAda002:
		return 1536
	case TextEmbedding3Large:
		return 3072
	default:
		return 1536
	}
}

// isNonRetryableError reports whether err is permanent and must not be retried.
//
// Returning false unconditionally, with a comment claiming that retrying
// everything is "conservative", inverts the meaning of the word. Retrying a 401
// three times does not recover anything: it sends three requests with the same
// bad key, triples your error rate, and delays the real error reaching the
// caller by the full backoff. Conservative means retrying only what can
// plausibly succeed.
func isNonRetryableError(err error) bool {
	var apiErr *openai.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.HTTPStatusCode {
		case http.StatusTooManyRequests, // 429: transient by definition
			http.StatusRequestTimeout:
			return false
		default:
			// 5xx are worth another attempt - every other 4xx is permanent.
			return apiErr.HTTPStatusCode < 500
		}
	}
	// Unclassified (transport-level) errors get a retry.
	return false
}

// EmbeddingCache provides caching for embeddings.
//
// Three deliberate design points, each of which the obvious implementation
// gets wrong:
//
//  1. The mutex is not optional. An embedder is called concurrently by
//     definition (that is the entire reason to batch), and Go's built-in map
//     is not safe for concurrent use. Racing writers do not corrupt quietly,
//     they abort the process with "fatal error: concurrent map writes", which
//     is unrecoverable: no panic to catch, no defer to run.
//
//  2. The key is a HASH of the text, not the text. Using the document itself
//     as the map key stores a second full copy of the entire corpus in RAM,
//     so the cache grows to the size of the thing it is meant to make cheap.
//     A 32-byte digest is bounded regardless of document size.
//
//  3. Real deployments need eviction and a shared tier. This map grows without
//     limit until the process is OOM-killed, and it is per-process, so every
//     replica pays to re-embed text its siblings have already embedded. Put an
//     LRU in front and Redis behind it. Content-addressed keys make the shared
//     tier trivial, since the hash is the same on every replica.
type EmbeddingCache struct {
	embedder Embedder
	mu       sync.RWMutex
	cache    map[string][]float32
}

// Embedder interface for different embedding providers
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	EmbedSingle(ctx context.Context, text string) ([]float32, error)
	GetDimensions() int
}

// NewEmbeddingCache creates a cached embedder
func NewEmbeddingCache(embedder Embedder) *EmbeddingCache {
	return &EmbeddingCache{
		embedder: embedder,
		cache:    make(map[string][]float32),
	}
}

// cacheKey returns a content-addressed key for text.
//
// Include the model and dimension in the key. Embeddings from different models
// are not interchangeable, and a cache keyed on text alone will happily serve a
// vector from the OLD model after you upgrade, silently mixing two incompatible
// spaces in one index. That corrupts retrieval quality in a way that looks like
// "the new model is worse" and costs days to track down.
func (ec *EmbeddingCache) cacheKey(text string) string {
	sum := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%d:%x", ec.embedder.GetDimensions(), sum)
}

// EmbedSingle embeds with caching
func (ec *EmbeddingCache) EmbedSingle(ctx context.Context, text string) ([]float32, error) {
	key := ec.cacheKey(text)

	ec.mu.RLock()
	cached, ok := ec.cache[key]
	ec.mu.RUnlock()
	if ok {
		return cached, nil
	}

	embedding, err := ec.embedder.EmbedSingle(ctx, text)
	if err != nil {
		return nil, err
	}

	ec.mu.Lock()
	ec.cache[key] = embedding
	ec.mu.Unlock()

	return embedding, nil
}

// Embed embeds multiple texts with caching, preserving input order.
//
// The uncachedIndices bookkeeping is what keeps output aligned with input: the
// embedder is handed only the cache misses, so its results come back in a
// COMPACTED order that no longer corresponds to the caller's slice. Writing
// embeddings[i] = newEmbeddings[i] would scatter vectors onto the wrong
// documents, and every one of them is a plausible-looking float slice, so
// nothing fails. You just get a silently mis-indexed corpus.
func (ec *EmbeddingCache) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	embeddings := make([][]float32, len(texts))
	var uncachedTexts []string
	var uncachedIndices []int

	// Check cache
	ec.mu.RLock()
	for i, text := range texts {
		if cached, ok := ec.cache[ec.cacheKey(text)]; ok {
			embeddings[i] = cached
		} else {
			uncachedTexts = append(uncachedTexts, text)
			uncachedIndices = append(uncachedIndices, i)
		}
	}
	ec.mu.RUnlock()

	// Embed uncached texts
	if len(uncachedTexts) > 0 {
		newEmbeddings, err := ec.embedder.Embed(ctx, uncachedTexts)
		if err != nil {
			return nil, err
		}
		if len(newEmbeddings) != len(uncachedTexts) {
			return nil, fmt.Errorf("embedder returned %d vectors for %d texts",
				len(newEmbeddings), len(uncachedTexts))
		}

		ec.mu.Lock()
		for i, embedding := range newEmbeddings {
			ec.cache[ec.cacheKey(uncachedTexts[i])] = embedding
			embeddings[uncachedIndices[i]] = embedding
		}
		ec.mu.Unlock()
	}

	return embeddings, nil
}

// GetDimensions returns the embedding dimensions
func (ec *EmbeddingCache) GetDimensions() int {
	return ec.embedder.GetDimensions()
}

// ClearCache clears the embedding cache
func (ec *EmbeddingCache) ClearCache() {
	ec.mu.Lock()
	defer ec.mu.Unlock()
	ec.cache = make(map[string][]float32)
}
```

### Junior → FAANG: Embedding Generation as a Cost and Quality Engineering Problem

Embedding generation has two dimensions that every junior engineer must internalize: cost and quality. Cost scales linearly with the number of tokens you embed: a corpus of 10 million 200-token documents requires 2 billion tokens of embedding API calls, which at $0.02 per million tokens is $40. That is the one-time ingestion cost. Re-embedding when the model changes is the same cost again. Caching embeddings by content hash is the most effective cost optimization: if the same text appears multiple times (a common document template, a boilerplate header, a repeated section), compute the embedding once and reuse it. How much this saves depends entirely on how duplicated your corpus actually is, so measure the duplicate rate before you promise anyone a number. The related and larger win is incremental ingestion: hash every chunk, and on a re-index only embed the chunks whose hash you have not seen. For a corpus that changes slowly, that turns each re-ingest from a full-corpus bill into a rounding error.

Quality depends on choosing the right embedding model for your specific domain and query patterns. General-purpose embedding models (OpenAI's text-embedding-3-large, Cohere's embed-v3) perform well on broad retrieval tasks. Domain-specific models fine-tuned on your data can outperform general models significantly for specialized queries (medical literature, legal documents, code). Evaluating embedding model quality requires building a retrieval benchmark: a set of (query, relevant document) pairs, and measuring recall@k (what fraction of relevant documents appear in the top-k results). Build this benchmark before committing to an embedding model.

Batching is the key to efficient embedding generation in Go. Instead of calling the embedding API for each document individually, batch documents into groups of 100-1000 and make a single API call. Most embedding APIs accept batch inputs, and batch calls are significantly more cost-efficient (lower overhead per token) and faster (fewer network round trips). Implement the batching logic in a Go worker pool: a producer sends documents to a buffered channel, a set of workers drain the channel in batches, and each worker calls the embedding API with its batch and writes results to an output channel.

### Senior @ FAANG: Embedding Infrastructure as Platform Service

At FAANG scale, embedding generation is a shared platform service, not a per-application responsibility. The embedding service accepts text inputs, computes embeddings using a specified model, caches results by content hash, enforces rate limits per caller, and writes results to a message queue for downstream consumers to process asynchronously. This architecture decouples the embedding computation from the indexing pipeline: multiple teams can generate embeddings through the same service, benefit from the shared cache, and consume embeddings from the same queue without competing for API capacity.

Embedding versioning is a data management concern that seniors must design for from the start. When the embedding model is upgraded, all existing embeddings are obsolete because the new model produces vectors in a different semantic space. The migration plan must cover: generating new embeddings for the entire corpus (potentially billions of tokens), storing new and old embeddings simultaneously during the migration, switching query-time embedding generation to the new model atomically with the index switch, and retiring the old embeddings once the migration is complete. Designing this migration procedure before it is needed, and testing it on a subset of the corpus, is the kind of operational preparation that prevents production crises.

Multimodal embeddings (joint embeddings of text and images in the same vector space) are an emerging capability that staff engineers must evaluate for use cases involving product catalogs, media libraries, or any content where text and images provide complementary information. A user query "red sneakers" can retrieve visually similar products even if the product title uses different words, because the image embedding captures the visual semantics that the text embedding misses. Evaluating whether multimodal embeddings improve retrieval quality for your specific use case, and what infrastructure changes are required to generate and store them, is a senior-level product and infrastructure evaluation task.
