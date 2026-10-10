## 117.10 When to Use Agents (and When Not To)

**Use agents when:**
- Tasks require multiple steps with uncertain paths
- You need to combine multiple data sources or tools
- The solution isn't known in advance
- Human-like reasoning improves outcomes

**Don't use agents when:**
- A simple API call or query suffices
- The task is fully deterministic
- Latency is critical (agents are slow)
- The workflow can be hardcoded

**Example Decision Tree:**

```
Need to answer user question?
├─ Can be answered from single source? → Simple RAG
├─ Requires 2-3 known steps? → Hardcoded workflow
└─ Requires dynamic tool selection? → Agent

Need to process data?
├─ Fixed pipeline? → Traditional batch job
├─ Requires decisions at each step? → Agent
└─ Needs human creativity? → Agent + human-in-loop
```

### Junior → FAANG: The "When Not to Use Agents" Question

"When would you NOT use an AI agent?" is a question that many juniors answer poorly because they are enthusiastic about the technology and have not internalized the costs. The correct answer enumerates the cases where agents are over-engineering: when the task has a fixed, known number of steps (use a deterministic pipeline), when the task requires 100% reliability and zero tolerance for hallucination (use a rules-based system), when the latency budget is tight (agents have multiple LLM round-trips, adding seconds of latency), when the task can be pre-specified as a function with fixed inputs and outputs (write the function), or when the cost of LLM calls is prohibitive for the task volume.

The decision tree at the end of this section is the interview tool you should internalize. Practice applying it to five or six concrete examples: sending a weekly newsletter (deterministic pipeline, not an agent), answering customer questions about account balances (direct API query, not an agent), conducting a multi-step research task on a new topic (agent, because the steps cannot be pre-specified), routing a support ticket to the right department (classification model, not an agent), and generating a personalized product recommendation (recommendation model, not an agent). This practice makes the decision tree automatic in interview contexts.

### Senior @ FAANG: Agent Adoption Governance

At FAANG, senior engineers are expected to evaluate and approve or reject proposals to use AI agents for specific use cases. The evaluation framework covers: does this use case genuinely require dynamic tool selection (cannot be solved with a fixed pipeline)? Is the expected task success rate acceptable for the use case's criticality? Is the estimated cost per task acceptable at the expected volume? Is the blast radius of agent failures within the acceptable risk tolerance? Has the agent been evaluated against a representative benchmark before the proposal is made? Proposals that do not answer all five questions are sent back for more analysis.

The "when not to use agents" judgment is a career-defining capability for senior AI engineers. Engineers who reach for agents as a default solution for every AI task are creating unnecessary operational complexity and cost. Engineers who can accurately identify the small class of tasks where agents add genuine value over deterministic approaches are building the organizational AI strategy on sound engineering foundations. At L6, this judgment is applied not just to individual decisions but to the organization's overall AI architecture: defining the categories of problems that the organization's agent infrastructure should address, and the categories that should use simpler AI patterns.

At L7, the organizational agent adoption policy is a governance document that engineering leadership uses to approve or redirect agent investments. The policy specifies: minimum requirements for using agents in production (evaluation benchmark, safety review, cost model, escalation workflow), maximum scope of autonomous agent action (what categories of actions agents are permitted to take autonomously versus which require human approval), and the organizational team responsible for agent platform operations (who is on call for agent failures, and what are the escalation paths?). Drafting and maintaining this policy, with input from engineering, product, legal, and trust-and-safety teams, is a quintessential staff-level organizational responsibility.
