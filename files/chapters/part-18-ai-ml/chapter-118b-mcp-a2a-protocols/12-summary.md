## Summary

MCP and A2A protocols form the backbone of modern AI agent systems:

- **MCP and A2A solve different problems.** MCP connects a model *down* to tools and context. A2A connects an agent *sideways* to peer agents. They are not competitors and not layers of one stack, and most real systems speak both. Getting this distinction right is the single highest-value thing in this chapter.
- **MCP** standardizes model-to-tool communication over JSON-RPC 2.0. Server primitives: tools (executable), resources (readable), prompts (templates). Client primitives: sampling, roots, elicitation.
- **MCP transports are exactly two**: stdio (subprocess) and Streamable HTTP (one endpoint, POST and GET, optional SSE). There is no WebSocket transport, and the older HTTP+SSE transport from revision 2024-11-05 is superseded.
- **A2A** is a specific protocol (Google-originated, now Linux Foundation), not a category. Agents publish an Agent Card at `/.well-known/agent-card.json` and exchange stateful, long-running Tasks that move through `submitted` and `working` to a terminal state.
- **Both protocols are versioned and moving.** MCP revisions are date strings and have broken compatibility between them. Pin a revision, and check the spec rather than a blog post or a book before you write code.
- **Orchestration patterns** include supervisor (single coordinator), peer-to-peer (direct delegation), and hierarchical (teams of teams). The dependency graph decides what can run concurrently.
- **Agent memory** requires both short-term (sliding window, bounded by tokens) and long-term (vector-searched facts, with expiry) storage.
- **Security is the protocol's weakest surface, not its strongest.** Validate `Origin` and bind to localhost on Streamable HTTP. Keep stdout clean under stdio. Enforce database and filesystem limits at the database and the OS, never in a prompt. And treat everything arriving from a tool *or a peer agent* as untrusted input: injection crosses agent boundaries as easily as legitimate results do.

### Junior → FAANG: Summary as Protocol Interview Preparation Map

Each bullet in this summary maps to a question category in FAANG AI infrastructure interviews. The MCP bullet (JSON-RPC protocol standardizing tool invocation) maps to "explain MCP and how it differs from custom function calling." The A2A bullet (AgentCards, standardized messages, multi-agent workflows) maps to "how do agents discover and communicate with each other?" The orchestration patterns bullet maps to "when would you use a supervisor pattern versus peer-to-peer versus hierarchical?" The memory bullet maps to "how do you handle context window limitations in long-running agent tasks?" The security bullet maps to "how do you secure agent-to-tool and agent-to-agent communication?" Having a specific, technical answer for each question is the preparation this summary points toward.

The "standardized protocol" framing throughout the summary is the key insight to internalize: the value of MCP and A2A is not in any specific implementation but in the standardization itself. Engineers who implement proprietary agent-to-tool and agent-to-agent communication protocols solve the same reliability, security, and observability problems independently for each integration. Engineers who adopt standardized protocols solve them once and benefit from the tooling, libraries, and documentation that grows around standards.

### Senior @ FAANG: Summary as Protocol Adoption Governance Framework

At senior level, the summary is the starting point for an organizational protocol adoption governance framework. The framework covers: which protocols does the organization standardize on (MCP for tool invocation, A2A using the patterns described here, or a different approach)? What is the migration path for existing agent systems that use proprietary protocols? What is the validation process for a new MCP server before it is added to the tool registry? What are the security requirements that every MCP tool must meet before being exposed to agents?

Documenting this framework, getting organizational alignment on it, and implementing the validation process are the organizational engineering contributions that staff engineers lead when the organization is adopting agent infrastructure at scale. The framework prevents the proliferation of inconsistent agent communication approaches that makes large-scale agent systems difficult to maintain, and it creates the foundation for the platform engineering investments (shared MCP clients, common A2A routing logic, centralized tool registry) that multiply the organization's AI agent development capacity.

---

### Navigation

- **Previous Chapter:** [Chapter 118: AI-Assisted Development & Vibe Coding](../chapter-118-ai-assisted-development/00-introduction.md)
- **Part Home:** [Part XVIII: AI Engineering and Machine Learning](../00-part-intro.md)
- **Next Chapter:** [Chapter 118C: AI System Design](../chapter-118c-ai-system-design/00-introduction.md)
