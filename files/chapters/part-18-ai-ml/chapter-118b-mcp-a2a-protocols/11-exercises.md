## Exercises

1. **MCP Calculator Server**: Build an MCP server exposing math tools (add, subtract, multiply, sqrt, solve_equation) with proper input validation and connect it to a local Claude/LLM instance.

2. **Database Assistant**: Create an MCP server with tools for schema inspection, query execution (read-only), and query explanation. Add a resource that exposes the ERD.

3. **Multi-Agent Research**: Build a 3-agent system: SearchAgent (web search), ExtractAgent (content extraction), SummaryAgent (LLM summarization). Have an orchestrator coordinate them to answer a question.

4. **Agent Memory**: Implement a vector-based memory system for an agent that stores conversation history and retrieves relevant past interactions using cosine similarity.

5. **MCP Testing**: Write integration tests that spawn an MCP server subprocess and verify tool execution, resource reading, and error handling using the stdio transport.

6. **Break the handshake on purpose**: Take a working stdio client and change `notifications/initialized` to `initialized`. Observe what happens: not an error, just a server that never leaves the initializing state, because notifications carry no id and there is nothing to reply to. Then change the pending-request map's key type from `int64` to `any` and watch every call hang until its deadline, because the id off the wire is a `float64`. Both bugs are invisible in review and total at runtime. Learning what they look like from the outside is worth more than reading about them.

7. **Streamable HTTP, correctly**: Implement the transport with one endpoint. POST returns `202` for notifications and answers requests inline - GET opens the SSE stream or returns `405`. Then write two tests that must pass: a request with a foreign `Origin` gets `403`, and fifty concurrent pushes to one SSE stream survive `go test -race`. If you skip the mutex, the race detector will find it in under a second.

8. **Read the spec, then diff the chapter**: Fetch the current MCP revision from modelcontextprotocol.io and the current A2A spec from a2a-protocol.org, and list everything in this chapter that is now out of date. This is not a rhetorical exercise. These protocols revise on a schedule shorter than a book's production cycle, and the ability to check a claim against a primary source is the skill the chapter is actually trying to teach.

### Junior → FAANG: Protocol Implementation Exercises as Deep Understanding Tools

Implementing protocols from a specification (rather than using a library) is the most effective way to develop deep protocol understanding. Exercise 1 (MCP calculator server) forces you to implement JSON-RPC request parsing, tool schema definition, parameter validation, and response formatting. After implementing it, you understand why MCP defines the schema the way it does, what validation gaps would cause security issues, and what monitoring signals are necessary to understand tool usage in production. This understanding is what makes protocol-level interview discussions fluent rather than superficial.

Exercise 3 (multi-agent research system) is the exercise most directly applicable to FAANG-level system design interviews. Decomposing a research task into planning, searching, summarizing, and synthesizing subtasks, routing them to appropriate specialist agents, and aggregating the results into a coherent output is a concrete implementation of the fan-out/fan-in architecture pattern. Building this system reveals the practical challenges that design discussions often miss: how do you handle a search agent that returns no results? How do you merge summaries from multiple search agents without introducing redundancy? How do you set the timeout for the whole orchestration when each subtask has its own timeout?

### Senior @ FAANG: Protocol Exercises as Team Engineering Investment

At senior level, Exercise 5 (MCP integration testing) is the most organizationally valuable exercise because it produces the test infrastructure that the team needs before shipping any MCP server to production. Integration tests that spawn the MCP server subprocess, call its tools with valid and invalid inputs, and verify the response format and error handling are the quality gate that prevents regressions when tool implementations change. Building this test infrastructure as part of the initial MCP server implementation, rather than as a follow-up, is the discipline that prevents the "works in development, fails in production" pattern. Assigning this exercise to the junior engineers on the team who are building MCP servers, with a senior engineer reviewing the test quality, is a concrete team capability investment that produces lasting value.

---
