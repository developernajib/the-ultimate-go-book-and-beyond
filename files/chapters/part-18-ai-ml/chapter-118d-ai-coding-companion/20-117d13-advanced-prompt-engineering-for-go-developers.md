## 118D.13 Advanced Prompt Engineering for Go Developers

### Chain-of-Thought Prompting for Complex Problems

Chain-of-thought (CoT) prompting asks the AI to show its reasoning step by step. For Go problems, this produces dramatically better results on complex tasks.

**Template: Chain-of-Thought Prompt**

```
Solve this step by step, showing your reasoning at each stage:

[Problem description]

Think through:
1. What are the inputs and expected outputs?
2. What edge cases exist?
3. What data structures are most appropriate?
4. What is the time and space complexity of your approach?
5. Are there concurrency considerations?
6. What error conditions need handling?

Then write the implementation.
```

### Few-Shot Prompting with Go Code Examples

Few-shot prompting provides examples of the pattern you want AI to follow. This is extremely effective for enforcing project-specific conventions.

**Template: Few-Shot with Go Conventions**

````
Here's how we write repository methods in this project:

Example 1:

```go
// GetUser retrieves a user by ID. Returns ErrNotFound if the user
// does not exist.
func (r *UserRepo) GetUser(ctx context.Context, id int64) (*User, error) {
    var user User
    err := r.db.QueryRow(ctx,
        "SELECT id, name, email, created_at FROM users WHERE id = $1", id).
        Scan(&user.ID, &user.Name, &user.Email, &user.CreatedAt)
    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("get user %d: %w", id, err)
    }
    return &user, nil
}
```

Example 2:
```go
// ListUsers retrieves all users matching the given filter.
func (r *UserRepo) ListUsers(ctx context.Context, filter UserFilter) ([]User, error) {
    query, args := filter.BuildQuery()
    rows, err := r.db.Query(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("list users: %w", err)
    }
    defer rows.Close()

    var users []User
    for rows.Next() {
        var u User
        if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.CreatedAt); err != nil {
            return nil, fmt.Errorf("scan user: %w", err)
        }
        users = append(users, u)
    }
    return users, rows.Err()
}
```

Now write the following methods in the EXACT same style:
[describe the methods you need]
````

### System Prompts That Enforce Go Best Practices

When calling a provider API directly, the system prompt sets the baseline behaviour for every subsequent turn. It is the right place for standards that should apply to all output, rather than repeating them in each request.

```go
package prompts

// GoExpertSystemPrompt returns a system prompt that enforces Go best practices
// in all AI responses. Use this as the system message when calling the API.
func GoExpertSystemPrompt() string {
	return `You are a senior Go engineer with 10+ years of experience.
When writing Go code, you MUST follow these rules:

1. ERROR HANDLING:
   - Always check and handle errors
   - Wrap errors with fmt.Errorf("context: %w", err)
   - Use sentinel errors for expected conditions
   - Use errors.Is and errors.As for error inspection
   - Never ignore errors (except fmt.Fprintf to http.ResponseWriter)

2. CONCURRENCY:
   - Every goroutine must have a clear shutdown mechanism
   - Use context.Context for cancellation propagation
   - Always defer cancel() immediately after context.WithCancel/WithTimeout
   - Use sync.WaitGroup to wait for goroutine completion
   - Never pass mutexes by value

3. MODERN IDIOMS (Go 1.27):
   - Use 'any' not 'interface{}'
   - Use 'for range N' syntax where applicable
   - Use builtin min/max
   - Use slices and maps packages
   - Use log/slog for structured logging
   - Use errors.Join for combining errors

4. SECURITY:
   - Use parameterized queries for ALL database operations
   - Validate all user input at the boundary
   - Use crypto/rand for random values, never math/rand
   - Set timeouts on all HTTP clients and servers
   - Never log sensitive data (passwords, tokens, PII)

5. STYLE:
   - Follow effective Go naming conventions
   - Exported types and functions must have godoc comments
   - Keep functions under 50 lines when possible
   - Use table-driven tests
   - Return early to reduce nesting

6. TYPES:
   - Define types for domain concepts (UserID, not int64)
   - Use generics when they reduce duplication without reducing clarity
   - Prefer interfaces at the consumer, not the producer
   - Keep interfaces small (1-3 methods)

Always explain your design decisions in comments.`
}
```

### Constraint-Based Prompting

Force specific patterns by including explicit constraints.

**Template: Constrained Generation**

```
Write a Go function that [description].

CONSTRAINTS (you must follow all of these):
- [ ] No external dependencies - standard library only
- [ ] Must be safe for concurrent use (document thread safety)
- [ ] Must handle context cancellation
- [ ] Time complexity must be O(n log n) or better
- [ ] Must not allocate on the hot path
- [ ] Must include godoc comment
- [ ] Must return a wrapped error, never a bare error string
- [ ] Must compile with Go 1.27

Show me the function signature first. I'll approve before you implement.
```

### Prompt Templates Library - Quick Reference

The templates below supplement those shown in full throughout earlier sections. Each uses `{placeholders}` that you fill in with your context. Store these in your project's `.ai/prompts/` directory for team sharing.

```
┌──────────────────────────────────────────────────────────────────┐
│  CATEGORY        │ TEMPLATE NAME         │ KEY PLACEHOLDERS      │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Architecture    │ architecture_review   │ system_type,          │
│                  │                       │ description,          │
│                  │                       │ constraints           │
│                  │ architecture_tradeoff │ option_a, option_b,   │
│                  │                       │ context               │
│                  │ api_design            │ resource, operations  │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Debugging       │ error_diagnosis       │ error_message,        │
│                  │                       │ stack_trace, code     │
│                  │ goroutine_leak        │ count, goroutine_dump │
│                  │ race_condition        │ race_detector_output  │
│                  │ performance_issue     │ symptom, pprof_output │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Code Review     │ security_review       │ code                  │
│                  │ performance_review    │ code, load            │
│                  │ concurrency_review    │ code                  │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Test Generation │ unit_tests            │ function_code         │
│                  │ fuzz_test             │ function_code,        │
│                  │                       │ invariants            │
│                  │ benchmark_test        │ function_code         │
│                  │ integration_test      │ handler_code,         │
│                  │                       │ dependencies          │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Documentation   │ godoc_comments        │ code                  │
│                  │ adr_document          │ decision, context,    │
│                  │                       │ options, chosen       │
│                  │ runbook               │ alert_name, service,  │
│                  │                       │ trigger, impact       │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Refactoring     │ modernize_go          │ code                  │
│                  │ extract_interface     │ code                  │
│                  │ reduce_complexity     │ code                  │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Performance     │ optimize_function     │ code, benchmark_result│
├──────────────────┼───────────────────────┼───────────────────────┤
│  Security        │ security_audit        │ code                  │
│                  │ owasp_review          │ code, app_type        │
├──────────────────┼───────────────────────┼───────────────────────┤
│  Database        │ schema_design         │ description, queries  │
│                  │ query_optimization    │ query, explain_output │
└──────────────────┴───────────────────────┴───────────────────────┘
```

Full template texts for architecture, debugging, review, and test categories were shown in their respective sections above (118D.2 through 118D.5). Here are the remaining templates not yet shown in full.

**Template: Optimize Function**

````
Optimize this Go function for performance:

```go
{code}
```

Current benchmark: {benchmark_result}
Target: {target}

Focus on: reducing allocations, avoiding copies, using sync.Pool
if applicable, optimizing data structures. Show the optimized
version with benchmark comparison, and state which changes you
expect to matter most so I know what to measure first.
````

**Template: Security Audit (OWASP)**

````
Perform a security audit of this Go module against the OWASP Top 10:

```go
{code}
```

For each finding: severity (CRITICAL/HIGH/MEDIUM/LOW), description,
proof of concept, and fix with code. Report everything you find,
including low-confidence findings, and label your confidence: I would
rather filter a false positive than miss a real one.
````

**Template: Database Schema Design**

```
Design a PostgreSQL schema for: {description}

Requirements:
- Include indexes for common query patterns: {queries}
- Add created_at, updated_at timestamps
- Define foreign key constraints
- Show the Go struct definitions that map to the tables
- Show the migration SQL
```

**Template: Query Optimization**

```
Optimize this PostgreSQL query:

Query: {query}
EXPLAIN ANALYZE output: {explain_output}
Table sizes: {table_sizes}

Suggest: index additions, query rewrites, or schema changes.
Show the optimized query and expected EXPLAIN output.
```

> **What AI Gets Wrong**: Prompt templates become outdated as AI models improve. A prompt that needed extensive hand-holding for an older model often works with a plain instruction on a current one, and the elaborate scaffolding can actively hurt: over-constrained prompts suppress capability the model already has. Periodically retest your templates stripped back to the minimal instruction and see whether the scaffolding is still earning its place.

> **Pro Tip**: Build a team-shared prompt library in your repository (e.g., `.ai/prompts/`). This becomes institutional knowledge: when a new engineer joins, they immediately have access to prompts that work well with your specific codebase and conventions.

---

### Junior → FAANG: Advanced Prompting as a Measurable Engineering Skill

Engineers entering FAANG interviews are frequently asked to describe their development process, not just their output. Advanced prompt engineering is a concrete process skill that can be described with before-and-after evidence: "I built a prompt template library for our Go service that reduced the average time to write a new gRPC handler from 45 minutes to 12 minutes, measured over 20 handlers across three engineers." That kind of quantified process improvement is the format FAANG interviews reward because it demonstrates both technical depth and impact measurement discipline.

The chain-of-thought prompting pattern in this section maps directly to a Go interview preparation strategy. When preparing for system design interviews, use chain-of-thought prompts to stress-test your own designs: "I am designing a vector search service in Go. Walk through the failure modes of the following design step by step, considering concurrency, latency tail percentiles, and memory pressure." The AI's walkthrough surfaces gaps you would miss in solo review. Bringing this kind of structured self-critique discipline to your actual interview answers signals L5 thinking to interviewers who are calibrating for "designs with awareness of tradeoffs" rather than "designs that sound correct."

The distinction between zero-shot, one-shot, and few-shot prompting maps to a practical interview habit. When you do not get a useful answer from an AI during interview preparation, add a concrete example to the prompt (one-shot). When one example is insufficient, add a second from a different scenario (few-shot). Documenting which technique worked for which type of Go question (concurrency design, error handling architecture, interface composition) builds a personal prompting fluency that is itself a FAANG-differentiating skill.

The team-shared prompt library recommendation is a portfolio artifact. Publishing a well-structured `.ai/prompts/` directory in a public GitHub repository, with organized categories (Go concurrency, gRPC, database, testing), README documentation, and version history, demonstrates initiative, organizational thinking, and practical AI integration skills simultaneously. FAANG hiring managers who review GitHub profiles look for exactly this kind of team-multiplier contribution.

### Senior @ FAANG: Prompt Engineering Governance as Platform Infrastructure

At senior level, the team-shared prompt library becomes a platform engineering responsibility rather than an individual contribution. The platform question is: who maintains the library, how are new prompts added, how are outdated prompts retired, and how does prompt quality get measured? Without governance, prompt libraries accumulate untested templates that give newer engineers false confidence. A governed library has each prompt tagged with the model it was validated against, the Go version and library versions it was written for, and the success rate measured by the team.

The model-specificity problem described in "What AI Gets Wrong" is a platform versioning concern at scale. When an organization routes across multiple providers through a gateway, prompt templates written for one model may produce degraded output on another. The platform engineering answer is prompt abstraction: templates that specify intent and constraints without encoding model-specific phrasing, combined with a prompt router that selects the appropriate model based on task type. Designing this abstraction layer requires understanding both the capabilities of each model and the cost-per-quality tradeoffs across providers.

The chain-of-thought pattern for architecture review becomes a platform tool when it is embedded in pull request automation. A Go service template that automatically runs an architecture review prompt against each new service's design document, flags deviations from approved patterns, and posts structured feedback as a PR comment is an engineering intelligence system. The Go code for this automation (reading the PR diff, constructing the architecture context, calling the LLM, parsing the response, posting the comment) is precisely the kind of AI-augmented platform tooling that staff engineers build and that FAANG engineering blog posts describe as "AI-powered developer experience."

The periodic template refresh requirement ("test your templates with minimal prompts") needs to be automated at the platform level. A weekly CI job that runs each prompt template against a golden set of inputs and measures output quality against stored baselines detects model drift: cases where an upstream model update changes the output distribution in ways that break downstream workflows. This monitoring requirement mirrors the evaluation framework described in chapter-118c: the same golden-test approach that validates RAG pipeline quality applies to prompt template quality. Senior engineers who recognize this pattern and build a unified evaluation framework across both domains reduce platform complexity while increasing coverage.

Organizational prompt engineering maturity moves through levels analogous to software engineering maturity. Level 1 is ad hoc prompting by individual engineers with no shared artifacts. Level 2 is a shared library with templates but no measurement. Level 3 is a governed library with model-version tagging and success rate tracking. Level 4 is automated prompt testing in CI with drift alerting. Level 5 is a prompt optimization pipeline that uses LLM-as-judge scoring to automatically improve templates over time. A staff engineer's roadmap for their organization's AI platform should articulate the current maturity level and the specific investments required to reach the next level, with ROI estimates at each step.

The bar-raiser question at staff level interviews for AI platform roles is: "How would you ensure prompt quality degrades gracefully when the underlying model changes?" The answer requires discussing fallback strategies (revert to previous model version, alert on quality drop, maintain a canary deployment of the new model), measurement thresholds (what quality score triggers an alert), and organizational response (who owns the response, what is the SLA for prompt template updates). Engineers who can answer this question at the operational detail level demonstrate that they have thought about AI platform reliability with the same rigor they apply to service reliability.
