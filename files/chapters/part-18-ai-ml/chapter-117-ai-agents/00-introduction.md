# Chapter 117: AI Agents

> *"The difference between a chatbot and an agent is the ability to take an action that changes the state of the world, and bear the consequences."*

AI agents represent a qualitative shift in what software systems can do. A conventional application executes a deterministic path through logic you wrote. An AI agent takes a goal expressed in natural language and autonomously determines what steps to take, what tools to use, and how to recover when intermediate steps fail. The LLM serves as the reasoning engine, but the agent's value is in its tools, the Go functions it can call to read files, query databases, make API requests, execute code, or invoke other agents. The combination of LLM reasoning with real-world tool execution is what makes agents useful beyond a chatbot.

The ReAct pattern, introduced in "ReAct: Synergizing Reasoning and Acting in Language Models" (Yao et al., 2022), is the dominant framework for implementing agents. The model generates reasoning traces and task-specific actions in an interleaved manner: reasoning traces help it induce, track, and update plans and handle exceptions, while actions let it gather information from external sources. The resulting thought-action-observation loop makes agent reasoning legible and debuggable in a way that action-only prompting is not. In Go, the ReAct loop maps to a plain `for` loop over a tool dispatch table, bounded by an iteration cap and a `context` deadline. There is no concurrency in a single agent's loop, and that is a feature: each turn depends on the previous turn's observation, so the loop is sequential, testable, and easy to instrument.

Go's concurrency primitives are a significant advantage for multi-agent systems. When a supervisor agent spawns three subagents to research different aspects of a problem in parallel, each running its own ReAct loop with its own tool calls, goroutines and channels provide the natural coordination model. A `sync.WaitGroup` or `errgroup` collects results, and a context with cancellation propagates deadlines through the entire agent tree. Go's `context` package is the right abstraction for the hardest problem in production agent systems: ensuring that no agent loop can run indefinitely and consume unbounded API credits.

**What you'll learn in this chapter:**

- AI agent architecture: the observe-think-act loop, the role of the LLM as a planner versus an executor, and where deterministic code should replace LLM decisions
- Implementing the ReAct pattern in Go: a production-grade agent loop with thought/action parsing, tool dispatch, and observation injection
- Building a typed tool system: defining tools as Go interfaces with JSON schema descriptions that the LLM can understand and invoke correctly
- Core tool implementations: web search, SQL query execution, file read/write, HTTP API calls, and Go code execution with sandboxing
- Memory systems: short-term context window management, long-term vector memory with semantic retrieval, and episodic memory for cross-session continuity
- Multi-agent orchestration: supervisor-worker patterns, peer-to-peer agent delegation, and parallel subagent execution using Go goroutines
- Production safety: rate limiting per agent, maximum step budgets and cost budgets, output validation before action execution, and human-in-the-loop escalation for destructive tools
- Prompt injection as a security boundary: every byte a tool returns is untrusted input that an attacker may control, and the model cannot be relied on to tell instructions apart from data
- Observability for agents: tracing the full thought-action chain, logging tool calls with inputs and outputs, and alerting on runaway agent loops

**Why this matters at scale:**

Coding agents such as Cognition's Devin and GitHub's Copilot coding agent autonomously write, test, and debug code across multi-file repositories, and the orchestration patterns in this chapter map to how such systems coordinate parallel investigation and editing tasks. Salesforce markets Agentforce for customer service workloads in which agents query CRM data, draft responses, and escalate to humans, and the tool system and safety guardrails you will build here are the same architecture at smaller scale. Payments and fraud teams commonly deploy investigation agents that call internal APIs, query transaction history, and draft a human-readable risk assessment for an analyst to approve, which shifts the analyst from gathering evidence to judging it. Vendors publish enthusiastic numbers for this kind of deployment. Treat them as marketing until you have measured your own.

**Prerequisites:** Familiarity with Go fundamentals (Go 1.27.1 baseline), concurrency and worker pools (Chapters 17--22), database and HTTP service patterns (Chapters 32--42), and Machine Learning Fundamentals, LLM Integration & Vector Databases (Chapters 113--116).

---

### Junior → FAANG: Understanding AI Agents Before Building Them

The epigraph defines the critical difference between a chatbot and an agent: actions that change the state of the world. A chatbot generates text. An agent calls a tool that sends an email, creates a database record, or deletes a file. The engineering consequences of this difference are enormous: a hallucinating chatbot produces incorrect text that a human can discard. A hallucinating agent may send an incorrect email, create a corrupt database record, or delete the wrong file. Before writing a single line of agent code, internalize this distinction and let it drive your safety and validation design.

The most important thing a junior engineer can learn about AI agents is when NOT to use them. Agents introduce non-determinism, cost unpredictability, and debugging complexity that fixed automation pipelines do not have. If your task has a well-defined input-output relationship with no need for multi-step reasoning, a direct API call is more reliable, cheaper, and testable than an agent. Use agents for tasks where the steps cannot be pre-specified: research that requires deciding which sources to consult based on intermediate findings, problem diagnosis that requires iterating until the root cause is found, or creative workflows that require evaluating partial results and adjusting direction.

For interviews, the question "when would you use an AI agent?" should trigger a nuanced answer that demonstrates you understand both the capabilities and the risks. "An agent is appropriate when the task requires dynamic tool selection based on intermediate results, when the number of steps is not known in advance, and when the task value justifies the additional cost and reliability risk compared to a deterministic implementation." That level of measured assessment signals production AI experience rather than enthusiasm about a new technology.

### Senior @ FAANG: Agent Infrastructure as Risk Management

At senior level, AI agents are a risk management challenge as much as an engineering challenge. Every tool an agent can call is a potential blast radius: a database write tool can corrupt data, a code execution tool can run arbitrary code on your infrastructure, an API call tool can send requests to external services on behalf of your users. Designing the agent's tool set means explicitly deciding the maximum blast radius each tool can have and building enforcement mechanisms (sandboxing, rate limiting, human approval workflows for high-impact actions) that prevent the agent from exceeding that blast radius.

The ADR for an agent deployment must cover: the tool set and the explicit blast radius of each tool (read-only tools have minimal blast radius, write tools require authorization, destructive tools require human approval), the agent's system prompt and its role in constraining agent behavior, the evaluation framework for measuring agent quality (task success rate, cost per task, safety violations per task), and the rollback procedure when an agent causes an unintended consequence. This ADR is the governance document that makes agent deployment defensible to engineering leadership and to affected stakeholders.

At L6, agent governance includes the policy for which tasks are suitable for autonomous agent execution versus which require human-in-the-loop approval. Classification criteria include: the reversibility of the task (reversible actions can be automated with less oversight than irreversible ones), the financial impact (actions above a dollar threshold require human approval), the scope of affected users (actions affecting more than one user require explicit review), and the confidence of the agent's reasoning (low-confidence steps should pause for human confirmation rather than proceeding). Defining these criteria and encoding them in the agent platform prevents the most catastrophic agent failures before they occur.

---
