## 118C.9 Common Mistakes and Production Pitfalls

| Mistake | Problem | Fix |
|---------|---------|-----|
| **Treating retrieved documents as trusted** | **Anyone who can write to the corpus can write your prompt** | **Fence retrieved text, instruct the model to treat it as data, and bound the blast radius architecturally** |
| **Retrieval filter supplied by the client** | **Caller picks which tenant's documents to search** | **Derive the filter from the authenticated identity, server-side, and fail closed** |
| **Acting on model output without validation** | **Injected text reaches a shell, SQL, or an HTTP call** | **Validate and constrain output - gate irreversible actions behind human approval** |
| Quality gate that passes when it cannot run | Zero metrics, zero cases, or NaN comparisons report green | Every degenerate path must fail closed, never "pass" |
| No streaming for long responses | User waits for entire response | Always stream for responses > 1s |
| Chunking with fixed chars not words | Breaks semantic units | Chunk on sentence/paragraph boundaries |
| No embedding cache | Repeated embedding calls waste money | Cache embeddings by content hash |
| Semantic cache keyed on "close enough" | Near-identical prompts have opposite answers | Require a high similarity threshold - never share a cache entry across users or tenants |
| Single vector DB call | No reranking = lower quality | Add cross-encoder reranking step |
| Dot product on unnormalized vectors | Ranks by magnitude, not relevance | Cosine, or normalize at ingest and then use dot product |
| ANN index operator class mismatched to query operator | Index silently unused, query goes O(n) | Match `vector_cosine_ops` with `<=>` - verify with `EXPLAIN` |
| No cost tracking | Surprise bills | Track every token with CostTracker |
| Unpriced model costs 0 | New model reports as free - overspend invisible | Unknown model is an error, not a zero |
| LLM calls in critical path | High latency | Use async pre-computation where possible |
| No eval framework | Can't detect regressions | Build eval suite before shipping |
| Prompt stored in code | Hard to iterate | Store prompts in config/DB |

### Junior → FAANG: AI System Mistakes as Interview Anti-Patterns

Each row in the common mistakes table defines an anti-pattern that can be cited in interviews. The first three are in bold because they are security defects rather than quality or cost problems, and because a design that gets them wrong is not "unpolished", it is exploitable. "Treating retrieved documents as trusted" is the one candidates most reliably miss: they describe a complete RAG pipeline without ever noting that the corpus is input, and the pipeline they drew has an open path from a wiki page to the model's instructions.

Of the non-security rows, "no evaluation framework" is the most critical: without it, every change to the RAG pipeline (chunking strategy, embedding model, retrieval parameters, prompt template) is made blind, with no way to measure whether it improved quality or introduced a regression. Note that the row directly below it is nastier: an evaluation framework that passes when it cannot run is worse than none, because it converts "we have no idea" into a green check.

"Prompt stored in code" makes it impossible to experiment with prompts without deploying new code. Storing prompts in configuration allows A/B testing and rollback without deployment.

Semantic caching deserves care in both directions. Skipping it is a cost miss, visible the moment the cost report shows the same question answered with a full LLM call hundreds of times an hour. Implementing it carelessly is a correctness bug: "semantically similar" is not "equivalent". A cosine threshold loose enough to be useful will eventually match "can I deploy on Friday?" with "can I not deploy on Friday?", and the user gets a confidently inverted answer. Worse, a cache keyed only on prompt similarity and shared across users will serve one tenant's answer, built from one tenant's retrieved documents, to another. Key the cache by tenant, keep the threshold tight, and remember that a cache hit on an LLM is a claim that two different strings mean the same thing, which is exactly the judgement LLMs exist to make and embeddings only approximate.

Reviewing this table before a FAANG system design interview and preparing a "what would go wrong if you didn't implement X?" answer for each row is high-impact preparation. Interviewers at FAANG AI companies often ask about mistakes because the answer reveals whether the candidate has production experience or only development experience with AI systems. Production experience means knowing what breaks in the real world. Development experience means knowing what works in a demo.

### Senior @ FAANG: Mistake Table as AI System Design Review Standard

At senior level, the common mistakes table is a design review checklist for new AI system proposals. Before approving a new RAG system for production deployment, a senior engineer reviews the proposal against each row: what can write to the corpus, and what happens when it writes an instruction? Where does the retrieval filter come from? What can the model's output reach without a human in the loop? Does the system have an evaluation framework, and does that framework fail closed? Is rate limiting and cost tracking implemented? Are prompts stored in configuration rather than code?

The first three questions are blockers, not follow-ups. The rest are follow-up requirements with a timeline. The distinction is worth holding: shipping without a semantic cache costs money, and shipping without a trust boundary costs you an incident. Using this checklist consistently across all AI system proposals ensures that the organization's AI systems meet a consistent production quality bar regardless of which team built them.

---
