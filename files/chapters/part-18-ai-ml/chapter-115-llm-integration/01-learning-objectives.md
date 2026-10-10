## Learning Objectives

By the end of this chapter, you will:

- Understand transformer architecture, tokenization, and key LLM concepts
- Integrate OpenAI's GPT models with production-ready Go clients
- Work with Anthropic's Claude API including streaming responses
- Run local LLMs using Ollama for privacy and cost optimization
- Master prompt engineering techniques: templates, few-shot learning, chain-of-thought
- Implement streaming responses with proper buffering and error handling
- Build rate limiting and cost management systems for LLM APIs
- Handle API errors with exponential backoff, retries, and circuit breakers
- Create a complete chat application with conversation management
- Deploy LLM-powered services at scale

### Junior → FAANG: LLM Objectives as Technical Depth Markers

Each objective maps to a technical depth that interviewers probe. "Understand transformer architecture and tokenization" means you can explain why token count matters for cost and context, why attention complexity is quadratic in sequence length, and what temperature and top-p parameters do. You do not need to implement a transformer from scratch, but you need to know that a 4096-token context window holds roughly 3000 words of English prose, and you need to be able to run the unit-economics arithmetic on demand. Take an illustrative output price of $15 per million tokens: a response consuming 2000 output tokens costs $0.03, and 10,000 such calls per day is $300 per day. Published prices change often, so read them from the provider's pricing page rather than from memory, but the shape of the calculation never changes.

"Implement streaming responses" is the objective that most directly improves user experience in LLM-powered applications. Streaming reduces perceived latency from "wait 5 seconds for the full response" to "start seeing the response immediately." In Go, streaming from an LLM API means consuming a Server-Sent Events stream and forwarding each chunk to the client over an HTTP response with transfer-encoding: chunked. Implementing this correctly, with proper error handling for mid-stream failures, is a Go backend engineering skill with broad application.

"Rate limiting and cost management" is the objective that prevents the most painful production incidents. Build a rate limiter that tracks token usage per user per hour, rejects requests when the budget is exhausted, exposes current budget consumption in the response header, and alerts when any user exceeds 80% of their daily budget. Having this built and tested before deploying any LLM feature is the difference between a controlled launch and an unexpected bill.

### Senior @ FAANG: Objectives as Platform Capability Requirements

Senior engineers read these objectives and evaluate which ones require individual service implementation versus shared platform support. Streaming response handling is something every LLM-powered service needs and can be standardized in the LLM gateway. Rate limiting and cost management are organizational concerns that must be enforced centrally, not per-service. Understanding transformer architecture is individual knowledge that the entire team should have as a baseline for making informed model selection decisions.

The "deploy at scale" objective is the one that requires the most upfront architectural thought. Deploying an LLM service at scale means designing for: stateless request handling (conversation history stored externally, not in process memory), horizontal scaling without session affinity (any instance can serve any request), graceful degradation when the LLM API is slow (return cached responses or degraded responses without error to the user), and cost predictability (know the cost per request, enforce per-user budgets, monitor for anomalies). Building all of this into the initial architecture is significantly cheaper than retrofitting it after the service is in production.
