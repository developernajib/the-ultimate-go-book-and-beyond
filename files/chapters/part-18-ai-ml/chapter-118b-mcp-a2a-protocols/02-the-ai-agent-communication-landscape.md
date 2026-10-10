## 118B.1 The AI Agent Communication Landscape

Modern AI systems involve two distinct communication boundaries: the boundary between an AI model and the external tools or data sources it needs, addressed by the **Model Context Protocol (MCP)**, and the boundary between multiple autonomous agents collaborating on a task, addressed by the **Agent2Agent (A2A)** protocol.

MCP standardizes how a model discovers and requests tool invocations, resource reads, and prompts, over one of its two transports: stdio or Streamable HTTP. A2A standardizes how an agent advertises its skills via an Agent Card and how peers submit long-running tasks to it.

A2A is a specific protocol with a specification, not an umbrella term for "ways agents talk". Direct HTTP calls, event buses, and workflow engines are architectural options for agent coordination, and they are alternatives to adopting A2A, not examples of it. That distinction matters when someone proposes "using A2A" and means "having one service call another".

```
┌──────────────────────────────────────────────────────────────────┐
│              Agent Communication Protocols                       │
│              (MCP revision 2025-11-25, A2A v1.x)                 │
│                                                                  │
│   Agent A                                        Agent B         │
│  ┌────────────┐                                 ┌────────┐       │
│  │ Host + LLM │ ◄──────────  A2A  ────────────► │ Host + │       │
│  │  client    │   (agent to agent: tasks)       │  LLM   │       │
│  └─────┬──────┘                                 └───┬────┘       │
│        │  MCP (model to tools: JSON-RPC 2.0)        │ MCP        │
│        ▼                                            ▼            │
│  ┌─────────────┐                             ┌─────────────┐     │
│  │ MCP Server  │                             │ MCP Server  │     │
│  │  Tools      │                             │  Tools      │     │
│  │  Resources  │                             │  Resources  │     │
│  │  Prompts    │                             │  Prompts    │     │
│  └──────┬──────┘                             └─────────────┘     │
│         ▼                                                        │
│  ┌─────────────┐                                                 │
│  │  Database   │   MCP transports (exactly two):                 │
│  │  Files      │   • stdio           (local subprocess)          │
│  │  APIs       │   • Streamable HTTP (remote, optional SSE)      │
│  └─────────────┘   No WebSocket transport. HTTP+SSE (2024-11-05) │
│                    is superseded by Streamable HTTP.             │
│                                                                  │
│  MCP server primitives      MCP client primitives                │
│  • tools     (model acts)   • sampling    (server asks for LLM)  │
│  • resources (context)      • roots       (filesystem bounds)    │
│  • prompts   (templates)    • elicitation (server asks user)     │
│                                                                  │
│  A2A: Agent Card at /.well-known/agent-card.json                 │
│       Task lifecycle: submitted → working → completed            │
│                       (or input-required / failed / canceled)    │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Communication Landscape as Interview Vocabulary

The distinction between MCP (model-to-tool communication) and A2A (agent-to-agent communication) is the foundational vocabulary for AI agent system design interviews. Without this distinction, discussions about agent architectures conflate two separate concerns: how does the agent invoke tools (MCP), and how do agents coordinate with each other (A2A)? These are separate problems with separate solutions, and confusing them leads to architectures where agent coordination logic is embedded in tool invocation mechanisms, making both harder to reason about and debug.

Practice explaining both protocols in one paragraph: "MCP standardizes how an AI agent discovers and invokes external tools. The agent queries an MCP server for available tools, receives their schemas, and calls them through a standard JSON-RPC interface. A2A communication is how multiple agents coordinate: one agent delegates a subtask to another agent through a shared protocol, waits for the result, and incorporates it into its reasoning. The two protocols operate at different levels: MCP is tool invocation, A2A is agent orchestration."

The "observable in production" requirement mentioned in this section is the most important non-functional requirement for agent communication systems. Every MCP tool call should be logged with its input, output, and latency. Every A2A delegation should be traced with a correlation ID that connects the delegating agent's reasoning to the sub-agent's execution. Without this observability, debugging agent behavior in production is essentially impossible. Designing agent communication systems with observability as a first-class requirement, not an afterthought, is the engineering maturity signal that distinguishes production-ready agent systems from research prototypes.

### Senior @ FAANG: Communication Landscape as Architectural Boundary Decision

At senior level, the communication landscape diagram is an architectural boundary decision. The boundary between MCP (model-to-tool) and A2A (agent-to-agent) determines where in the system different engineering concerns live: schema validation, authentication, rate limiting, and tool versioning live in the MCP layer. Task routing, result aggregation, load balancing, and agent health monitoring live in the A2A layer. Getting these boundaries right at design time prevents the coupling that makes agent systems expensive to evolve.

The "choosing the right combination" framing at the end of the section is the staff-level architectural judgment question. A single-agent system with MCP tools is the simplest configuration and should be the default. A multi-agent system with A2A coordination is more complex and should only be adopted when the tasks genuinely require parallel specialized processing that a single agent cannot provide. The transition from single-agent to multi-agent architecture is a discrete architectural step that requires planning, not a gradual drift that happens as the system grows. Senior engineers define the criteria for this transition and govern it, preventing teams from jumping to multi-agent complexity before single-agent reliability is established.
