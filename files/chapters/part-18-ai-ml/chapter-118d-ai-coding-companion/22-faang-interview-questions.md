## 118D.15 FAANG Interview Questions

### Question 1: AI-Augmented Workflow Design

**Question**: You've joined a new team that hasn't adopted AI coding tools. How would you introduce AI-assisted development to the team without disrupting existing workflows?

**What interviewers look for**: Pragmatic change management, understanding that tool adoption requires trust, not mandates. Starting with low-risk high-value use cases, measuring results, and expanding gradually.

**Strong answer elements**:
- Start with non-controversial use cases: test generation, documentation, code formatting
- Demonstrate value through measurable results (time saved, coverage improved)
- Establish guidelines for AI-generated code quality and ownership
- Address concerns about skill atrophy, code quality, and job security honestly
- Build a team prompt library and CLAUDE.md collaboratively
- Never mandate adoption, let results speak for themselves
- Be honest about the evidence: the headline productivity numbers are vendor-run and narrow, and at least one controlled trial found experienced developers got slower on familiar code while believing they were faster. A pitch that acknowledges this earns more trust than one that quotes 55%

### Question 2: AI-Generated Code Review

**Question**: A junior engineer submits a PR where 90% of the code was AI-generated. They say "it works and all tests pass." How do you review this PR?

**What interviewers look for**: Understanding that "it works" is necessary but not sufficient. AI-generated code needs the same review rigor as human-written code, with extra attention to common AI failure patterns.

**Strong answer elements**:
- Apply the same review standards as human-written code
- Check for AI-specific antipatterns: ignored error returns, goroutine leaks, SQL injection via string formatting
- Verify the engineer understands what the code does (can they explain the design decisions?)
- Check that tests cover meaningful behavior, not just happy paths
- Treat "all tests pass" with suspicion when the tests were also AI-generated: a test generated from the implementation encodes that implementation's bugs as expected values, so a green suite proves the code matches itself. Read the assertions against the contract, and check the boundary cases arithmetically (an off-by-one in a boundary test passes silently while testing nothing)
- Ask whether anything sensitive went into the prompt to produce this
- Evaluate whether the architecture is appropriate for the actual requirements
- Provide constructive feedback that helps the engineer develop their review skills

### Question 3: Debugging with AI

**Question**: Describe how you would use AI to debug a production issue where a Go service's memory usage grows linearly over time.

**What interviewers look for**: Systematic debugging methodology that uses AI as a tool, not a crutch. Understanding of Go memory profiling, pprof, and common memory leak patterns.

**Strong answer elements**:
- Capture pprof heap profiles at intervals and diff them
- Feed the pprof output to AI with context about the service's workload
- Ask AI to identify growing allocations versus stable allocations
- Common Go causes: goroutine leaks, cache without eviction, slice growth without reset, unclosed HTTP response bodies
- Verify AI's hypothesis by examining the specific code path
- Fix, test, deploy, and monitor to confirm the fix

### Question 4: Prompt Engineering

**Question**: You need AI to generate a Go function that handles database transactions with retry logic. Your first prompt produces code that ignores context cancellation and doesn't handle serialization failures correctly. How do you refine your prompt?

**What interviewers look for**: Understanding of iterative prompt refinement, constraint-based prompting, and the ability to identify what went wrong in AI output.

**Strong answer elements**:
- Add explicit constraints: "Must respect context cancellation" and "Must handle serialization failures (pgx error code 40001) with retry"
- Provide a few-shot example showing the desired transaction pattern
- Specify the error handling contract: "Return the original error, not a retry-obscured error"
- Include the specific database driver (pgx) so AI uses the right API
- Review the refined output for the specific issues from the first attempt

### Question 5: AI Limitations

**Question**: In what situations would you explicitly NOT use AI assistance, even if it could technically help?

**What interviewers look for**: Mature judgment about AI limitations, understanding that AI is not universally beneficial.

**Strong answer elements**:
- Security-critical implementation details (cryptographic protocols, auth flows), because a model trained on public code has read a lot of subtly broken public code and will reproduce it fluently
- Novel algorithmic problems where understanding the solution is the point
- Team design discussions where human consensus-building matters more than speed
- When learning a fundamental concept, because using AI to skip the understanding creates knowledge that collapses under the first follow-up question
- Performance-critical code where you need to understand every instruction
- Situations where AI's training data may reflect biased or outdated patterns

### Question 6: Team AI Standards

**Question**: How would you establish code ownership and quality standards when a significant portion of your team's code is AI-generated?

**What interviewers look for**: Understanding that AI changes the production process but not the ownership model. Practical guidelines that maintain engineering culture.

**Strong answer elements**:
- The person who submits the PR owns ALL code in it, regardless of origin
- AI-generated code must meet the same quality bar as human-written code
- Establish a team AI usage guideline document (what's allowed, what needs extra review, what's prohibited)
- Require that engineers can explain any code they submit
- Track AI contribution metrics to understand team dynamics (not to evaluate individuals)
- Regular retrospectives on AI tool effectiveness and team workflow

---

### Junior → FAANG: Interview Questions as Structured Study Targets

Each question in this section tests a specific competency cluster. Question 1 (workflow design) tests process thinking: can you describe your own engineering workflow with enough specificity that an interviewer can assess whether you are systematic or ad hoc? Question 2 (trust and verification) tests quality discipline: do you understand when AI output is reliable and when it requires careful human verification? Question 3 (code quality) tests engineering standards: do you hold AI-generated code to the same bar as human-written code, and do you know how to enforce that bar? Question 4 (team dynamics) tests leadership at scope: can you think beyond your own workflow to the organizational implications of AI adoption?

The study strategy for these questions is to answer each one against your actual experience before the interview. For Question 1, write down your actual workflow step by step, including CLAUDE.md contents, prompt templates you use regularly, and the review checklist you apply to AI output. For Question 2, write down a specific example where AI gave you incorrect output, how you detected the error, and what you changed in your process as a result. For Questions 3 and 4, write down the specific quality standards and team guidelines you would advocate for, with the rationale for each. Answers grounded in specific experience outperform generic answers at every FAANG calibration level.

The "strong answer elements" for Question 4 (code ownership, quality bar, usage guidelines, explainability, metrics, retrospectives) is a complete team AI governance framework in six bullet points. An engineer who can speak to all six elements in an interview, with concrete examples of how they implemented or would implement each one, is demonstrating the organizational thinking that distinguishes L5 candidates from L4 candidates at FAANG calibration committees.

### Senior @ FAANG: Interview Questions as Staff-Level Architecture Review Indicators

At staff level, the interview questions in this section are used differently: they are not questions asked of the candidate but questions the candidate should be asking the interviewer about the organization's current AI practices. "How does your team currently handle code ownership when AI tools are involved?" and "What is your current approach to AI usage guidelines across engineering?" reveal the organization's AI maturity level and surface the work that needs to be done. Staff engineers who ask these questions in interviews are demonstrating that they arrive with an organizational improvement agenda, not just an individual contributor skill set.

The Question 2 domain (trust and verification boundaries) is a staff-level system design topic when extended to organizational scale. The individual answer (do not trust AI for security-critical code, financial calculations, distributed systems semantics) becomes a policy question: how does the organization enforce these trust boundaries systematically? The answer involves automated linting that flags AI-generated code in sensitive paths, code review policies that require domain expert sign-off for AI-generated security code, and CI gates that run the AI code through specialized analyzers before merge. Designing this enforcement system requires understanding both the technical mechanisms and the organizational change management required to make engineers follow the policy consistently.

Question 3 (code quality standards) at staff level is the platform engineering question: how does the organization scale quality enforcement beyond individual code review? The answer is the full platform stack: golangci-lint configuration distributed via service template, AI code review automation as a PR comment bot, golden test suites for AI-generated service initializations, and quarterly quality audits that measure whether AI-generated code has higher defect rates than human-written code in the same domains. Staff engineers who can describe this enforcement stack in an interview are demonstrating that they have thought through the organizational mechanics of quality at scale, not just the individual discipline of quality in their own work.

The bar-raiser signal for AI-augmented development interviews at L6/L7 is the ability to describe the organizational feedback loop: how does the team learn from AI failures, update its usage guidelines, improve its prompt templates, and adjust its trust boundaries based on measured outcomes rather than intuition? Engineers who describe a static policy ("here is what we allow and what we prohibit") are at L5. Engineers who describe a dynamic governance system with measurement, retrospectives, and policy evolution over time are at L6. Engineers who describe how that governance system scales across multiple teams and feeds into an organization-wide AI platform roadmap are at L7.

### Question 7: Data Handling and Prompt Hygiene

**Question**: An engineer on your team is debugging a production incident and pastes a failing request payload, including real customer data and an API key from the logs, into an AI chat to ask what's wrong. What's your response, and what do you change?

**What interviewers look for**: Recognition that this is a data disclosure to a third party, not a tooling faux pas. Proportionate response, and a systemic fix rather than blame.

**Strong answer elements**:
- Name it correctly: confidential data left the organization's control and went to a third-party service. Handle it as you would any other disclosure, including rotating the exposed credential immediately, since it must now be treated as compromised
- Check the contractual reality rather than assuming: retention and training terms differ enormously between consumer tiers and enterprise agreements. "It's fine, they don't train on it" is a claim to verify in your own contract, not a default
- Respond without blame. The engineer was debugging an incident at speed with a tool that felt like a colleague. If reporting this gets someone punished, the next one goes unreported, and unreported is strictly worse
- Fix it systemically: an approved tier with the right terms, secrets kept out of the files assistants read, redaction in logs so payloads are not sitting there in the first place, and an explicit written rule in the project context file
- Be honest that this control is cultural, not technical. You cannot lint what someone pastes into a chat window. Written norms plus a blameless reporting path is the mechanism you actually have
