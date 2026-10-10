## 107.13 Interview Insights

**Common Security Questions at FAANG**:

- "How do you prevent SQL injection in Go?" → Show parameterized queries
- "Explain CSRF and how to prevent it" → Token-based validation
- "What security headers should a production API set?" → CSP, HSTS, X-Frame-Options
- "How would you implement rate limiting?" → Token bucket algorithm
- "What's the difference between crypto/rand and math/rand?" → Cryptographic security

**Red Flags in Interviews**:
- Not knowing about parameterized queries
- Using `text/template` for HTML
- No mention of input validation
- Unfamiliarity with OWASP Top 10

### Junior → FAANG: Preparing for Security Interview Questions

Security questions in FAANG interviews are designed to reveal whether you have real-world security thinking or only surface-level familiarity. The questions listed above have expected answer structures that experienced interviewers recognize.

**Gap to close:** For each question above, practice a structured answer that covers: what the risk is, how it manifests in Go specifically, the primary defense, and a secondary defense (defense in depth). Answers that stop at one layer are L3 answers. Answers that describe layered defenses are L4/L5 answers.

**Red flags to avoid:** The red flags listed above are instant interview signals. If you use `text/template` for HTML output in any whiteboard exercise, the interviewer will note it immediately. Practice using `html/template` in your code examples consistently so it is habitual.

**Interview prep habit:** Do one security-focused code review per week. Find open-source Go projects on GitHub, read recent PRs, and identify any security concerns. This builds the pattern recognition that lets you spot issues quickly in an interview setting.

### Senior @ FAANG: What Bar-Raisers Look For in Security Interviews

Bar-raisers at FAANG companies are not satisfied with correct technical answers alone. They are evaluating whether you raise the security bar for the team, not just meet it personally.

**The "how do you scale this?" follow-up:** After you answer any security question correctly, a bar-raiser will ask: "How do you make sure everyone on your team does this?" Prepare for this follow-up. The answer involves shared libraries, lint rules, PR templates, training programs, and metrics. Candidates who answer only the technical question and cannot articulate organizational scaling are evaluated as strong individual contributors but not as multipliers.

**Design question depth:** Senior security design questions at FAANG assess your ability to reason about trade-offs. "Design a rate limiting system for our API" has multiple correct answers with different trade-offs. The evaluation is on the trade-off reasoning: can you articulate why you chose Redis over in-process limiting? Can you explain the failure mode when Redis is unavailable and the business implications of fail-open vs fail-closed? The decision itself matters less than the reasoning process.

**Incident-based questions:** "Tell me about a security incident you handled" is a bar-raiser favorite. Prepare a story with: the initial signal (how was it detected?), the investigation (how did you determine scope?), the immediate mitigation, the root cause, and the systemic fix. Stories that include a process change or a technical control that prevented recurrence are L6 stories. Stories that include only the tactical fix are L4 stories.

**Cross-functional thinking:** Staff-level security interview questions test whether you think across product, legal, compliance, and engineering. "A critical vulnerability is discovered in a customer-facing feature. Walk me through your response." The answer must include: technical remediation, customer communication (coordinated with legal and PR), regulatory notification if required, and post-incident process improvement. An answer that covers only the technical remediation is incomplete at L6+.

---
