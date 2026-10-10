# Chapter 115: LLM Integration

> *"An LLM API call is not a function call. It is a probabilistic, latency-variable, cost-bearing network operation that can hallucinate. Design accordingly."*

Large Language Models have crossed the threshold from research curiosity to production infrastructure. Coding assistants generate code accepted by millions of developers daily. CRM copilots draft emails and summarize customer records for enterprise sales teams. Documentation assistants answer developer questions with context drawn from thousands of API reference pages. Behind every one of these products is code (Go is a strong fit) managing API clients, streaming token buffers, prompt templates, retry logic, cost accounting, and fallback providers. Integrating LLMs correctly is a distinct engineering discipline with failure modes that do not exist in conventional service integrations.

The core challenges are: latency (a streaming response that emits tokens as they are generated is a fundamentally different user experience than a multi-second blocking call, and your HTTP handlers need to handle both), cost (a naive LLM integration without token budgets and caching can burn through a large API credit balance in hours), reliability (LLM providers have higher error rates and longer tail latencies than typical APIs, demanding exponential backoff with jitter and circuit breakers), and correctness (prompt engineering is an empirical discipline, since small wording changes produce large quality differences, and you need systematic evaluation to detect regression). Go's strong concurrency model and interface system provide natural solutions to all four.

This chapter builds a production-grade LLM integration layer in Go that handles every major provider (OpenAI, Anthropic Claude, and local Ollama models) through a unified interface with automatic multi-provider fallback. You will implement true streaming with server-sent events and proper backpressure, a prompt template system with variable injection and version tracking, a cost tracker that enforces per-request and per-user token budgets, and a conversation manager that maintains context across turns with sliding window truncation when the context window fills. The result is a reusable foundation for any LLM-powered feature.

**What you'll learn in this chapter:**

- Transformer architecture essentials: tokenization, context windows, temperature, top-p sampling, and what they mean for your API calls
- Building a unified multi-provider LLM client in Go with a common interface across OpenAI, Anthropic, and Ollama
- Streaming responses with `io.Reader`-based token buffers, server-sent events delivery to HTTP clients, and proper cancellation propagation
- Prompt engineering for production: template systems, few-shot examples, chain-of-thought instructions, and structured output with JSON mode
- Cost management: per-model token pricing, request-level budget enforcement, user-level quotas, and cost attribution logging
- Resilience patterns specific to LLM APIs: exponential backoff with jitter, circuit breakers calibrated for long-latency operations, and automatic provider failover
- Conversation management: multi-turn context tracking, sliding window truncation, and memory summarization to handle long conversations
- Rate limiting and request queuing: managing concurrent LLM requests within provider rate limits without degrading user experience

**Why this matters at scale:**

Products with AI features embedded in a mainstream workflow process enormous volumes of LLM requests, and multi-provider fallback plus cost control is what makes that economically and operationally sustainable. AI-powered summarization features use streaming responses to provide instant perceived performance despite LLM latency, which is the same streaming pattern you will implement here. Customer-support agents built on LLMs resolve a meaningful share of incoming queries end-to-end, and their prompt engineering and conversation management stack maps directly to what this chapter teaches. At scale, the difference between a naive and a production-grade LLM integration is measured in dollars and user-facing reliability.

**Prerequisites:** Go 1.27.1 baseline, Chapters 113--114 (ML ecosystem familiarity and pipelines), Go concurrency and channels (Chapters 17--22), HTTP server patterns in Go (Chapters 38--42), and active API keys for at least one LLM provider (or local Ollama).

---

### Junior → FAANG: LLM Integration as Production Engineering

The epigraph of this chapter is the most important concept to internalize before writing a single line of LLM integration code. An LLM API call is not a function call. A regular function call is deterministic, fast, and free. An LLM API call is probabilistic (the same input can produce different outputs), slow (hundreds of milliseconds to seconds), expensive (dollars per million tokens), and unreliable (providers have outages, rate limits, and degraded performance periods). Every design decision in LLM integration flows from these four properties.

The first three things to build around every LLM API call are: a timeout (to bound latency), a retry with exponential backoff (to handle transient failures), and token counting (to prevent cost surprises). A junior who builds an LLM integration without these three components has built a prototype, not a production service. Practice wrapping an OpenAI API call with a 30-second context timeout, exponential backoff with jitter on 429 and 500 errors, and token count logging before and after each call. That wrapper is the foundation of every production LLM service.

Interview entry point for LLM integration questions is usually framed as: "You need to add an AI-powered search feature to your product using an LLM API. How would you design it?" Your answer should immediately address: rate limiting per user (prevent abuse and cost overruns), cost attribution (which user/feature is driving which spend), error handling (what happens when the LLM API is slow or returns an error), and caching (which queries are cacheable and for how long). These four concerns, stated before any discussion of prompt engineering or model selection, signal production LLM engineering experience.

### Senior @ FAANG: LLM Integration as Platform Design

At senior level, LLM integration is a platform problem. Individual services calling LLM APIs directly create a fragmented landscape: no shared rate limiting, no cost visibility across services, no standardized error handling, and no ability to swap providers without touching multiple codebases. The solution is an LLM gateway: a shared internal service that proxies all LLM API calls, enforces organizational policies (rate limits, cost quotas, content filtering), provides unified observability, and abstracts provider details behind a stable internal API.

Designing an LLM gateway in Go is an excellent senior-level engineering project that touches all the right concerns: authentication and authorization (which services are allowed to call which models?), rate limiting (per-service and per-user token budgets), cost attribution (tag every call with service, user, and feature identifiers for billing reports), semantic caching (cache responses for identical or semantically similar prompts to reduce cost), provider routing (route to different providers based on cost, latency, and availability), and observability (latency histograms, error rate per provider, token usage per model).

ADR decisions at the LLM gateway level include: should the gateway support streaming responses, and if so, how does the gateway cache, rate limit, and attribute cost for streaming calls? Should the gateway enforce content filtering (using a moderation API to check inputs before forwarding them), and if so, how does it handle the latency and cost of the additional API call? Should the gateway enforce prompt injection detection, and if so, what is the detection logic and the action when injection is detected? Each of these decisions has significant implementation complexity and must be documented before implementation begins.

At L6, LLM integration governance includes the process for approving new models for production use. When a new model from a new provider becomes available, the approval process should cover: security review (what data will be sent to the provider, what are the provider's data retention policies?), performance evaluation (how does the model's quality and latency compare to existing models on the organization's specific use cases?), cost analysis (what is the per-token cost at the organization's expected volume?), and compliance review (does the model's output satisfy the organization's content standards for each use case?). This approval process prevents ad-hoc model adoption that creates hidden compliance and security risks.

Staff engineers at FAANG are expected to drive the organization's LLM strategy: which models to use for which use cases, what the policy is for fine-tuning versus prompting, how to manage prompt versioning and testing, and what the governance process is for AI-generated content that reaches users. These strategic decisions require deep technical knowledge (to evaluate model capabilities accurately) combined with business acumen (to understand the cost-quality tradeoff at scale) and organizational judgment (to build consensus across product, legal, privacy, and engineering stakeholders).

---
