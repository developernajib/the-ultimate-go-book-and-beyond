### CLAUDE.md Specification: Approved Dependencies

The approved-dependency list closes the context file, and it is the section that stops an assistant from inventing imports:

```markdown
## Dependencies (approved)
- github.com/go-chi/chi/v5
- github.com/jackc/pgx/v5
- github.com/redis/go-redis/v9
- github.com/stretchr/testify
- google.golang.org/grpc
```

### Configuring Custom Workflows

Build scripts that chain AI into your development workflow. The pattern is: gather context from git, CI, and code analysis, then send it to an LLM for synthesis.

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"
)

// LLMClient abstracts the language model interface.
type LLMClient interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

// AnthropicClient implements LLMClient for Anthropic Claude.
type AnthropicClient struct {
	apiKey string
	model  string
}

// NewAnthropicClient constructs a new Anthropic Claude client.
func NewAnthropicClient(apiKey, model string) *AnthropicClient {
	return &AnthropicClient{apiKey: apiKey, model: model}
}

// Complete sends a prompt to the model (in production, via Messages API HTTP POST).
func (c *AnthropicClient) Complete(ctx context.Context, prompt string) (string, error) {
	_ = ctx
	return fmt.Sprintf("AI Briefing (%s):\n- Key commits processed\n- No failing CI runs", c.model), nil
}

// WorkflowStep represents one step in an AI-augmented workflow.
type WorkflowStep struct {
	Name    string
	Command string
	Args    []string
}

// MorningBriefing gathers project state and asks AI for a prioritized summary.
func MorningBriefing(ctx context.Context, llm LLMClient, projectDir string) error {
	steps := []WorkflowStep{
		{"Recent Commits", "git", []string{"-C", projectDir, "log", "--since=yesterday", "--oneline", "--all"}},
		{"Open PRs", "gh", []string{"pr", "list", "--state=open", "--json=number,title,updatedAt"}},
		{"CI Status", "gh", []string{"run", "list", "--limit=5", "--json=status,conclusion,name"}},
	}

	var parts []string
	for _, step := range steps {
		cmd := exec.CommandContext(ctx, step.Command, step.Args...)
		cmd.Dir = projectDir
		out, err := cmd.Output()
		if err != nil {
			parts = append(parts, fmt.Sprintf("## %s\n(failed: %v)", step.Name, err))
			continue
		}
		parts = append(parts, fmt.Sprintf("## %s\n%s", step.Name, string(out)))
	}

	prompt := fmt.Sprintf(`Morning briefing for my Go project. Summarize:
1. What happened yesterday (key commits)
2. What needs attention today (open PRs, failing CI)
3. Suggested priorities for today

Data:
%s

Keep it concise: bullet points only.`, strings.Join(parts, "\n\n"))

	briefing, err := llm.Complete(ctx, prompt)
	if err != nil {
		return fmt.Errorf("AI briefing: %w", err)
	}

	fmt.Println("\n========== MORNING BRIEFING ==========")
	fmt.Println(briefing)
	fmt.Println("=======================================")
	return nil
}

func main() {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		slog.Error("ANTHROPIC_API_KEY not set")
		os.Exit(1)
	}

	projectDir := "."
	if len(os.Args) > 1 {
		projectDir = os.Args[1]
	}

	// Model IDs are aliases and are complete as written: do not append a date
	// suffix. "claude-sonnet-4-20250514" is a dated snapshot of a superseded
	// model, and pinning one in an example guarantees the example rots. Read
	// the model from configuration in real code so it can change without a
	// deploy, and check the provider's current model list rather than any
	// book's.
	model := os.Getenv("BRIEFING_MODEL")
	if model == "" {
		model = "claude-sonnet-5"
	}
	llm := NewAnthropicClient(apiKey, model)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if err := MorningBriefing(ctx, llm, projectDir); err != nil {
		slog.Error("briefing failed", "error", err)
		os.Exit(1)
	}
}
```

### Measuring Your AI-Augmented Productivity

A weekly snapshot of your own workflow. Read the commentary after the struct before you act on any of it:

```go
package productivity

import "time"

// DailyMetrics tracks productivity indicators for an AI-augmented workflow.
type DailyMetrics struct {
	Date             time.Time `json:"date"`
	LinesWritten     int       `json:"lines_written"`
	LinesAIGenerated int       `json:"lines_ai_generated"`
	TestsWritten     int       `json:"tests_written"`
	BugsFoundReview  int       `json:"bugs_found_in_review"`
	AIPrompts        int       `json:"ai_prompts_sent"`
	AIPromptsUseful  int       `json:"ai_prompts_useful"`
	TimeDesignMin    int       `json:"time_design_minutes"`
	TimeCodingMin    int       `json:"time_coding_minutes"`
	TimeReviewMin    int       `json:"time_review_minutes"`
}
```

What these fields let you compute, and what each is actually worth:

1. **Prompt Efficiency** = Useful Prompts / Total Prompts. Useful as a *trend for you*, meaningless as an absolute. There is no published threshold, and an earlier version of this section asserted two ("below 50% you're wasting time, above 80% you've reached peak efficiency") that were simply invented. A falling ratio is a signal worth investigating. A number is not a grade.

2. **Design Time Ratio** = Design Minutes / Total Work Minutes. This should *increase* with AI adoption, because that is the entire claimed mechanism: time moving out of typing and into thinking. If it is not increasing, the tool is not doing what the pitch says it does, and that is worth knowing.

3. **Review Catch Rate** = Bugs Found / 1000 Lines Reviewed. Measures whether review is catching real issues. Watch this one closely as AI-generated volume rises: if the rate collapses, the likely explanation is not that the code got better but that reviewers stopped reading carefully.

4. **Test Density** = Tests Written / Lines Written. Should increase, because AI makes drafting tests cheap. Pair it with something that measures whether the tests are any good, since density counts tests that assert nothing exactly the same as tests that catch bugs.

Note what is deliberately not on this list: **AI Contribution %** (AI-generated lines over total lines). It is the most tempting metric here and the most actively harmful. It measures typing, which was never the bottleneck - it rewards accepting more generated code, which is the behaviour you least want to incentivise, and it trends the wrong way when an engineer correctly decides to write twelve careful lines instead of accepting forty. A team that manages this number will hit it.

> **Pro Tip**: Treat every one of these as a trend line for a single person or team over time, never as a benchmark to compare people against or a target to hit. The moment a ratio becomes a goal, it stops measuring anything: the fastest way to a high prompt-efficiency score is to only ask easy questions. And remember the finding from this chapter's introduction, which is the reason to instrument any of this at all: developers in a controlled trial believed AI made them 20% faster while measurably running 19% slower. Your intuition about your own velocity is the one instrument here you know to be unreliable.

---

### Junior → FAANG: Approved Dependency List and Custom Workflows as Portfolio Material

The approved dependency list (chi, pgx, go-redis, testify, grpc) is the technology stack declaration that answers "what are the key libraries in your Go services?" in a FAANG interview. Knowing the rationale for each library (not just what it does but why it was chosen over alternatives) is the interview depth that distinguishes engineers who made deliberate technology choices from those who use whatever was in the project they joined.

The morning briefing workflow is a concrete example of AI-powered developer tooling that can be demonstrated in a FAANG interview as a side project. The implementation uses standard Go patterns (context, exec.CommandContext, structured logging) to chain git, GitHub CLI, and CI status data into an AI-synthesized daily briefing. Extending this to a team tool (configurable for each project, distributed as a CLI binary, with team-specific data sources) is a portfolio-quality side project that demonstrates Go engineering, AI integration, and developer experience thinking simultaneously.

The productivity metrics (prompt efficiency, design time ratio, review catch rate, test density) are a measurement framework for your own work. Tracked over a quarter, they produce the before-and-after comparison that performance reviews want when they ask you to "describe the impact of your work", and an engineer who can point at a measured shift in how their time is spent is making a stronger case than one describing a feeling.

Two cautions, because this is where the temptation to embellish is strongest. Measure your own trend and report it as such: a number from your own instrumentation of your own work is evidence, and the same number quoted as an industry benchmark is not. And do not reach for AI contribution percentage, however good the number looks. It measures lines, lines measure typing, and typing was never the constraint. If an interviewer asks how much of your code AI writes, the more impressive answer is about what you verify and what you refuse to delegate.

### Senior @ FAANG: Custom Workflows as Team Engineering Platform

At senior level, the custom workflow infrastructure (the morning briefing pattern, the productivity metrics framework) is the foundation for an engineering intelligence platform. An organization-wide version of the morning briefing, configurable per team and integrated with Jira, GitHub, and PagerDuty, is a platform tool that gives engineering managers real-time visibility into team productivity and project health without manual reporting. The productivity metrics, aggregated across the team and visualized in a dashboard, provide the data for engineering leadership discussions about AI tool ROI.

The approved dependency list governance (who decides which libraries are approved, how new libraries go through the approval process, what the security review requirements are for new libraries) is a staff engineer responsibility at FAANG. Without approval governance, teams independently adopt libraries that have security vulnerabilities, licensing conflicts, or operational incompatibilities. With approval governance (a platform team maintains the approved list, new library requests go through a review process, approved libraries are kept updated by the platform team), the organization maintains security and operational control over its Go dependency ecosystem while enabling teams to adopt the libraries they need.
