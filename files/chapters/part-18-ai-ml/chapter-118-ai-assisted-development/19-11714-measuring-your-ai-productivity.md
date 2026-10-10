## 118.14 Measuring Your AI Productivity

Productivity is not a feeling. It is a measurement. This section is last in the chapter, but if you only adopt one practice from all of it, adopt this one, because there is now direct evidence that the feeling is unreliable in a specific and humbling direction.

In METR's 2025 randomized trial, sixteen experienced open-source developers worked 246 real tasks in repositories they knew well, with and without AI tools. They finished roughly **19% slower** with AI. Afterwards, asked to estimate, those same developers said AI had made them about **20% faster**. Not novices, not people with something to prove: experienced maintainers, in their own code, wrong about their own speed by roughly 40 percentage points, in the flattering direction.

That result may or may not generalize to your work. The point is not that AI is slow. The point is that the introspective sense of "this is going faster" survived contact with a stopwatch that said otherwise, which means your sense of it is not evidence. Neither is your team's. Measure.

### What to Measure

**Cycle time** (from task start to PR merge): track this for a representative sample of tasks before and after adopting AI tools. Deliberately no target number is given here. The honest expectation is a real gain on mechanical, well-patterned work, something close to a wash on work requiring deep familiarity with an existing codebase, and a genuine possibility of a slowdown on the hardest tasks in code you know best. If you find a number, it is yours. Do not adopt anyone else's, including a vendor's.

**Rework rate** (bugs found in PR review, post-merge bugs, production incidents): watch this next to cycle time, because the pair is what tells the story. Cycle time alone can improve while the work simply moves downstream to the reviewer, the on-call engineer, or the person who inherits the code. If rework climbs, the answer is more review rigor, not less AI.

**Test coverage** (measured by your CI): If AI is generating tests properly, coverage should be stable or improving. If coverage drops, AI is generating code without tests and you're not catching it.

**Security issues found in review** (your own pre-PR security review log): Track how many security issues you find in AI-generated code over time. If the number is non-zero and not decreasing, your security review practice needs to be more rigorous.

**Time spent on boilerplate vs. architecture** (self-reported, rough estimate): before AI, what share of your coding time went to boilerplate (tests, validation, DTOs, documentation)? After, how much has that shifted? Treat this one as the softest number on the list, since it is exactly the kind of self-report METR showed to be unreliable. It is still worth tracking, because the shift in *where* your time goes is the real prize even when total time barely moves.

### Benchmarking Your AI Workflow

Every quarter, run this benchmark to see where you are:

**Task**: Implement a complete CRUD endpoint for a new resource in your main service. Include: database migration, repository layer, service layer, HTTP handler, request/response types, validation, error handling, tests for all layers.

**Measure**:
- Total time from start to passing tests
- Number of AI prompts used
- Number of review iterations required
- Lines of code written by AI vs. by you
- Security issues found in your own review
- Number of tests, coverage percentage

Track this quarterly, and write down your prediction before you start. Guessing first and comparing afterwards is what turns the benchmark into calibration data: it measures not just your workflow but how well you know your workflow. If your predictions are consistently rosier than your stopwatch, you have reproduced the METR result on a sample size of one, signaling that gut instincts should be discounted accordingly.

### When the Numbers Tell You Something is Wrong

**Cycle time decreased but rework rate increased**: You're moving faster but reviewing less carefully. Slow down the review phase. Add the critique prompt as a mandatory step.

**Coverage dropped**: AI is generating untested code and you're accepting it. Add "generate tests" to every implementation prompt.

**Security issues in review increased**: The AI is confidently generating insecure patterns. Add explicit security constraints to your prompts. Use the security review template (Template 6) before every PR.

**Prompts to completion increased over time**: this usually means CLAUDE.md has gone stale. The AI is not starting from correct context, so you spend rounds correcting it back to conventions the file should have supplied. Update CLAUDE.md.

**Every number improved and nothing feels different**: believe the numbers. The reverse case is the dangerous one.

---

### Junior → FAANG: Productivity Measurement as Engineering Maturity Signal

The ability to measure your own productivity is an engineering maturity signal that FAANG interviewers assess. Engineers who say "I'm more productive with AI" without quantifying it are asserting exactly the thing METR's participants asserted and were wrong about, and a good interviewer knows that. Engineers who say "my cycle time from task assignment to PR ready dropped from 3 days to 1.5 days over 6 months of AI tool adoption, and my PR review iteration count dropped from 2.3 to 1.8 on average" are demonstrating both measurement discipline and genuine AI-assisted productivity gains. The measurement habit that this section teaches builds the foundation for impact quantification that is required for FAANG promotion discussions.

The CLAUDE.md staleness diagnostic (prompts to completion increasing over time) is a concrete example of using measurement to diagnose process problems. Most engineers notice when their AI workflow becomes less efficient but cannot diagnose why without measurement. Tracking prompts-to-completion per task type creates the data needed to distinguish "this task type requires more iteration because it is inherently complex" from "this task type requires more iteration because CLAUDE.md is missing context for it." This data-driven diagnosis is the approach FAANG engineers are expected to apply to operational problems.

Start measuring now, even if the measurement is as simple as a personal spreadsheet with columns for task description, task type, time to PR ready, and number of AI prompt iterations. Six months of this data is a portfolio artifact that demonstrates both productivity and measurement discipline. The data will also tell you which task categories benefit most from AI assistance, which is information you need to allocate AI tool usage strategically.

### Senior @ FAANG: AI Productivity Measurement as Engineering Metrics Platform

At senior level, AI productivity measurement is an organizational metrics platform, not a personal spreadsheet. The DORA metrics (deployment frequency, lead time for changes, mean time to recovery, change failure rate) provide the baseline framework for measuring engineering productivity. AI tool adoption should move the needle on lead time for changes (shorter cycle time from PR creation to merge) and potentially on change failure rate (if AI-assisted code review catches defects before they reach production). Measuring these metrics before and after AI tool adoption, controlling for other changes, provides the evidence base for continued investment in AI tools.

The diagnostic section at the end of this file (high prompts-to-completion indicating stale CLAUDE.md) is the template for an organizational AI productivity diagnostic process. When a team's AI-assisted productivity is below expectations, the diagnostic questions are: is CLAUDE.md current? Are engineers using the correct task-type tool selection (high-complexity tasks use full-context tools, not inline completion)? Are engineers specifying constraints before generating or accepting the first plausible output? Are engineers applying the review checklist or skimming? Each diagnostic question has a corresponding intervention (update CLAUDE.md, train on tool selection, coach on prompting discipline, enforce the review checklist in code review). A staff engineer who can run this diagnostic for a team and implement the interventions is providing the organizational AI productivity improvement that justifies the platform investment in AI tools.
