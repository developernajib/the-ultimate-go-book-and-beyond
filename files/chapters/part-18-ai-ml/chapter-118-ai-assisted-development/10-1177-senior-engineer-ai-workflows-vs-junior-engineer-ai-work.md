## 118.7 Senior Engineer AI Workflows vs Junior Engineer AI Workflows

### The Intern/Junior Workflow (Anti-Pattern)

This is the workflow that leads to production incidents, security breaches, and unmaintainable codebases. It is unfortunately the most common pattern among engineers new to AI tools.

**Phase 1: Request**
"Write me a REST API with user authentication, CRUD operations, and JWT tokens in Go."

**Phase 2: Accept**
Paste the 500-line output into `main.go`. It compiles. Ship it.

**Phase 3: Debug by prompting**
It fails in production. Paste the error into AI. Paste the fix back. Repeat.

**Phase 4: Technical debt accumulates**
Six months later: nobody understands why the code is structured this way. There are no tests. The JWT implementation has a known vulnerability. The database queries have N+1 problems. Adding a new feature requires rewriting half the codebase.

The intern/junior pattern treats AI as a magic box that produces code. The output is not understood, not tested, and not owned. This is the root cause of most AI-assisted development failures.

### The Mid-Level Workflow

The mid-level engineer uses AI for specific functions rather than entire systems. They read what AI generates. They add some tests.

**Pattern**:
1. Design roughly: "I need a user service with these methods"
2. Use AI to implement each method
3. Read the output before committing
4. Add basic tests
5. Submit PR

This is better. The engineer understands the individual pieces. But they often don't challenge the abstractions, miss security implications, and don't push AI to match their existing patterns.

### The Senior Engineer Workflow

The senior engineer's AI workflow is fundamentally different in its starting point:

**Before writing any code**:
1. Design the interfaces. On paper, in a doc, wherever. The interfaces are the contract.
2. Write the test contracts (or have AI generate them, then review carefully).
3. Only then: use AI to implement against the contracts.

**During implementation**:
- AI handles boilerplate (error messages, validation, documentation, test tables)
- Engineer handles: design decisions, domain logic, security-sensitive code
- Every AI output goes through the review checklist (section 118.4)

**After implementation**:
- Run the full test suite with `-race`
- Run `govulncheck ./...`
- Run AI critique prompt on the diff
- Write PR description (AI helps)
- Add architectural notes to CLAUDE.md if patterns changed

**How seniors multiply their impact with AI**:

```go
// Senior engineer task: design the abstraction. This part is the job.
type NotificationService interface {
    Send(ctx context.Context, notification Notification) error
    SendBatch(ctx context.Context, notifications []Notification) []error
    GetDeliveryStatus(ctx context.Context, id string) (DeliveryStatus, error)
}

type Notification struct {
    ID        string
    Recipient Recipient
    Template  string
    Variables map[string]string
    Priority  Priority
}
```
Then to AI: "Implement the EmailNotificationService and SMSNotificationService structs satisfying this interface. Use the existing patterns in pkg/notification/. Generate tests for both."

The AI expresses those decisions in code. The engineer moves on to the next decision, then reviews what came back against the contract they wrote.

### The Staff/Principal Workflow

At staff level, the leverage point shifts from individual productivity to team productivity:

**Organization-wide tooling**:

```go
// Staff engineer builds internal tools powered by AI
// Example: internal code review bot that knows your conventions

package main

import (
    "context"
    "fmt"

    anthropic "github.com/anthropics/anthropic-sdk-go"
)

type InternalReviewBot struct {
    client    anthropic.Client
    standards string // loaded from internal standards doc
    patterns  string // loaded from CLAUDE.md
}

func (b *InternalReviewBot) ReviewPR(ctx context.Context, diff string) (ReviewResult, error) {
    systemPrompt := fmt.Sprintf(`You are a code reviewer for our engineering team.
Our standards:
%s

Our patterns:
%s

Review the diff for violations of these standards.
Be specific. Cite file and line. Distinguish BLOCKING from ADVISORY.
Report findings you are unsure about, marked as such, rather than staying silent.`,
        b.standards, b.patterns)

    msg, err := b.client.Messages.New(ctx, anthropic.MessageNewParams{
        Model:     anthropic.ModelClaudeOpus4_8,
        MaxTokens: 4096,
        System: []anthropic.TextBlockParam{
            {Text: systemPrompt},
        },
        Messages: []anthropic.MessageParam{
            anthropic.NewUserMessage(anthropic.NewTextBlock(diff)),
        },
    })
    if err != nil {
        return ReviewResult{}, fmt.Errorf("calling claude: %w", err)
    }

    // parse response into structured ReviewResult
    return parseReviewResult(msg.Content), nil
}
```

Two things to note about that snippet, because both are easy to get wrong. `anthropic.NewClient()` returns a value, not a pointer, so the field is `anthropic.Client`. And the model identifier will be stale by the time you read this: check the provider's current model list rather than trusting a constant printed in a book. This bot supplements human review and gates nothing on its own. It is a linter with better prose, not an approver.

**Custom MCP servers for internal systems**:

Staff engineers build MCP servers that give Claude Code access to internal tools. Note that every item below is a read of data someone else wrote, which makes all of it untrusted input (Section 118.2): scope these servers read-only and assume an attacker can put text in any field the agent will read.
- Internal service registry: Claude Code can look up service owners, runbooks
- Internal documentation: Claude Code can reference internal standards
- Production metrics: Claude Code can see current error rates when debugging
- Incident system: Claude Code can reference recent incidents when diagnosing bugs

**Evaluating AI tools for team adoption**:

Staff engineers run structured evaluations of AI tools before org-wide adoption:
- Benchmark on internal codebase samples
- Test on security-sensitive code patterns
- Measure actual developer productivity (not self-reported)
- Evaluate data security and privacy implications
- Cost modeling at team scale

---

### Junior → FAANG: Closing the Gap Between Junior and Senior AI Workflows

The senior engineer AI workflow described in this section is the target workflow for engineers who want to advance beyond L4 at FAANG. The key differences are not about which tools to use but about what you bring to the interaction: strong foundations that let you verify output, interface design skills that let you specify before generating, architectural judgment that lets you reject locally correct but globally wrong suggestions, and security knowledge that lets you catch the vulnerabilities that AI generates without flagging them.

The fastest path to closing this gap is structured, deliberate practice. For each task where you use AI, practice the pre-generation step (define the interface, write the test cases, specify the error handling contract) before asking the AI to generate. This forces you to think through the design before seeing AI output, which prevents the "accept the first plausible suggestion" trap that junior engineers fall into. After generation, practice the systematic review checklist rather than skimming for obvious errors. After merging, practice the retrospective: did the AI generate what you expected? Where did it diverge from your design intent? What context would have prevented the divergence?

The tool selection assessment listed at the end (evaluating data security, privacy implications, cost modeling at team scale) is L5 work. Taking on this responsibility, even informally, is one of the concrete ways to demonstrate readiness for L5 promotion. Volunteer to assess a new AI tool, write up the evaluation framework, and present the findings to the team. This visible, high-impact work demonstrates the scope expansion that FAANG promotion committees look for in L4-to-L5 candidates.

### Senior @ FAANG: Institutionalizing the Senior AI Workflow

At senior level, the goal is not to have one senior engineer using the sophisticated AI workflow while others use the anti-pattern. The goal is to make the senior workflow the default for the entire team through tooling, process, and culture. Tooling: code coverage gates enforce "write tests before merging". Pre-commit hooks enforce formatting and linting. CI pipelines enforce security scanning. These automate the quality checks that senior engineers apply manually. Process: requiring a design document or interface specification before implementation begins enforces the "specify before generating" step. Code review culture: establishing the expectation that every PR reviewer checks error handling, nil safety, and security patterns makes the review checklist a team standard rather than a personal habit.

The "cost modeling at team scale" item in the senior responsibilities list deserves dedicated attention. The cost of AI-assisted development at team scale is not just the per-seat license cost. It includes: the LLM API cost for custom tools and CI/CD integrations, the engineering time cost of reviewing AI-generated code (if reviews are slower because of AI output quality, the tool costs more in engineer time than it saves), and the incident cost of AI-generated bugs that reach production (if the review process is not rigorous enough, AI tools increase the defect rate rather than decreasing it). Building a complete cost model that accounts for all three components, and comparing it to the productivity gains, is the financial analysis that justifies or challenges continued AI tool investment at engineering leadership level.
