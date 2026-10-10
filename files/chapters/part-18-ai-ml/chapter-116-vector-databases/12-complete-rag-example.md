## 116.11 Complete RAG Example

Retrieval-Augmented Generation grounds LLM responses in up-to-date, domain-specific facts by injecting retrieved documents into the prompt context before inference. The following pipeline demonstrates retrieval, reranking, and context assembly steps that precede the LLM call, significantly reducing hallucination.

```go
// examples/rag-system/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/yourusername/gobook/pkg/embeddings"
	"github.com/yourusername/gobook/pkg/rag"
	"github.com/yourusername/gobook/pkg/vectordb/pgvector"
)

func main() {
	ctx := context.Background()

	// Initialize pgvector
	pgConfig := pgvector.Config{
		Host:       "localhost",
		Port:       5432,
		User:       "postgres",
		Password:   os.Getenv("POSTGRES_PASSWORD"),
		Database:   "vectordb",
		TableName:  "documents",
		Dimensions: 1536,
	}

	pgClient, err := pgvector.NewClient(ctx, pgConfig)
	if err != nil {
		log.Fatal(err)
	}
	defer pgClient.Close()

	// Setup database
	if err := pgClient.CreateExtension(ctx); err != nil {
		log.Fatal(err)
	}
	if err := pgClient.CreateTable(ctx); err != nil {
		log.Fatal(err)
	}
	if err := pgClient.CreateIndex(ctx, pgvector.HNSWIndex); err != nil {
		log.Fatal(err)
	}

	// Initialize embedder
	embedderConfig := embeddings.OpenAIConfig{
		APIKey: os.Getenv("OPENAI_API_KEY"),
		Model:  embeddings.TextEmbedding3Small,
	}

	embedder := embeddings.NewOpenAIEmbedder(embedderConfig)

	// Initialize RAG system
	ragConfig := rag.DefaultRAGConfig()
	ragSystem := rag.NewRAGSystem(ragConfig, embedder, pgClient)

	// Index documents
	documents := []rag.Document{
		{
			ID:      "doc1",
			Content: "Go is a statically typed, compiled programming language designed at Google. It is syntactically similar to C, but with memory safety, garbage collection, structural typing, and CSP-style concurrency.",
			Metadata: map[string]any{
				"category": "programming",
				"topic":    "golang",
			},
		},
		{
			ID:      "doc2",
			Content: "Vector databases are specialized databases designed to store and query high-dimensional vectors efficiently. They use approximate nearest neighbor algorithms like HNSW and IVF for fast similarity search.",
			Metadata: map[string]any{
				"category": "database",
				"topic":    "vectors",
			},
		},
	}

	for _, doc := range documents {
		if err := ragSystem.IndexDocument(ctx, doc); err != nil {
			log.Fatal(err)
		}
	}

	// Query the RAG system
	queryReq := rag.QueryRequest{
		Query: "What is Go programming language?",
	}

	resp, err := ragSystem.Query(ctx, queryReq)
	if err != nil {
		log.Fatal(err)
	}

	// Display results
	fmt.Printf("Retrieved %d chunks:\n\n", len(resp.Chunks))
	for i, chunk := range resp.Chunks {
		fmt.Printf("Chunk %d (score: %.3f):\n%s\n\n", i+1, chunk.Score, chunk.Text)
	}

	// Generate prompt for LLM
	prompt := ragSystem.GeneratePrompt(queryReq.Query, resp.Context)
	fmt.Printf("Generated prompt:\n%s\n", prompt)

	// Calculate metrics
	metrics := rag.CalculateMetrics(resp)
	fmt.Printf("\nRetrieval Metrics:\n")
	fmt.Printf("  Chunks: %d\n", metrics.NumChunksRetrieved)
	fmt.Printf("  Average Score: %.3f\n", metrics.AverageScore)
	fmt.Printf("  Context Length: %d chars\n", metrics.ContextLength)
}
```

### Junior → FAANG: Complete Examples as Study and Interview Reference

The complete RAG example is the most valuable single artifact in this chapter for interview preparation. Read through it completely, understand each step, and practice explaining it verbally in 10 minutes. The explanation should cover: how documents are chunked and stored, how queries are processed at retrieval time, how the retrieved context is assembled into a prompt, how the LLM is called, and how quality metrics are tracked. Being able to walk through this example end-to-end with no notes, including the error handling and the metrics, is a strong signal of production RAG experience.

Reranking is the step in this example that most significantly improves quality over naive top-k retrieval. After the initial vector search returns the top-20 candidates, a reranker scores each candidate against the query using a cross-encoder model (which considers both the query and the document together, rather than independently as in bi-encoder embedding models). The top-5 reranked results are typically significantly more relevant than the top-5 results from vector search alone. Understanding why this works (cross-encoders model query-document interaction more precisely than bi-encoders but are too slow to run on the entire corpus) demonstrates deep RAG understanding.

The metrics tracked in this example (retrieval latency, reranking latency, context length, number of chunks used) should be logged with every query in production and aggregated into a monitoring dashboard. If retrieval latency suddenly increases, the embedding API may be slow. If context length suddenly decreases, the vector search may be returning fewer relevant results (potential retrieval quality regression). If the number of chunks used is consistently the maximum (all retrieved chunks are used), the chunk count may be too small and the best relevant context may be getting cut off.

### Senior @ FAANG: Complete RAG System as Platform Template

At senior level, the complete RAG example is a template that the platform team maintains and model teams customize. The platform template provides: the vector store integration, the embedding client with caching, the retrieval pipeline with configurable top-k and reranking, the context assembly logic with token budget management, and the observability instrumentation. Model teams provide: the document corpus and chunking strategy, the system prompt for their use case, and the post-processing logic for their specific answer format.

Evaluating the example's quality systematically requires a diverse set of test queries that cover: factual questions (does the RAG correctly retrieve and answer factual questions?), ambiguous queries (does the RAG handle questions that require disambiguation?), out-of-scope questions (does the RAG correctly say "I don't know" rather than hallucinating?), and adversarial queries (does the RAG resist prompt injection from documents in the corpus?). Building and maintaining this test suite is a senior-level quality engineering responsibility.

At L7, the complete RAG pipeline becomes the reference architecture for the organization's AI retrieval strategy. Every team building a document Q&A system, a recommendation system, or any retrieval-augmented feature should start from this reference architecture rather than designing from scratch. The reference architecture is a maintained, tested, documented starting point that includes all the production concerns (observability, error handling, graceful degradation, quality evaluation) that teams would otherwise discover and address independently. Maintaining this reference architecture and updating it as the infrastructure evolves is a high-impact staff engineering contribution.

---
