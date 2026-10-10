## 115.4 Anthropic Claude Integration

### Claude Messages API Client

Anthropic's Claude uses a slightly different API design. Here's a complete implementation:

```go
// anthropic/client.go
package anthropic

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://api.anthropic.com/v1"

	// DefaultModel is a fallback only - read the real value from configuration.
	// Model IDs move faster than your deploy cadence.
	DefaultModel = "claude-sonnet-5"

	// APIVersion pins the Anthropic wire format. It is not the model version
	// and it does not change when models do. Sending it is mandatory.
	APIVersion = "2023-06-01"
)

type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
}

func NewClient(apiKey string, opts ...ClientOption) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: DefaultBaseURL,
		httpClient: &http.Client{
			Timeout: 60 * time.Second,
		},
	}

	for _, opt := range opts {
		opt(c)
	}

	return c
}

type ClientOption func(*Client)

func WithHTTPClient(client *http.Client) ClientOption {
	return func(c *Client) {
		c.httpClient = client
	}
}

type MessageRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	System   string    `json:"system,omitempty"`

	// MaxTokens has no omitempty: Anthropic requires it on every request, and
	// an omitted field would be a 400 rather than a default.
	MaxTokens int `json:"max_tokens"`

	// Temperature and TopP are pointers on purpose, for two independent
	// reasons.
	//
	// First, the encoding/json footgun: with `float64` plus omitempty, a
	// deliberate Temperature of 0 is indistinguishable from "unset" and gets
	// dropped from the payload. You ask for determinism and silently get the
	// server default. A pointer distinguishes "zero" from "absent".
	//
	// Second, and more importantly: the newest Claude models reject sampling
	// parameters outright with a 400 rather than ignoring them. Steer those
	// models with the prompt and with effort/thinking controls instead. Leave
	// these nil unless you have confirmed the target model accepts them.
	Temperature *float64 `json:"temperature,omitempty"`
	TopP        *float64 `json:"top_p,omitempty"`

	Stream bool `json:"stream,omitempty"`
}

type Message struct {
	Role    string         `json:"role"` // user or assistant
	Content []ContentBlock `json:"content"`
}

type ContentBlock struct {
	Type string `json:"type"` // text, image
	Text string `json:"text,omitempty"`
}

// NewTextMessage creates a simple text message
func NewTextMessage(role, text string) Message {
	return Message{
		Role: role,
		Content: []ContentBlock{
			{Type: "text", Text: text},
		},
	}
}

type MessageResponse struct {
	ID           string         `json:"id"`
	Type         string         `json:"type"`
	Role         string         `json:"role"`
	Content      []ContentBlock `json:"content"`
	Model        string         `json:"model"`
	StopReason   string         `json:"stop_reason"`
	StopSequence string         `json:"stop_sequence"`
	Usage        Usage          `json:"usage"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

func (c *Client) CreateMessage(
	ctx context.Context,
	req MessageRequest,
) (*MessageResponse, error) {
	if req.Model == "" {
		req.Model = DefaultModel
	}
	if req.MaxTokens == 0 {
		req.MaxTokens = 1024
	}

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/messages",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("anthropic-version", APIVersion)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	var msgResp MessageResponse
	if err := json.NewDecoder(resp.Body).Decode(&msgResp); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	return &msgResp, nil
}

// StreamMessage streams a message response
func (c *Client) StreamMessage(
	ctx context.Context,
	req MessageRequest,
) (<-chan StreamEvent, error) {
	if req.Model == "" {
		req.Model = DefaultModel
	}
	if req.MaxTokens == 0 {
		req.MaxTokens = 1024
	}
	req.Stream = true

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/messages",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("anthropic-version", APIVersion)
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

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()

			if !strings.HasPrefix(line, "data: ") {
				continue
			}

			data := strings.TrimPrefix(line, "data: ")

			var event StreamEvent
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				events <- StreamEvent{Error: err}
				return
			}

			select {
			case events <- event:
			case <-ctx.Done():
				return
			}

			if event.Type == "message_stop" {
				return
			}
		}

		if err := scanner.Err(); err != nil {
			events <- StreamEvent{Error: err}
		}
	}()

	return events, nil
}

type StreamEvent struct {
	Type  string       `json:"type"`
	Index int          `json:"index,omitempty"`
	Delta *StreamDelta `json:"delta,omitempty"`
	Usage *Usage       `json:"usage,omitempty"`
	Error error        `json:"-"`
}

type StreamDelta struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	StopReason string `json:"stop_reason,omitempty"`
}
```

### Claude Usage Example

This usage example constructs a system prompt and a user message, sends the request to the Claude client, and streams the response tokens to stdout in real time. Streaming mode reduces time-to-first-token perceived latency significantly for conversational applications compared to waiting for the full completion.

```go
// examples/claude_example.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"yourproject/anthropic"
)

func main() {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		log.Fatal("ANTHROPIC_API_KEY environment variable required")
	}

	client := anthropic.NewClient(apiKey)

	// Basic message
	resp, err := client.CreateMessage(context.Background(), anthropic.MessageRequest{
		Model: anthropic.DefaultModel,
		Messages: []anthropic.Message{
			anthropic.NewTextMessage("user", "Explain Go interfaces in 3 sentences."),
		},
		System:    "You are a Go programming expert.",
		MaxTokens: 200,
		// No Temperature: current models reject it. Steer with the prompt.
	})
	if err != nil {
		log.Fatalf("Message failed: %v", err)
	}

	fmt.Printf("Response: %s\n", resp.Content[0].Text)
	fmt.Printf("Tokens: %d input, %d output\n",
		resp.Usage.InputTokens,
		resp.Usage.OutputTokens,
	)

	// Streaming message
	fmt.Println("\n--- Streaming Response ---")
	stream, err := client.StreamMessage(context.Background(), anthropic.MessageRequest{
		Messages: []anthropic.Message{
			anthropic.NewTextMessage("user", "Write a haiku about concurrency."),
		},
		MaxTokens: 100,
	})
	if err != nil {
		log.Fatalf("Stream failed: %v", err)
	}

	for event := range stream {
		if event.Error != nil {
			log.Printf("Stream error: %v", event.Error)
			break
		}

		if event.Type == "content_block_delta" && event.Delta != nil {
			fmt.Print(event.Delta.Text)
		}

		if event.Type == "message_stop" {
			fmt.Println("\n[Stream complete]")
			break
		}
	}
}
```

Note what the consumer loop is doing: it switches on `event.Type` and ignores
anything it does not recognise. That is the right default for an SSE stream you
do not control. Anthropic interleaves `ping` keepalives, `message_start`,
`content_block_start`/`_stop`, `message_delta` (which carries the final
`stop_reason` and the output token count), and can add new event types without
breaking the wire contract. A decoder that treats an unknown event as an error
will start failing the day the provider ships a feature you did not opt into.

The one type you must not ignore is `error`, which arrives mid-stream after a
`200 OK`. An overloaded backend can accept your request, start streaming, and
then fail. Because the status line already said 200, a client that only checks
`resp.StatusCode` reports success and returns a truncated answer. Treat a
mid-stream `error` event as a failed request, not as an end-of-stream.

### Junior → FAANG: Claude-Specific Integration Considerations

The Claude Messages API uses a different message structure than OpenAI's chat completions API: system messages are a top-level parameter rather than a message in the array, and the API enforces strict alternation between user and assistant turns. These structural differences mean you cannot use the same message formatting code for both APIs without a translation layer. Building a provider-agnostic message format and translating to each provider's format at the client boundary is the correct architectural approach.

Claude's thinking capability (where the model reasons before answering) and its computer use tools are differentiating features that produce structured content blocks beyond the standard text response, and both are configured per request. Thinking is worth understanding as a moving target rather than a fixed API: the original design took an explicit token budget, and the current generation instead lets the model decide how much to think, with a separate effort control for depth. Two consequences follow for your client. Reasoning arrives as its own block type alongside text, so a response parser that assumes `content[0]` is the answer will hand your users the model's scratchpad. And whether the reasoning text is populated at all is itself a per-request setting on current models, defaulting to omitted, so a UI that streams reasoning must opt in explicitly or it will render a long, silent pause. Check the current API reference before wiring this up rather than copying a snippet, and test whether exposed reasoning actually improves user trust before paying for it at scale.

Prompt caching, where Claude caches the computation for frequently repeated system prompt prefixes, is a significant cost optimization for applications with long system prompts and high request volume. A legal assistant application with a 10,000-token system prompt containing the relevant legal context can cache that prompt computation and pay only a fraction of the full token cost for subsequent requests that reuse the same prefix. Implementing prompt caching in Go requires setting the `cache_control` parameter on the message parts that should be cached, and tracking cache hit rates as a cost efficiency metric.

### Senior @ FAANG: Multi-Provider Strategy and Claude's Role

At FAANG scale, the choice of provider and model tier for a specific feature is an ADR-level decision with significant cost and quality implications, and it is a decision with a shelf life, since the ranking changes with every release cycle. Write the ADR so that it records the evaluation method, not just the winner, because the method is what you will re-run in six months. The evaluation criteria include: benchmark performance on tasks representative of your specific use case (general benchmarks often do not correlate with performance on domain-specific tasks), cost per token relative to quality (a cheaper model that is 80% as good might be the right choice for 90% of your requests), context window size, and provider reliability SLA (what is the provider's historical uptime and what support do they provide for production outages?).

A multi-provider strategy is a risk management decision. Relying on a single LLM provider creates a single point of failure: if that provider has an outage, all LLM-dependent features are unavailable. A fallback strategy (primary provider fails, fall back to secondary, fall back to cached responses or a local model) reduces this risk at the cost of implementation complexity and the need to maintain integrations with multiple providers. The fallback cascade must be designed so that the quality degradation at each level is acceptable for the user experience and disclosed to the user where relevant.

Claude's instruction following and safety features are relevant to senior-level risk management decisions. For applications where users can provide arbitrary input that is forwarded to the LLM, Claude's trained refusal behaviors provide a layer of defense against prompt injection and misuse attempts. Understanding the limits of these built-in protections, and adding application-level input validation and output filtering on top of them, is the defense-in-depth approach that senior engineers implement for any LLM feature that handles untrusted user input.
