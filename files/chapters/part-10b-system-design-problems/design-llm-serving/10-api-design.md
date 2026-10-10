## API Design

The API follows the OpenAI-compatible format, which has become the de facto industry standard for LLM inference endpoints. By using this familiar interface, any existing application built for OpenAI can switch to your platform with minimal code changes. The endpoints cover the core use cases: chat completions (the primary inference endpoint), embeddings for vector search, model listing for discovery, usage tracking for billing, and fine-tuning for customization.

The chat completions endpoint is by far the most complex: it handles both streaming (SSE) and non-streaming responses, supports multi-modal inputs (text plus images), accepts system prompt cache hints, and returns token usage metadata for billing. The `stream` boolean in the request determines the response format, streaming returns `text/event-stream` with chunked delta objects, while non-streaming returns a single JSON response after the full generation completes.

```go
package api

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// POST /v1/chat/completions - Chat completion (streaming/non-streaming)
// The primary inference endpoint. Accepts OpenAI-compatible ChatRequest,
// routes to the correct model worker, and returns tokens either as a
// stream (SSE) or a buffered JSON response.
type ChatCompletionRequest struct {
	Model       string    `json:"model" validate:"required"`
	Messages    []Message `json:"messages" validate:"required,min=1"`
	MaxTokens   int       `json:"max_tokens" validate:"gt=0,lte=128000"`
	Temperature float64   `json:"temperature" validate:"gte=0,lte=2"`
	TopP        float64   `json:"top_p"`
	Stream      bool      `json:"stream"`
	Stop        []string  `json:"stop,omitempty"`
	// Extension fields (not in OpenAI spec)
	SystemPromptID string `json:"system_prompt_id,omitempty"` // enables prompt caching
	Priority       int    `json:"priority,omitempty"`          // 0=normal, 1=high
}

type ChatCompletionResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"` // "chat.completion"
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
	Created int64    `json:"created"`
}

type Choice struct {
	Index        int     `json:"index"`
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"` // stop, length, content_filter
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	CachedTokens     int `json:"cached_tokens,omitempty"`
}

// POST /v1/embeddings - Generate text embeddings for vector search
// GET /v1/models - List available models with pricing and context limits
// GET /v1/usage?start={date}&end={date} - Token usage stats for billing
// POST /v1/fine-tuning/jobs - Create a fine-tuning job with training data
// GET /v1/fine-tuning/jobs/{id} - Check fine-tuning job status

// Health and operational endpoints (not customer-facing)
// GET /v1/health - Returns model load status and GPU utilization
// GET /v1/metrics - Prometheus-format metrics (TTFT, TPOT, queue depth)
```

---
