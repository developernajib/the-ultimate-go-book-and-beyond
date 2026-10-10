## 118.2 The AI Tool Ecosystem for Developers

Four tools cover almost all serious AI-assisted Go work: Claude Code, GitHub Copilot, Cursor, and calling a model API directly from your own code. They are not competitors so much as different shapes. This section walks each one, then gives you a matrix for choosing between them, and closes on the project context file that makes any of them behave.

> **Pinned to what shipped as of July 2026.** This is the fastest-moving material in the book, and the parts that move fastest are product names, model identifiers, and pricing. Capabilities described below are dated where the date matters. Check each vendor's current documentation before you make a decision on the strength of a paragraph in a book, including this one.

### Claude Code

Claude Code is Anthropic's official CLI for Claude, a terminal-based AI coding assistant designed for serious software engineering work. It also ships as an IDE extension and in desktop and web form, but the CLI is the reference surface and the one this chapter uses.

**What it is**: Unlike chat interfaces, Claude Code is a tool that runs in your terminal, reads your codebase, edits files, runs commands, and iterates on tasks with genuine autonomy. It can read hundreds of files, understand your project's architecture, and make coordinated multi-file changes.

**Key strengths for Go engineers**:

- **Large context window**: Claude's context window allows it to hold entire medium-sized codebases in context simultaneously. For Go projects, this means it can understand package dependencies, interface implementations, and architectural patterns across your codebase before it writes a single line.

- **Strong code reasoning**: Claude does well on tasks involving Go's type system, interface patterns, error handling conventions, and concurrency primitives. "Does well" is the honest ceiling here. It is not a guarantee, it is not verification, and on concurrency in particular it produces confident code that races (Section 118.5 has the specifics). The compiler and `go test -race` are your evidence. The model's fluency is not.

- **Agentic file editing**: Claude Code can edit multiple files in a single task, maintaining consistency across changes. Ask it to refactor a repository pattern across 12 files and it will do it coherently.

- **Terminal integration**: Claude Code runs commands such as `go test`, `go build`, `go vet`, and `golangci-lint`, then iterates on the failures. You can set it on a task and review the result. Note that it asks permission before running commands by default, and that default is load-bearing. Section 118.5 covers why you should not turn it off.

**Installation and basic usage**:

```bash
# Install Claude Code. The native installer is the recommended path and
# self-updates in the background.
curl -fsSL https://claude.ai/install.sh | bash

# Homebrew, WinGet, apt, dnf, and apk packages exist too, as does the npm
# package below. All of them install the same native binary.
npm install -g @anthropic-ai/claude-code

# Start an interactive session in your project directory
cd /your/go/project
claude

# Start a session with an opening prompt
claude "review internal/auth/jwt.go for security issues"

# Run non-interactively and exit, printing the result (-p / --print)
claude -p "review internal/auth/jwt.go for security issues"

# Pipe content in when you want to scope the input explicitly
cat internal/auth/jwt.go | claude -p "review this file for security issues"

# Continue the most recent conversation in this directory (-c / --continue)
claude --continue
```

There is no `--file` flag. Claude Code reads files itself using its own tools, so naming the path in the prompt is the normal way to point it at something. Piping is for when you want to hand it exactly one blob of input and nothing else.
**Core commands in interactive mode**:

```bash
# Inside a claude session:
> review the auth package for security vulnerabilities
> write table-driven tests for the UserService interface
> refactor the database layer to use the repository pattern
> explain how the rate limiter works in pkg/middleware/ratelimit.go
> find all places where we're not handling errors and fix them
```

**When to use Claude Code vs other tools**:
- Large context tasks, reading and editing multiple files: Claude Code
- Quick inline completion while typing: Copilot
- Full IDE experience with AI: Cursor
- One-off or batch generation from your own code: the provider API directly

The rest of this section takes those three alternatives in turn.

---
### GitHub Copilot

GitHub Copilot pioneered AI-assisted coding and remains the most widely deployed AI coding tool in enterprise environments.

**Three Modes**:

**Inline Completion**: Copilot suggests code as you type, appearing as gray ghost text. This is Copilot's strongest mode: low latency, highly context-aware within the file, and good at completing patterns it recognizes.

```go
// Type this:
func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*User, error) {
    // Copilot will suggest the entire implementation
    // based on your existing repository methods
}
```
**Copilot Chat**: Conversational AI inside your IDE. Ask questions about code, request refactors, get explanations.

**Copilot Agent Mode**: Copilot decides which files to change, makes the edits across all of them, runs terminal commands, reads the output, and iterates on failures, in the same shape as Claude Code but driven from inside the editor. Multi-file editing reached general availability in February 2025 and agent mode is available in both the VS Code and JetBrains families.

**Copilot for Go, where it excels**:
- Completing repetitive patterns (repository methods, handler functions, test cases)
- Generating table-driven tests when you've written one test case as an example
- Writing documentation comments (godoc format)
- Implementing obvious interface methods

**Where Copilot struggles**:
- Complex domain logic that requires understanding your business
- Correct concurrency patterns in non-trivial cases
- Security-sensitive code (always review)
- Large multi-file architectural changes

**Copilot coding agent**: GitHub's longer-horizon mode, where you assign an issue and the agent plans, implements, and opens a PR for review. It has been generally available since September 2025. Useful for well-defined tasks on well-documented codebases. (This is the successor to Copilot Workspace, the technical preview that introduced the idea and was sunset on May 30, 2025. If you find tutorials referencing Workspace, they predate the change.)

---
### Cursor

Cursor is an AI-first IDE built on VS Code. If you currently use VS Code, Cursor is close to a drop-in replacement: your keybindings, themes, and most extensions carry over. The gap worth knowing about before you switch is the extension marketplace. Cursor is a fork, so it cannot use Microsoft's VS Code Marketplace and pulls from Open VSX instead, and Microsoft's proprietary extensions do not run on it. For Go work this is rarely a blocker, since the Go extension and gopls are open source, but check any extension your team depends on before you commit to the move.

**Key differentiators from VS Code + Copilot**:

- **Multi-file agent editing** (Cmd+I / Ctrl+I): one instruction, a coordinated change across files. It reads the relevant files, works out the pattern, and applies the change in one pass. Ask it to "add a new endpoint that follows the pattern of the existing handlers" and it reads the existing handlers, understands the pattern, and creates the new one correctly. This panel was called Composer for most of Cursor's life. Cursor 2.0 reused the name for its own in-house model in October 2025, so "Composer" in a tutorial may mean the panel or the model depending on when it was written. Check the date.

- **Codebase indexing**: Cursor indexes your entire codebase and uses this index for all suggestions. Even in a large monorepo, Cursor knows where to find things.

- **Chat with codebase context**: `@codebase` in Cursor chat searches your indexed codebase. `@file` references a specific file, `@folder` a subdirectory, and `@docs` queries indexed official documentation.

**Cursor Rules** (`.cursor/rules/*.mdc`): Cursor's equivalent of CLAUDE.md, and the same concept of project-specific instructions that shape AI behavior. Rules live in a directory rather than one file, each with YAML frontmatter (`description`, `globs`, `alwaysApply`) that controls when it loads, so a rule about test conventions can be scoped to `*_test.go` instead of burning context on every request. The older single `.cursorrules` file in the project root is deprecated, and you will still see it in most tutorials. Keep `alwaysApply: true` to one or two rules, because every always-applied rule is injected into every request whether or not it is relevant, and that budget comes out of your working context.

```markdown
---
description: Go conventions for this REST API
globs: ["**/*.go"]
alwaysApply: true
---

You are working on a Go 1.27 REST API.

When writing Go code:
- Always propagate context.Context as the first argument
- Use errors.Is/errors.As, never string comparison on errors
- Wrap errors with fmt.Errorf("context: %w", err)
- Use slog for all logging
- Never use global state outside of main
- All exported functions must have godoc comments

When writing tests:
- Use table-driven tests
- Use testify/assert for assertions
- Mock interfaces with testify/mock
- Test names follow: TestFunctionName_Scenario_ExpectedBehavior
```
**Best for**: Engineers who want full IDE features plus AI, rapid prototyping, UI work, and anyone who prefers a GUI over terminal tools.

---
### Calling a Model API Directly

The OpenAI and Anthropic APIs give you programmatic access to the same models that power the interactive tools. The example below uses OpenAI's Go SDK, but the shape is the same either way. Note that model identifiers are the fastest-moving detail in this entire chapter, so check the provider's current model list rather than copying an ID out of a book. The example takes its own advice and reads the model from the environment rather than hard-coding a constant, which is also what you want in a tool that outlives one model generation.

**When to use the API directly**:
- Building custom tooling (code review bots, documentation generators)
- Batch processing (analyzing hundreds of files)
- Integration into CI/CD pipelines
- When you need fine-grained control over temperature, system prompts, and model selection

**Example: Custom Go code review tool**:

````go
package main

import (
    "context"
    "fmt"
    "os"

    "github.com/openai/openai-go"
    "github.com/openai/openai-go/option"
)

// CodeReviewer wraps the OpenAI API for Go-specific code review.
type CodeReviewer struct {
    client openai.Client
    model  string
}

// NewCodeReviewer creates a new code reviewer. The model is configuration,
// not a constant: provider model IDs are retired on the provider's schedule,
// not yours.
func NewCodeReviewer(apiKey, model string) *CodeReviewer {
    return &CodeReviewer{
        client: openai.NewClient(option.WithAPIKey(apiKey)),
        model:  model,
    }
}

// ReviewFile asks the model to review a Go file and returns its notes.
func (r *CodeReviewer) ReviewFile(ctx context.Context, filename, content string) (string, error) {
    const systemPrompt = `You are a Go security and code quality expert.
Review the provided Go code for:
1. Security vulnerabilities (injection, auth flaws, crypto misuse)
2. Concurrency issues (race conditions, goroutine leaks, deadlocks)
3. Error handling issues (swallowed errors, missing error checks)
4. Go anti-patterns (improper interface use, global state, panic misuse)

Format your response as a numbered list.
Be specific: cite line numbers and explain why each issue is a problem.
If you are unsure whether something is a bug, say so rather than guessing.`

    resp, err := r.client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
        Model: r.model,
        Messages: []openai.ChatCompletionMessageParamUnion{
            openai.SystemMessage(systemPrompt),
            openai.UserMessage(fmt.Sprintf("File: %s\n\n```go\n%s\n```", filename, content)),
        },
        Temperature: openai.Float(0.1), // Low temperature for consistent analysis
    })
    if err != nil {
        return "", fmt.Errorf("reviewing file %s: %w", filename, err)
    }

    if len(resp.Choices) == 0 {
        return "", fmt.Errorf("reviewing file %s: model returned no choices", filename)
    }

    return resp.Choices[0].Message.Content, nil
}

func main() {
    apiKey := os.Getenv("OPENAI_API_KEY")
    if apiKey == "" {
        fmt.Fprintln(os.Stderr, "OPENAI_API_KEY not set")
        os.Exit(1)
    }

    model := os.Getenv("OPENAI_MODEL")
    if model == "" {
        fmt.Fprintln(os.Stderr, "OPENAI_MODEL not set: see the provider's current model list")
        os.Exit(1)
    }

    if len(os.Args) < 2 {
        fmt.Fprintln(os.Stderr, "usage: review <file.go>")
        os.Exit(1)
    }

    content, err := os.ReadFile(os.Args[1])
    if err != nil {
        fmt.Fprintf(os.Stderr, "reading file: %v\n", err)
        os.Exit(1)
    }

    reviewer := NewCodeReviewer(apiKey, model)
    review, err := reviewer.ReviewFile(context.Background(), os.Args[1], string(content))
    if err != nil {
        fmt.Fprintf(os.Stderr, "review failed: %v\n", err)
        os.Exit(1)
    }

    fmt.Println(review)
}
````
---
### Choosing the Right Tool: Decision Matrix

| Task | Best Tool | Why |
|------|-----------|-----|
| Inline completion while typing | GitHub Copilot | Lowest latency, IDE-integrated |
| Multi-file refactoring | Claude Code or Cursor's agent | Large context, coordinated edits |
| Understanding an unfamiliar codebase | Claude Code | Large context window, can read entire codebase |
| Quick function generation | Copilot Chat or Cursor Chat | Fast, IDE-integrated |
| Security review of a file | Claude Code or API | Thoroughness matters more than speed |
| Generating tests for an interface | Copilot or Cursor | Repetitive pattern, fast turnaround |
| Architecture brainstorming | Claude (web or CLI) | Conversational, holds a long thread |
| Custom CI/CD integration | OpenAI/Anthropic API | Programmatic control |
| Rapid UI prototyping | Cursor | IDE features + AI for visual work |
| Reading documentation + coding | Cursor (@docs feature) | Direct doc integration |

**Context window: how to think about it**

Published context numbers move every few months, so any table printed in a book is wrong by the time you read it. Check the provider's current documentation. What does not change is the arithmetic, and the arithmetic is worth internalizing because it is routinely misstated.

Go source runs very roughly 8 to 12 tokens per line, so a 200K-token window holds on the order of 20,000 lines, not the 100,000-plus that gets claimed. That is a substantial Go service, but it is not a monorepo. A million-token window moves the ceiling to roughly 100,000 lines, which changes what is possible without changing the underlying rule: context is a budget, and every token of vendored dependency you pour in is a token not spent on your own code.

The architectural split matters more than the raw number. Full-context tools (Claude Code) can be handed a large slice of the codebase directly and reason across it in one pass, which is what you want for a security audit or a refactor touching thirty interconnected files. Retrieval-based tools (Cursor's indexing, Copilot's file context) fetch what looks relevant on demand, which is faster and cheaper and entirely sufficient when you are writing one more handler that follows an existing pattern. Neither is better. They fail differently: full context runs out of budget, and retrieval fetches the wrong thing and does not tell you.

---

### CLAUDE.md: The Project Context File

Whichever tool you land on, the single most useful thing you do next is the same, and it is not prompting. It is writing down what the tool cannot infer from the code. Every tool in this section has a version of this file. Cursor calls it a rule, Copilot calls it a custom instruction, and Claude Code calls it CLAUDE.md. The rest of this section works through the Claude Code form, because the content is what matters and it ports.

CLAUDE.md is the most important file you will create for AI-assisted development. It lives at the root of your repository and is loaded automatically at the start of a session, so it is where you put the things a new contributor would otherwise have to learn by getting them wrong first:

```markdown
# Project Context

Payments ledger service. Go 1.27, PostgreSQL 16, no ORM.

## Conventions
- Errors wrap with %w and are never logged and returned at the same layer.
- All money is `decimal.Decimal` cents. Never float64.
- Handlers stay thin: validation, call service, map error to status.

## Constraints
- Every query goes through pgx with parameterized args. Never fmt.Sprintf a query.
- New dependencies need an ADR before use.

## Commands
- Test: `make test` (runs `go test -race ./...`)
- Lint: `make lint` (golangci-lint)
```

Keep it short and specific. A CLAUDE.md that restates general Go style wastes context on things the model already knows. A CLAUDE.md that says "money is always `decimal.Decimal` cents, never float64" prevents a class of bug the model would otherwise reintroduce every session. Section 118.8 covers how to build one properly.

A realistic example runs longer than the sketch above, and the sections that follow walk one for a B2B SaaS API, one heading at a time.

### Junior → FAANG: Mastering the AI Tool Ecosystem Early

The distinction between chat-based AI tools and agentic AI tools like Claude Code is the most important concept to internalize early in your AI-assisted engineering career. Chat tools require you to copy-paste code into a browser window, provide context manually in each message, and apply suggested edits by hand. Agentic tools read your actual files, run your actual tests, and edit your actual codebase. The quality of the result is dramatically higher with agentic tools because the AI has real context instead of context you remembered to include. Every junior engineer at a FAANG-level company is expected to use agentic tools fluently, not as an occasional experiment.

The decision matrix in this section is a concrete artifact for interview conversations about developer productivity and tooling choices. FAANG interviews for senior engineering roles frequently ask: "how do you approach tool selection for your team?" or "what is your development workflow?" Having a structured answer based on task type (inline completion vs. multi-file refactoring vs. security review vs. architecture brainstorming) versus tool capability (context window size, IDE integration, programmatic control) demonstrates systematic thinking rather than personal preference.

The full-context versus retrieval distinction is the part worth understanding for Go work. A large-context tool can hold a medium-sized Go service (packages, tests, migrations) at once, which lets it spot a pattern inconsistency across fifty files in a single pass. A retrieval-based tool has to be pointed at the files first, which means you have to already suspect where the problem is. Knowing when this full-context capability matters (large refactors, security audits, understanding complex dependencies) versus when retrieval is sufficient (implementing a new function that follows an existing pattern) is tool literacy that junior engineers develop through practice.

The custom code review tool example in Go is a portfolio artifact. Building a production-quality version of this tool for a Go project (with structured output, rate limiting, batch processing across a repository, and integration into a GitHub Actions workflow) is the kind of side project that demonstrates both Go proficiency and AI engineering capability simultaneously. Practice extending the example in three steps. Add a severity classifier that rates each finding as critical, high, medium, or low. Add a deduplication step that removes findings the codebase already handles correctly based on existing test coverage. Add a reporting format that produces a markdown summary suitable for a PR comment.

For interview preparation at FAANG, be ready to describe your AI-assisted workflow concretely. Interviewers at AI-forward companies now ask about tool usage as part of engineering productivity assessment. Practice answering: "I use Claude Code for initial implementations of new features. I provide the interface definition and the test cases first, then ask it to implement. I review the implementation for correctness, security, and architectural fit. On average, the first implementation requires one or two revision cycles before it meets the project standard." This workflow description signals that you use AI as a force multiplier while maintaining engineering judgment, which is what FAANG interviewers are looking for.

### Senior @ FAANG: Tool Ecosystem Strategy for Engineering Organizations

At senior level, the AI tool ecosystem decision is an organizational strategy question, not an individual workflow question. Which tools does the organization standardize on? What is the approval process for new tools given that AI tools have access to source code and may transmit it to third-party providers? What is the security review requirement for agentic tools that can execute shell commands in the developer environment? How do you measure whether AI tool adoption is increasing engineering velocity at the team level? These questions require policy decisions that staff engineers are expected to drive.

The decision matrix is also the starting point for a tool strategy that includes cost management, and the cost model is no longer the simple thing it was. Both major tools now bill a per-seat subscription plus metered usage on top of it, so "Copilot is per seat and Claude Code is per token" is a distinction that has stopped being true. GitHub replaced Copilot's premium request quota with token-metered AI credits on June 1, 2026, and Claude Code is sold both as a seat subscription with usage limits and as pay-as-you-go API billing, with enterprise seats metering tokens on top of the seat fee. Custom API integrations in CI/CD pipelines add usage-based costs that scale with repository activity. A 50-engineer team using multiple AI tools simultaneously generates significant monthly spend that must be tracked, attributed, and justified. The senior engineer's role includes modeling the cost of AI tool adoption against the productivity gains and presenting the business case to engineering leadership. Model that cost against your team's actual token consumption rather than against list prices, because the seat fee is now the floor and not the bill.

Context size has cost implications beyond the technical, because you pay per token and a bigger context means a bigger bill on every request. A task that requires 100K tokens of context using Claude Code costs proportionally more than the same task using a retrieval-based tool with 10K of effective context. For tasks where retrieval-based context is sufficient (implementing a new endpoint that follows an existing pattern), using the smaller-context tool is the correct cost optimization. For tasks where full-context reasoning is required (security audit of a complex authentication flow, refactoring that touches 30 interconnected files), the larger-context tool is the correct choice. Developing team guidelines that match task type to tool based on both capability and cost is a staff-level platform engineering contribution.

The tool ecosystem evaluation framework for senior engineers covers: data privacy (does the tool transmit source code to third-party servers, and is that acceptable under the organization's data classification policy?), security surface (can the tool execute arbitrary commands, and what are the guardrails?), measurement (how do you measure the tool's effect on PR throughput, defect rates, and time-to-merge?), and integration (does the tool integrate with the existing IDE, CI/CD pipeline, and code review workflow, or does it require workflow changes that increase adoption friction?). Completing this evaluation for each candidate tool and documenting the results in an ADR is the responsible way to make organizational tool adoption decisions at senior level.

The custom CI/CD integration pattern (the code reviewer example) scales to an organizational AI platform that provides standardized AI capabilities to all development teams. Instead of each team building its own integration, a platform team maintains a shared code review API, a documentation generation service, and a test generation service, all backed by AI models with organizational prompt templates, rate limiting, cost attribution, and audit logging. This is the platform engineering vision for AI-assisted development at FAANG scale: individual tools for interactive use, shared platform services for automated workflows.
