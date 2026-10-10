## Problem Statement

LLM serving is one of the most resource-intensive challenges in modern infrastructure. Unlike traditional web APIs where a request takes milliseconds to process, a single LLM inference request can occupy an expensive GPU for seconds or even minutes while generating tokens one at a time. The system must handle streaming responses, manage GPU memory carefully, and batch requests efficiently to keep costs manageable. This problem statement defines the requirements for a production-grade inference platform.

Design infrastructure to serve Large Language Models (LLMs) like GPT-4/Claude at scale:
- 10M requests per day (100K tokens/request avg)
- Sub-second time-to-first-token (TTFT) for streaming
- Support models: 7B, 13B, 70B, 405B parameters
- Streaming responses (token-by-token)
- Context: up to 128K tokens per request
- Multi-modal: text + image inputs
- Fine-tuned model variants per customer
- Cost efficiency: maximize GPU utilization
- Auto-scaling: bursty traffic patterns

---
