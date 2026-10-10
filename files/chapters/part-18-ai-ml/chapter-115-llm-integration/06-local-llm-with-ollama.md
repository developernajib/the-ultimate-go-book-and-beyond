## 115.5 Local LLM with Ollama

Ollama runs LLMs locally, eliminating API costs and enabling offline operation. Perfect for development, privacy-sensitive applications, and cost optimization.

### Ollama Client Implementation

Ollama exposes two different HTTP surfaces, and knowing which one you are on saves an afternoon. Its native API lives under `/api/generate` and `/api/chat` and streams newline-delimited JSON objects, not server-sent events. Separately, it offers an OpenAI-compatible shim under `/v1/chat/completions` that speaks the SSE dialect the OpenAI client from the previous section already understands. The shim is the quickest way to point existing code at a local model. The native API is what the client below targets, because it exposes the load and evaluation timings you want when the bottleneck is your own hardware rather than someone else's rate limit.

```go
// ollama/client.go
package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const DefaultBaseURL = "http://localhost:11434"

type Client struct {
	baseURL    string
	httpClient *http.Client
}

func NewClient(opts ...ClientOption) *Client {
	c := &Client{
		baseURL: DefaultBaseURL,
		httpClient: &http.Client{
			Timeout: 5 * time.Minute, // Local models can be slow
		},
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

type GenerateRequest struct {
	Model    string `json:"model"`
	Prompt   string `json:"prompt"`
	System   string `json:"system,omitempty"`
	Template string `json:"template,omitempty"`
	Context  []int  `json:"context,omitempty"`
	Stream   bool   `json:"stream,omitempty"`
	Raw      bool   `json:"raw,omitempty"`

	// Options is a pointer because omitempty does not do what people expect on
	// a struct value: encoding/json has no notion of an "empty" struct, so a
	// zero-valued Options would still marshal as "options":{} on every request.
	// A nil pointer actually omits the key.
	Options *Options `json:"options,omitempty"`
}

type Options struct {
	Temperature float64 `json:"temperature,omitempty"`
	TopP        float64 `json:"top_p,omitempty"`
	TopK        int     `json:"top_k,omitempty"`
	NumPredict  int     `json:"num_predict,omitempty"` // Max tokens
}

type GenerateResponse struct {
	Model     string `json:"model"`
	CreatedAt string `json:"created_at"`
	Response  string `json:"response"`
	Done      bool   `json:"done"`
	Context   []int  `json:"context,omitempty"`

	// Metrics (only when Done is true). Durations are nanoseconds.
	TotalDuration      int64 `json:"total_duration,omitempty"`
	LoadDuration       int64 `json:"load_duration,omitempty"`
	PromptEvalCount    int   `json:"prompt_eval_count,omitempty"`
	PromptEvalDuration int64 `json:"prompt_eval_duration,omitempty"`
	EvalCount          int   `json:"eval_count,omitempty"`
	EvalDuration       int64 `json:"eval_duration,omitempty"`

	// Err carries a decode or transport failure to the consumer of the stream
	// channel. It is never part of the wire format. Without it, a stream that
	// dies halfway through is indistinguishable from one that finished, and
	// the caller silently returns a truncated answer as if it were complete.
	Err error `json:"-"`
}

func (c *Client) Generate(
	ctx context.Context,
	req GenerateRequest,
) (*GenerateResponse, error) {
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/api/generate",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	// Ollama streams by default, read all chunks
	var final GenerateResponse
	decoder := json.NewDecoder(resp.Body)

	for {
		var chunk GenerateResponse
		if err := decoder.Decode(&chunk); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("decode chunk: %w", err)
		}

		final.Response += chunk.Response
		if chunk.Done {
			accumulated := final.Response
			final = chunk
			final.Response = accumulated // Preserve accumulated response
			break
		}
	}

	return &final, nil
}

func (c *Client) StreamGenerate(
	ctx context.Context,
	req GenerateRequest,
) (<-chan GenerateResponse, error) {
	req.Stream = true

	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/api/generate",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	chunks := make(chan GenerateResponse, 10)

	go func() {
		defer close(chunks)
		defer resp.Body.Close()

		decoder := json.NewDecoder(resp.Body)
		for {
			var chunk GenerateResponse
			if err := decoder.Decode(&chunk); err == io.EOF {
				return
			} else if err != nil {
				// Surface the failure instead of closing the channel silently.
				select {
				case chunks <- GenerateResponse{Err: fmt.Errorf("decode chunk: %w", err)}:
				case <-ctx.Done():
				}
				return
			}

			select {
			case chunks <- chunk:
			case <-ctx.Done():
				return
			}

			if chunk.Done {
				return
			}
		}
	}()

	return chunks, nil
}

// ChatRequest represents a chat-style request (newer Ollama API)
type ChatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream,omitempty"`
	Options  *Options  `json:"options,omitempty"`
}

type Message struct {
	Role    string `json:"role"` // system, user, assistant
	Content string `json:"content"`
}

type ChatResponse struct {
	Model     string  `json:"model"`
	CreatedAt string  `json:"created_at"`
	Message   Message `json:"message"`
	Done      bool    `json:"done"`
}

func (c *Client) Chat(
	ctx context.Context,
	req ChatRequest,
) (*ChatResponse, error) {
	reqBody, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/api/chat",
		bytes.NewReader(reqBody),
	)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, body)
	}

	var final ChatResponse
	decoder := json.NewDecoder(resp.Body)

	for {
		var chunk ChatResponse
		if err := decoder.Decode(&chunk); err == io.EOF {
			break
		} else if err != nil {
			return nil, fmt.Errorf("decode chunk: %w", err)
		}

		final.Message.Content += chunk.Message.Content
		if chunk.Done {
			accumulated := final.Message.Content
			final = chunk
			final.Message.Content = accumulated // Preserve accumulated content
			break
		}
	}

	return &final, nil
}
```

### Ollama Usage Example

The example below runs a blocking generation and then a streamed one against a
model you have already pulled with `ollama pull`. Note the metrics on the final
chunk: `PromptEvalCount` and `EvalCount` are the local equivalents of a
provider's input and output token counts, and the duration fields let you
separate model load time from actual generation. That distinction matters,
because the first request after a cold start pays to page the weights into
memory and can look pathologically slow for reasons that have nothing to do
with your prompt.

```go
// examples/ollama_example.go
package main

import (
	"context"
	"fmt"
	"log"

	"yourproject/ollama"
)

func main() {
	client := ollama.NewClient()
	ctx := context.Background()

	// Use whatever tag you have pulled locally - `ollama list` shows them.
	// Open-weight model names churn as fast as hosted ones, so this belongs
	// in configuration rather than in a string literal.
	const model = "llama3.2"

	resp, err := client.Generate(ctx, ollama.GenerateRequest{
		Model:  model,
		Prompt: "Explain Go's defer statement in one sentence.",
		Options: &ollama.Options{
			Temperature: 0.7,
			NumPredict:  100,
		},
	})
	if err != nil {
		log.Fatalf("Generate failed: %v", err)
	}

	fmt.Printf("Response: %s\n", resp.Response)
	fmt.Printf("Tokens: %d prompt, %d completion\n",
		resp.PromptEvalCount,
		resp.EvalCount,
	)

	// Streaming chat
	fmt.Println("\n--- Streaming Chat ---")
	stream, err := client.StreamGenerate(ctx, ollama.GenerateRequest{
		Model:  model,
		Prompt: "Write a short poem about goroutines.",
		Options: &ollama.Options{
			Temperature: 0.8,
			NumPredict:  150,
		},
	})
	if err != nil {
		log.Fatalf("Stream failed: %v", err)
	}

	for chunk := range stream {
		if chunk.Err != nil {
			log.Fatalf("Stream broke mid-response: %v", chunk.Err)
		}
		fmt.Print(chunk.Response)
		if chunk.Done {
			fmt.Printf("\n\n[Completed in %dms, %d tokens generated]\n",
				chunk.TotalDuration/1_000_000,
				chunk.EvalCount,
			)
		}
	}
}
```

### Junior → FAANG: Local LLMs for Development and Privacy-Sensitive Use Cases

Ollama enables two important use cases for junior engineers: cost-free local development and privacy-preserving inference for sensitive data. During development, using a local Llama or Mistral model via Ollama for rapid iteration saves significant API costs and removes the latency of a network round-trip. Ollama serves an OpenAI-compatible endpoint alongside its native one, so a Go client that abstracts the base URL can point at either with a configuration change rather than a code change. Be precise about what that compatibility buys you: the request and response envelopes line up for ordinary chat completions, which is enough to swap providers in a test. It does not mean the two are interchangeable. Provider-specific extensions, tool-calling details, and structured-output modes are where the shim leaks, and those are exactly the features production code ends up depending on. Verify against the local endpoint rather than assuming.

Privacy-sensitive use cases are where local models make a genuine production argument. If your application processes documents containing personal health information, financial records, or confidential business data, sending that data to an external LLM API raises privacy and compliance concerns. Running a capable open-weight model on your own infrastructure keeps sensitive data on-premises. Note that "open weights" and "open source" are not the same thing, and the licence is a review item rather than a formality: several widely used open-weight releases carry restrictions on commercial use, on training other models, or on deployment above a user threshold. Read the licence before you build a product on it. The quality gap between the best open-weight models and frontier API models has narrowed considerably, which makes this tradeoff far more viable than it once was, though the frontier keeps moving too.

For interview discussions, be able to articulate the local-versus-API tradeoff concisely: API models are higher quality, always up-to-date, and require no infrastructure investment, but cost money per token, send data to a third party, and have usage-dependent latency. Local models require GPU infrastructure investment and operational overhead, have lower quality than frontier models, but have no per-token cost, keep data on-premises, and have hardware-limited rather than API-limited throughput. Which to choose depends on the quality bar, the privacy requirements, the cost sensitivity, and the infrastructure capability of the organization.

### Senior @ FAANG: Hybrid Deployment Architecture for LLMs

At senior level, the choice between local and API LLMs is rarely binary. The right architecture for many organizations is a hybrid: use local models for classification, routing, and other tasks where adequate quality models can run on CPU or modest GPU, use API models for high-quality generation tasks where frontier model quality justifies the cost, and use retrieval-augmented generation to reduce the amount of context that needs to be sent to the API model (reducing cost and privacy exposure simultaneously).

Capacity planning for local LLM inference is a senior-level infrastructure concern, and it is worth walking the arithmetic slowly, because the naive version produces a number that is wrong by an order of magnitude in a direction that will embarrass you in a design review.

Start with memory, which is the easy part. Weights at 4-bit quantization cost roughly half a byte per parameter, so a 70B model needs about 35 GB just to hold the weights, and you should budget closer to 40 GB once the KV cache and activations are accounted for. That already tells you the model does not fit on a small accelerator and that the KV cache, which grows with both concurrency and sequence length, is what will actually run you out of memory first.

Now throughput, where the trap is. Suppose a single unbatched request decodes at 20 tokens per second. A 200-token response therefore occupies the GPU for 10 seconds. To sustain 10 requests per second you need 10 seconds of GPU time per request times 10 requests per second, which is 100 GPU-seconds of work per wall-clock second: 100 GPUs. Not ten. The instinct to divide where you should multiply is what produces fleet estimates that are off by 10x.

That 100-GPU figure is also the wrong answer, for the opposite reason: it assumes you serve one request per GPU at a time, which no serious inference stack does. Decoding is memory-bandwidth-bound, so the GPU is mostly idle waiting on weight reads, and running many sequences concurrently amortizes each read across the whole batch. Continuous batching exploits this by admitting and retiring sequences every step instead of waiting for a fixed batch to drain, and it raises aggregate throughput substantially, at some cost to per-request latency. The honest planning process is therefore: derive the memory floor analytically, then measure achieved throughput at your target batch size and sequence length on your actual hardware, and size from the measurement. Do not size from a single-stream tokens-per-second number, in either direction.

Model versioning for locally deployed LLMs requires the same discipline as model versioning for any ML artifact: models are stored in a registry, deployments reference specific versions, and updates are rolled out with canary testing and automatic rollback. Ollama is optimized for developer ergonomics rather than fleet operations, and that shows up as gaps in exactly the places production wants guarantees. The right response is not to reach for ONNX, which is a poor fit for large autoregressive models with a KV cache, but to move to a purpose-built serving runtime (vLLM, TensorRT-LLM, SGLang, and their peers) that implements continuous batching, paged KV cache management, and tensor parallelism as first-class features. At L6, you evaluate this maturity gap and decide whether Ollama stays a development-and-prototyping tool while a dedicated runtime carries production, which is the split most organizations converge on.
