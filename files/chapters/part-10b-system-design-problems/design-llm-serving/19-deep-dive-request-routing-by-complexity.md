## Deep Dive: Request Routing by Complexity

Not every user query requires a massive 70B or 405B parameter model. Simple factual questions can be answered just as well by a 7B model that runs much faster and costs far less. A complexity router classifies incoming requests using fast heuristics (keyword matching and token count estimation) and sends each request to the smallest model capable of handling it well. This single optimization can reduce GPU costs dramatically because the majority of real-world queries are simple enough for a small model.

```go
package routing

import (
	"context"
	"strings"
)

type Message struct {
	Role    string
	Content string
}

type ChatRequest struct {
	Model    string
	Messages []Message
	Priority int
}

type ModelWorker interface{}

type WorkerPool interface {
	SelectWorker(ctx context.Context, modelID string, priority int) (ModelWorker, error)
}

// ComplexityRouter classifies requests and routes to appropriate model size
// Simple queries (factual, short) -> 8B model (cheaper, faster)
// Medium queries (summarization, translation) -> 70B model
// Complex queries (reasoning, coding, long context) -> 405B model
type ComplexityRouter struct {
	workerPools map[string]WorkerPool // model -> pool
}

type ComplexityClass string
const (
	ClassSimple  ComplexityClass = "simple"  // factual Q&A, simple tasks
	ClassMedium  ComplexityClass = "medium"  // summarization, translation
	ClassComplex ComplexityClass = "complex" // multi-step reasoning, coding, analysis
)

// Route selects the optimal model for a request
func (r *ComplexityRouter) Route(ctx context.Context, req ChatRequest) (ModelWorker, string, error) {
	class := r.classifyRequest(req)

	var modelID string
	switch class {
	case ClassSimple:
		modelID = "llama-3.1-8b"   // fast, cheap
	case ClassMedium:
		modelID = "llama-3.1-70b"  // balanced
	case ClassComplex:
		modelID = "llama-3.1-405b" // maximum capability
	}

	// Override if user explicitly requested a specific model
	if req.Model != "" && req.Model != "auto" {
		modelID = req.Model
	}

	pool, ok := r.workerPools[modelID]
	if !ok {
		// Fallback to 70B if requested model unavailable
		pool = r.workerPools["llama-3.1-70b"]
		modelID = "llama-3.1-70b"
	}

	worker, err := pool.SelectWorker(ctx, modelID, req.Priority)
	return worker, modelID, err
}

func (r *ComplexityRouter) classifyRequest(req ChatRequest) ComplexityClass {
	if len(req.Messages) == 0 {
		return ClassSimple
	}

	// Fast heuristic classification (< 1ms)
	totalTokens := estimateTokenCount(req.Messages)
	lastMsg := req.Messages[len(req.Messages)-1].Content

	// Long context = complex
	if totalTokens > 16000 {
		return ClassComplex
	}

	// Code-related keywords
	codeKeywords := []string{"code", "function", "implement", "debug", "algorithm", "class", "struct", "package"}
	for _, kw := range codeKeywords {
		if strings.Contains(strings.ToLower(lastMsg), kw) {
			return ClassComplex
		}
	}

	// Reasoning keywords
	reasoningKeywords := []string{"analyze", "compare", "explain why", "step by step", "pros and cons", "evaluate"}
	for _, kw := range reasoningKeywords {
		if strings.Contains(strings.ToLower(lastMsg), kw) {
			return ClassMedium
		}
	}

	// Short, factual queries
	if totalTokens < 500 && len(lastMsg) < 200 {
		return ClassSimple
	}

	return ClassMedium // default
}

func estimateTokenCount(messages []Message) int {
	total := 0
	for _, m := range messages {
		total += len(m.Content) / 4 // rough estimate: 4 chars per token
	}
	return total
}
```

---
