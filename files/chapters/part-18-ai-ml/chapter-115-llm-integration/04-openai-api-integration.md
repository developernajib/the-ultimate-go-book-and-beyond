## 115.3 OpenAI API Integration

### Complete OpenAI Client

Let's build a production-ready OpenAI client with error handling, retries, and streaming:

```go
// openai/client.go
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	DefaultBaseURL = "https://api.openai.com/v1"

	// DefaultModel is a fallback only. Model IDs are retired and superseded on
	// a schedule you do not control, so production code should read the model
	// from configuration (see the multi-provider discussion below) rather than
	// baking a constant into the binary.
	DefaultModel = "gpt-4o"
)

type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client

	// Rate limiting
	rateLimiter *RateLimiter
}

func NewClient(apiKey string, opts ...ClientOption) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: DefaultBaseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		// Your actual limit depends on your account tier and the model. Read it
		// from the x-ratelimit-limit-requests response header and configure it
		// with WithRateLimit rather than trusting this placeholder.
		rateLimiter: NewRateLimiter(500, time.Minute),
	}

	for _, opt := range opts {
		opt(c)
	}

	return c
}

type ClientOption func(*Client)

func WithBaseURL(url string) ClientOption {
	return func(c *Client) {
		c.baseURL = url
	}
}

func WithHTTPClient(client *http.Client) ClientOption {
	return func(c *Client) {
		c.httpClient = client
	}
}

func WithRateLimit(requests int, per time.Duration) ClientOption {
	return func(c *Client) {
		c.rateLimiter = NewRateLimiter(requests, per)
	}
}

// ChatCompletionRequest represents OpenAI's chat completion API request.
//
// Note on MaxCompletionTokens: the older `max_tokens` field is deprecated on
// the Chat Completions API and is rejected outright by the reasoning models,
// which require `max_completion_tokens`. Emit the new field name. If you must
// talk to an OpenAI-compatible third-party server that only understands
// `max_tokens`, translate in that provider's adapter, not here.
type ChatCompletionRequest struct {
	Model               string    `json:"model"`
	Messages            []Message `json:"messages"`
	Temperature         float64   `json:"temperature,omitempty"`
	TopP                float64   `json:"top_p,omitempty"`
	MaxCompletionTokens int       `json:"max_completion_tokens,omitempty"`
	Stream              bool      `json:"stream,omitempty"`
	User                string    `json:"user,omitempty"`
}

type Message struct {
	Role    string `json:"role"` // system, user, assistant
	Content string `json:"content"`
}

type ChatCompletionResponse struct {
	ID      string   `json:"id"`
	Object  string   `json:"object"`
	Created int64    `json:"created"`
	Model   string   `json:"model"`
	Choices []Choice `json:"choices"`
	Usage   Usage    `json:"usage"`
}

type Choice struct {
	Index        int     `json:"index"`
	Message      Message `json:"message"`
	FinishReason string  `json:"finish_reason"`
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// CreateChatCompletion sends a chat completion request
func (c *Client) CreateChatCompletion(
	ctx context.Context,
	req ChatCompletionRequest,
) (*ChatCompletionResponse, error) {
	// Wait for rate limiter
	if err := c.rateLimiter.Wait(ctx); err != nil {
		return nil, fmt.Errorf("rate limiter: %w", err)
	}

	// Set default model
	if req.Model == "" {
		req.Model = DefaultModel
	}

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/chat/completions",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	var chatResp ChatCompletionResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &chatResp, nil
}

// StreamChatCompletion streams chat completion responses
func (c *Client) StreamChatCompletion(
	ctx context.Context,
	req ChatCompletionRequest,
) (<-chan StreamEvent, error) {
	if err := c.rateLimiter.Wait(ctx); err != nil {
		return nil, fmt.Errorf("rate limiter: %w", err)
	}

	if req.Model == "" {
		req.Model = DefaultModel
	}
	req.Stream = true

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/chat/completions",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	events := make(chan StreamEvent, 10)

	go func() {
		defer close(events)
		defer resp.Body.Close()

		decoder := NewSSEDecoder(resp.Body)
		for {
			event, err := decoder.Decode()
			if err == io.EOF {
				return
			}
			if err != nil {
				events <- StreamEvent{Error: err}
				return
			}

			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}()

	return events, nil
}

type StreamEvent struct {
	Delta StreamDelta
	Error error
	Done  bool
}

type StreamDelta struct {
	Content string `json:"content"`
	Role    string `json:"role"`
}
```

Two things this client deliberately does not do, so that you notice them rather
than inherit them silently. It does not request usage accounting on the
streaming path: a streamed response carries no `usage` object unless you ask for
it (OpenAI gates this behind a `stream_options.include_usage` flag), so a
streaming-only integration that skips it has no per-request token numbers to
bill against. And it retries nothing. Retry and circuit breaking are built in a
later section and wrap this client from the outside.

### Server-Sent Events Decoder

Server-sent events (SSE) carry streaming tokens from the LLM provider to the client as a sequence of newline-delimited JSON payloads over a persistent HTTP connection. The following decoder correctly handles chunked transfer encoding, partial reads, and the `[DONE]` sentinel that signals stream completion.

```go
// openai/sse.go
package openai

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
)

type SSEDecoder struct {
	scanner *bufio.Scanner
}

func NewSSEDecoder(r io.Reader) *SSEDecoder {
	s := bufio.NewScanner(r)
	// bufio.Scanner defaults to a 64KB line cap and returns bufio.ErrTooLong
	// past it. Token deltas are tiny, but a single SSE line also carries tool
	// call arguments and structured output, which are not. Raise the cap so a
	// large line surfaces as data rather than as a stream error.
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	return &SSEDecoder{scanner: s}
}

type StreamChunk struct {
	ID      string         `json:"id"`
	Object  string         `json:"object"`
	Created int64          `json:"created"`
	Model   string         `json:"model"`
	Choices []StreamChoice `json:"choices"`
}

type StreamChoice struct {
	Index        int         `json:"index"`
	Delta        StreamDelta `json:"delta"`
	FinishReason *string     `json:"finish_reason"`
}

func (d *SSEDecoder) Decode() (StreamEvent, error) {
	for d.scanner.Scan() {
		line := d.scanner.Text()

		// SSE format: "data: {...}"
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")

		// OpenAI sends "[DONE]" when stream completes
		if data == "[DONE]" {
			return StreamEvent{Done: true}, nil
		}

		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return StreamEvent{}, err
		}

		if len(chunk.Choices) > 0 {
			return StreamEvent{
				Delta: chunk.Choices[0].Delta,
			}, nil
		}
	}

	if err := d.scanner.Err(); err != nil {
		return StreamEvent{}, err
	}

	return StreamEvent{}, io.EOF
}
```

### Rate Limiter Implementation

This limiter faces the other way from the one you would put in front of your own
API. It is not defending you from your callers. It is keeping *you* inside the
provider's quota, so that you shed load in your own process, where you control
the queueing, instead of collecting 429s.

The implementation below is a fixed-window counter: the full allowance is
restored every `interval`, and callers block until the window rolls over. Name
it honestly, because it is not a token bucket, and the difference shows up at
the seams. A fixed window lets a caller spend the tail of one window and the
head of the next back to back, briefly running at twice the configured rate.
Against a provider that meters on a sliding window, that burst is exactly what
earns a 429. It is shown here because it is short enough to read in one sitting.
Reach for `golang.org/x/time/rate` in production, which gives you a real token
bucket, `Wait`/`Allow`/`Reserve`, and burst control that has already been
debugged.

```go
// openai/ratelimit.go
package openai

import (
	"context"
	"sync"
	"time"
)

// RateLimiter is a fixed-window request counter.
type RateLimiter struct {
	tokens   int
	capacity int
	interval time.Duration
	mu       sync.Mutex
	lastFill time.Time
}

func NewRateLimiter(capacity int, interval time.Duration) *RateLimiter {
	return &RateLimiter{
		tokens:   capacity,
		capacity: capacity,
		interval: interval,
		lastFill: time.Now(),
	}
}

func (rl *RateLimiter) Wait(ctx context.Context) error {
	for {
		rl.mu.Lock()

		// Refill tokens based on elapsed time
		now := time.Now()
		elapsed := now.Sub(rl.lastFill)
		if elapsed >= rl.interval {
			rl.tokens = rl.capacity
			rl.lastFill = now
		}

		if rl.tokens > 0 {
			rl.tokens--
			rl.mu.Unlock()
			return nil
		}

		// Calculate wait time
		waitTime := rl.interval - elapsed
		rl.mu.Unlock()

		// Wait or check context cancellation
		timer := time.NewTimer(waitTime)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
			// Continue loop to try again
		}
	}
}
```

### Usage Example

The following usage example demonstrates how to integrate the preceding components into a working end-to-end flow, showing the initialization sequence, primary API calls, and expected outputs. This represents the minimal viable integration pattern that production code should extend from.

```go
// examples/openai_basic.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"yourproject/openai"
)

func main() {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		log.Fatal("OPENAI_API_KEY environment variable required")
	}

	client := openai.NewClient(apiKey)

	// Simple completion
	resp, err := client.CreateChatCompletion(context.Background(), openai.ChatCompletionRequest{
		Model: "gpt-4o",
		Messages: []openai.Message{
			{Role: "system", Content: "You are a helpful assistant."},
			{Role: "user", Content: "Explain Go channels in 3 sentences."},
		},
		Temperature:         0.7,
		MaxCompletionTokens: 200,
	})
	if err != nil {
		log.Fatalf("Completion failed: %v", err)
	}

	fmt.Printf("Response: %s\n", resp.Choices[0].Message.Content)
	fmt.Printf("Tokens used: %d (prompt: %d, completion: %d)\n",
		resp.Usage.TotalTokens,
		resp.Usage.PromptTokens,
		resp.Usage.CompletionTokens,
	)

	// Streaming completion
	fmt.Println("\n--- Streaming Response ---")
	streamResp, err := client.StreamChatCompletion(context.Background(), openai.ChatCompletionRequest{
		Messages: []openai.Message{
			{Role: "user", Content: "Write a haiku about Go programming."},
		},
	})
	if err != nil {
		log.Fatalf("Stream failed: %v", err)
	}

	for event := range streamResp {
		if event.Error != nil {
			log.Printf("Stream error: %v", event.Error)
			break
		}
		if event.Done {
			fmt.Println("\n[Stream complete]")
			break
		}
		fmt.Print(event.Delta.Content)
	}
}
```

### Junior → FAANG: OpenAI Integration Patterns for Production

The most important pattern in any OpenAI client is the retry-with-exponential-backoff wrapper around every API call. OpenAI returns 429 (rate limited) and 503 (service unavailable) errors that are transient and should be retried, and 400 (invalid request) and 401 (unauthorized) errors that are permanent and should propagate immediately to the caller. Implementing this distinction correctly prevents two common failure modes: infinite retries on permanent errors, and no retries on transient errors. Practice implementing this wrapper with a configurable max retry count, base delay, and jitter factor.

Token counting before making an API call is a prerequisite for cost control. A tokenizer that matches the target model (OpenAI's tiktoken, via one of its Go ports, or the provider's own token-counting endpoint) counts tokens before the API call, allowing you to: validate that the request fits within the context window, estimate the cost of the request before incurring it, and log the estimated cost alongside the actual usage from the API response for reconciliation. Juniors who skip token counting create systems where a single large user input can generate an unexpectedly expensive API call.

For interview prep, design an OpenAI client wrapper in Go that includes: authentication via environment variable (never hardcoded), request timeout with a configurable deadline, retry logic for transient errors, token counting and logging, rate limit enforcement using a token bucket, and structured logging of request and response metadata. This wrapper is the minimum production-quality LLM client, and being able to design it in detail from memory demonstrates hands-on experience with production LLM integration.

### Senior @ FAANG: Multi-Provider Client Design and Governance

At senior level, the OpenAI client is one implementation of a provider interface, not the application's primary abstraction. The primary abstraction is the LLM client interface that all providers implement: `Complete(ctx context.Context, req CompletionRequest) (CompletionResponse, error)` and `Stream(ctx context.Context, req CompletionRequest) (<-chan CompletionChunk, error)`. With this interface, swapping providers or adding a new provider requires only a new implementation, not changes to every call site.

Versioning the model selection is a senior-level concern. Providers ship new models, and retire old ones, on a cadence measured in months, and each one arrives with different capabilities, costs, context windows, and sometimes a different request surface (a parameter that silently worked yesterday returns a 400 today). Hardcoding the model name in application code means every model upgrade requires a code change and deployment. The better pattern is to externalize the model selection to a configuration service, allowing the platform team to change the model for any feature without a code deployment. This configuration must include the model name, context window size, and cost per token for accurate budget enforcement.

Rate limit management at FAANG scale requires understanding OpenAI's rate limit structure: requests per minute, tokens per minute, and tokens per day per model, with separate limits per organization and per API key. The platform team must track consumption against all three limits simultaneously, route requests to API keys with available capacity, and queue requests when all capacity is consumed rather than failing immediately. This capacity management logic belongs in the LLM gateway, not in individual service clients. Designing the gateway to handle rate limit management transparently is one of the highest-value platform capabilities for LLM-heavy organizations.
