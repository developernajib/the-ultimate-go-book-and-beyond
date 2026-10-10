# Chapter 118B: Model Context Protocol (MCP) & Agent-to-Agent (A2A) Communication

> *"A tool that every agent can discover, invoke, and trust is infrastructure. A tool that only one agent knows about is a hardcoded dependency."*

The explosive growth of AI agent systems has surfaced a classic distributed systems problem in new clothing: how do heterogeneous agents, built by different teams with different LLMs and different tool implementations, discover and invoke each other's capabilities reliably? Ad-hoc integration, one agent calling another via a hardcoded HTTP endpoint with a bespoke JSON schema, does not scale. Two named specifications answer different halves of this question, and the first thing to get right is that they are not competitors and not layers of one stack.

**MCP (Model Context Protocol)** connects a model to tools and context. It is an open protocol originated by Anthropic, built on JSON-RPC 2.0, in which a server advertises tools, resources, and prompts, and a client (an LLM application) discovers and invokes them.

**A2A (Agent2Agent)** connects agents to each other. It is a separate protocol, originated by Google and donated to the Linux Foundation in 2025, in which agents publish an Agent Card describing their skills and exchange long-running, stateful tasks.

Keep these straight. MCP is how one agent reaches its tools. A2A is how two agents reach each other. Conflating them is the single most common error in writing about this space, and it leads to designs that use one protocol for a job the other was built for.

MCP defines exactly two standard transports, and the count matters because outdated material will tell you otherwise:

- **stdio**, where the client launches the server as a subprocess and they exchange newline-delimited JSON-RPC over stdin and stdout. Clients should support this whenever possible.
- **Streamable HTTP**, a single endpoint accepting POST and GET, where the server may optionally use Server-Sent Events to stream multiple messages back.

There is no WebSocket transport in MCP. If you have read that there is, the source was wrong. The older HTTP+SSE transport from protocol revision 2024-11-05 was **replaced** by Streamable HTTP and survives only as a backwards-compatibility path. Implementations may also define custom transports, but the two above are what the specification standardizes.

The payoff is real: a Go service exposing database query, file system access, or API integration capabilities via MCP can be consumed by any MCP-speaking host without integration-specific code.

A2A covers agent-level coordination: an orchestrator delegating a research subtask needs a standard way to express the request, receive progress, handle partial results, and cancel. Together they compose an agent ecosystem in roughly the way REST and gRPC did for microservices. Go suits both: strong typing, interface-based composition, and solid HTTP and gRPC support.

One warning before you invest in the details. This is the fastest-moving material in this book. MCP revisions are dated strings (`2025-11-25` at the time of writing, with the next revision in a release-candidate cycle) and the protocol has already had breaking changes between revisions. Everything here is pinned to a specific revision and says so. Check the current spec at modelcontextprotocol.io before you write code, and treat any undated claim about MCP, including one in a book, as suspect.

**What you'll learn in this chapter:**

- MCP specification deep dive: the server primitives (tools, resources, prompts), the client primitives (sampling, roots, elicitation), the JSON-RPC 2.0 message format, and the initialization and capability negotiation handshake
- Building an MCP server in Go that exposes tools (callable functions), resources (readable data sources), and prompts (reusable instruction templates)
- MCP transport implementations: stdio for local subprocess servers and Streamable HTTP for remote deployment, including the `Origin` validation and localhost binding that Streamable HTTP requires
- MCP client implementation: capability discovery, tool invocation with typed parameter marshaling, and streaming result handling
- Agent-to-agent communication patterns: task delegation, progress reporting, partial result streaming, and cascading cancellation
- Hierarchical agent orchestration: supervisor agents that decompose goals and dispatch subtasks to specialist agents via A2A protocols
- Context management across agent boundaries: propagating user identity, authorization scope, conversation history, and observability trace IDs
- Security for agent protocols: authenticating MCP clients, authorizing tool invocations by scope, and rate limiting per-agent to prevent runaway consumption

**Why this matters at scale:**

MCP's value is distribution. Anthropic's Claude apps speak MCP natively, and support has spread across editors, IDEs, and agent frameworks, so an MCP server you write is reachable from every one of those hosts without per-host integration work. Block was among the earliest adopters outside Anthropic and has been public about using MCP internally. That adoption curve, rather than any single vendor's endorsement, is the argument for the protocol.

A2A took a different route to the same place: Google published it in 2025, donated it to the Linux Foundation the same year, and a large roster of companies signed on as supporters. Both protocols are young. The specifications are versioned, actively revised, and have already broken compatibility at least once each. Learning them now is worthwhile precisely because they are not finished, but write your code against a pinned revision and expect to revisit it.

**Prerequisites:** Chapter 117 (AI agents and the ReAct pattern), Chapter 115 (LLM integration and function calling), Go's `net/http` and gRPC server patterns, and familiarity with JSON-RPC concepts.

---

### Junior → FAANG: MCP and A2A as Emerging Production Standards

The Model Context Protocol (MCP) and Agent-to-Agent (A2A) communication patterns represent the emerging standardization layer for AI agent infrastructure. Understanding these protocols before they become assumed knowledge is a career timing advantage: engineers who learn emerging standards during their adoption phase position themselves as practitioners rather than followers. The opening quote captures the essential insight: a tool that every agent can discover through a standard protocol is infrastructure. A tool that requires hardcoded configuration in each agent is technical debt.

For FAANG interview preparation, being able to explain MCP and A2A at the conceptual level is increasingly expected for AI engineering roles. The highest-value thing you can do in that conversation is distinguish them correctly, because most candidates cannot. MCP is a JSON-RPC 2.0 protocol that lets an LLM application discover and invoke tools, read resources, and fetch prompts from a server: it connects a model to its context. A2A is a distinct protocol for agents to exchange tasks with each other, built around a published Agent Card and a task lifecycle. One is vertical (model to tools), the other horizontal (agent to agent). A candidate who says "MCP and A2A are two competing agent protocols" has revealed they read a headline. A candidate who explains that a single system usually speaks both, MCP downward to its tools and A2A sideways to its peers, has revealed they read the specs.

The engineering challenge underneath both is the same: how do you design agent communication so that agents can be added, removed, or upgraded without changing every other agent that talks to them? The answer is a standard protocol with capability discovery.

### Senior @ FAANG: Protocol Standardization as Platform Engineering Investment

At senior level, MCP and A2A are platform engineering investments that reduce the long-term cost of maintaining AI agent systems. Without a standard protocol, every agent integration is custom: agent A calls tool X through its specific API, agent B calls tool Y through a different API, and the integration surface grows as O(agents x tools). With MCP, every agent calls every tool through the same protocol, and the integration surface grows as O(agents + tools). This difference matters at FAANG scale where the number of agents and tools can each reach dozens or hundreds.

The strategic engineering decision for a senior engineer is: when does the investment in MCP or A2A standardization pay off? For a team with two agents and five tools, the protocol overhead may not be worth the investment. For a team with ten agents and twenty tools, the standardization investment pays back quickly in reduced integration maintenance. Senior engineers who can model this break-even point and present it to engineering leadership as a platform proposal are making the kind of evidence-based architectural investment decisions that staff-level engineering requires.
