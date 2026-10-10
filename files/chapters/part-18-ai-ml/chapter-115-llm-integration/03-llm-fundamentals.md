## 115.2 LLM Fundamentals

### Transformer Architecture Basics

LLMs are built on the transformer architecture, which processes text through attention mechanisms:

```
┌──────────────────────────────────────────────────────────────┐
│                  Transformer Architecture                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Input Text: "The quick brown fox"                           │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────┐                                             │
│  │ Tokenizer   │  Converts text to token IDs                 │
│  └──────┬──────┘  ["The"→1, "quick"→523, "brown"→892...]     │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐                                             │
│  │ Embeddings  │  Maps tokens to high-dimensional vectors    │
│  └──────┬──────┘  (typically 768-4096 dimensions)            │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐                                             │
│  │  Attention  │  Self-attention: each token attends to      │
│  │   Layers    │  other tokens to capture context            │
│  └──────┬──────┘  ("quick" learns it modifies "fox")         │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐                                             │
│  │Feed-forward │  Non-linear transformations                 │
│  │   Layers    │                                             │
│  └──────┬──────┘                                             │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐                                             │
│  │   Output    │  Probability distribution over vocabulary   │
│  │   Layer     │  Next token prediction                      │
│  └──────┬──────┘                                             │
│         │                                                    │
│         ▼                                                    │
│  Generated Token (e.g., "jumps")                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Tokenization

LLMs don't process raw text. They work with tokens. Understanding tokenization is critical for:
- **Cost management**: APIs charge per token (input + output)
- **Context limits**: Models have maximum token counts (8K, 32K, 128K)
- **Performance**: Fewer tokens mean faster processing

```go
// Token estimation (approximate).
// Byte-pair tokenizers average roughly 4 characters per token for English text.
// Non-English text and code tokenize far less efficiently, so treat this as a
// guard rail only. For billing or context-limit decisions, use the provider's
// own tokenizer or token-counting endpoint.
package llm

import (
	"fmt"
	"unicode/utf8"
)

// EstimateTokenCount provides a rough token count estimate.
// For precise counts, use the model's actual tokenizer.
func EstimateTokenCount(text string) int {
	// Rule of thumb: 1 token ≈ 4 characters for English
	// This is an approximation - actual tokenization varies
	charCount := utf8.RuneCountInString(text)
	return (charCount + 3) / 4 // Round up
}

// TokenBudget manages token allocation for prompts
type TokenBudget struct {
	MaxTokens       int
	SystemPrompt    string
	UserPrompt      string
	MaxCompletion   int
}

func (tb *TokenBudget) Validate() error {
	systemTokens := EstimateTokenCount(tb.SystemPrompt)
	userTokens := EstimateTokenCount(tb.UserPrompt)
	totalInput := systemTokens + userTokens

	if totalInput + tb.MaxCompletion > tb.MaxTokens {
		return fmt.Errorf("token budget exceeded: %d + %d > %d",
			totalInput, tb.MaxCompletion, tb.MaxTokens)
	}
	return nil
}
```

### Temperature and Sampling

Temperature controls randomness in LLM outputs:

- **Temperature 0.0**: Deterministic, always selects highest probability token
- **Temperature 0.3-0.5**: Low creativity, good for factual tasks
- **Temperature 0.7-0.9**: Balanced creativity
- **Temperature 1.0+**: High creativity, more random

```go
// SamplingConfig controls LLM output randomness
type SamplingConfig struct {
	Temperature float64 // 0.0-2.0, controls randomness
	TopP        float64 // 0.0-1.0, nucleus sampling
	TopK        int     // Limit to top K tokens
	MaxTokens   int     // Maximum completion tokens
}

// Preset configurations for common use cases
var (
	// Factual: low randomness for consistent, factual responses
	FactualConfig = SamplingConfig{
		Temperature: 0.1,
		TopP:        0.9,
		MaxTokens:   1024,
	}

	// Creative: high randomness for creative writing
	CreativeConfig = SamplingConfig{
		Temperature: 0.9,
		TopP:        0.95,
		MaxTokens:   2048,
	}

	// CodeGen: balanced for code generation
	CodeGenConfig = SamplingConfig{
		Temperature: 0.2,
		TopP:        0.95,
		MaxTokens:   4096,
	}
)
```

Not every provider accepts every knob. `top_k` in particular is absent from
several chat APIs, and some current frontier models reject sampling parameters
outright in favour of prompt-level steering. Treat `SamplingConfig` as your
internal vocabulary and have each provider adapter drop or translate the fields
its API does not accept, rather than assuming the union is portable.

### Junior → FAANG: LLM Concepts That Matter for Engineers

Tokenization is the LLM concept with the most direct engineering implications. A token is roughly 0.75 words in English, so a 1000-token context window holds about 750 words. Knowing this lets you estimate context window usage in system design: a user chat history with 20 turns of 50 words each uses approximately 1333 tokens, leaving the majority of a 4096-token window for the system prompt and the model's response. Engineers who cannot do this math struggle to design reliable LLM applications because they cannot predict when context window overflow will occur.

Temperature and top-p are the generation parameters that most affect output determinism. For factual tasks (answering questions about a knowledge base), use temperature near zero for maximum determinism. For creative tasks (generating product descriptions), use higher temperature for diversity. For structured output (generating JSON), use temperature near zero and add explicit JSON format instructions to the prompt. These are practical defaults worth memorizing.

The attention mechanism's quadratic complexity with sequence length is the engineering reason why LLM inference latency increases significantly with long contexts. A request with a 100,000-token context window takes disproportionately longer than a 1000-token request, even with efficient attention implementations. This matters for system design: if your use case requires long context windows, plan for higher latency and higher cost per request, and consider whether retrieval-augmented generation with shorter context windows is a viable alternative.

### Senior @ FAANG: Transformer Architecture as Infrastructure Design Input

Staff engineers use transformer architecture understanding to make infrastructure decisions. The key architectural fact is that LLM inference has two phases: prefill (processing the input tokens, which is compute-intensive and can be parallelized across tokens) and decode (generating output tokens one at a time, which is memory-bandwidth-intensive and is the bottleneck for most inference workloads). This distinction matters for capacity planning: a service that handles many short requests (high prefill, low decode) has different GPU requirements than one handling long streaming responses (low prefill, high decode).

KV cache is the memory optimization that enables efficient multi-turn conversations. On the first turn, the model processes the system prompt and computes key-value pairs for each attention layer. On subsequent turns, those KV pairs are cached and only the new turn tokens are processed. The LLM serving platform must be designed to store and retrieve KV caches efficiently: the cache size per conversation scales with sequence length and model size, and eviction policies must balance memory cost against the latency benefit of cache hits.

At L6, understanding transformer internals enables evaluation of emerging inference optimization techniques: speculative decoding (use a small draft model to propose multiple tokens, verify with the large model in parallel), quantization (reduce model weights from float16 to int8 or int4 to reduce memory footprint), and continuous batching (batch multiple requests together dynamically rather than waiting for a fixed batch to fill). Each technique has tradeoffs in quality, latency, and complexity that staff engineers must evaluate against the organization's specific requirements and constraints.
