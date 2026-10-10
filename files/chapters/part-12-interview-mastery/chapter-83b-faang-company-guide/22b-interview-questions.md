## 83B.21 Interview Questions

Five FAANG-style questions that probe knowledge of company-specific interview processes.

### Q1 (Amazon): How does Amazon weight Leadership Principles versus coding bar in an SDE-II loop, and how do you prepare for that mix?

**Answer:** Amazon runs a 5-round loop where every interviewer is assigned 2-3 Leadership Principles (LPs) to probe, alongside coding or system design. The bar raiser is LP-focused and can veto a hire even with strong code. Prepare a STAR story bank covering at least the 8 most-tested LPs (Customer Obsession, Ownership, Bias for Action, Deliver Results, Dive Deep, Invent and Simplify, Are Right A Lot, Earn Trust). Each story should map cleanly to 2-3 LPs. Coding expectations sit at LeetCode medium with one hard, but communication of trade-offs in the LP frame matters as much as the optimal solution.

### Q2 (Google): Why does Google emphasize "Googleyness" and how is it evaluated separately from technical signal?

**Answer:** Googleyness covers intellectual humility, comfort with ambiguity, collaboration, and bias toward learning. It is scored independently in the packet that goes to the hiring committee. Interviewers tag specific moments (asking clarifying questions, admitting uncertainty, building on hints) as Googleyness signal. The hiring committee can downgrade a strong-coding candidate if Googleyness scores are weak. Practice thinking aloud, narrating uncertainty without panic, and treating the interviewer as a collaborator.

### Q3 (Meta): How does Meta's "product sense" round differ from a system design round at Google?

**Answer:** Meta's product round (for senior+ ICs and EMs) tests whether you can pick the right user problem, define metrics, and reason about trade-offs in a Meta-style product surface (feed, messaging, ads). System design at Google emphasizes scale math, storage choice, and consistency models. At Meta, you can ace the architecture and still fail the product round if you cannot justify why a feature should exist. Prepare with the CIRCLES framework (Comprehend, Identify, Report needs, Cut features, List solutions, Evaluate, Summarize).

### Q4 (Netflix): Why does Netflix avoid algorithm puzzles and what does that mean for preparation?

**Answer:** Netflix hires senior-only and runs deep technical conversations rather than LeetCode. Expect detailed dives into past systems you built, on-call incidents you owned, and architectural decisions you made. Prepare three to five projects you can discuss for 45 minutes each, including failure modes, alternatives considered, and metrics. The "Keeper Test" culture means the bar is whether the team would fight to keep you, so demonstrate force-multiplier impact.

### Q5 (Apple): How should you approach the Apple team-matching loop given its decentralized hiring?

**Answer:** Apple loops are run by individual teams with no centralized rubric, so signal can vary widely. The same candidate may face deep low-level systems questions on one team and product-focused discussion on another. Research the team's domain before the loop, ask the recruiter about the interviewer mix, and tailor stories to the team's stack. Apple values secrecy and craft, so emphasize attention to detail and willingness to own a problem end to end.


### Junior → FAANG: Practice Questions for FAANG Company Knowledge

Practice questions for company-specific knowledge test whether you can connect general engineering principles to the specific constraints of each company's business and technical environment. For each question, practice answering in the specific company's cultural register: Amazon answers reference LPs, Google answers reference scale and first-principles thinking, Meta answers reference product impact and speed. The mechanical answer (correct engineering) is necessary but not sufficient. The cultural register (delivered in the company's values language) is what creates the impression of genuine fit.

### Senior @ FAANG: Company Interview Questions as a Calibration Tool

Senior candidates should use these practice questions to calibrate the scope of their answers against the target level. An L6-level answer to 'how would you design the Twitter timeline?' should cover: capacity estimation that drives the fan-out decision, an explicit trade-off analysis of hybrid fan-out strategy, the consistency model for timeline delivery, and monitoring and SLO definition. If your practice answer stops at high-level architecture without reaching these dimensions, you are answering at L4/L5 scope. Run through each question with a timer and a rubric: did you cover capacity, trade-offs, consistency, and observability? If any dimension is missing, identify why and build a habit of including it.
