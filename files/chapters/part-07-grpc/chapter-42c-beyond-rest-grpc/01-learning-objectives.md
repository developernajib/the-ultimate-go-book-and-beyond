## Learning Objectives

By the end of this chapter, you will:
- Implement production gRPC services with streaming, interceptors, and load balancing
- Build GraphQL APIs in Go with efficient resolvers and dataloaders
- Choose between REST, gRPC, GraphQL, WebSocket, and SSE for specific use cases
- Implement bidirectional streaming with gRPC
- Build GraphQL subscriptions for real-time data
- Design API gateways that support multiple protocols

---

### Junior → FAANG: Mapping Learning Objectives to Interview Readiness

Learning objectives for a chapter like this have a natural gap between "I can implement this" and "I can explain when to use it and why." FAANG interviews test both. Being able to write a streaming gRPC handler is table stakes. Explaining why you would use server streaming versus bidirectional streaming for a specific use case, or why you chose DataLoader for GraphQL rather than caching at the resolver level, is what separates candidates who pass phone screens from those who clear on-sites.

A useful habit: after working through each section, write a one-sentence trade-off summary in your own words. For example: "I use gRPC interceptors for auth and logging because they compose cleanly and apply consistently to every RPC without duplicating code in each handler." That kind of concise framing translates directly to FAANG interview answers.

For entry-level roles, the highest-signal objectives from this chapter are: (1) understanding the four gRPC streaming patterns and when each applies, (2) being able to explain N+1 in GraphQL and how DataLoader fixes it, and (3) knowing the correct gRPC status codes to return for common domain errors. These three topics appear in virtually every senior and mid-level API design interview at FAANG companies.

### Senior @ FAANG: Connecting Objectives to Platform Maturity and Staff-Level Scope

At staff level, the framing of learning objectives shifts from "what can I implement" to "what does the team or organization need to be capable of, and how do I build that capability systematically." The objectives in this chapter map to a platform maturity model: a team that has not implemented interceptors for auth, tracing, and rate limiting across their gRPC services has not reached production maturity. A team running GraphQL without DataLoader is accumulating a database load debt that will surface as a scaling incident.

A staff engineer uses this chapter's objectives as an audit checklist for their organization's current state. For each objective, the question is not "have I personally done this" but "does every team that runs a gRPC service have this in place, and is there a platform-provided library or template that makes the right thing the easy thing." If the answer is no, that gap is a platform investment opportunity.

The L6/L7 bar-raiser signal here is scope amplification: how many teams benefit from your knowledge of interceptor patterns? If you write a shared interceptor library for auth, tracing, and rate limiting that every service team imports, you have multiplied the value of this chapter's content across the organization. That leverage is what distinguishes staff-level contribution from senior-level contribution.
