## 118C.1 AI System Architecture Overview

A production AI platform requires several horizontal concerns that a bare LLM API call does not provide: authentication, rate limiting, and cost tracking at the gateway layer, intelligent routing and caching at the LLM router layer, and a Retrieval-Augmented Generation (RAG) pipeline that grounds model responses in your own data. Each layer is independently scalable: the gateway can absorb traffic spikes while the LLM router quietly fails over from one model provider to another without client impact. Understanding how these layers compose lets you design a system that is observable, cost-efficient, and resilient to individual provider outages.

```
┌──────────────────────────────────────────────────────────────────┐
│                    Production AI Platform                        │
│                                                                  │
│  Client         Gateway          LLM Router        Models        │
│  ┌──────┐      ┌────────┐      ┌──────────┐      ┌──────────┐    │
│  │ App  │─────►│ Auth   │─────►│ Load     │─────►│ OpenAI   │    │
│  │      │      │ Rate   │      │ Balance  │      │ Anthropic│    │
│  │      │      │ Limit  │      │ Fallback │      │ Google   │    │
│  └──────┘      │ Cost   │      │ Cache    │      └──────────┘    │
│                └────────┘      └──────────┘                      │
│                                     │                            │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │                  RAG Pipeline                           │     │
│  │  Query → Embed → VectorSearch → Rerank → LLM → Answer   │     │
│  │             ↑                                           │     │
│  │         Vector DB (pgvector, Pinecone, Weaviate)        │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Layered Architecture as System Design Interview Starting Point

The layered architecture diagram in this section (gateway, LLM router, RAG pipeline, vector database) is the canonical answer to the FAANG system design question "design a production AI question-answering system." Start every AI system design discussion by drawing this architecture: "the system has four main components: a gateway layer that handles authentication, rate limiting, and cost tracking. An LLM router that handles provider selection, failover, and caching. A RAG pipeline that retrieves relevant documents from a vector database. And the vector database itself that stores and indexes the document embeddings." This framing immediately establishes that you have thought about the system holistically, not just the LLM API call.

The "independently scalable" property of each layer is an important design principle to articulate. The gateway can scale horizontally to handle traffic spikes without scaling the LLM router or the RAG pipeline. The vector database can be scaled independently of the LLM calls (more read replicas for high-recall retrieval without affecting LLM call latency). This independent scalability is what makes the layered architecture appropriate for production use cases where different layers have different scaling characteristics.

The "fails over from one model provider to another without client impact" property of the LLM router deserves specific attention. Implementing transparent failover requires: circuit breakers per provider, a fallback priority list (try Provider A first, then B, then C), request serialization that makes the failover invisible to the calling code (the router exposes a single interface regardless of which provider handles the request), and monitoring that distinguishes "request succeeded via primary provider" from "request succeeded via fallback provider" so that the failover rate is visible.

### Senior @ FAANG: Architecture Layers as Organizational Team Boundaries

At senior level, the architecture diagram is also an organizational boundary diagram. Each layer can be owned by a different team: the gateway layer by the infrastructure team, the LLM router by the AI platform team, the RAG pipeline by the application team, and the vector database by the data platform team. Getting the team boundaries right prevents coupling between teams (the application team should not need to know which LLM provider the router selected) while ensuring clear ownership of each layer's reliability (each team is on-call for their layer's SLA).

The "observable" property mentioned in the overview is the most important non-functional requirement for production AI systems at FAANG scale. Each layer must emit metrics (request count, error rate, latency, cost) that can be combined into a system-level dashboard. The gateway emits per-endpoint, per-user request metrics. The LLM router emits per-provider latency and error rate metrics. The RAG pipeline emits retrieval recall and generation quality metrics. The vector database emits query latency and index size metrics. Without this observability at each layer, understanding which layer is causing a latency increase or quality regression requires manual investigation rather than dashboard-driven diagnosis.
