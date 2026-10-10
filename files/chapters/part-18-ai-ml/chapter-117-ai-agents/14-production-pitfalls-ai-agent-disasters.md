## 117.13 Production Pitfalls: AI Agent Disasters

The scenarios below are illustrative composites, not incident reports from any named company. Real postmortems for agent failures are rarely published, and inventing specific dollar figures and dates would give you numbers to quote that nobody could check. The failure *modes* are real and well documented, and they are what matters: each one describes something that has happened repeatedly, and each has a mechanical fix you can implement today.

### Pitfall 1: Infinite Agent Loops

**Scenario**: An agent instructed to "complete the task" retries a failing API call forever. Nothing in the loop counts iterations, so the only limits are the provider's rate limiter and your credit card. This is the single most common way an agent project generates a surprise invoice, and it is entirely preventable with a `for i := 0; i < max; i++`.

**The Anti-Pattern**:
```go
// WRONG: No loop protection
func (a *Agent) Execute(task Task) Result {
    for {
        action := a.decide(task)
        result := a.execute(action)

        if result.Success {
            return result
        }
        // Keeps trying forever if action always fails
    }
}
```

**The Better Approach**:
```go
// RIGHT: Bounded execution with circuit breaker
type BoundedAgent struct {
    agent          *Agent
    maxIterations  int
    maxDuration    time.Duration
    maxCost        float64
    circuitBreaker *CircuitBreaker
}

func (b *BoundedAgent) Execute(ctx context.Context, task Task) (Result, error) {
    startTime := time.Now()
    var totalCost float64
    var lastError error

    for iteration := 0; iteration < b.maxIterations; iteration++ {
        // Check timeout
        if time.Since(startTime) > b.maxDuration {
            return Result{}, fmt.Errorf("timeout after %d iterations: %w", iteration, lastError)
        }

        // Check cost budget
        if totalCost > b.maxCost {
            return Result{}, fmt.Errorf("cost limit exceeded: $%.2f", totalCost)
        }

        // Check circuit breaker
        if !b.circuitBreaker.Allow() {
            return Result{}, fmt.Errorf("circuit breaker open after repeated failures")
        }

        // Execute with context
        action, err := b.agent.decide(ctx, task)
        if err != nil {
            lastError = err
            b.circuitBreaker.RecordFailure()
            continue
        }

        result, cost, err := b.agent.execute(ctx, action)
        totalCost += cost

        if err != nil {
            lastError = err
            b.circuitBreaker.RecordFailure()
            continue
        }

        b.circuitBreaker.RecordSuccess()

        if result.Complete {
            return result, nil
        }

        // Update task with result for next iteration
        task = task.WithResult(result)
    }

    return Result{}, fmt.Errorf("max iterations reached (%d): %w", b.maxIterations, lastError)
}
```

**Key Insight**: Agents must have hard limits on iterations, time, and cost. Implement circuit breakers to stop when actions consistently fail.

---

### Pitfall 2: Unrestricted Tool Access

**Scenario**: An autonomous coding agent is given shell access so it can run tests. Partway through a run it decides, reasonably enough, that the disk is full and that clearing `/tmp` would help. The files in `/tmp` belonged to other production processes.

Note that the agent was not attacked and did nothing forbidden. It was handed a tool whose blast radius was "anything this machine can do" and it used it. The lesson is about the grant, not the model.

**The Anti-Pattern**:
```go
// WRONG: Unrestricted shell access
type ShellTool struct{}

func (t *ShellTool) Execute(command string) (string, error) {
    cmd := exec.Command("bash", "-c", command) // Anything goes!
    output, err := cmd.CombinedOutput()
    return string(output), err
}
```

**A tempting fix that does not work**: keep `bash -c`, add a regex allowlist for `go test`, and reject any command containing `rm`, `;`, `|`, `>`, and friends.

It fails in both directions at once, which is the hallmark of this whole family of mistakes.

It is too weak, because the command still reaches a shell. The shell is a programming language, and a blocklist of its metacharacters is an enumeration of badness against an interpreter with more ways to compose than you can list. Once `bash -c` receives model-authored text, you are negotiating with a language, not validating an input.

It is also too strict, in a way that guarantees someone disables it. `strings.Contains(command, "rm")` rejects `go build ./cmd/normalize`, because "normalize" contains the letters `rm`. `go test ./internal/movers` trips the `mv` rule. The tool blocks real work, an engineer removes the check to get the build green, and the guardrail is gone.

**The Better Approach**: do not involve a shell at all.

```go
// RIGHT: no shell, argv allowlist, explicit subcommands
type SafeShellTool struct {
    // allowed maps an executable to the subcommands permitted for it.
    allowed map[string]map[string]bool
    workDir string
    timeout time.Duration
}

func NewSafeShellTool(workDir string) *SafeShellTool {
    return &SafeShellTool{
        allowed: map[string]map[string]bool{
            "go":  {"build": true, "test": true, "vet": true, "fmt": true},
            "npm": {"test": true, "lint": true, "build": true},
        },
        workDir: workDir,
        timeout: 30 * time.Second,
    }
}

// Execute takes argv, not a command string. This signature is the security
// control. There is no shell to inject into, so metacharacters lose their
// meaning entirely: an argument of "; rm -rf /" is passed to the program as
// one literal string, and `go test` simply reports that no such package
// exists. Nothing needs to be escaped, because nothing is ever parsed.
func (t *SafeShellTool) Execute(ctx context.Context, argv []string) (string, error) {
    if len(argv) < 2 {
        return "", fmt.Errorf("expected at least a program and a subcommand")
    }

    prog, sub := argv[0], argv[1]

    subs, ok := t.allowed[prog]
    if !ok {
        return "", fmt.Errorf("program not allowed: %s", prog)
    }
    if !subs[sub] {
        return "", fmt.Errorf("subcommand not allowed: %s %s", prog, sub)
    }

    // Reject flags that turn an allowed subcommand into arbitrary execution.
    // `go test -exec` runs a program of the caller's choosing, and `go test
    // -toolexec` does the same at build time: both make "go test" a shell by
    // another name. An allowlisted verb is not automatically a safe verb.
    for _, arg := range argv[2:] {
        if strings.HasPrefix(arg, "-exec") || strings.HasPrefix(arg, "-toolexec") {
            return "", fmt.Errorf("flag not allowed: %s", arg)
        }
    }

    ctx, cancel := context.WithTimeout(ctx, t.timeout)
    defer cancel()

    // exec.CommandContext with separate args never invokes a shell.
    cmd := exec.CommandContext(ctx, prog, argv[1:]...)
    cmd.Dir = t.workDir

    // Restrict environment
    cmd.Env = []string{
        "PATH=/usr/local/go/bin:/usr/bin",
        "HOME=/tmp",
    }

    output, err := cmd.CombinedOutput()
    return string(output), err
}
```

**Key Insight**: Never hand model-authored text to a shell. Take `argv`, allowlist the program and subcommand, and let the operating system's `exec` boundary do the work that string filtering cannot. Then put the whole thing in a container with a read-only root and no network, because the tool above still runs a real compiler on real code, and defense in depth assumes each layer will eventually fail.

---

### Pitfall 3: No Human-in-the-Loop for Dangerous Actions

**Scenario**: A customer service agent is given permission to issue refunds. Over a weekend, with no human watching, it issues a large volume of fraudulent ones. It could not distinguish a legitimate hardship story from a social-engineered one, because that distinction is not visible in the text, and text was all it had.

This is prompt injection wearing a customer's clothes. The attacker did not need to jailbreak anything: they simply asked, persuasively, and the agent had both the authority to say yes and no reason to doubt them.

**The Anti-Pattern**:
```go
// WRONG: Autonomous execution of sensitive actions
func (a *SupportAgent) HandleRequest(req Request) Response {
    intent := a.classifyIntent(req)

    switch intent {
    case "refund":
        // Immediately issues refund without approval!
        return a.processRefund(req)
    }
}
```

**The Better Approach**:
```go
// RIGHT: Human-in-the-loop for sensitive actions
type GuardedAgent struct {
    agent          *Agent
    approvalQueue  *ApprovalQueue
    sensitiveActions map[string]SensitiveConfig
}

type SensitiveConfig struct {
    RequireApproval  bool
    MaxAutoAmount    float64
    CooldownPeriod   time.Duration
}

func (g *GuardedAgent) HandleRequest(ctx context.Context, req Request) Response {
    intent := g.agent.classifyIntent(req)
    action := g.agent.planAction(req, intent)

    // Check if action requires approval
    if config, sensitive := g.sensitiveActions[action.Type]; sensitive {
        if g.requiresApproval(action, config) {
            // Queue for human review
            approval := g.approvalQueue.Submit(ApprovalRequest{
                Action:      action,
                Request:     req,
                Risk:        g.assessRisk(action),
                Explanation: g.agent.explainDecision(),
            })

            return Response{
                Status:  "pending_approval",
                Message: "Your request is being reviewed by our team.",
                TicketID: approval.ID,
            }
        }
    }

    return g.agent.execute(ctx, action)
}

func (g *GuardedAgent) requiresApproval(action Action, config SensitiveConfig) bool {
    // Always require approval above threshold
    if action.Amount > config.MaxAutoAmount {
        return true
    }

    // Check for velocity (multiple requests)
    if g.getRecentActionCount(action.UserID, action.Type, time.Hour) > 3 {
        return true
    }

    // Check for anomalies
    if g.isAnomalous(action) {
        return true
    }

    return config.RequireApproval
}

func (g *GuardedAgent) assessRisk(action Action) RiskLevel {
    score := 0.0

    // High-value actions
    if action.Amount > 100 {
        score += 0.3
    }

    // New users
    if g.getUserAge(action.UserID) < 30*24*time.Hour {
        score += 0.2
    }

    // Unusual patterns
    if g.isOutOfPattern(action) {
        score += 0.3
    }

    switch {
    case score > 0.6:
        return RiskHigh
    case score > 0.3:
        return RiskMedium
    default:
        return RiskLow
    }
}
```

**Key Insight**: Sensitive actions (financial, data deletion, account changes) must require human approval above certain thresholds or when anomalies are detected.

---

### Pitfall 4: No Agent Action Logging

**Scenario**: An agent makes a series of database modifications that corrupt customer data. With no action log, nobody can determine what it did, in what order, or why. Recovery becomes archaeology.

This one is worse for agents than for ordinary services, and the reason is worth internalizing. When a conventional service misbehaves you read the code, because the code is the decision. An agent's decisions were made by a model sampling from a distribution, and they exist nowhere but the trace you captured while it ran. Rerunning the same input does not reproduce them. If you did not log it, the information is not recoverable from anywhere, at any price.

**The Anti-Pattern**:
```go
// WRONG: No logging
func (a *Agent) Execute(action Action) Result {
    return a.tools[action.Tool].Execute(action.Params)
}
```

**The Better Approach**:
```go
// RIGHT: Full action logging
type AuditedAgent struct {
    agent         *Agent
    logger        *ActionLogger
    traceStore    *TraceStore
    maxIterations int
}

// traceKey is an unexported named type used as the context key.
//
// context.WithValue(ctx, "trace_id", id) with a plain string key compiles and
// go vet reports it: string keys live in a single global namespace shared by
// every package in the binary, so any dependency using the same literal
// silently overwrites your value. An unexported type cannot collide, because
// no other package can name it.
type traceKey struct{}

type ActionLog struct {
    TraceID     string
    Timestamp   time.Time
    AgentID     string
    ActionType  string
    Tool        string
    Input       json.RawMessage
    Output      json.RawMessage
    Duration    time.Duration
    Success     bool
    Error       string
    Reasoning   string
    CostUSD     float64
}

func (a *AuditedAgent) Execute(ctx context.Context, task Task) (Result, error) {
    traceID := generateTraceID()
    ctx = context.WithValue(ctx, traceKey{}, traceID)

    // Start trace
    trace := &ExecutionTrace{
        TraceID:   traceID,
        Task:      task,
        StartTime: time.Now(),
        Actions:   make([]ActionLog, 0),
    }

    defer func() {
        trace.EndTime = time.Now()
        a.traceStore.Store(trace)
    }()

    // Bounded, even here. This function is about logging, but an unbounded
    // `for {}` would reintroduce Pitfall 1 two pages after fixing it. Every
    // agent loop in a codebase needs a cap, including the ones whose subject
    // is something else.
    for iteration := 0; iteration < a.maxIterations; iteration++ {
        // Log the decision
        decision, reasoning := a.agent.decide(ctx, task)

        // Execute and log the action
        start := time.Now()
        result, err := a.agent.execute(ctx, decision)

        actionLog := ActionLog{
            TraceID:    traceID,
            Timestamp:  start,
            AgentID:    a.agent.ID,
            ActionType: decision.Type,
            Tool:       decision.Tool,
            Input:      mustMarshal(decision.Params),
            Output:     mustMarshal(result),
            Duration:   time.Since(start),
            Success:    err == nil,
            Error:      errorString(err),
            Reasoning:  reasoning,
        }

        trace.Actions = append(trace.Actions, actionLog)
        a.logger.Log(actionLog)

        if result.Complete || err != nil {
            return result, err
        }

        task = task.WithResult(result)
    }

    return Result{}, fmt.Errorf("max iterations reached (%d)", a.maxIterations)
}

// Replay capability for debugging
func (a *AuditedAgent) Replay(traceID string) error {
    trace, err := a.traceStore.Get(traceID)
    if err != nil {
        return err
    }

    fmt.Printf("Replaying trace %s\n", traceID)
    fmt.Printf("Task: %s\n", trace.Task.Description)

    for i, action := range trace.Actions {
        fmt.Printf("\n[%d] %s - %s\n", i, action.Timestamp.Format(time.RFC3339), action.ActionType)
        fmt.Printf("  Reasoning: %s\n", action.Reasoning)
        fmt.Printf("  Input: %s\n", action.Input)
        fmt.Printf("  Output: %s\n", action.Output)
        if !action.Success {
            fmt.Printf("  Error: %s\n", action.Error)
        }
    }

    return nil
}
```

**Key Insight**: Every agent action must be logged with full context - what, why, inputs, outputs, and timing. This is essential for debugging and compliance.

---

### Pitfall 5: Trusting Agent Output Without Validation

**Scenario**: A code-generation agent reports that it has fixed a security vulnerability. The code it produced introduced a SQL injection instead. Nobody checked, and it shipped.

The trap here is not that the model was wrong. Models are wrong routinely and that is survivable. The trap is that the model was *confident and articulate* about being right, and a fluent explanation of a fix reads exactly like a correct fix. Fluency is not evidence. The agent has no privileged insight into whether its own output works, so its report of success carries no more weight than its code does.

**The Anti-Pattern**:
```go
// WRONG: Trusting agent output blindly
func (a *CodingAgent) FixVulnerability(code string) string {
    prompt := fmt.Sprintf("Fix the security vulnerability in this code:\n%s", code)
    fixed := a.llm.Complete(prompt)
    return fixed // Deploy directly!
}
```

**The Better Approach**:
```go
// RIGHT: Validate agent outputs
type ValidatedCodingAgent struct {
    agent       *CodingAgent
    validators  []CodeValidator
    testRunner  *TestRunner
}

type CodeValidator interface {
    Validate(code string) ([]Issue, error)
}

func (v *ValidatedCodingAgent) FixVulnerability(ctx context.Context, code string) (*FixResult, error) {
    // Generate fix
    proposed := v.agent.generateFix(ctx, code)

    // Validate the fix
    result := &FixResult{
        Original: code,
        Proposed: proposed,
        Valid:    true,
    }

    // Run static analysis
    for _, validator := range v.validators {
        issues, err := validator.Validate(proposed)
        if err != nil {
            return nil, err
        }

        if len(issues) > 0 {
            result.Valid = false
            result.Issues = append(result.Issues, issues...)
        }
    }

    // Check for common vulnerabilities
    vulnCheck := v.checkVulnerabilities(proposed)
    if len(vulnCheck) > 0 {
        result.Valid = false
        result.Vulnerabilities = vulnCheck
    }

    // Run tests
    testResult, err := v.testRunner.Run(proposed)
    if err != nil {
        return nil, err
    }

    if !testResult.AllPassed {
        result.Valid = false
        result.FailedTests = testResult.Failed
    }

    // Diff analysis
    result.Diff = generateDiff(code, proposed)

    // Don't auto-merge if validation failed
    if !result.Valid {
        result.RequiresReview = true
    }

    return result, nil
}

// checkVulnerabilities is a triage heuristic that flags code for human review.
// It is not a security scanner and must not be described as one.
//
// It produces false positives (a Sprintf near the word SELECT is often a log
// line) and false negatives (injection built with + or a strings.Builder sails
// through). That tradeoff is acceptable only because of what the result is
// used for: routing to a reviewer, never gating a merge. Run a real analyzer,
// go vet, and staticcheck for the actual finding.
func (v *ValidatedCodingAgent) checkVulnerabilities(code string) []Vulnerability {
    var vulns []Vulnerability

    // SQL injection patterns
    if strings.Contains(code, "fmt.Sprintf") && strings.Contains(code, "SELECT") {
        vulns = append(vulns, Vulnerability{
            Type:     "POSSIBLE_SQL_INJECTION",
            Severity: "REVIEW",
            Line:     findLineContaining(code, "fmt.Sprintf"),
        })
    }

    // Command execution warrants a look regardless of how it is written.
    if strings.Contains(code, "exec.Command") {
        vulns = append(vulns, Vulnerability{
            Type:     "COMMAND_EXECUTION",
            Severity: "REVIEW",
        })
    }

    return vulns
}
```

**Key Insight**: Agents make mistakes and describe them confidently. Validate outputs with tools that actually execute something (compilers, tests, analyzers) rather than with the model's own account of its work, and require human review for security-relevant changes. Note also that the tests are themselves agent-authored: an agent that writes both the fix and the test that passes it has verified nothing. The test suite must predate the fix or come from someone other than the fixer.

---

### AI Agent Pitfall Quick Reference

| Pitfall | Consequence | Fix |
|---------|-------------|-----|
| Infinite loops | Cost explosion, rate limits | Bounded iterations, circuit breakers |
| Unrestricted tools | Destructive actions | Argv allowlists, no shell, sandboxing |
| No approval flow | Fraud, unauthorized actions | Human-in-the-loop for sensitive ops |
| No action logging | Untraceable decisions | Full audit trail with replay |
| Trusting model output | Bugs, vulnerabilities | Validation, testing, review |
| Trusting tool input | Prompt injection, exfiltration | Treat all tool output as untrusted, enforce limits outside the model |

### Junior → FAANG: Disasters as Learning Opportunities

The "no action logging" pitfall is one that junior engineers often dismiss as optional observability but that becomes the critical failure point in every serious agent incident. When an agent takes an unexpected action (sends an email to the wrong recipient, deletes the wrong record, makes an API call with incorrect parameters), the audit log is the only way to understand what happened. Without it, the incident is undiagnosable and the corrective action is guesswork. Make comprehensive action logging the first feature you implement in any agent project, before any tools or the observe-think-act loop.

The "trusting output" pitfall produces the most subtle failures because the bugs are not immediately visible. An agent that receives a code snippet from its code execution tool and includes it in a response without validation might expose a vulnerability to the user. An agent that receives a SQL query result and uses it as context for the next LLM call without sanitizing it might be susceptible to SQL injection in the reasoning chain. Practice implementing output validation for each of your agent's tools: define the expected output schema, validate the actual output against it, and return a structured error to the LLM when validation fails.

For interview prep, walk through the pitfall table for a specific agent design and explain the mitigation for each. "For the customer support agent, I would prevent infinite loops with a MaxIterations of 8 and a loop detection check. I would prevent cost accumulation with a per-session budget of 50,000 tokens and an automatic termination when the budget is 80% consumed. I would prevent the approval flow gap by requiring explicit customer confirmation for any action that modifies customer account data." This structured pitfall analysis demonstrates production maturity.

### Senior @ FAANG: Disaster Prevention as Platform Architecture

The pitfall table, viewed from a platform engineering perspective, becomes a checklist of platform features. Infinite loop prevention is a platform feature (MaxIterations enforcement). Prompt injection detection is a platform feature (content moderation layer on inputs). Cost accumulation prevention is a platform feature (per-session budget enforcement). No approval flow is a platform feature (human-in-the-loop workflow for tool calls classified as requiring approval). No action logging is a platform feature (mandatory audit logging for every tool call). The goal is to move every pitfall prevention mechanism from individual agent code into platform enforcement so that teams following the default path are automatically protected.

At L6, the pitfall table drives the agent platform's security model. The "prompt injection" row is a security vulnerability, not just a reliability concern. An agent that is vulnerable to prompt injection can be used as an attack vector: a malicious user embeds instructions in content that the agent will retrieve, causing the agent to take actions on behalf of the attacker using the agent's privileged tool access. The security review for every new tool must specifically evaluate prompt injection risk, and the platform must implement content filtering on retrieved content to remove potential injection attempts before they reach the LLM.

---
