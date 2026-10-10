## 117.11 Common Pitfalls

1. **Infinite Loops**: Always set `MaxIterations`. Agents get stuck in cycles, and a loop with no cap is a blank cheque against your API budget.

2. **Token Waste**: Each iteration resends the history, so cost per step grows as the run goes on. Bound the context and summarize.

3. **Tool Reliability**: Agents will call your tools in unexpected ways. Validate every argument at the tool boundary, and remember JSON numbers arrive as `float64`.

4. **Error Handling**: Tools will fail. Feed the failure back to the model as an observation rather than swallowing it, and retry only tools that are idempotent. Retrying `send_email` is not resilience, it is three emails.

5. **Trusting Tool Output**: Everything a tool returns is untrusted input, not instruction. This is the one that turns a bug into a breach.

6. **Security**: Agents can execute code and reach your data. Sandbox tools, enforce limits outside the model, and require human approval for anything irreversible.

### Junior → FAANG: Pitfalls as Production Preparation

Each pitfall in this list corresponds to a production failure mode that has caused incidents at real companies. Infinite loops are the most common: an agent that is asked to monitor a system and take corrective action can enter an infinite loop where every corrective action triggers a new alert, which triggers another corrective action. Always set MaxIterations to a value appropriate for the task (research tasks might allow 20 iterations, simple query-and-respond tasks should cap at 5), and implement a circuit breaker that detects when the agent is making the same tool call with the same arguments repeatedly.

Tool failures that are not handled gracefully produce confusing agent behavior: the agent might retry the same failing tool indefinitely, conclude incorrectly that the task is impossible, or take alternative actions based on an incorrect understanding of why the tool failed. Build tool implementations that return structured error objects with error type (transient, permanent, authorization), suggested retry strategy (retry in N seconds, no retry, escalate to human), and a human-readable explanation that the LLM can incorporate into its reasoning. This structured error response improves agent resilience significantly over returning a generic error string.

For interview prep, practice running through these five pitfalls mentally for any agent design you describe in an interview. "I would implement a MaxIterations limit of 10 for this use case. I would check for tool call repetition and break out of the loop if the same tool is called with the same arguments twice. All tool call parameters would be validated against the JSON schema before execution. Error handling would return structured errors that the LLM can interpret and respond to appropriately. And the code execution tool would run in a Docker sandbox with network isolation."

### Senior @ FAANG: Pitfall Prevention as Platform Engineering

At senior level, the common pitfalls list becomes a platform requirement specification. Infinite loop prevention is enforced by the platform (MaxIterations is a required parameter with a maximum allowed value). Token cost accumulation is monitored by the platform (per-session cost budget is enforced with automatic termination). Trusting tool output without validation is prevented by the platform's output validation layer. Security for code execution is enforced by the platform's sandbox infrastructure (no agent can execute code outside the sandbox regardless of its tool configuration). Platform-level enforcement is more reliable than per-agent code because it applies uniformly to all agents, including agents written by teams that are not aware of the pitfalls.

The "trusting output" pitfall deserves special attention at the senior level because it is the most subtle. An agent that validates tool inputs but not tool outputs can be manipulated through a tool whose output is controlled by an attacker: a web search tool that retrieves a malicious page containing injected instructions, or a database query tool that returns data crafted by a malicious insider to manipulate agent behavior. Output validation must be as rigorous as input validation: check that tool outputs conform to the expected schema, apply content moderation to text outputs, and log anomalous outputs for security review.

At L6, pitfall governance includes automated testing of each pitfall scenario in the CI pipeline: a test that verifies the agent terminates at MaxIterations, a test that verifies the session cost budget enforcement, a test that verifies the sandbox prevents unauthorized network access, and a test that verifies structured error handling produces correct agent behavior. These tests cannot catch all possible failure modes, but they verify the most critical platform safety guarantees and run with every code change to prevent regressions.

---
