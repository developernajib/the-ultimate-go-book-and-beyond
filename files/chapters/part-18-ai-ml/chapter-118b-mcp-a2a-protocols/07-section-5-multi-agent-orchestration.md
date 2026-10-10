## 118B.6 Multi-Agent Orchestration

### 5.1 Supervisor Pattern

One agent decomposes a goal and dispatches the pieces to specialists, then reassembles the answers. The pipeline below is search, then extract, then summarize and analyze.

The interesting part is which steps run concurrently and why. Extraction fans out across sources because the sources are independent: no extraction needs another's output. Summarize and analyze run concurrently for the same reason, both consuming the finished `contents`. But the stages themselves are strictly sequential, because each consumes what the previous produced. That is the general rule for agent pipelines: the dependency graph decides the concurrency, and the only wins available are where the graph forks.

```go
package orchestration

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/yourorg/a2a"
)

// Orchestrator coordinates multiple specialized agents
type Orchestrator struct {
	agent    *a2a.Agent
	registry *a2a.AgentRegistry
	logger   *slog.Logger
}

// ResearchPipeline demonstrates multi-agent coordination
type ResearchTask struct {
	Query   string
	MaxDocs int
}

type ResearchResult struct {
	Query     string
	Sources   []string
	Summary   string
	Sentiment string
	Duration  time.Duration
}

// Execute coordinates: Search → Extract → Summarize → Analyze
func (o *Orchestrator) Execute(ctx context.Context, task ResearchTask) (*ResearchResult, error) {
	start := time.Now()

	// Step 1: Search for relevant documents
	searchResp, err := o.agent.Send(ctx, "search-agent", "web_search", map[string]any{
		"query": task.Query,
		"limit": task.MaxDocs,
	})
	if err != nil {
		return nil, fmt.Errorf("search failed: %w", err)
	}

	sources, _ := searchResp.Payload["urls"].([]any)

	// Step 2: Extract content from all sources in parallel
	type extractResult struct {
		url     string
		content string
		err     error
	}

	extractCh := make(chan extractResult, len(sources))
	for _, src := range sources {
		url := fmt.Sprintf("%v", src)
		go func(url string) {
			resp, err := o.agent.Send(ctx, "extraction-agent", "extract_content", map[string]any{
				"url": url,
			})
			if err != nil {
				extractCh <- extractResult{url: url, err: err}
				return
			}
			content, _ := resp.Payload["content"].(string)
			extractCh <- extractResult{url: url, content: content}
		}(url)
	}

	var contents []string
	var sourceURLs []string
	for range sources {
		r := <-extractCh
		if r.err == nil {
			contents = append(contents, r.content)
			sourceURLs = append(sourceURLs, r.url)
		}
	}

	// Step 3: Summarize and analyze in parallel
	var wg sync.WaitGroup
	var summary, sentiment string
	var summaryErr, sentimentErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		resp, err := o.agent.Send(ctx, "llm-agent", "summarize", map[string]any{
			"texts": contents,
			"query": task.Query,
		})
		if err != nil {
			summaryErr = err
			return
		}
		summary, _ = resp.Payload["summary"].(string)
	}()

	go func() {
		defer wg.Done()
		resp, err := o.agent.Send(ctx, "analysis-agent", "sentiment", map[string]any{
			"texts": contents,
		})
		if err != nil {
			sentimentErr = err
			return
		}
		sentiment, _ = resp.Payload["sentiment"].(string)
	}()

	wg.Wait()

	if summaryErr != nil {
		return nil, summaryErr
	}
	if sentimentErr != nil {
		o.logger.Warn("sentiment analysis failed", "error", sentimentErr)
	}

	return &ResearchResult{
		Query:     task.Query,
		Sources:   sourceURLs,
		Summary:   summary,
		Sentiment: sentiment,
		Duration:  time.Since(start),
	}, nil
}
```

### 5.2 Agent Memory and State

Agents in a multi-agent system need memory with two different shapes, and the split below reflects that. Short-term memory is a sliding window of recent messages, bounded by count and replayed within a token budget. Long-term memory is a keyed store of extracted facts, each with a confidence and an expiry, because a fact learned six months ago about a changing world is a liability rather than an asset.

`GetContext` is the function to read carefully: it walks backwards from the most recent message and stops at the token budget, which is what keeps a long conversation from silently overflowing the context window.

```go
package memory

import (
	"math"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// AgentMemory provides short and long-term memory for agents
type AgentMemory struct {
	mu          sync.RWMutex
	shortTerm   []MemoryEntry  // Recent messages
	longTerm    map[string]FactEntry  // Extracted facts
	maxShortTerm int
}

type MemoryEntry struct {
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
	Tokens    int       `json:"tokens"`
}

type FactEntry struct {
	Fact      string    `json:"fact"`
	Source    string    `json:"source"`
	Confidence float64  `json:"confidence"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at,omitempty"`
}

func NewAgentMemory(maxShortTerm int) *AgentMemory {
	return &AgentMemory{
		shortTerm:    make([]MemoryEntry, 0, maxShortTerm),
		longTerm:     make(map[string]FactEntry),
		maxShortTerm: maxShortTerm,
	}
}

// AddMessage adds a message to short-term memory
func (m *AgentMemory) AddMessage(role, content string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry := MemoryEntry{
		Role:      role,
		Content:   content,
		Timestamp: time.Now(),
		Tokens:    estimateTokens(content),
	}

	m.shortTerm = append(m.shortTerm, entry)

	// Trim to max size (sliding window)
	if len(m.shortTerm) > m.maxShortTerm {
		m.shortTerm = m.shortTerm[len(m.shortTerm)-m.maxShortTerm:]
	}
}

// StoreFact stores a long-term fact
func (m *AgentMemory) StoreFact(key string, fact FactEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.longTerm[key] = fact
}

// GetContext returns conversation context within token limit
func (m *AgentMemory) GetContext(maxTokens int) []MemoryEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var result []MemoryEntry
	totalTokens := 0

	// Walk backwards through recent messages
	for i := len(m.shortTerm) - 1; i >= 0; i-- {
		entry := m.shortTerm[i]
		if totalTokens+entry.Tokens > maxTokens {
			break
		}
		result = append([]MemoryEntry{entry}, result...)
		totalTokens += entry.Tokens
	}

	return result
}

// RelevantFacts retrieves facts matching a query
func (m *AgentMemory) RelevantFacts(query string) []FactEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()

	now := time.Now()
	var facts []FactEntry
	for _, fact := range m.longTerm {
		if !fact.ExpiresAt.IsZero() && fact.ExpiresAt.Before(now) {
			continue // expired
		}
		facts = append(facts, fact)
	}
	return facts
}

func estimateTokens(text string) int {
	// Rough estimate: 4 chars per token
	return len(text) / 4
}

// VectorMemory provides semantic search over agent memories
type VectorMemory struct {
	mu      sync.RWMutex
	entries []VectorEntry
}

type VectorEntry struct {
	ID        string
	Content   string
	Embedding []float32
	Metadata  map[string]any
	CreatedAt time.Time
}

func (vm *VectorMemory) Store(content string, embedding []float32, metadata map[string]any) string {
	// A timestamp is not an ID. Two Stores in the same nanosecond, which
	// concurrent callers reach easily, collide and produce duplicate IDs.
	id := uuid.New().String()
	vm.mu.Lock()
	vm.entries = append(vm.entries, VectorEntry{
		ID:        id,
		Content:   content,
		Embedding: embedding,
		Metadata:  metadata,
		CreatedAt: time.Now(),
	})
	vm.mu.Unlock()
	return id
}

// Search finds semantically similar memories
func (vm *VectorMemory) Search(queryEmbedding []float32, topK int) []VectorEntry {
	vm.mu.RLock()
	defer vm.mu.RUnlock()

	type scored struct {
		entry VectorEntry
		score float32
	}

	var results []scored
	for _, entry := range vm.entries {
		score := cosineSimilarity(queryEmbedding, entry.Embedding)
		results = append(results, scored{entry, score})
	}

	// Sort by score descending. The hand-rolled double loop this replaces was
	// a selection sort: O(n^2) comparisons over every memory in the store on
	// every single search. Fine for the ten entries in a demo, quadratic
	// misery at ten thousand.
	sort.Slice(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	var entries []VectorEntry
	for i := 0; i < min(topK, len(results)); i++ {
		entries = append(entries, results[i].entry)
	}
	return entries
}

func cosineSimilarity(a, b []float32) float32 {
	if len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float32
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (sqrt32(normA) * sqrt32(normB))
}

func sqrt32(x float32) float32 {
	return float32(math.Sqrt(float64(x)))
}
```

This `VectorMemory` is a linear scan: every search compares against every stored entry. That is correct and completely adequate up to a few thousand entries, and it is the right thing to write first. Past that, reach for a real vector index (Chapter 115) rather than optimizing this one, because the fix is an approximate-nearest-neighbour structure, not a faster loop.

---

### Junior → FAANG: Supervisor Pattern as Go Concurrency Interview Topic

The supervisor pattern in multi-agent orchestration is the AI agent equivalent of the actor model's supervisor tree. A supervisor monitors worker agents, detects failures, and applies a restart strategy (restart immediately, restart with backoff, escalate to parent supervisor). In Go, this is implemented with goroutines for each worker agent, channels for work distribution and result collection, and a monitoring goroutine that tracks agent health and applies the restart strategy. The goroutine lifecycle management (launching worker goroutines, detecting when they exit, restarting them without leaking the old goroutine) is a Go concurrency interview topic.

The task decomposition aspect of multi-agent orchestration (breaking a high-level task into subtasks, routing subtasks to the appropriate specialist agents, collecting and aggregating results) maps to the fan-out/fan-in pattern in Go concurrency. The orchestrator goroutine fans out by launching work goroutines for each subtask, then fans in by reading from a results channel until all subtasks are complete. Understanding when to use a WaitGroup versus a channel for fan-in (WaitGroup when you only need to know when all goroutines complete, channel when you need to collect results or handle errors from individual goroutines) is Go concurrency fluency that FAANG interviews test.

### Senior @ FAANG: Multi-Agent Orchestration as Distributed Systems Reliability Challenge

At senior level, multi-agent orchestration introduces distributed systems reliability challenges that single-agent systems do not have. When an orchestrator delegates subtasks to three agents in parallel and one agent fails, the orchestrator must decide: retry the failed subtask on the same agent, retry on a different agent, or fail the entire orchestration. Each strategy has different reliability and cost implications. The retry-on-different-agent strategy requires that agents are stateless so that any agent can handle any subtask. If agents maintain state across calls, routing to a different agent produces incorrect results. These reliability properties must be specified in the agent contract before the orchestration system is designed, not discovered after an incident reveals the assumption was violated.
