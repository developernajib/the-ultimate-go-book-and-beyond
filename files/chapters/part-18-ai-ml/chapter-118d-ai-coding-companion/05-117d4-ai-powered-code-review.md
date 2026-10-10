## 118D.4 AI-Powered Code Review

### Using AI as Your First Code Reviewer

The most productive way to use AI for code review is as a pre-reviewer. Before you submit a PR to your team, run it through AI to catch the mechanical issues that waste human reviewers' time: missing error checks, potential nil dereferences, context leaks, and Go style violations. This means your human reviewers can focus on design, architecture, and business logic, the things that actually require human judgment.

### What AI Catches That Humans Miss (and Vice Versa)

AI excels at exhaustive mechanical checks, every error return, every nil dereference path, every context propagation gap, because it processes the entire diff without attention fatigue. Humans outperform AI on design coherence, business logic correctness, and whether a change introduces subtle race conditions that require understanding the broader system state.

```
┌─────────────────────────────────────────────────────────────────┐
│                 AI vs HUMAN CODE REVIEW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AI CATCHES BETTER:                                             │
│  ├── Unchecked error returns                                    │
│  ├── Missing context cancellation checks                        │
│  ├── Potential nil pointer dereferences                         │
│  ├── SQL injection in dynamic queries                           │
│  ├── Goroutine leaks (missing done channels / context)          │
│  ├── Resource leaks (unclosed files, connections, bodies)       │
│  ├── Race conditions in obvious shared-state patterns           │
│  ├── Style inconsistencies (naming, formatting)                 │
│  ├── Missing HTTP header security settings                      │
│  └── Deprecated API usage                                       │
│                                                                 │
│  HUMANS CATCH BETTER:                                           │
│  ├── Wrong abstraction for the domain                           │
│  ├── Over-engineering / under-engineering for actual scale      │
│  ├── Business logic correctness                                 │
│  ├── Whether the code matches the requirements                  │
│  ├── Organizational context (why was this done this way?)       │
│  ├── Performance implications specific to your data patterns    │
│  ├── Whether the change is the right change to make at all      │
│  ├── Team convention violations that aren't written down        │
│  └── Subtle concurrency issues in complex state machines        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Security-Focused AI Review Prompts

**Template: Security Review Prompt**

````
Review this Go code for security vulnerabilities. Focus on:

1. Input validation: Are all user inputs sanitized? Any injection vectors?
2. Authentication/Authorization: Are there bypass opportunities?
3. SQL injection: Any string concatenation in queries?
4. Path traversal: Any user-controlled file paths?
5. Sensitive data exposure: Are secrets, tokens, or PII logged or returned in errors?
6. Race conditions in security-critical paths
7. Timing attacks in comparison operations
8. Missing TLS validation in HTTP clients
9. Unsafe deserialization

Code to review:

```text
[paste code]
```

For each finding, provide:
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- The vulnerable line(s)
- How it could be exploited
- The fix with code

If you find no issues in a category, say so explicitly rather than
staying silent, so I can tell "checked and clean" from "not checked".
````

### Performance-Focused AI Review Prompts

**Template: Performance Review Prompt**

````
Review this Go code for performance issues. Focus on:

1. Allocations in hot paths (loops, handlers)
2. N+1 query patterns
3. Missing connection pooling
4. Unbounded slice/map growth
5. Unnecessary string concatenation (use strings.Builder)
6. Missing context timeouts on I/O operations
7. Synchronous operations that could be concurrent
8. Mutex contention patterns
9. Missing caching opportunities

Code to review:

```text
[paste code]
```

Expected load: [X requests/second], [Y concurrent users]

For each finding, rank by expected impact and provide a fix. Be
explicit about which findings you are confident in and which are
speculative: I will profile before acting, and I want to know which
ones are worth measuring first.
````

### Example: AI Review Catches a Context Leak in HTTP Middleware

This example shows AI detecting a common mistake: a middleware that calls `context.WithCancel` but never defers `cancel()`, causing the goroutine managing the cancellation signal to leak for the lifetime of the request context. The fix is a single `defer cancel()` immediately after the `WithCancel` call.

```go
// BEFORE AI REVIEW: contains a context leak.
package middleware

import (
	"context"
	"net/http"
	"time"
)

// TimeoutMiddleware adds a timeout to every request.
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// BUG: context.WithTimeout creates a context that MUST be canceled.
			// If the handler returns before the timeout, the timer goroutine
			// leaks until the timeout expires.
			ctx, _ := context.WithTimeout(r.Context(), timeout)
			r = r.WithContext(ctx)
			next.ServeHTTP(w, r)
		})
	}
}
```

**AI Review Output:**

```
FINDING: Context leak in TimeoutMiddleware

SEVERITY: HIGH

ISSUE: Line with context.WithTimeout discards the cancel function.
context.WithTimeout starts a timer goroutine that runs until either
the timeout expires or cancel() is called. By discarding the cancel
function, every request that completes before the timeout leaks a
goroutine for the remaining timeout duration.

At 1000 requests/second with a 30-second timeout, this is 30,000
leaked goroutines at any given time.

FIX:
```

```go
// AFTER AI REVIEW: context leak fixed.
package middleware

import (
	"context"
	"net/http"
	"time"
)

// TimeoutMiddleware adds a timeout to every request. The context is
// properly canceled when the handler returns to prevent goroutine leaks.
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel() // Always cancel to release the timer goroutine.
			r = r.WithContext(ctx)
			next.ServeHTTP(w, r)
		})
	}
}
```

### Example: AI Review Finds SQL Injection in Dynamic Query Builder

String-built SQL is the classic injection surface, and it is exactly the kind of bug AI review catches reliably because the pattern is textual: concatenation flowing into a query API. The exchange below shows a review catching it and proposing the parameterized fix.

```go
// BEFORE AI REVIEW: contains SQL injection vulnerability.
package repository

import (
	"context"
	"database/sql"
	"fmt"
)

// SearchUsers finds users matching the given filters.
// VULNERABLE: filter values are concatenated directly into the query.
func SearchUsersVulnerable(ctx context.Context, db *sql.DB, filters map[string]string) ([]User, error) {
	query := "SELECT id, name, email FROM users WHERE 1=1"

	for key, value := range filters {
		// BUG: SQL injection. User-controlled values inserted into query string.
		query += fmt.Sprintf(" AND %s = '%s'", key, value)
	}

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, u)
	}

	return users, rows.Err()
}

// User represents a user record.
type User struct {
	ID    int64
	Name  string
	Email string
}
```

**AI Review Output:**

```
FINDING: SQL Injection (CRITICAL)

Both the column names AND values are user-controlled and concatenated
directly into the SQL query. An attacker can:
1. Inject via value: filters["name"] = "'; DROP TABLE users; --"
2. Inject via key: filters["1=1; DROP TABLE users; --"] = ""

This is exploitable for data exfiltration, data modification, and
denial of service.

FIX: Use parameterized queries. Whitelist allowed column names.
```

```go
// AFTER AI REVIEW: SQL injection fixed.
package repository

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// allowedFilterColumns defines the columns that can be filtered on.
// Any column not in this list is rejected to prevent SQL injection
// through column name manipulation.
var allowedFilterColumns = []string{"name", "email", "status", "role"}

// SearchUsers finds users matching the given filters using parameterized queries.
func SearchUsers(ctx context.Context, db *sql.DB, filters map[string]string) ([]User, error) {
	var (
		conditions []string
		args       []any
		argIndex   int
	)

	for column, value := range filters {
		// Whitelist check: only allow known column names.
		if !slices.Contains(allowedFilterColumns, column) {
			return nil, fmt.Errorf("invalid filter column: %q", column)
		}

		argIndex++
		conditions = append(conditions, fmt.Sprintf("%s = $%d", column, argIndex))
		args = append(args, value)
	}

	query := "SELECT id, name, email FROM users"
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, u)
	}

	return users, rows.Err()
}

// User represents a user record.
type User struct {
	ID    int64
	Name  string
	Email string
}
```

### Go Code: Automated AI Code Review CLI Tool

The review CLI gathers a git diff, sends it to an LLM with focus-area directives, and prints structured findings sorted by severity.

```go
package review

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ReviewConfig holds configuration for the AI code review.
type ReviewConfig struct {
	FocusAreas   []string // "security", "performance", "correctness", "style"
	DiffSource   string   // "staged", "branch", "file"
	BranchTarget string   // Target branch for branch diff.
}

// ReviewResult contains the structured output of the review.
type ReviewResult struct {
	Summary  string          `json:"summary"`
	Findings []ReviewFinding `json:"findings"`
	Score    int             `json:"score"` // 1-10, overall code quality.
}

// ReviewFinding represents a single review comment.
type ReviewFinding struct {
	File        string `json:"file"`
	Line        int    `json:"line,omitempty"`
	Severity    string `json:"severity"` // "critical", "high", "medium", "low", "info"
	Category    string `json:"category"` // "security", "performance", "correctness", "style"
	Description string `json:"description"`
	Suggestion  string `json:"suggestion"`
}

// GetDiff retrieves the code diff from the configured source.
func GetDiff(cfg ReviewConfig) (string, error) {
	switch cfg.DiffSource {
	case "staged":
		return gitOutput("diff", "--cached")
	case "branch":
		return gitOutput("diff", cfg.BranchTarget+"...HEAD")
	default:
		content, err := os.ReadFile(cfg.DiffSource)
		return string(content), err
	}
}

func gitOutput(args ...string) (string, error) {
	out, err := exec.Command("git", args...).Output()
	return string(out), err
}

// BuildReviewPrompt constructs the LLM prompt for code review.
func BuildReviewPrompt(cfg ReviewConfig, diff string) string {
	return fmt.Sprintf(`You are a senior Go engineer performing a code review.
Focus areas: %s

Review this git diff and provide structured feedback:

%sdiff
%s
%s

Respond in JSON: {"summary": "...", "findings": [{"file": "...", "line": N,
"severity": "critical|high|medium|low|info", "category": "security|performance|
correctness|style", "description": "...", "suggestion": "..."}], "score": N}`,
		strings.Join(cfg.FocusAreas, ", "), "```", diff, "```")
}

// PrintResults displays review findings sorted by severity (most critical first).
func PrintResults(result *ReviewResult) {
	fmt.Printf("\n=== AI Code Review Results ===\n")
	fmt.Printf("Score: %d/10\n", result.Score)
	fmt.Printf("Summary: %s\n\n", result.Summary)

	severityOrder := map[string]int{
		"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4,
	}

	// Simple sort by severity.
	findings := make([]ReviewFinding, len(result.Findings))
	copy(findings, result.Findings)
	for i := range len(findings) {
		for j := i + 1; j < len(findings); j++ {
			if severityOrder[findings[i].Severity] > severityOrder[findings[j].Severity] {
				findings[i], findings[j] = findings[j], findings[i]
			}
		}
	}

	for idx, f := range findings {
		fmt.Printf("[%d] %s (%s) -- %s:%d\n", idx+1, f.Severity, f.Category, f.File, f.Line)
		fmt.Printf("    %s\n", f.Description)
		if f.Suggestion != "" {
			fmt.Printf("    Fix: %s\n", f.Suggestion)
		}
		fmt.Println()
	}
}

// Usage: call GetDiff, then BuildReviewPrompt, send to LLMClient.Complete
// (Section 118D.2), parse the JSON response into ReviewResult, call PrintResults.
```

> **What AI Gets Wrong**: AI code reviews tend to produce false positives on intentional patterns. If your codebase deliberately uses `sync.Pool` for a non-standard purpose, or intentionally skips error checking on `fmt.Fprintf` to a response writer, AI will flag it. Include a note in your prompt about intentional patterns to reduce noise: "We intentionally ignore fmt.Fprintf errors to http.ResponseWriter because the connection may already be closed."

> **Pro Tip**: Run AI review on your own code *before* submitting the PR. Fix the obvious issues first, then let human reviewers focus on design and business logic. This dramatically improves your team's review velocity and your reputation as an engineer who submits clean PRs.

### Junior → FAANG: AI Pre-Review as Professional Engineering Habit

The "run AI review before submitting PR" practice is the single single most useful AI tool habit for junior engineers at FAANG. Human code reviewers at FAANG are often senior engineers whose time is scarce. Submitting PRs with obvious style violations, missing error handling, and unused imports wastes their time on issues that AI can identify and you can fix in 5 minutes. Running AI pre-review, fixing everything it identifies, and then submitting for human review is the practice that earns a reputation for submitting clean PRs, which directly affects how reviewers perceive your growth trajectory.

The "false positives on intentional patterns" limitation of AI code review is a practical skill to develop: knowing when to accept AI's feedback versus when to document why the AI is wrong. If AI flags a pattern that is intentional (deliberately ignoring fmt.Fprintf errors on a closed response writer, using sync.Pool in a non-standard way), add a comment in the code explaining the intent. This comment serves dual purpose: it prevents AI (and future human reviewers) from flagging the same pattern repeatedly, and it documents the design decision for engineers who will maintain the code.

For FAANG code review interviews specifically, the ability to review AI-generated code systematically is assessed by having you review a code snippet. Practice the review checklist approach: go through the code line by line asking "are types correct? are errors handled? are nil pointers possible? are inputs validated? are security requirements met?" rather than reading for overall impression. This systematic approach catches the specific categories of bugs that AI-generated code is prone to.

### Senior @ FAANG: AI Code Review as Engineering Productivity Platform

At senior level, AI-powered code review is an organizational productivity platform, not just an individual habit. The three-phase review strategy (AI catches mechanical issues, automated tools catch security and performance issues, human reviewers focus on design and business logic) is an organizational process design that allocates review effort optimally. Implementing this as an explicit team process (PR template that requires AI pre-review confirmation, CI checks for security and linting, human review guidelines that focus on design), rather than an individual practice, produces consistent results across the team.

The "intentional patterns" annotation practice (commenting why the AI warning is wrong) is a knowledge management strategy. Each annotation is organizational knowledge captured in the code: why this pattern is intentional, what trade-off it represents, and why the AI's suggestion does not apply. This knowledge would otherwise exist only in the memory of the engineer who made the decision, and would require re-explaining in every code review. Encouraging the team to annotate intentional patterns systematically creates a codebase that explains itself to both AI reviewers and human reviewers, reducing review friction for all future changes.

---
