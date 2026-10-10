## 117.12 Case Studies: Agent Patterns at Scale

A note on how to read this section. What follows are the recurring *architectural patterns* in production agent systems: plan-and-execute, provider-native tool loops, server-managed sessions, approval-gated workflows, and multi-agent routing. They are named after the kind of system that popularized each one, not presented as a leaked account of any company's internals. Nobody outside those teams knows what their code looks like, and a chapter that claimed otherwise would be inventing detail you could not check.

The patterns are the transferable part anyway. Vendors rename products yearly. The reason a financial agent needs an approval gate above a dollar threshold does not change.

### Plan-and-Execute Architecture

The pattern behind most "deep research" and long-horizon agents: decompose the goal into a dependency graph of subtasks, execute what is ready, and replan when a step fails rather than aborting the run.

```go
// Plan-and-execute agentic architecture
package agents

import (
    "context"
    "fmt"
)

// PlanningAgent decomposes a goal, then executes the resulting subtasks.
type PlanningAgent struct {
    llm           LLMClient
    tools         *ToolRegistry
    memory        *ConversationMemory
    planner       *TaskPlanner
    executor      *ToolExecutor
    maxIterations int
    // maxReplans bounds how many times a failing plan may be redrafted.
    // Replanning calls the model, and a plan whose every draft fails would
    // otherwise replan forever, at roughly one LLM call per attempt.
    maxReplans int
}

type Task struct {
    ID          string
    Description string
    Status      string
    Subtasks    []Subtask
    Result      any
}

type Subtask struct {
    ID          string
    Action      string
    Tool        string
    Parameters  map[string]any
    Dependency  []string
    Result      any
    Status      string
}

// Execute runs the agent on a task.
//
// Note the loop uses an index, not `for _, subtask := range plan.Subtasks`.
// Subtask is a struct, so ranging by value hands you a copy, and the
// `subtask.Status = "completed"` writes below would update that copy and be
// discarded at the end of the iteration. The plan would finish with every
// subtask still marked pending, dependenciesMet would never see a completed
// dependency, and nothing would report an error. Take the address instead.
func (a *PlanningAgent) Execute(ctx context.Context, task string) (*Task, error) {
    // Plan the task
    plan, err := a.planner.Plan(ctx, task)
    if err != nil {
        return nil, err
    }

    replans := 0

    // Execute subtasks
    for i := range plan.Subtasks {
        subtask := &plan.Subtasks[i]

        // Check dependencies
        if !a.dependenciesMet(plan, subtask) {
            continue
        }

        // Execute subtask
        result, err := a.executeSubtask(ctx, subtask)
        if err != nil {
            subtask.Status = "failed"

            if replans >= a.maxReplans {
                return plan, fmt.Errorf("subtask %q failed and replan budget (%d) is exhausted: %w",
                    subtask.Action, a.maxReplans, err)
            }
            replans++

            // Replan on failure
            newPlan, replanErr := a.planner.Replan(ctx, plan, subtask, err)
            if replanErr != nil {
                return plan, fmt.Errorf("replanning after %q failed: %w", subtask.Action, replanErr)
            }
            plan = newPlan
            continue
        }

        subtask.Result = result
        subtask.Status = "completed"
    }

    // Synthesize final result
    plan.Result = a.synthesizeResults(plan)
    plan.Status = "completed"

    return plan, nil
}

// TaskPlanner uses LLM to decompose tasks
type TaskPlanner struct {
    llm       LLMClient
    tools     *ToolRegistry
}

func (p *TaskPlanner) Plan(ctx context.Context, task string) (*Task, error) {
    // Get available tools
    toolDescriptions := p.tools.Describe()

    prompt := fmt.Sprintf(`You are a task planner. Break down this task into subtasks.

Task: %s

Available tools:
%s

Return a JSON plan with subtasks. Each subtask should specify:
- action: what to do
- tool: which tool to use
- parameters: tool parameters
- dependencies: IDs of subtasks that must complete first

Plan:`, task, toolDescriptions)

    resp, err := p.llm.Complete(ctx, prompt)
    if err != nil {
        return nil, err
    }

    return parsePlan(resp)
}

func (p *TaskPlanner) Replan(
    ctx context.Context,
    currentPlan *Task,
    failedSubtask *Subtask,
    failure error,
) (*Task, error) {
    prompt := fmt.Sprintf(`A subtask failed. Create an alternative plan.

Original task: %s
Failed subtask: %s
Error: %v
Completed subtasks: %v

Create a new plan to complete the task:`,
        currentPlan.Description,
        failedSubtask.Action,
        failure,
        getCompletedSubtasks(currentPlan))

    resp, err := p.llm.Complete(ctx, prompt)
    if err != nil {
        return nil, err
    }

    return parsePlan(resp)
}
```

### Provider-Native Tool Loop

The second pattern is the one you will actually write most often: a loop against a provider's native tool-use protocol. The shape below follows Anthropic's Messages API, where the model returns `tool_use` blocks and you reply with matching `tool_result` blocks. The names differ across providers, the loop does not.

Two details in the code are load-bearing and are the usual sources of confusion. Every `tool_result` must carry the `tool_use_id` of the call it answers, because a turn can contain several parallel tool calls and the pairing is what tells the model which result belongs to which call. And a failing tool returns a result with `IsError: true` rather than being dropped: the model needs to see the failure to route around it, and a missing result for an issued call is a protocol error, not a silent no-op.

```go
// Provider-native tool use loop (Anthropic Messages API shape)
package claude

import (
    "context"
    "fmt"
)

// ClaudeToolAgent implements Claude's tool use protocol
type ClaudeToolAgent struct {
    client   *AnthropicClient
    tools    []ToolDefinition
    maxTurns int
    // model is configuration, not a constant. Provider model identifiers are
    // the shortest-lived string in an AI codebase: they are added, superseded,
    // and retired on the vendor's schedule. Any ID hardcoded in a book is
    // wrong by the time you read it. Read it from config and check the
    // provider's current model list.
    model string
    // handlers maps tool name to implementation.
    handlers map[string]ToolHandler
}

// ToolDefinition is the wire shape sent to the API: it describes the tool, it
// does not implement it. The handler is kept out of this struct because the
// struct is marshalled to JSON, and a func field would make it unmarshalable.
type ToolDefinition struct {
    Name        string     `json:"name"`
    Description string     `json:"description"`
    InputSchema JSONSchema `json:"input_schema"`
}

// ToolHandler is the local implementation behind a ToolDefinition.
type ToolHandler func(ctx context.Context, input map[string]any) (string, error)

type ToolUse struct {
    ID    string                 `json:"id"`
    Name  string                 `json:"name"`
    Input map[string]any `json:"input"`
}

type ToolResult struct {
    ToolUseID string `json:"tool_use_id"`
    Content   string `json:"content"`
    IsError   bool   `json:"is_error"`
}

// Run executes the agent with tool use
func (a *ClaudeToolAgent) Run(ctx context.Context, prompt string) (string, error) {
    messages := []Message{
        {Role: "user", Content: prompt},
    }

    for turn := 0; turn < a.maxTurns; turn++ {
        // Call Claude with tools
        resp, err := a.client.CreateMessage(ctx, MessageRequest{
            Model:     a.model,
            MaxTokens: 4096,
            Tools:     a.tools,
            Messages:  messages,
        })
        if err != nil {
            return "", err
        }

        // Check if Claude wants to use tools
        toolUses := extractToolUses(resp.Content)
        if len(toolUses) == 0 {
            // No tools, return final response
            return extractText(resp.Content), nil
        }

        // Add assistant message with tool uses
        messages = append(messages, Message{
            Role:    "assistant",
            Content: resp.Content,
        })

        // Execute tools and collect results.
        //
        // Every issued tool_use gets exactly one tool_result carrying its ID,
        // including the failures. Dropping the result of a failed call leaves
        // the model with an unanswered tool_use, which the API rejects, and
        // sending back an empty Content on error tells the model the call
        // succeeded and returned nothing.
        toolResults := make([]ToolResult, len(toolUses))
        for i, toolUse := range toolUses {
            result, err := a.executeTool(ctx, toolUse)
            if err != nil {
                result = fmt.Sprintf("error: %v", err)
            }
            toolResults[i] = ToolResult{
                ToolUseID: toolUse.ID,
                Content:   result,
                IsError:   err != nil,
            }
        }

        // Add tool results to messages
        messages = append(messages, Message{
            Role:    "user",
            Content: formatToolResults(toolResults),
        })
    }

    return "", fmt.Errorf("max turns exceeded")
}

func (a *ClaudeToolAgent) executeTool(
    ctx context.Context,
    toolUse ToolUse,
) (string, error) {
    handler, ok := a.handlers[toolUse.Name]
    if !ok {
        // The model invented a tool that does not exist. Report it rather than
        // panicking on a nil handler: the model will usually correct itself
        // when the next turn shows the name was rejected.
        return "", fmt.Errorf("tool not found: %s", toolUse.Name)
    }
    return handler(ctx, toolUse.Input)
}
```

### Server-Managed Sessions

The third pattern moves the agent loop to the provider: you create a persistent agent configuration, start a session, and poll or stream while the server runs the loop and calls back when it needs something from you.

**Do not build new work on OpenAI's Assistants API.** It was deprecated in August 2025 and shuts down on 26 August 2026, superseded by the Responses API, where Assistants become Prompts, Threads become Conversations, and Runs become Responses. Anthropic's Managed Agents is a separate offering in the same shape. The code below is kept because the *pattern* long outlives the product: a create-then-poll loop with a `requires_action` state is what every server-managed agent surface looks like, whichever vendor you use. Read it as a shape to recognize, and check the current API reference before writing any of it.

The polling loop below is also where two real bugs live. Read the `default` branch and the terminal-state handling closely.

```go
// Server-managed session pattern (shape shown: OpenAI Assistants, now sunset)
package assistants

import (
    "context"
    "fmt"
    "time"
)

// AssistantService manages OpenAI Assistants
type AssistantService struct {
    client      *OpenAIClient
    assistants  map[string]*Assistant
    threads     map[string]*Thread
}

type Assistant struct {
    ID           string
    Name         string
    Instructions string
    Model        string
    Tools        []Tool
    FileIDs      []string
}

type Thread struct {
    ID        string
    Messages  []ThreadMessage
    CreatedAt time.Time
}

type Run struct {
    ID             string
    AssistantID    string
    ThreadID       string
    Status         string
    RequiredAction *RequiredAction
}

type RequiredAction struct {
    Type        string
    ToolCalls   []ToolCall
}

// CreateAndRun creates a thread and runs the assistant
func (s *AssistantService) CreateAndRun(
    ctx context.Context,
    assistantID string,
    userMessage string,
) (string, error) {
    // Create thread with message
    thread, err := s.client.CreateThread(ctx, []ThreadMessage{
        {Role: "user", Content: userMessage},
    })
    if err != nil {
        return "", err
    }

    // Create run
    run, err := s.client.CreateRun(ctx, thread.ID, assistantID)
    if err != nil {
        return "", err
    }

    // Poll for completion
    for {
        run, err = s.client.GetRun(ctx, thread.ID, run.ID)
        if err != nil {
            return "", err
        }

        switch run.Status {
        case "completed":
            // Get final message
            messages, err := s.client.ListMessages(ctx, thread.ID)
            if err != nil {
                return "", err
            }
            // Check the length before indexing. A completed run with no
            // messages is unlikely, but messages[0] on an empty slice panics,
            // and a panic in a polling goroutine takes the process down.
            if len(messages) == 0 {
                return "", fmt.Errorf("run completed but returned no messages")
            }
            return messages[0].Content, nil

        case "requires_action":
            // Handle tool calls
            if err := s.handleToolCalls(ctx, run); err != nil {
                return "", err
            }

        // Enumerate every terminal state. This is the important line in the
        // whole function. If "cancelled" or "expired" is left out, it falls to
        // the default branch, sleeps a second, polls again, gets the same
        // terminal status, and loops forever: a hung request, a leaked
        // goroutine, and a poll every second against the API until the process
        // dies. The default branch must only ever be reached by states that
        // are genuinely still in progress.
        case "failed", "cancelled", "expired":
            return "", fmt.Errorf("run ended in terminal state %q", run.Status)

        case "queued", "in_progress", "cancelling":
            // Sleep on a context-aware timer so a cancelled request stops
            // polling immediately instead of finishing its nap first.
            select {
            case <-ctx.Done():
                return "", ctx.Err()
            case <-time.After(time.Second):
            }

        default:
            // An unrecognised status is a protocol change, not a reason to
            // spin. Fail loudly so it is noticed.
            return "", fmt.Errorf("unknown run status %q", run.Status)
        }
    }
}

func (s *AssistantService) handleToolCalls(
    ctx context.Context,
    run *Run,
) error {
    results := make([]ToolOutput, len(run.RequiredAction.ToolCalls))

    for i, call := range run.RequiredAction.ToolCalls {
        output, err := s.executeTool(ctx, call)
        results[i] = ToolOutput{
            ToolCallID: call.ID,
            Output:     output,
        }
        if err != nil {
            results[i].Output = fmt.Sprintf("Error: %v", err)
        }
    }

    return s.client.SubmitToolOutputs(ctx, run.ThreadID, run.ID, results)
}
```

### Approval-Gated Financial Workflows

The fourth pattern is the one with money attached. Financial agents are where the safety machinery from Section 9 stops being theoretical: the agent proposes an action, deterministic code decides whether a human must approve it, and the audit log records both regardless of the outcome.

Note where the authority sits. The model classifies and drafts. It does not decide whether approval is required: `determineApproval` is plain Go comparing an amount against a threshold, and it runs after the model has spoken and cannot be talked out of its answer. That ordering is the entire design. A model that decided its own approval requirements would be one convincing sentence away from approving everything.

```go
// Approval-gated financial agent
package financial

import (
    "context"
    "fmt"
    "time"
)

// FinancialAgent automates financial operations
type FinancialAgent struct {
    llm           LLMClient
    paymentTools  *PaymentToolKit
    fraudDetector *FraudDetector
    auditLog      *AuditLog
    // fraudThreshold is the score above which a task is escalated to a human.
    // It is configuration rather than a literal in the middle of a function:
    // risk teams retune this number, and it should not take a deploy.
    fraudThreshold float64
    // approvalThreshold is the amount above which a human must sign off.
    approvalThreshold float64
}

type FinancialTask struct {
    ID          string
    Type        string // refund, dispute, reconciliation
    Amount      float64
    Currency    string
    CustomerID  string
    Context     map[string]any
}

type FinancialAction struct {
    Type       string
    Parameters map[string]any
    Approval   *ApprovalRequirement
    Result     any
}

// ProcessTask handles financial tasks with approval workflow
func (a *FinancialAgent) ProcessTask(
    ctx context.Context,
    task FinancialTask,
) (*FinancialAction, error) {
    // Log task start
    a.auditLog.RecordTaskStart(task)

    // Analyze task with LLM
    prompt := fmt.Sprintf(`Analyze this financial task and determine the action:

Task Type: %s
Amount: %.2f %s
Customer: %s
Context: %v

Available actions:
- approve_refund: Approve refund request
- reject_refund: Reject refund with reason
- escalate: Escalate to human review
- request_info: Request additional information

Determine the appropriate action with parameters:`,
        task.Type, task.Amount, task.Currency, task.CustomerID, task.Context)

    resp, err := a.llm.Complete(ctx, prompt)
    if err != nil {
        return nil, err
    }

    action, err := parseAction(resp)
    if err != nil {
        return nil, err
    }

    // Check fraud
    if task.Amount > 0 {
        fraudRisk := a.fraudDetector.Assess(task)
        if fraudRisk > a.fraudThreshold {
            action.Type = "escalate"
            // parseAction may well have left Parameters nil, and assigning to
            // a nil map panics. Reading from one is fine, which is why this
            // kind of bug survives until the first high-risk transaction, then
            // takes down the handler on exactly the path that mattered most.
            if action.Parameters == nil {
                action.Parameters = make(map[string]any)
            }
            action.Parameters["reason"] = "High fraud risk"
        }
    }

    // Determine approval requirements
    action.Approval = a.determineApproval(task, action)

    // Execute if no approval needed
    if action.Approval == nil {
        result, err := a.executeAction(ctx, task, action)
        if err != nil {
            return nil, err
        }
        action.Result = result
    }

    // Log action
    a.auditLog.RecordAction(task, action)

    return action, nil
}

// determineApproval decides whether a human must sign off. This is ordinary Go,
// deliberately: it is not a prompt, not a tool the model can call, and not a
// judgement the model contributes to. The model's output is an input here, not
// an authority.
func (a *FinancialAgent) determineApproval(
    task FinancialTask,
    action *FinancialAction,
) *ApprovalRequirement {
    // High-value transactions need approval
    if task.Amount > a.approvalThreshold {
        return &ApprovalRequirement{
            Level:    "manager",
            Reason:   "High-value transaction",
            Deadline: time.Now().Add(24 * time.Hour),
        }
    }

    // Refunds over half the threshold get a lighter-weight review.
    if action.Type == "approve_refund" && task.Amount > a.approvalThreshold/2 {
        return &ApprovalRequirement{
            Level:    "team_lead",
            Reason:   "Refund above the auto-approval limit",
            Deadline: time.Now().Add(4 * time.Hour),
        }
    }

    return nil
}
```

### Multi-Agent Routing and Fan-Out

The last pattern: decompose a task, route each piece to whichever specialist agent can handle it, run the independent pieces concurrently, and aggregate. This is where Go earns its place in the stack, and also where agent systems acquire ordinary distributed-systems bugs that have nothing to do with AI.

```go
// Multi-agent coordination
package multiagent

import (
    "context"
    "fmt"
    "sync"
)

// AgentOrchestrator coordinates multiple specialized agents
type AgentOrchestrator struct {
    agents      map[string]Agent
    router      *TaskRouter
    coordinator *Coordinator
}

type Agent interface {
    Name() string
    Capabilities() []string
    Process(ctx context.Context, task Task) (Result, error)
}

// TaskRouter determines which agent handles a task
type TaskRouter struct {
    llm        LLMClient
    agents     map[string]Agent
}

func (r *TaskRouter) Route(ctx context.Context, task Task) (string, error) {
    // Get agent capabilities
    capabilities := make(map[string][]string)
    for name, agent := range r.agents {
        capabilities[name] = agent.Capabilities()
    }

    prompt := fmt.Sprintf(`Route this task to the appropriate agent.

Task: %s
Task Type: %s

Available agents:
%v

Return the agent name that should handle this task:`,
        task.Description, task.Type, capabilities)

    resp, err := r.llm.Complete(ctx, prompt)
    if err != nil {
        return "", err
    }

    return parseAgentName(resp), nil
}

// Coordinator manages agent collaboration
type Coordinator struct {
    mu     sync.Mutex
    state  map[string]*AgentState
    events chan AgentEvent
}

type AgentState struct {
    AgentName   string
    CurrentTask *Task
    Status      string
    Results     []Result
}

// ProcessComplexTask handles tasks requiring multiple agents
func (o *AgentOrchestrator) ProcessComplexTask(
    ctx context.Context,
    task Task,
) (*CompositeResult, error) {
    // Decompose task
    subtasks, err := o.decomposeTask(ctx, task)
    if err != nil {
        return nil, err
    }

    // Route subtasks to agents
    assignments := make(map[string][]Task)
    for _, subtask := range subtasks {
        agentName, err := o.router.Route(ctx, subtask)
        if err != nil {
            return nil, err
        }
        assignments[agentName] = append(assignments[agentName], subtask)
    }

    // Execute in parallel where possible.
    //
    // Resolve each agent from the map on this goroutine, before the fan-out,
    // and pass the value in. Reading o.agents[name] inside the goroutines is a
    // concurrent map read that races any registration on another goroutine,
    // and Go's runtime aborts the whole process on a detected map race rather
    // than returning an error you could handle.
    results := make(chan SubtaskResult, len(subtasks))
    var wg sync.WaitGroup

    for agentName, tasks := range assignments {
        agent, ok := o.agents[agentName]
        if !ok {
            return nil, fmt.Errorf("router assigned work to unknown agent %q", agentName)
        }
        for _, t := range tasks {
            if !o.canExecute(t, assignments) {
                continue
            }
            wg.Add(1)
            go func(agent Agent, task Task) {
                defer wg.Done()
                result, err := agent.Process(ctx, task)
                results <- SubtaskResult{
                    TaskID: task.ID,
                    Result: result,
                    Error:  err,
                }
            }(agent, t)
        }
    }

    wg.Wait()
    close(results)

    // Aggregate results
    return o.aggregateResults(task, results), nil
}

func (o *AgentOrchestrator) decomposeTask(
    ctx context.Context,
    task Task,
) ([]Task, error) {
    prompt := fmt.Sprintf(`Decompose this complex task into subtasks:

Task: %s

Each subtask should be:
- Self-contained
- Assigned to a single agent
- Have clear inputs and outputs

Return subtasks as JSON array:`, task.Description)

    resp, err := o.router.llm.Complete(ctx, prompt)
    if err != nil {
        return nil, err
    }

    return parseSubtasks(resp)
}
```

### Junior → FAANG: Case Studies as Viability Evidence

Three capability classes come up repeatedly in interviews, and it is worth being able to name what each one demonstrates rather than which vendor shipped it last quarter. Provider-hosted multi-modal agents demonstrate tool use at scale. Computer-use agents demonstrate the extreme end of the blast radius spectrum, direct control of a machine, and the explicit safety controls that become mandatory at that end. Sandboxed code execution demonstrates the isolation properties required before you let a model run code that a user's input influenced.

Name the pattern first and the product second, and say when you last checked. An interviewer who works on these systems will know the current products better than you do, and citing a sunset preview as a live deployment costs more credibility than saying "the last time I looked at this class of system" and being right about the engineering.

The case studies also reveal what agents are not yet good at in production. Long-horizon planning (maintaining coherent strategy over many steps), highly reliable tool use (agents still hallucinate tool calls or arguments in difficult contexts), and cost predictability (agent step counts are variable and hard to budget for) are known limitations that the research community is actively working on. Acknowledging these limitations in interview discussions demonstrates technical honesty and current awareness that distinguishes engineers who follow the field from those who only know the marketing material.

### Senior @ FAANG: Case Studies as Architectural Reference Points

Large-scale agent infrastructure rests on the same principles as any production ML serving platform: shared evaluation frameworks, standardized tool interfaces, centralized cost management, and horizontal scaling. The useful calibration is that scale does not dissolve the hard parts. Reliability, cost predictability, and safety remain unsolved by compute alone and are addressed, where they are addressed at all, by careful platform engineering. Anyone who believes more GPUs will fix an agent's reliability problems has not looked closely at one.

Computer-use agents are the most instructive case for senior engineers, because they sit at the highest blast radius currently deployed anywhere. Direct control of a machine means the agent can take any action the machine can take, including irreversible ones, and including actions suggested by whatever text happened to be on the screen. The mitigations that vendors converge on are worth knowing as a template: explicit user confirmation for high-impact actions, session isolation, and verification of the action against the observed screen state before it commits. That convergence is itself the signal. Independent teams arrived at the same controls because the alternatives did not survive contact with production.

At L6, these patterns form the evidence base for the organization's agent capability roadmap, and the standard of evidence matters. "A vendor's launch post says this works at production scale" is marketing. "We ran our own benchmark on our own tasks and measured a task success rate we can live with, at a cost per task we can afford" is evidence. Staff engineers are the ones expected to know the difference and to insist on the second before committing budget. The technology-readiness assessment that justifies investment has to come from your own measurements, because the vendor's numbers were produced on the vendor's tasks.

---
