## Exercises

### Exercise 1: Architecture Review Session

Use AI (Claude Code, ChatGPT, or Cursor) to conduct an architecture review of a Go service you're building or maintaining.

1. Write a `CLAUDE.md` or system prompt describing your project
2. Present your architecture to AI and ask for the adversarial review
3. Document the top 3 issues AI identified
4. Implement a fix for at least one issue
5. Ask AI to review your fix

**Deliverable**: A brief architecture review document with findings and resolutions.

### Exercise 2: Debug a Goroutine Leak

Given this intentionally buggy code, use AI to identify and fix the goroutine leak:

```go
package fetch

import (
	"fmt"
	"net/http"
	"time"
)

func fetchAll(urls []string) []string {
	results := make(chan string)

	for _, url := range urls {
		go func() {
			resp, err := http.Get(url)
			if err != nil {
				results <- fmt.Sprintf("error: %v", err)
				return
			}
			defer resp.Body.Close()
			results <- fmt.Sprintf("%s: %d", url, resp.StatusCode)
		}()
	}

	var collected []string
	timeout := time.After(5 * time.Second)
	for range len(urls) {
		select {
		case r := <-results:
			collected = append(collected, r)
		case <-timeout:
			return collected // BUG: leaks goroutines still writing to results
		}
	}
	return collected
}
```

**Task**: Feed this to AI, get the diagnosis, implement the fix, and write tests for the fixed version.

### Exercise 3: AI-Generated Test Suite

Take a Go package you've written (at least 5 exported functions) and use AI to generate a full test suite.

1. Feed each function to AI and request table-driven tests
2. Review the generated tests for correctness and coverage
3. Add 3 edge cases that AI missed
4. Run the tests and fix any failures
5. Measure coverage with `go test -cover`

**Deliverable**: A complete `_test.go` file with at least 80% coverage.

### Exercise 4: Code Modernization

Find a Go 1.18-era open-source project on GitHub and use AI to modernize it.

1. Identify all deprecated patterns (interface{}, ioutil, etc.)
2. Ask AI to modernize each file
3. Verify the modernized code compiles
4. Run the existing tests to confirm behavior is preserved

**Deliverable**: A diff showing all modernization changes.

### Exercise 5: Security Review

Write a deliberately insecure Go HTTP handler (include SQL injection, missing auth, XSS, etc.) and submit it to AI for security review.

1. Create a handler with at least 5 security vulnerabilities
2. Ask AI to find them (without telling it the count)
3. Compare AI's findings to your known vulnerabilities
4. Note which vulnerabilities AI found and which it missed
5. Fix all vulnerabilities using AI suggestions

**Deliverable**: Before/after code with a security finding report.

### Exercise 6: Mock Interview Marathon

Conduct 3 mock interviews using AI:

1. **Coding interview**: Solve a medium-difficulty algorithm problem with AI as interviewer
2. **System design interview**: Design a URL shortener with AI asking follow-up questions
3. **Behavioral interview**: Practice 3 behavioral questions using the STAR method

**Deliverable**: Notes from each session with AI's feedback and your self-assessment.

### Exercise 7: Documentation Generation

Take an undocumented Go package and use AI to generate complete documentation.

1. Generate godoc comments for all exported symbols
2. Generate a package-level overview doc.go
3. Generate a README with usage examples
4. Generate an ADR for the key design decision in the package
5. Review and refine all generated documentation

**Deliverable**: A fully documented package with godoc, README, and ADR.

### Exercise 8: Build a Personal AI Workflow

Set up your personal AI development workflow.

1. Configure `CLAUDE.md` for your primary project
2. Create 5 custom prompt templates for your most common tasks
3. Set up a pre-commit hook that runs AI code review
4. Configure your editor (Cursor or VS Code with Copilot) with Go-specific settings
5. Run the workflow for one full day and measure prompt efficiency

**Deliverable**: Your `CLAUDE.md`, prompt templates, and one-day productivity metrics.

### Exercise 9: Refactoring with AI

Take a function with cyclomatic complexity > 15 (or write one) and use AI to refactor it.

1. Ask AI to analyze the function's complexity
2. Get 3 refactoring suggestions
3. Implement the best suggestion
4. Write tests for both the original and refactored version
5. Verify behavior equivalence by running both test suites

**Deliverable**: Before/after code with tests proving behavioral equivalence.

### Exercise 10: AI-Powered Incident Response

Simulate a production incident using AI.

1. Create a scenario: "Our Go service's p99 latency jumped from 50ms to 2s"
2. Feed AI the symptoms and ask for an investigation plan
3. Follow the plan, providing AI with simulated data at each step
4. Have AI help you write a postmortem
5. Have AI suggest preventive measures

**Deliverable**: A complete incident postmortem document generated collaboratively with AI.

---

### Junior → FAANG: Practical Exercises as Interview Evidence

Each of the five exercises in this section produces a concrete deliverable that answers a specific FAANG interview question. The architecture review session produces evidence for "describe a time you identified design flaws before implementation." The CLAUDE.md setup produces evidence for "describe how you improve team processes and developer experience." The AI-accelerated feature build produces evidence for "describe a time you delivered a feature faster than expected without sacrificing quality." The legacy code modernization produces evidence for "describe a time you improved an existing codebase systematically." The incident postmortem produces evidence for "describe a time you diagnosed and resolved a production issue."

The STAR format (Situation, Task, Action, Result) that FAANG interviews use rewards exactly the structure these exercises produce: a realistic scenario, a concrete task, a documented AI-augmented action, and a measurable deliverable. Engineers who complete all five exercises have five STAR stories grounded in real AI-assisted engineering work rather than hypothetical descriptions of what they would do. This is the difference between "I would use AI to review architecture" (weak) and "I ran an AI architecture review session that identified three goroutine lifetime issues in a service I was designing, which I then fixed before implementation" (strong).

The incident postmortem exercise is particularly valuable because postmortems are a FAANG cultural artifact. Every FAANG engineering organization runs blameless postmortems with structured formats (timeline, root cause, contributing factors, action items, SLO impact). An engineer who can demonstrate that they know the format, know how to drive the process, and can use AI to accelerate the synthesis of a clear narrative from raw data is demonstrating both technical depth and organizational cultural fluency simultaneously.

### Senior @ FAANG: Exercises as Team Training Program Design

At senior level, these five exercises are the foundation of a team AI training program rather than individual portfolio projects. The architecture review exercise becomes a team workshop: each engineer reviews the same service design independently using AI, then the team compares what each AI session flagged and discusses what the team's AI-assisted review checklist should include. The differences between sessions reveal gaps in individual prompting technique and opportunities for shared prompt templates that capture the team's collective architectural judgment.

The CLAUDE.md exercise becomes the team's onboarding program for AI-assisted development. Running this exercise as a team means the resulting CLAUDE.md reflects collective agreement about conventions, architecture, and constraints rather than one engineer's opinion. The process of building it together is itself a team alignment exercise: debates about what goes in the CLAUDE.md surface disagreements about code conventions, architecture principles, and library choices that need to be resolved anyway. AI-assisted team alignment produces better CLAUDE.md content and better team cohesion simultaneously.

The legacy modernization exercise is a risk management training tool at team scale. The most dangerous AI-assisted work is AI-assisted refactoring of code with insufficient test coverage, because AI-generated refactoring changes can break subtle behaviors that only tests would catch. Running this exercise with the team, with explicit measurement of test coverage before and after, trains every engineer to follow the "tests first, then AI refactor" discipline that prevents AI-assisted technical debt accumulation. Teams that skip this discipline produce refactoring that looks correct and passes CI but breaks edge cases that the test suite does not cover.

The postmortem exercise run as a team training reveals how AI changes the incident response and postmortem process. The AI-assisted synthesis of a postmortem timeline (feeding the AI the raw log excerpts, alert history, and chat messages) is faster than manual synthesis, but requires the incident commander to validate that the AI's timeline matches what actually happened. Running this as a training exercise with a simulated incident teaches engineers when to trust AI synthesis and when to override it, which is exactly the human-in-the-loop judgment described throughout this chapter. A staff engineer who runs this training exercise quarterly, with different simulated scenarios each time, is investing in the team's AI-augmented incident response capability in a measurable way.

