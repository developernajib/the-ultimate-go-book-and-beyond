## Core Components

### 1. LLM Request Router

The LLM Request Router is the entry point that accepts OpenAI-compatible chat completion requests and routes them to the least-loaded inference worker. It distinguishes between streaming and non-streaming responses at the protocol level: streaming requests use Server-Sent Events (SSE) so the client can render tokens as they are generated, while non-streaming requests buffer the complete response before returning. The router tracks active request counts per worker in Redis and implements a timeout mechanism so slow completions do not block capacity indefinitely.

```go
package router

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

type WorkerPool interface {
	SelectWorker(ctx context.Context, model string, priority int) (ModelWorker, error)
}

type ModelWorker interface {
	Generate(ctx context.Context, req GenerateRequest) (<-chan Token, error)
}

type MetricsRecorder interface {
	RecordCacheLookup(model string, hit bool)
	RecordTTFT(model string, d time.Duration)
	RecordCompletion(model string, tokens int, d time.Duration)
}

type GenerateRequest struct {
	Messages    []Message
	MaxTokens   int
	Temperature float64
	CachedKV    *KVState
}

type Token struct {
	ID           int
	Text         string
	FinishReason string
}

type KVState struct{}

type PromptCache struct{}

func (c *PromptCache) Get(ctx context.Context, req ChatRequest) (bool, *KVState) {
	return false, nil
}

func estimateTokenCount(messages []Message) int {
	var total int
	for _, m := range messages {
		total += len(m.Content) / 4
	}
	return total
}

func generateRequestID() string {
	return fmt.Sprintf("req-%d", time.Now().UnixNano())
}

// LLMRouter routes inference requests to the right model workers
type LLMRouter struct {
	workerPool  WorkerPool
	promptCache *PromptCache
	rdb         *redis.Client
	metrics     MetricsRecorder
}

// ChatRequest is the incoming API request (OpenAI-compatible format)
type ChatRequest struct {
	Model       string        `json:"model"`
	Messages    []Message     `json:"messages"`
	MaxTokens   int           `json:"max_tokens"`
	Temperature float64       `json:"temperature"`
	Stream      bool          `json:"stream"`
	UserID      string        `json:"user_id"`
	// Extension fields
	SystemPromptID string    `json:"system_prompt_id,omitempty"` // for prompt caching
	Priority       int       `json:"priority,omitempty"`          // 0=normal, 1=high
}

// Message is a single conversation turn
type Message struct {
	Role    string `json:"role"`    // system, user, assistant
	Content string `json:"content"` // text content
	Images  []string `json:"images,omitempty"` // base64 images for multi-modal
}

// TokenUsage tracks token consumption
type TokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	CachedTokens     int `json:"cached_tokens"` // tokens served from KV cache
}

// HandleChat processes a chat completion request
func (r *LLMRouter) HandleChat(w http.ResponseWriter, req *http.Request) {
	var chatReq ChatRequest
	if err := json.NewDecoder(req.Body).Decode(&chatReq); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	// Bound total generation time so a stuck completion cannot hold a
	// worker slot indefinitely
	ctx, cancel := context.WithTimeout(req.Context(), 5*time.Minute)
	defer cancel()

	// 1. Validate and select model
	worker, err := r.workerPool.SelectWorker(ctx, chatReq.Model, chatReq.Priority)
	if err != nil {
		http.Error(w, "model unavailable", http.StatusServiceUnavailable)
		return
	}

	// 2. Check prompt cache (for repeated system prompts)
	cacheHit, cachedKVState := r.promptCache.Get(ctx, chatReq)
	r.metrics.RecordCacheLookup(chatReq.Model, cacheHit)

	// 3. Estimate token count for billing/quota
	promptTokens := estimateTokenCount(chatReq.Messages)
	if promptTokens > 128000 {
		http.Error(w, "context too long (max 128K tokens)", http.StatusBadRequest)
		return
	}

	// 4. Route to streaming or non-streaming
	if chatReq.Stream {
		r.handleStreamingResponse(ctx, w, chatReq, worker, cachedKVState)
	} else {
		r.handleNonStreamingResponse(ctx, w, chatReq, worker, cachedKVState)
	}
}

// handleStreamingResponse returns tokens via SSE as they're generated
func (r *LLMRouter) handleStreamingResponse(
	ctx context.Context,
	w http.ResponseWriter,
	req ChatRequest,
	worker ModelWorker,
	cachedKV *KVState,
) {
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	start := time.Now()
	var totalTokens int
	firstToken := true

	// Create token stream from model worker
	tokenStream, err := worker.Generate(ctx, GenerateRequest{
		Messages:    req.Messages,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
		CachedKV:    cachedKV,
	})
	if err != nil {
		errData, _ := json.Marshal(map[string]string{"error": err.Error()})
		fmt.Fprintf(w, "data: %s\n\n", errData)
		flusher.Flush()
		return
	}

	// Stream tokens to client
	for token := range tokenStream {
		if firstToken {
			r.metrics.RecordTTFT(req.Model, time.Since(start))
			firstToken = false
		}

		// OpenAI-compatible SSE format
		chunk := map[string]any{
			"id":      generateRequestID(),
			"object":  "chat.completion.chunk",
			"model":   req.Model,
			"choices": []map[string]any{
				{
					"delta":         map[string]string{"content": token.Text},
					"finish_reason": token.FinishReason,
					"index":         0,
				},
			},
		}

		data, _ := json.Marshal(chunk)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()

		totalTokens++

		if token.FinishReason != "" {
			break
		}
	}

	// Send [DONE] signal
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()

	r.metrics.RecordCompletion(req.Model, totalTokens, time.Since(start))
}

func (r *LLMRouter) handleNonStreamingResponse(
	ctx context.Context,
	w http.ResponseWriter,
	req ChatRequest,
	worker ModelWorker,
	cachedKV *KVState,
) {
	tokenStream, err := worker.Generate(ctx, GenerateRequest{
		Messages:    req.Messages,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
		CachedKV:    cachedKV,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var fullText string
	for token := range tokenStream {
		fullText += token.Text
	}

	response := map[string]any{
		"id":    generateRequestID(),
		"model": req.Model,
		"choices": []map[string]any{
			{"message": map[string]string{"role": "assistant", "content": fullText}},
		},
	}
	json.NewEncoder(w).Encode(response)
}
```

### 2. Continuous Batching Engine

Continuous batching is the key innovation that makes LLM serving economically viable at scale. Static batching waits until a full batch is assembled before starting, which wastes GPU cycles when requests arrive unevenly. Continuous batching instead processes each new request as soon as a sequence slot is free, mixing prefill (processing the input prompt) and decode (generating output tokens) phases across different requests in the same batch. The `BatchScheduler` below maintains a queue of waiting requests and a set of active sequences, inserting new requests into in-flight batches as generation slots open up.

```go
package inference

import (
	"context"
	"sync"
	"time"
)

// BatchScheduler implements continuous batching for efficient GPU utilization
// Key insight: LLM generation has two phases:
//   Prefill: process all input tokens (parallel, slow per request)
//   Decode: generate output tokens one-by-one (fast per token, benefit from batching)
// Continuous batching: add new requests to decode batch as slots open up
type GPUEngine interface {
	Prefill(ctx context.Context, tokens []int) *KVBlock
	DecodeBatch(ctx context.Context, reqs []*InferenceRequest) []Token
}

type BatchScheduler struct {
	maxBatchSize    int
	maxSeqLen       int
	pendingRequests chan *InferenceRequest
	activeRequests  []*InferenceRequest
	gpuEngine       GPUEngine
	mu              sync.Mutex
}

// InferenceRequest is a single request being processed
type InferenceRequest struct {
	ID          string
	Tokens      []int      // tokenized input
	OutputTokens []int     // generated tokens so far
	MaxNewTokens int
	Temperature  float64
	KVCache     *KVBlock   // GPU memory block for KV cache
	ResultCh    chan<- Token
	Done        chan struct{}
	Finished    bool       // set when EOS reached or token budget spent
	StartedAt   time.Time
}

// KVBlock is GPU memory holding key-value attention cache
type KVBlock struct {
	Layers  int
	Heads   int
	SeqLen  int
	Data    []uint16 // fp16 values (Go has no float16 type), resident on GPU
}

// Token is a single generated token
type Token struct {
	ID           int
	Text         string
	LogProb      float64
	FinishReason string
}

// RunScheduler continuously processes requests using continuous batching
func (s *BatchScheduler) RunScheduler(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			s.scheduleBatch(ctx)
		}
	}
}

// scheduleBatch runs one iteration of the continuous batching loop
func (s *BatchScheduler) scheduleBatch(ctx context.Context) {
	s.mu.Lock()

	// Drain finished requests
	var active []*InferenceRequest
	for _, req := range s.activeRequests {
		if !req.Finished {
			active = append(active, req)
		} else {
			// Request finished (EOS or token budget) - signal completion
			close(req.Done)
		}
	}
	s.activeRequests = active

	// Fill available batch slots with pending requests
	for len(s.activeRequests) < s.maxBatchSize {
		select {
		case req := <-s.pendingRequests:
			// Prefill phase: process input tokens
			s.prefill(ctx, req)
			s.activeRequests = append(s.activeRequests, req)
		default:
			goto done
		}
	}
done:
	s.mu.Unlock()

	if len(s.activeRequests) == 0 {
		time.Sleep(1 * time.Millisecond)
		return
	}

	// Decode phase: generate one token per active request in parallel
	// This is the key efficiency: all active sequences advance simultaneously
	tokens := s.gpuEngine.DecodeBatch(ctx, s.activeRequests)

	s.mu.Lock()
	for i, req := range s.activeRequests {
		token := tokens[i]
		req.OutputTokens = append(req.OutputTokens, token.ID)

		// Send token to requester's channel
		select {
		case req.ResultCh <- token:
		default:
			// Receiver not keeping up or disconnected: drop the token,
			// the request still terminates via MaxNewTokens
		}

		// Check stopping criteria - the drain step at the top of the
		// next iteration closes Done and frees the batch slot
		if token.FinishReason != "" || len(req.OutputTokens) >= req.MaxNewTokens {
			req.Finished = true
		}
	}
	s.mu.Unlock()
}

// prefill runs the attention computation over input tokens
func (s *BatchScheduler) prefill(ctx context.Context, req *InferenceRequest) {
	// Run full forward pass over input tokens - populates KV cache
	// This is parallelizable across tokens (unlike decode which is sequential)
	req.KVCache = s.gpuEngine.Prefill(ctx, req.Tokens)
	req.StartedAt = time.Now()
}
```

### 3. Prompt Cache

The prompt cache avoids recomputing the attention key-value (KV) tensors for system prompts that appear identically across thousands of requests, a critical optimization when system prompts can be thousands of tokens long. The cache identifies a prefix by SHA-256 over the model ID and the exact prefix messages and stores the precomputed KV state on NVMe SSD rather than in GPU VRAM, since SSDs offer sufficient bandwidth for prompt restoration (a system prompt of about 1,200 tokens produces a ~400MB KV state, which loads in roughly 12 milliseconds). Exact prefix matching is used rather than fuzzy matching to guarantee that the cached state is mathematically identical to what fresh computation would produce.

```go
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// PromptCache caches KV states for repeated system prompts
// Key insight: many API users have the same system prompt (instructions, personas)
// Re-computing KV cache for system prompt on every request wastes GPU
type PromptCache struct {
	rdb    *redis.Client
	maxKVs int // max cached KV states
}

type Message struct {
	Role    string
	Content string
}

type ChatRequest struct {
	Model          string
	Messages       []Message
	SystemPromptID string
}

// CachedKVKey identifies a cached prompt prefix
type CachedKVKey struct {
	ModelID  string
	Messages []Message // prefix to cache (typically system prompt)
	Hash     string    // computed from above
}

// CacheEntry stores metadata about a cached KV state
type CacheEntry struct {
	Hash      string
	ModelID   string
	TokenLen  int
	CacheFile string // path to GPU memory snapshot on disk/NVMe
	HitCount  int64
	LastUsed  time.Time
	CreatedAt time.Time
}

// ComputeHash generates a deterministic hash for a prompt prefix
func ComputeHash(modelID string, messages []Message) string {
	h := sha256.New()
	h.Write([]byte(modelID))
	for _, msg := range messages {
		h.Write([]byte(msg.Role + ":" + msg.Content))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Get retrieves cached KV state for a prompt prefix
func (c *PromptCache) Get(ctx context.Context, req ChatRequest) (bool, *KVState) {
	// Prefer a client-supplied prompt ID, otherwise hash the system message
	promptID := req.SystemPromptID
	if promptID == "" {
		if len(req.Messages) == 0 || req.Messages[0].Role != "system" {
			return false, nil
		}
		promptID = ComputeHash(req.Model, req.Messages[:1])
	}

	cacheKey := fmt.Sprintf("kvcache:%s:%s", req.Model, promptID)
	data, err := c.rdb.Get(ctx, cacheKey).Bytes()
	if err != nil {
		return false, nil
	}

	var entry CacheEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return false, nil
	}

	// Update hit counter
	c.rdb.HIncrBy(ctx, "kvcache:stats", entry.Hash, 1)
	c.rdb.HSet(ctx, cacheKey+":meta", "last_used", time.Now().Unix())

	// Load KV state from disk/NVMe (fast: PCIe bandwidth ~32 GB/s)
	kvState := loadKVFromDisk(entry.CacheFile)
	return true, kvState
}

// Set stores a KV cache entry
func (c *PromptCache) Set(ctx context.Context, modelID, systemPromptID string, kvState *KVState, tokenLen int) error {
	cacheFile := fmt.Sprintf("/nvme/kvcache/%s/%s.bin", modelID, systemPromptID)

	// Save KV state to NVMe (faster than DRAM for GPU cache)
	if err := saveKVToDisk(cacheFile, kvState); err != nil {
		return err
	}

	entry := CacheEntry{
		Hash:      systemPromptID,
		ModelID:   modelID,
		TokenLen:  tokenLen,
		CacheFile: cacheFile,
		CreatedAt: time.Now(),
		LastUsed:  time.Now(),
	}

	data, _ := json.Marshal(entry)
	cacheKey := fmt.Sprintf("kvcache:%s:%s", modelID, systemPromptID)
	return c.rdb.Set(ctx, cacheKey, data, 24*time.Hour).Err()
}

// KV cache prefix sharing:
// Request A: [system_prompt][user_msg_A]
// Request B: [system_prompt][user_msg_B]
// Both share the [system_prompt] KV computation → ~50% token savings
type KVState struct {
	LayerCount int
	HeadCount  int
	TokenLen   int
	Data       []byte // serialized KV tensors
}

func loadKVFromDisk(path string) *KVState {
	// Read from NVMe: 32GB/s bandwidth → 400MB KV = 12ms load time
	return nil // simplified
}

func saveKVToDisk(path string, kv *KVState) error {
	// Write to NVMe
	return nil // simplified
}
```

### 4. Auto-Scaling

GPU instances are 10-50x more expensive than CPU instances, so auto-scaling decisions directly determine operating cost. The auto-scaler evaluates three signals every 30 seconds: queue depth (absolute backlog), P99 time-to-first-token latency (user-facing quality signal), and GPU memory utilization percentage (capacity headroom). Scaling out is triggered when any signal crosses its threshold, scaling in requires all signals to be below their targets simultaneously to avoid oscillation. A scale-in cooldown prevents premature deprovisioning after a burst.

```go
package scaling

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type CloudProvider interface {
	LaunchInstances(ctx context.Context, model string, count int) error
	DrainAndTerminate(ctx context.Context, model string, count int) error
}

// GPUAutoScaler manages the pool of model serving instances
type GPUAutoScaler struct {
	rdb        *redis.Client
	cloudAPI   CloudProvider
	minWorkers int
	maxWorkers int
	model      string
	lowStreak  int       // consecutive low-load evaluations
	lastScale  time.Time // for scale-in cooldown
}

// ScalingMetrics are used to make scaling decisions
type ScalingMetrics struct {
	QueueDepth    int     // pending requests
	AvgLatencyMs  float64 // P50 TTFT
	P99LatencyMs  float64 // P99 TTFT
	GPUUtilization float64 // 0-100%
	TokensPerSec  float64
	WorkerCount   int
}

// AutoScale evaluates metrics and adjusts worker count
func (s *GPUAutoScaler) AutoScale(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := s.collectMetrics(ctx)
			decision := s.makeScalingDecision(metrics)

			switch decision {
			case "scale_up":
				s.scaleUp(ctx, metrics.WorkerCount+2)
				s.lastScale = time.Now()
			case "scale_down":
				s.scaleDown(ctx, metrics.WorkerCount-1)
				s.lastScale = time.Now()
			}
		}
	}
}

// makeScalingDecision determines if scaling is needed
func (s *GPUAutoScaler) makeScalingDecision(m ScalingMetrics) string {
	// Scale up if:
	// - Queue depth > 20 requests (waiting > 2 seconds at 10 req/sec)
	// - P99 latency > 5 seconds (TTFT too high)
	// - GPU utilization > 85%
	if m.QueueDepth > 20 || m.P99LatencyMs > 5000 || m.GPUUtilization > 85 {
		s.lowStreak = 0
		if m.WorkerCount < s.maxWorkers {
			return "scale_up"
		}
		return "no_change"
	}

	// Scale down only after 5 consecutive low-load checks and a
	// 10-minute cooldown since the last scaling action
	if m.QueueDepth < 5 && m.GPUUtilization < 30 {
		s.lowStreak++
		if s.lowStreak >= 5 &&
			time.Since(s.lastScale) > 10*time.Minute &&
			m.WorkerCount > s.minWorkers {
			return "scale_down"
		}
		return "no_change"
	}

	s.lowStreak = 0
	return "no_change"
}

func (s *GPUAutoScaler) scaleUp(ctx context.Context, targetCount int) {
	fmt.Printf("Scaling up to %d workers\n", targetCount)
	// In production: launch new GPU instances (AWS p4d.24xlarge, etc.)
	// Time to start: ~5 minutes (GPU instance + model loading)
	// Strategy: pre-warm instances in anticipation of traffic spikes
	s.cloudAPI.LaunchInstances(ctx, s.model, targetCount)
}

func (s *GPUAutoScaler) scaleDown(ctx context.Context, targetCount int) {
	fmt.Printf("Scaling down to %d workers\n", targetCount)
	// Drain: stop accepting new requests, finish in-flight, then terminate
	s.cloudAPI.DrainAndTerminate(ctx, s.model, targetCount)
}

func (s *GPUAutoScaler) collectMetrics(ctx context.Context) ScalingMetrics {
	queueDepth, _ := s.rdb.LLen(ctx, fmt.Sprintf("queue:%s", s.model)).Result()
	p99Latency, _ := s.rdb.ZScore(ctx, "latency:p99", s.model).Result()
	gpuUtil, _ := s.rdb.ZScore(ctx, "gpu:util", s.model).Result()
	workerCount, _ := s.rdb.SCard(ctx, fmt.Sprintf("workers:%s", s.model)).Result()

	return ScalingMetrics{
		QueueDepth:     int(queueDepth),
		P99LatencyMs:   p99Latency,
		GPUUtilization: gpuUtil,
		WorkerCount:    int(workerCount),
	}
}
```

---
