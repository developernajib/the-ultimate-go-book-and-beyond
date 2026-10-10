## 116.8 Building a RAG System

Retrieval-Augmented Generation combines vector search with LLMs to provide context-aware responses.

```go
// pkg/rag/rag.go
package rag

import (
	"context"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yourusername/gobook/pkg/embeddings"
	"github.com/yourusername/gobook/pkg/vectordb"
)

// RAGConfig configures the RAG system
type RAGConfig struct {
	// ChunkSize and ChunkOverlap are in BYTES, not characters and not tokens.
	// Three units get conflated here and the distinction matters: the embedding
	// model's limit is in TOKENS, this code slices BYTES, and a "character" is
	// a rune that may occupy several bytes. For English prose the three track
	// each other closely enough that the bug hides - for non-Latin scripts a
	// byte-sized chunk holds far fewer tokens than you assumed, and chunks come
	// out much smaller than intended.
	//
	// ChunkOverlap MUST be < ChunkSize (see chunkDocument, which enforces it).
	ChunkSize    int
	ChunkOverlap int
	TopK            int     // Number of chunks to retrieve
	ScoreThreshold  float32 // Minimum similarity score
	MaxContextChars int     // Maximum context length for LLM
}

// DefaultRAGConfig returns sensible defaults
func DefaultRAGConfig() RAGConfig {
	return RAGConfig{
		ChunkSize:       1000,
		ChunkOverlap:    200,
		TopK:            5,
		ScoreThreshold:  0.7,
		MaxContextChars: 8000,
	}
}

// RAGSystem implements Retrieval-Augmented Generation
type RAGSystem struct {
	config    RAGConfig
	embedder  embeddings.Embedder
	store     vectordb.VectorStore
}

// NewRAGSystem creates a new RAG system
func NewRAGSystem(config RAGConfig, embedder embeddings.Embedder, store vectordb.VectorStore) *RAGSystem {
	return &RAGSystem{
		config:   config,
		embedder: embedder,
		store:    store,
	}
}

// Document represents a document to index
type Document struct {
	ID       string
	Content  string
	Metadata map[string]any
}

// IndexDocument chunks and indexes a document
func (r *RAGSystem) IndexDocument(ctx context.Context, doc Document) error {
	// Chunk the document
	chunks := r.chunkDocument(doc.Content)

	// Generate embeddings for all chunks
	embeddings, err := r.embedder.Embed(ctx, chunks)
	if err != nil {
		return fmt.Errorf("generating embeddings: %w", err)
	}

	// Create vector documents
	var vectorDocs []vectordb.Document
	for i, chunk := range chunks {
		metadata := make(map[string]any)
		for k, v := range doc.Metadata {
			metadata[k] = v
		}
		metadata["chunk_index"] = i
		metadata["total_chunks"] = len(chunks)
		metadata["source_doc_id"] = doc.ID

		vectorDocs = append(vectorDocs, vectordb.Document{
			ID:       fmt.Sprintf("%s_chunk_%d", doc.ID, i),
			Text:     chunk,
			Vector:   embeddings[i],
			Metadata: metadata,
		})
	}

	// Upsert to vector store
	if err := r.store.Upsert(ctx, vectorDocs); err != nil {
		return fmt.Errorf("upserting to vector store: %w", err)
	}

	return nil
}

// chunkDocument splits a document into overlapping chunks.
//
// Read the loop-advance logic carefully, because the obvious version of this
// function contains an INFINITE LOOP that a perfectly ordinary document
// triggers. The naive advance is:
//
//	start = end - r.config.ChunkOverlap
//	if start < 0 { start = 0 }
//
// Now feed it a document beginning with a short sentence: "Hi. " followed by
// prose. findSentenceBreak returns 3, so end = 3, so start = 3 - 200 = -197,
// which clamps to 0, the value it already had. The loop emits "Hi." and starts
// over, forever, appending to `chunks` until the process is OOM-killed. The
// clamp does not save you: it is what disguises the bug, converting a negative
// index into a silent lack of progress. The same thing happens whenever
// ChunkOverlap >= the realized chunk length, which any early break can cause.
//
// The invariant to enforce is simply that `start` strictly increases. Do that
// explicitly rather than hoping the arithmetic works out.
//
// Note also that this operates on BYTES, not runes. content[start:end] can
// split a multi-byte UTF-8 character in half, producing chunks with replacement
// characters that then get embedded. Fine for ASCII, quietly corrupting for
// anything else, so the boundary is snapped to a rune edge below.
func (r *RAGSystem) chunkDocument(content string) []string {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil
	}

	// Guard the configuration itself: overlap must be strictly less than size,
	// or no advance is possible at all.
	size := r.config.ChunkSize
	overlap := r.config.ChunkOverlap
	if size <= 0 {
		size = 1000
	}
	if overlap < 0 || overlap >= size {
		overlap = size / 5 // sane default: 20%
	}

	var chunks []string
	start := 0

	for start < len(content) {
		end := start + size
		if end > len(content) {
			end = len(content)
		}

		// Try to break at a sentence boundary within this window.
		if end < len(content) {
			if bp := r.findSentenceBreak(content, start, end); bp > start {
				end = bp
			}
		}

		// Never split a multi-byte rune.
		end = snapToRuneBoundary(content, end)

		if chunk := strings.TrimSpace(content[start:end]); chunk != "" {
			chunks = append(chunks, chunk)
		}

		if end >= len(content) {
			break
		}

		// Advance, and GUARANTEE forward progress. next may land at or before
		// start when the realized chunk was shorter than the overlap - in that
		// case give up the overlap for this step rather than looping forever.
		next := end - overlap
		if next <= start {
			next = end
		}
		start = snapToRuneBoundary(content, next)
	}

	return chunks
}

// snapToRuneBoundary moves i forward to the next UTF-8 rune boundary.
func snapToRuneBoundary(s string, i int) int {
	if i >= len(s) {
		return len(s)
	}
	for i < len(s) && !utf8.RuneStart(s[i]) {
		i++
	}
	return i
}

// findSentenceBreak finds a good place to break text (sentence boundary).
//
// Deliberately crude, and you should know how it is wrong: "Dr. Smith",
// "e.g.", "3.14", and "foo.bar" all look like sentence ends to it. It also
// only searches BACKWARD from the window edge, so an early terminator can
// yield a very short chunk, which is precisely the input that made the caller's
// naive advance loop forever. Real sentence segmentation needs a proper
// tokenizer. For structured formats, prefer splitting on the document's own
// boundaries (Markdown headings, HTML block elements, paragraph breaks), which
// are both more reliable and more semantically meaningful than punctuation.
//
// A minimum-chunk floor is imposed so that a stray early period cannot produce
// a three-character chunk that is useless to embed.
func (r *RAGSystem) findSentenceBreak(content string, start, end int) int {
	const minChunk = 64 // do not accept absurdly short chunks

	// Look backward from end for sentence terminators
	for i := end - 1; i > start; i-- {
		if i-start < minChunk {
			break
		}
		if content[i] == '.' || content[i] == '!' || content[i] == '?' {
			// Check if next char is whitespace or end of string.
			// content[i+1] is a BYTE - converting it to a rune is only valid for
			// ASCII, which is fine here because we are testing for ASCII space.
			if i+1 >= len(content) || unicode.IsSpace(rune(content[i+1])) {
				return i + 1
			}
		}
	}

	// No sentence break found, look for newline
	for i := end - 1; i > start; i-- {
		if i-start < minChunk {
			break
		}
		if content[i] == '\n' {
			return i + 1
		}
	}

	// No good break point found
	return -1
}

// QueryRequest represents a RAG query
type QueryRequest struct {
	Query    string
	Filter   map[string]any
	TopK     int // Override default if > 0
}

// QueryResponse contains retrieved chunks and context
type QueryResponse struct {
	Chunks  []RetrievedChunk
	Context string
}

// RetrievedChunk represents a retrieved chunk with metadata
type RetrievedChunk struct {
	Text     string
	Score    float32
	Metadata map[string]any
}

// Query retrieves relevant chunks for a query
func (r *RAGSystem) Query(ctx context.Context, req QueryRequest) (*QueryResponse, error) {
	// Generate query embedding
	queryEmbedding, err := r.embedder.EmbedSingle(ctx, req.Query)
	if err != nil {
		return nil, fmt.Errorf("embedding query: %w", err)
	}

	// Determine topK
	topK := r.config.TopK
	if req.TopK > 0 {
		topK = req.TopK
	}

	// Search vector store
	searchResp, err := r.store.Query(ctx, queryEmbedding, topK, req.Filter)
	if err != nil {
		return nil, fmt.Errorf("querying vector store: %w", err)
	}

	// Filter by score threshold and build response
	var chunks []RetrievedChunk
	var contextParts []string
	contextChars := 0

	for _, result := range searchResp.Results {
		if result.Score < r.config.ScoreThreshold {
			continue
		}

		chunk := RetrievedChunk{
			Text:     result.Text,
			Score:    result.Score,
			Metadata: result.Metadata,
		}
		chunks = append(chunks, chunk)

		// Add to context if within limit
		if contextChars+len(result.Text) <= r.config.MaxContextChars {
			contextParts = append(contextParts, result.Text)
			contextChars += len(result.Text)
		}
	}

	// Build context string
	context := strings.Join(contextParts, "\n\n")

	return &QueryResponse{
		Chunks:  chunks,
		Context: context,
	}, nil
}

// GeneratePrompt creates a prompt for the LLM with retrieved context
func (r *RAGSystem) GeneratePrompt(query string, context string) string {
	return fmt.Sprintf(`Answer the following question using only the provided context. If the context doesn't contain enough information to answer the question, say "I don't have enough information to answer that question."

Context:
%s

Question: %s

Answer:`, context, query)
}

// RetrievalMetrics provides metrics about retrieval quality
type RetrievalMetrics struct {
	NumChunksRetrieved int
	AverageScore       float32
	MinScore           float32
	MaxScore           float32
	ContextLength      int
}

// CalculateMetrics calculates metrics for a query response
func CalculateMetrics(resp *QueryResponse) RetrievalMetrics {
	metrics := RetrievalMetrics{
		NumChunksRetrieved: len(resp.Chunks),
		ContextLength:      len(resp.Context),
	}

	if len(resp.Chunks) == 0 {
		return metrics
	}

	var sum float32
	metrics.MinScore = resp.Chunks[0].Score
	metrics.MaxScore = resp.Chunks[0].Score

	for _, chunk := range resp.Chunks {
		sum += chunk.Score
		if chunk.Score < metrics.MinScore {
			metrics.MinScore = chunk.Score
		}
		if chunk.Score > metrics.MaxScore {
			metrics.MaxScore = chunk.Score
		}
	}

	metrics.AverageScore = sum / float32(len(resp.Chunks))

	return metrics
}

// Reranker re-ranks retrieved chunks for better relevance
type Reranker interface {
	Rerank(ctx context.Context, query string, chunks []RetrievedChunk) ([]RetrievedChunk, error)
}

// CrossEncoderReranker uses a cross-encoder model for reranking
type CrossEncoderReranker struct {
	// In production, this would use a cross-encoder API
	// For example, Cohere's Rerank API or a local model
}

// Rerank reranks chunks using a cross-encoder
func (r *CrossEncoderReranker) Rerank(ctx context.Context, query string, chunks []RetrievedChunk) ([]RetrievedChunk, error) {
	// Placeholder: In production, call reranking API
	// For now, return chunks as-is
	return chunks, nil
}

// QueryWithReranking retrieves and reranks chunks
func (r *RAGSystem) QueryWithReranking(ctx context.Context, req QueryRequest, reranker Reranker) (*QueryResponse, error) {
	// Initial retrieval with higher topK
	initialTopK := req.TopK * 2
	if initialTopK == 0 {
		initialTopK = r.config.TopK * 2
	}

	req.TopK = initialTopK
	resp, err := r.Query(ctx, req)
	if err != nil {
		return nil, err
	}

	// Rerank
	reranked, err := reranker.Rerank(ctx, req.Query, resp.Chunks)
	if err != nil {
		return nil, fmt.Errorf("reranking: %w", err)
	}

	// Take top chunks after reranking
	finalTopK := req.TopK / 2
	if finalTopK > len(reranked) {
		finalTopK = len(reranked)
	}

	resp.Chunks = reranked[:finalTopK]

	// Rebuild context
	var contextParts []string
	contextChars := 0

	for _, chunk := range resp.Chunks {
		if contextChars+len(chunk.Text) <= r.config.MaxContextChars {
			contextParts = append(contextParts, chunk.Text)
			contextChars += len(chunk.Text)
		}
	}

	resp.Context = strings.Join(contextParts, "\n\n")

	return resp, nil
}
```

### Junior → FAANG: RAG Architecture as Interview Centerpiece

The RAG system is the most commonly asked about AI architecture in senior engineering interviews at FAANG companies. Being able to explain each component clearly, with the specific engineering decisions involved, is the single highest-ROI preparation step for AI infrastructure roles. Practice explaining RAG in five distinct layers: ingestion (how documents are chunked, embedded, and stored), retrieval (how queries are embedded and matched against stored vectors), augmentation (how retrieved context is assembled into a prompt), generation (how the LLM is called with the augmented prompt), and evaluation (how retrieval quality and answer quality are measured and monitored).

Chunking strategy is the most underestimated RAG design decision. Chunks that are too large include irrelevant information that confuses the LLM. Chunks that are too small lack context and produce incomplete answers. The right chunk size depends on the document type: code files are best chunked at the function level, long-form articles at the paragraph level, and structured documents at the section level. Overlap between chunks prevents important information from being split across chunks. Knowing these heuristics and being able to justify them is the kind of RAG engineering depth that passes a FAANG bar-raiser interview.

Query-time strategies beyond simple nearest neighbor retrieval significantly improve RAG quality: HyDE (Hypothetical Document Embedding, where you ask the LLM to generate a hypothetical document that would answer the question, embed that, and use it for retrieval), multi-query retrieval (generate multiple query variants, retrieve for each, merge and deduplicate the results), and parent-document retrieval (retrieve small chunks for precision, then expand to the parent document for richer context). Each of these strategies adds latency and complexity but can significantly improve recall for difficult queries.

### Senior @ FAANG: RAG Systems at Organizational Scale

At FAANG scale, a RAG system serves many product teams with different document corpora, different retrieval quality requirements, and different latency budgets. The platform design must support: per-corpus index isolation (one team's documents should not contaminate another team's search results), per-query configuration (some queries need precise keyword matching, others need broad semantic retrieval), and per-team quality SLOs (a customer-facing search feature has stricter recall requirements than an internal documentation search).

Evaluation infrastructure is the most important investment for a RAG system that aims to improve over time. Without evaluation, you are flying blind: you might change the chunking strategy, the embedding model, or the retrieval parameters and have no way to know whether the change improved or degraded quality. The evaluation harness should: measure retrieval recall@k, measure answer faithfulness (is the LLM's answer supported by the retrieved context?), measure answer relevance, and compare these metrics across different system configurations. Building this evaluation infrastructure before the first production launch is a senior-level commitment that pays for itself within weeks.

Context compression is a technique that senior engineers implement when the retrieved context is too long to fit in the LLM's effective attention window. Even if the context technically fits within the token limit, very long contexts cause LLM performance to degrade on the "lost in the middle" problem. Context compression techniques include extractive compression (use a smaller model to extract the most relevant sentences) and abstractive compression (use a smaller model to summarize each chunk). These techniques reduce context length while preserving the most relevant information, improving both LLM quality and cost.

At L7, RAG governance includes the policy for when RAG output is appropriate for user-facing applications and when human review is required. In high-stakes domains (medical, legal, financial), even well-implemented RAG systems produce factual errors at a rate that is unacceptable without human oversight. Defining the quality threshold required for each use case, building the human review workflow for cases below the threshold, and monitoring the rate at which human review is triggered is the governance framework that makes RAG trustworthy in sensitive applications.
