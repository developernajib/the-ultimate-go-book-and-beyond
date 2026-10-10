## 118B.9 FAANG Interview Questions

**Q: What is MCP and why does it matter for AI applications?**

A: MCP (Model Context Protocol) is a standardized protocol that defines how AI models communicate with external tools, data sources, and services using JSON-RPC 2.0. It matters because: (1) standardization - any MCP-compatible tool works with any MCP-compatible model, (2) separation of concerns - tool logic lives outside the model, (3) security - tool permissions are explicit and auditable, (4) discoverability - models can dynamically discover available tools.

**Q: What's the difference between MCP tools, resources, and prompts?**

A: **Tools** are executable functions the model can call (like `query_database`, `send_email`) - they have side effects and return results. **Resources** are data sources the model can read (like `db://schema`, `file:///config.json`) - they're read-only and URI-addressable. **Prompts** are reusable prompt templates with arguments (like `code_review(language="go")`) - they return pre-formatted messages.

**Q: How do you prevent prompt injection attacks in MCP tool implementations?**

A: Start by correcting the premise, because the phrasing hides the shape of the problem. You do not "prevent" prompt injection at the tool, and injection is not primarily about the tool's *arguments*. The model reads its instructions and its data from one flat token stream with no structural boundary between them, so any text your tool *returns* can be read as instruction. A `read_file` tool is a perfect injection vector even though its own argument was a harmless path, because the file's contents land in the context window.

So the defenses that count live outside the model, where injected text gets no vote:

1. **A read-only database role**, not a SQL string filter. Parameterized queries do not apply when the model authors the query structure, which is the usual misconception here.
2. **Path containment** resolved through symlinks and compared with `filepath.Rel`, not a `HasPrefix` test.
3. **Host allowlists** compared against a parsed URL's host field, not a substring search of the URL.
4. **Least privilege per tool**, so a compromised context reaches as little as possible.
5. **Human approval** on anything irreversible.
6. **Audit logs and rate limits**, which contain and reveal abuse rather than preventing it.

Then the framing that gets you the offer: audit tool *combinations*, not tools. An MCP server exposing retrieval alongside any outbound-request tool is an exfiltration channel, even though each tool is individually defensible. Assume the model is fully compromised and ask what it can still reach. That answer is the real blast radius.

**Q: What's the A2A protocol and how does it differ from MCP?**

A: They solve different problems and are not competitors. MCP connects a model *down* to tools and context: a server exposes tools, resources, and prompts, and the client invokes them. A2A connects an agent *sideways* to peer agents, which are opaque to each other and may run on different stacks from different vendors.

Concretely: MCP is JSON-RPC 2.0 over stdio or Streamable HTTP, and its unit of work is a tool call. A2A offers several bindings (JSON-RPC 2.0, gRPC, HTTP+JSON), discovers peers through an Agent Card published at **`/.well-known/agent-card.json`**, and its unit of work is a stateful Task moving through `submitted` and `working` to a terminal state, or pausing at `input-required`. That task lifecycle exists because agent-to-agent work runs for minutes or hours, which no request-response call models honestly.

A single system typically speaks both: MCP downward to its tools, A2A sideways to its peers. Origins differ too, which is worth knowing: MCP came from Anthropic, A2A from Google and now sits with the Linux Foundation.

**Q: How would you design MCP server authentication for a multi-tenant environment at FAANG scale?**

A: Layer the defenses. First, terminate TLS at an API gateway and pin client certificates for first-party agents. Second, require OAuth 2.1 bearer tokens on every JSON-RPC call, scoped per tenant and per tool. Third, enforce per-tenant RBAC inside the MCP server so `read_customer` for tenant A cannot reach tenant B data. Fourth, add rate limits and per-tool quotas in a sidecar (Envoy or similar) to contain runaway agents. Fifth, emit structured audit logs with trace IDs tied to the agent, tool, arguments hash, and tenant, then ship them to a SIEM for anomaly detection.

If the server speaks Streamable HTTP, add the two the spec makes normative and interviewers notice when you skip: validate the `Origin` header and reject mismatches with 403, and bind local servers to 127.0.0.1 rather than 0.0.0.0. Both defend against a browser being used as a confused deputy against a server that assumed it was unreachable.

---

### Junior → FAANG: MCP and A2A Interview Questions as Technical Vocabulary Building

The interview questions in this section are more advanced than typical junior-level questions because MCP and A2A are emerging protocol standards that require specific knowledge. For FAANG interviews at L4 and L5, you are not expected to have memorized the full MCP specification. You are expected to understand the architectural problem it solves (standardizing tool invocation), the key design decisions (JSON-RPC 2.0 over stdio or Streamable HTTP), and the production concerns (schema validation, authentication, monitoring). Practice the "what is MCP and why does it matter?" question until the answer is fluent and specific rather than vague.

One cheap way to sound current: say which spec revision you are describing, and say when you last checked. These protocols change on a timescale shorter than most interview loops, and "as of the 2025-11-25 revision" signals that you read specifications rather than blog posts. It also protects you: if the interviewer knows of a newer revision, you have framed your answer as pinned rather than wrong.

The multi-tenant security question (the last question) is the most complex and highest-signal question in the list. The layered defense answer (TLS, OAuth 2.1, RBAC, rate limits, audit logs) demonstrates systems-level security thinking that goes beyond individual security measures. For FAANG security interviews, this kind of layered defense answer is expected: no single mechanism is sufficient, and the defense-in-depth approach shows that you understand that security is a property of the system, not a single feature. Practice explaining why each layer is necessary even though it overlaps with other layers.

### Senior @ FAANG: Interview Questions as Architecture Review Template

At senior level, the interview questions in this section are an architecture review template for evaluating a proposed agent system design. Before a team ships a new agent system to production, senior engineers should run the team through these questions: how does your MCP server validate tool schemas? What happens when an agent is unavailable? How do you route tasks in the multi-agent system? How do you secure the MCP server against unauthorized access? Teams that cannot answer these questions concisely have design gaps that will become production incidents. The interview questions, used as a design review prompt, reveal these gaps before deployment rather than after.
