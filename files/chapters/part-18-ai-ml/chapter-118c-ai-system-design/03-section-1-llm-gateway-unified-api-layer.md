## 118C.2 The LLM Gateway as a Unified API Layer

The LLM gateway presents a single `Provider` interface to application code while routing requests to OpenAI, Anthropic, or other backends based on the model name. It adds token budget tracking, request costing, and a load balancer that distributes requests across multiple API keys to stay within per-key rate limits at high concurrency.

```go
package llmgateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Provider represents an LLM provider
type Provider string

const (
	ProviderAnthropic Provider = "anthropic"
	ProviderOpenAI    Provider = "openai"
	ProviderGoogle    Provider = "google"
	ProviderLocal     Provider = "local" // Ollama, vLLM
)

// ChatMessage is the unified message format
type ChatMessage struct {
	Role    string `json:"role"` // "system", "user", "assistant"
	Content string `json:"content"`
}

// CompletionRequest is the unified request format
type CompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Temperature float64       `json:"temperature,omitempty"`
	Stream      bool          `json:"stream,omitempty"`

	// Provider-specific options
	Provider Provider `json:"provider,omitempty"`
}

// CompletionResponse is the unified response format
type CompletionResponse struct {
	ID      string        `json:"id"`
	Model   string        `json:"model"`
	Choice  ChatMessage   `json:"choice"`
	Usage   TokenUsage    `json:"usage"`
	Latency time.Duration `json:"latency"`
	Cost    float64       `json:"cost"` // USD
}

type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// StreamChunk is a token in a streaming response
type StreamChunk struct {
	Delta        string
	Done         bool
	FinishReason string
}

// LLMClient is the interface all providers implement
type LLMClient interface {
	Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error)
	Stream(ctx context.Context, req *CompletionRequest) (<-chan StreamChunk, error)
	Name() Provider
}

// Gateway is the unified LLM gateway with load balancing
type Gateway struct {
	logger *slog.Logger

	mu      sync.RWMutex
	clients map[Provider][]LLMClient
	current map[Provider]*atomic.Uint64

	// fallbackOrder fixes the provider priority for failover and for
	// "pick any available". Go randomises map iteration order, so ranging
	// over g.clients would make the fallback chain differ between requests:
	// the same outage would hit a different backup provider each time, which
	// is impossible to reason about in an incident.
	fallbackOrder []Provider

	cache   *ResponseCache
	costs   *CostTracker
	metrics *GatewayMetrics
}

type GatewayMetrics struct {
	requests  atomic.Int64
	errors    atomic.Int64
	tokens    atomic.Int64
	cacheHits atomic.Int64
}

func NewGateway() *Gateway {
	return &Gateway{
		logger:        slog.Default(),
		clients:       make(map[Provider][]LLMClient),
		current:       make(map[Provider]*atomic.Uint64),
		fallbackOrder: []Provider{ProviderAnthropic, ProviderOpenAI, ProviderGoogle, ProviderLocal},
		cache:         NewResponseCache(1000, 5*time.Minute),
		costs:         NewCostTracker(),
		metrics:       &GatewayMetrics{},
	}
}

// RegisterClient adds an LLM client for a provider
func (g *Gateway) RegisterClient(client LLMClient) {
	g.mu.Lock()
	defer g.mu.Unlock()

	provider := client.Name()
	g.clients[provider] = append(g.clients[provider], client)
	if _, ok := g.current[provider]; !ok {
		g.current[provider] = &atomic.Uint64{}
	}
}

// Complete processes a completion request with load balancing and caching
func (g *Gateway) Complete(ctx context.Context, req *CompletionRequest) (*CompletionResponse, error) {
	g.metrics.requests.Add(1)

	// Check cache
	cacheKey := g.cacheKey(req)
	if !req.Stream {
		if cached, ok := g.cache.Get(cacheKey); ok {
			g.metrics.cacheHits.Add(1)
			return cached, nil
		}
	}

	// Select client with round-robin load balancing
	client, err := g.selectClient(req.Provider)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	resp, err := client.Complete(ctx, req)
	if err != nil {
		g.metrics.errors.Add(1)
		// Try fallback
		return g.fallback(ctx, req, client.Name())
	}

	resp.Latency = time.Since(start)
	cost, err := g.costs.Calculate(req.Model, resp.Usage)
	if err != nil {
		// Loudly. An unpriced model is a hole in the budget, not a free request.
		g.logger.Error("cost tracking failed", "model", req.Model, "err", err)
	}
	resp.Cost = cost
	g.metrics.tokens.Add(int64(resp.Usage.TotalTokens))

	// Cache successful responses
	if !req.Stream {
		g.cache.Set(cacheKey, resp)
	}

	return resp, nil
}

// Stream returns a channel of tokens from the selected provider.
//
// Note what it does not do, compared with Complete: no cache lookup and no
// cache write. A streamed response is delivered incrementally and the gateway
// never holds the whole thing, so there is nothing to store. If you want
// streaming and caching together, the accumulation has to happen somewhere
// explicit (buffer the deltas as they pass through and write the assembled
// response on completion), and it must not run on the truncated-stream path.
func (g *Gateway) Stream(ctx context.Context, req *CompletionRequest) (<-chan StreamChunk, error) {
	g.metrics.requests.Add(1)

	client, err := g.selectClient(req.Provider)
	if err != nil {
		return nil, err
	}

	stream, err := client.Stream(ctx, req)
	if err != nil {
		g.metrics.errors.Add(1)
		return nil, err
	}
	return stream, nil
}

// fallback tries other providers when primary fails, in fallbackOrder.
func (g *Gateway) fallback(ctx context.Context, req *CompletionRequest, failed Provider) (*CompletionResponse, error) {
	g.logger.Warn("primary provider failed, trying fallback", "failed", failed)

	// Snapshot the candidates under the lock and release it before making any
	// network call. Holding mu across Complete would block RegisterClient (and
	// every other writer) for the length of the whole fallback chain, which is
	// exactly when the system is already degraded.
	g.mu.RLock()
	candidates := make([]LLMClient, 0, len(g.clients))
	for _, provider := range g.fallbackOrder {
		if provider == failed {
			continue
		}
		if clients := g.clients[provider]; len(clients) > 0 {
			candidates = append(candidates, clients[0])
		}
	}
	g.mu.RUnlock()

	for _, client := range candidates {
		start := time.Now()
		resp, err := client.Complete(ctx, req)
		if err != nil {
			g.logger.Warn("fallback provider failed", "provider", client.Name(), "err", err)
			continue
		}

		// The fallback path has to do the same bookkeeping as the happy path.
		// Forgetting it here is a common bug: cost and latency silently stop
		// being recorded for exactly the requests you most want to understand.
		resp.Latency = time.Since(start)
		cost, cerr := g.costs.Calculate(req.Model, resp.Usage)
		if cerr != nil {
			g.logger.Error("cost tracking failed", "model", req.Model, "err", cerr)
		}
		resp.Cost = cost
		g.metrics.tokens.Add(int64(resp.Usage.TotalTokens))
		return resp, nil
	}

	return nil, fmt.Errorf("all providers failed (primary %s)", failed)
}

func (g *Gateway) selectClient(preferred Provider) (LLMClient, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	// Use preferred if specified
	if preferred != "" {
		if clients, ok := g.clients[preferred]; ok && len(clients) > 0 {
			idx := g.current[preferred].Add(1) % uint64(len(clients))
			return clients[idx], nil
		}
	}

	// Otherwise pick the first available provider in priority order.
	for _, provider := range g.fallbackOrder {
		if clients := g.clients[provider]; len(clients) > 0 {
			idx := g.current[provider].Add(1) % uint64(len(clients))
			return clients[idx], nil
		}
	}

	return nil, fmt.Errorf("no LLM clients available")
}

func (g *Gateway) cacheKey(req *CompletionRequest) string {
	data, err := json.Marshal(req)
	if err != nil {
		// Marshal fails only on unmarshalable field types, which would be a
		// programming error here. Return a key that cannot collide with a real
		// one so the request simply misses the cache instead of aliasing.
		return ""
	}
	// Hash it. `fmt.Sprintf("%x", data)` would hex-encode the entire request
	// body, producing a map key that grows with the prompt: a long conversation
	// would store megabytes of key per entry and blow up the cache's memory.
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}

// ResponseCache is an in-memory cache for LLM responses.
//
// Eviction is oldest-first by insertion time, which is FIFO, not LRU: Get does
// not refresh an entry, so a hot key is still evicted once it ages out. That is
// a deliberate simplification. A real LRU needs an intrusive list (or
// container/list) updated on every Get, and the eviction scan below is O(n) per
// insert, which is fine at maxSize=1000 and not fine at 10^6.
type ResponseCache struct {
	mu      sync.Mutex
	entries map[string]*cacheEntry
	maxSize int
	ttl     time.Duration
}

type cacheEntry struct {
	resp      *CompletionResponse
	createdAt time.Time
}

func NewResponseCache(maxSize int, ttl time.Duration) *ResponseCache {
	return &ResponseCache{
		entries: make(map[string]*cacheEntry, maxSize),
		maxSize: maxSize,
		ttl:     ttl,
	}
}

func (c *ResponseCache) Get(key string) (*CompletionResponse, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Since(entry.createdAt) > c.ttl {
		delete(c.entries, key)
		return nil, false
	}
	return entry.resp, true
}

func (c *ResponseCache) Set(key string, resp *CompletionResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.entries) >= c.maxSize {
		// Evict oldest
		oldest := time.Now()
		var oldestKey string
		for k, v := range c.entries {
			if v.createdAt.Before(oldest) {
				oldest = v.createdAt
				oldestKey = k
			}
		}
		delete(c.entries, oldestKey)
	}

	c.entries[key] = &cacheEntry{resp: resp, createdAt: time.Now()}
}

// CostTracker tracks LLM API costs
type CostTracker struct {
	mu      sync.Mutex
	total   float64
	byModel map[string]float64

	// Pricing per 1M tokens (input/output), USD.
	pricing map[string][2]float64
}

// NewCostTracker seeds an illustrative price table.
//
// Treat these numbers as a placeholder, not a reference. Provider pricing
// changes without warning, models are introduced and retired, and a price
// compiled into a binary is a price nobody re-checks. In production this table
// is configuration loaded at startup from a source you can update without a
// deploy, and reconciled against the provider's invoice, because your token
// accounting and their billing will eventually disagree and you want to find
// out from a dashboard rather than from Finance.
func NewCostTracker() *CostTracker {
	return &CostTracker{
		byModel: make(map[string]float64),
		pricing: map[string][2]float64{
			"claude-opus-4-8":  {5.0, 25.0},
			"claude-sonnet-5":  {3.0, 15.0},
			"claude-haiku-4-5": {1.0, 5.0},
		},
	}
}

// Calculate returns the USD cost of a single completion.
//
// An unknown model is an error, not a zero. Returning 0 here is the tempting
// shortcut and a genuinely dangerous one: add a model, forget the price entry,
// and every dashboard reports the new model as free. The overspend is invisible
// until the invoice arrives, and the bug looks like a billing dispute rather
// than a missing map key.
func (ct *CostTracker) Calculate(model string, usage TokenUsage) (float64, error) {
	pricing, ok := ct.pricing[model]
	if !ok {
		return 0, fmt.Errorf("no pricing configured for model %q", model)
	}

	inputCost := float64(usage.PromptTokens) / 1_000_000 * pricing[0]
	outputCost := float64(usage.CompletionTokens) / 1_000_000 * pricing[1]
	cost := inputCost + outputCost

	ct.mu.Lock()
	ct.total += cost
	ct.byModel[model] += cost
	ct.mu.Unlock()

	return cost, nil
}
```

---

### Junior → FAANG: LLM Gateway as Interface Design Interview Topic

The LLM gateway pattern demonstrates the Open-Closed Principle applied to AI infrastructure: the gateway is open for extension (new providers can be added by implementing the Provider interface) and closed for modification (application code does not need to change when new providers are added). This is the canonical SOLID example for AI systems design interviews. Be prepared to explain: why define a Provider interface rather than calling OpenAI or Anthropic directly? The answer covers testability (mock the provider in tests), provider flexibility (swap providers without code changes), and rate limit management (the gateway manages API key rotation across multiple keys without the calling code needing to know).

The token budget tracking and cost calculation in the gateway are what make LLM infrastructure economically sustainable. Without cost tracking at the gateway level, engineering teams have no visibility into which requests, users, or features are consuming LLM budget. With per-request cost tracking, you can aggregate cost by user, by feature, by model, and by time period, enabling the product decisions (which features are too expensive to run at scale?) and the cost optimization decisions (which features can use a cheaper model without quality regression?) that keep AI products economically viable.

### Senior @ FAANG: LLM Gateway as Critical Infrastructure Component

At senior level, the LLM gateway is critical infrastructure with the same reliability requirements as a payment gateway or an authentication service. It is the single point of failure for all LLM-dependent features in the organization, which means its availability directly determines the availability of every AI feature. The reliability requirements: high availability (deploy in multiple regions, active-active configuration), low latency overhead (the gateway should add less than 5ms to each LLM request), transparent failover (application code should not need to handle provider-specific errors), and comprehensive observability (every request logged with provider, model, token counts, cost, and latency). Designing the LLM gateway to meet these requirements, not just to route requests correctly, is the production engineering work that staff engineers are expected to specify and review.
