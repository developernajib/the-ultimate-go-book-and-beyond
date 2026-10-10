## 118.12 Anti-Patterns Reference

This section is a complete reference of AI-assisted development anti-patterns. Bookmark it. Review it before every significant AI coding session.

---
### Anti-Pattern 1: The Magic Box

**Description**: Using AI as a black box. Asking for "an auth system" and shipping the output without understanding it.

**Why it fails**: You own what ships. You cannot debug, extend, or secure code you don't understand. When something breaks at 3am, "the AI wrote it" is not an answer.

**Fix**: You must be able to explain every line of AI-generated code before it enters your codebase. If you can't explain it, ask AI to explain it. If you still can't explain it after the explanation, that's a signal the abstraction is wrong.

---
### Anti-Pattern 2: One Giant Prompt

**Description**: Asking AI to "build a complete [system/feature/service]" in a single prompt.

**Why it fails**: AI will generate something that compiles but has inconsistent architecture, missing tests, insecure defaults, and wrong abstractions. You have no checkpoints to catch mistakes.

**Fix**: Incremental prompts. Interfaces first. Tests second. Implementation third. One component at a time.

---
### Anti-Pattern 3: Skipping the Security Review

**Description**: Shipping AI-generated authentication, authorization, cryptography, or input validation code without expert security review.

**Why it fails**: AI security code looks right. It often is not. The patterns are subtle. The consequences are catastrophic.

**Fix**: Every line of security-sensitive code gets reviewed by someone who knows security. No exceptions. Not even "just for now."

---
### Anti-Pattern 4: No Tests = Done

**Description**: AI generates code, it compiles, no tests are written or required.

**Why it fails**: Untested code is a bet that you'll never need to change it. You will always need to change it.

**Fix**: Tests are not optional. If AI doesn't generate them, require AI to generate them. Tests are part of the definition of done.

---
### Anti-Pattern 5: Trust the First Output

**Description**: Accepting AI output without revision, critique, or alternative exploration.

**Why it fails**: AI's first answer is often the most obvious solution, which is rarely the best solution for complex problems. It is optimized for plausibility, not correctness.

**Fix**: For important decisions, ask for multiple approaches. Ask AI to critique its own first answer. Ask for what could go wrong with the proposed approach.

---
### Anti-Pattern 6: No CLAUDE.md (Context Amnesia)

**Description**: every Claude Code session starts from zero, with no project context, no established patterns, and no conventions.

**Why it fails**: AI defaults to generic patterns instead of your patterns. Every session fights the same battle about which error handling style, which logging library, which architectural pattern.

**Fix**: CLAUDE.md. Write it once, keep it updated, and let it carry your accumulated project context into every new session.

---
### Anti-Pattern 7: Wrong Tool for the Job

**Description**: Using a single AI tool for everything regardless of fit.

**Why it fails**: Copilot inline completion while editing is very different from Claude Code for multi-file refactoring. Using the wrong tool means either inadequate output quality or unnecessary friction.

**Fix**: Know your tools. Use the decision matrix in section 118.2. Use Copilot for inline completion. Use Claude Code for large context tasks. Use the API for custom tooling.

---
### Anti-Pattern 8: Outdated Advice (Training Cutoff Blindness)

**Description**: Accepting AI suggestions about library versions, Go features, and API patterns without checking against current documentation.

**Why it fails**: AI has a training cutoff. The ecosystem moves. What AI says about `pgx/v4` may not be true for `pgx/v5`. What it says about Go may describe the language as it was several releases ago, because that is what most of its training data describes.

**Fix**: Always check `go.mod`, official documentation, and `pkg.go.dev` for current API signatures and best practices. Treat AI as "probably right but verify."

---
### Anti-Pattern 9: Hallucinated APIs

**Description**: Using AI-generated code that references functions, packages, or types that don't exist.

**Why it fails**: the code won't compile, which is the good case, because you find out at once. The bad case is a hallucinated dependency: you go looking for a package that has never existed, or worse, install a real one that someone registered under the plausible name a model keeps inventing.

**Fix**: Every import, every function call, every method name should be verified against the actual source. `go build` catches most of these, but non-stdlib packages require checking `pkg.go.dev`.

---
### Anti-Pattern 10: Performance Theater

**Description**: Accepting AI "performance optimizations" without profiling data.

**Why it fails**: AI guesses about performance. It optimizes based on general principles, not your specific bottleneck. You may add complexity for zero benefit, or introduce a bug while "optimizing" something that was never the bottleneck.

**Fix**: Profile first. Always. Use `go tool pprof`, benchmark with `go test -bench`, and `benchstat` for comparison. Optimize based on data. Use AI to help interpret profiling output and generate hypotheses, never to prescribe optimizations without measurement.

---
### Anti-Pattern 11: Prompt-Only Development

**Description**: Entire features developed through back-and-forth prompting without ever writing code yourself.

**Why it fails**: You lose touch with the codebase. Context drift accumulates as each prompt adds to a pile of AI-generated code you don't deeply understand. Architectural coherence degrades.

**Fix**: Write the architectural skeleton yourself. Write the interfaces. Write at least one implementation method yourself to understand the patterns. Use AI to fill in the rest, but stay connected to what's being built.

---
### Anti-Pattern 12: No Critique Loop

**Description**: Accepting AI output and submitting it to human review without running it through AI critique first.

**Why it fails**: AI finds many of the obvious issues in its own output faster than a human reviewer will. Not running the critique first spends scarce human review attention on things a machine would have caught. Note the direction of this claim: it is an argument for critique as a cheap pre-filter, not an argument that a clean critique means the diff is clean. It routinely misses real bugs.

**Fix**: Before opening a PR, run the Critique Prompt (section 118.3) on your diff. Fix what it finds. Then submit for human review. The human review should be focused on what AI cannot catch: business logic, architecture, judgment calls.

### Junior → FAANG: Anti-Patterns as Interview Preparation Material

Each anti-pattern here is a question a FAANG interviewer can ask: "what are the risks of accepting AI-generated code without review?" (Anti-Pattern 1, The Magic Box), "how do you ensure AI-generated security code is correct?" (Anti-Pattern 3, Skipping the Security Review), "how do you handle the knowledge cutoff problem?" (Anti-Pattern 8, Outdated Advice). Preparing a concrete answer with an example for each anti-pattern gives you interview material that demonstrates production-level AI tool maturity.

Anti-Pattern 5, Trust the First Output, is the most insidious of the twelve because it is invisible in the short term. Engineers who review AI-generated code to confirm it looks right rather than to verify that it is right will have a higher rate of bugs that pass review than engineers who apply the systematic checklist. In a FAANG code review round, the interviewer observes not just what you flag but how you approach the review: do you read for understanding or scan for anomalies? Engineers who read for understanding, even when reviewing AI-generated code, demonstrate the thoroughness that FAANG review processes require.

Reviewing this reference before each significant AI coding session, as recommended, is a habit that compounds over time. The first few sessions, the anti-patterns will catch behaviors you were not aware of. After a dozen sessions, the systematic review approach becomes automatic and the reference serves as a calibration check rather than a discovery tool. After a hundred sessions, you will have added personal anti-patterns to the list based on the specific mistakes AI makes most often in your domain and codebase.

### Senior @ FAANG: Anti-Pattern Reference as Code Review Audit Tool

At senior level, the anti-pattern reference is an audit tool for team code review quality. Periodically review a sample of merged PRs that involved significant AI assistance and check them against the list: are there functions that ignore the project's error handling conventions (Anti-Pattern 6)? Deprecated APIs that were current in the model's training data (Anti-Pattern 8)? Security-sensitive code merged with no specialist review (Anti-Pattern 3)? Each finding is a code review quality gap that requires a process intervention, not just individual coaching.

The fix for Anti-Pattern 12, No Critique Loop (run the Critique Prompt on your diff before requesting human review) is a process change that improves review quality at almost no cost in time. Encoding this as a required step in the PR template (a checklist item: "ran AI critique on this diff before requesting review") makes it visible in the review process. Reviewing PR templates across the team's repositories and adding this checklist item is a one-time platform contribution that permanently improves AI-assisted code review quality for the team.

---
