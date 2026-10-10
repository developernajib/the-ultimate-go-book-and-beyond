## 118C.3 Anthropic Claude Client

The Anthropic Claude client implements the `Provider` interface from the gateway, handling the Messages API's SSE streaming format by parsing `data:` lines and assembling delta content blocks into the final completion. It classifies HTTP response codes into retryable errors (429, 529) and terminal errors (400, 401) to drive the gateway's retry policy correctly.

```go
package anthropic

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/yourorg/llmgateway"
)

// ClaudeClient implements LLMClient for Anthropic's API
type ClaudeClient struct {
	apiKey  string
	baseURL string
	model   string
	client  *http.Client
	logger  *slog.Logger
}

func NewClaudeClient(apiKey, model string) *ClaudeClient {
	return &ClaudeClient{
		apiKey:  apiKey,
		baseURL: "https://api.anthropic.com/v1",
		model:   model,
		client:  &http.Client{Timeout: 120 * time.Second},
		logger:  slog.Default(),
	}
}

func (c *ClaudeClient) Name() llmgateway.Provider {
	return llmgateway.ProviderAnthropic
}

// claudeRequest maps to Anthropic's Messages API
type claudeRequest struct {
	Model     string          `json:"model"`
	MaxTokens int             `json:"max_tokens"`
	Messages  []claudeMessage `json:"messages"`
	System    string          `json:"system,omitempty"`
	Stream    bool            `json:"stream,omitempty"`
}

type claudeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type claudeResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Usage struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	StopReason string `json:"stop_reason"`
}

// APIError is a classified error response from the Anthropic API.
type APIError struct {
	StatusCode int
	Type       string // e.g. "rate_limit_error", "authentication_error"
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("anthropic API error %d (%s): %s", e.StatusCode, e.Type, e.Message)
}

// Retryable reports whether the gateway should back off and try again.
//
// 429 (rate limited) and 529 (overloaded) are transient: the identical request
// will probably succeed a moment later. 5xx is a server-side fault, likewise
// worth a retry. Everything else is terminal, and the distinction matters in
// both directions. Retrying a 401 loops forever against a key that will never
// work. Not retrying a 429 turns a brief throttle into a user-visible outage.
func (e *APIError) Retryable() bool {
	switch {
	case e.StatusCode == http.StatusTooManyRequests: // 429
		return true
	case e.StatusCode == 529: // overloaded_error; no net/http constant for it
		return true
	case e.StatusCode >= 500:
		return true
	default:
		return false
	}
}

// parseAPIError drains the error body and classifies it.
func parseAPIError(resp *http.Response) *APIError {
	body, _ := io.ReadAll(resp.Body)
	apiErr := &APIError{StatusCode: resp.StatusCode, Message: string(body)}

	// Anthropic error bodies are {"type":"error","error":{"type":..,"message":..}}.
	var envelope struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error.Type != "" {
		apiErr.Type = envelope.Error.Type
		apiErr.Message = envelope.Error.Message
	}
	return apiErr
}

func (c *ClaudeClient) Complete(ctx context.Context, req *llmgateway.CompletionRequest) (*llmgateway.CompletionResponse, error) {
	claudeReq := c.convertRequest(req)

	data, err := json.Marshal(claudeReq)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST",
		c.baseURL+"/messages", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, parseAPIError(resp)
	}

	var claudeResp claudeResponse
	if err := json.NewDecoder(resp.Body).Decode(&claudeResp); err != nil {
		return nil, err
	}

	// Concatenate every text block rather than taking Content[0].
	//
	// Reading Content[0].Text is the obvious shortcut and it breaks the moment
	// thinking is enabled: the response then leads with a thinking block, so
	// Content[0].Text is empty and the answer silently disappears. Selecting on
	// block type is correct regardless of which block kinds the model emits.
	var sb strings.Builder
	for _, block := range claudeResp.Content {
		if block.Type == "text" {
			sb.WriteString(block.Text)
		}
	}
	content := sb.String()

	return &llmgateway.CompletionResponse{
		ID:    claudeResp.ID,
		Model: claudeResp.Model,
		Choice: llmgateway.ChatMessage{
			Role:    "assistant",
			Content: content,
		},
		Usage: llmgateway.TokenUsage{
			PromptTokens:     claudeResp.Usage.InputTokens,
			CompletionTokens: claudeResp.Usage.OutputTokens,
			TotalTokens:      claudeResp.Usage.InputTokens + claudeResp.Usage.OutputTokens,
		},
	}, nil
}

func (c *ClaudeClient) Stream(ctx context.Context, req *llmgateway.CompletionRequest) (<-chan llmgateway.StreamChunk, error) {
	claudeReq := c.convertRequest(req)
	claudeReq.Stream = true

	data, err := json.Marshal(claudeReq)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST",
		c.baseURL+"/messages", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, parseAPIError(resp)
	}

	ch := make(chan llmgateway.StreamChunk, 100)
	go func() {
		defer close(ch)
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		// bufio.Scanner defaults to a 64KB maximum token size and returns
		// ErrTooLong past it, which here would look like a stream that simply
		// stops mid-answer. A single SSE data line can exceed 64KB, so raise
		// the cap explicitly rather than discovering it on a long response.
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}

			// Note: there is no "data: [DONE]" sentinel here. That is OpenAI's
			// convention. The Anthropic Messages API terminates a stream with a
			// message_stop event, so that is what we key on.
			data := strings.TrimPrefix(line, "data: ")

			var event map[string]any
			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			eventType, _ := event["type"].(string)
			switch eventType {
			case "content_block_delta":
				delta, _ := event["delta"].(map[string]any)
				// Select on the delta type. A stream may interleave
				// thinking_delta blocks (which carry "thinking", not "text"),
				// and only text_delta belongs in the user-visible answer.
				if deltaType, _ := delta["type"].(string); deltaType != "text_delta" {
					continue
				}
				if text, _ := delta["text"].(string); text != "" {
					ch <- llmgateway.StreamChunk{Delta: text}
				}
			case "message_stop":
				ch <- llmgateway.StreamChunk{Done: true, FinishReason: "stop"}
				return
			}
		}

		// A stream that ends without message_stop was truncated (network drop,
		// context cancellation). Surface it rather than letting the consumer
		// mistake a partial answer for a complete one.
		if err := scanner.Err(); err != nil {
			c.logger.Error("claude stream aborted", "err", err)
		}
	}()

	return ch, nil
}

func (c *ClaudeClient) convertRequest(req *llmgateway.CompletionRequest) *claudeRequest {
	// Honour the per-request model, falling back to the client's default.
	// Pinning to c.model and ignoring req.Model is a subtle accounting bug:
	// the gateway prices the request against req.Model while the API actually
	// serves c.model, so the cost dashboard is wrong in a way no test catches.
	model := req.Model
	if model == "" {
		model = c.model
	}

	claudeReq := &claudeRequest{
		Model:     model,
		MaxTokens: req.MaxTokens,
	}
	if claudeReq.MaxTokens == 0 {
		claudeReq.MaxTokens = 4096
	}

	// Note the deliberate absence of Temperature. Current Claude models reject
	// temperature/top_p/top_k outright, so forwarding the gateway's Temperature
	// field here would turn every request into a 400. Steer these models with
	// the prompt instead. This is the kind of provider-specific quirk the
	// per-provider client exists to absorb.

	for _, msg := range req.Messages {
		if msg.Role == "system" {
			claudeReq.System = msg.Content
		} else {
			claudeReq.Messages = append(claudeReq.Messages, claudeMessage{
				Role:    msg.Role,
				Content: msg.Content,
			})
		}
	}

	return claudeReq
}
```

---

### Junior → FAANG: API Client Implementation as Error Classification Interview Topic

The Anthropic Claude client demonstrates the error classification pattern that is essential for any external API client: distinguishing retryable errors (429 Too Many Requests, 529 Overloaded) from terminal errors (400 Bad Request, 401 Unauthorized). Retryable errors warrant exponential backoff and retry. Terminal errors warrant immediate failure with a specific error type that the caller can handle. Without this classification, a client that retries on 401 Unauthorized will loop indefinitely, and a client that does not retry on 429 Too Many Requests will fail unnecessarily under high load.

The SSE streaming format parsing (reading event-stream lines, extracting data fields, assembling delta content) is a concrete text processing task in Go. Implementing it requires understanding Go's bufio.Scanner for line reading, the event-stream format (event type line followed by data line followed by blank line), and the JSON structure of the delta content for each provider. The Anthropic Messages API sends `content_block_delta` events carrying a typed delta, and terminates the stream with a `message_stop` event. The OpenAI chat completions streaming API sends data lines with delta objects in a `choices` array, and terminates with a literal `data: [DONE]` sentinel.

That last difference is worth dwelling on, because it is the single most common bug in hand-written multi-provider clients: `[DONE]` is an OpenAI convention, and Anthropic never sends it. A parser that waits for `[DONE]` on an Anthropic stream waits forever, or (more insidiously) appears to work because the HTTP body closes on its own and the loop exits without anyone noticing the completion signal was never received. Format differences like this are exactly why each provider gets its own client implementation rather than one clever parser with flags.

### Senior @ FAANG: Provider Client as Versioned API Dependency

At senior level, each provider client is a versioned API dependency that requires maintenance as the provider's API evolves. The `anthropic-version` header pins the wire contract, which is why it is required on every request and why a client that hardcodes it (as this one does) keeps working when new behaviour ships behind a later version. Change surfaces up through several channels: authentication accepts either an `x-api-key` header or an `Authorization: Bearer` token depending on whether you are using an API key or an OAuth credential, new capabilities arrive behind `anthropic-beta` headers before they go GA, and the set of content block types a response can contain grows over time. That last one is what bit the `Content[0]` shortcut above. Maintaining the client to track these changes, with clear version notes in the code, is a maintenance responsibility that belongs to the platform team. The organizational cost of this maintenance is the "API dependency tax" for using external LLM providers. It should be factored into the make-versus-buy analysis when deciding whether to use an external provider or host an open-source model internally.
