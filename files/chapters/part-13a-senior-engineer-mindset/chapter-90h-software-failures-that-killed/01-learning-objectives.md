## Learning Objectives

1. **Understand how software defects cause physical harm** - Trace the causal chain from code-level bugs through
   system-level failures to real-world consequences, developing intuition for which software defects can cross the
   digital-physical boundary
2. **Build safety interlock systems** - Implement mutex-based, channel-based, and state-machine-based safety
   interlocks in Go that make unsafe system states unrepresentable at the type level
3. **Implement redundant sensor voting** - Build N-modular redundancy systems in Go with Byzantine fault tolerance
   for sensor fusion in safety-critical applications
4. **Prevent numerical errors** - Use Go's type system, monotonic clocks, and safe conversion functions to prevent
   the classes of floating-point and integer overflow errors that have destroyed spacecraft and killed soldiers
5. **Design type-safe domain models** - Create Go types that encode physical units, safety constraints, and domain
   invariants so that entire categories of errors become compile-time failures
6. **Build concurrent alarm systems** - Implement alarm processing pipelines in Go that maintain correctness under
   concurrent load and never silently drop critical alerts
7. **Recognize organizational failure patterns** - Identify the management antipatterns, schedule pressure dynamics,
   and normalization of deviance that consistently precede safety-critical software failures
8. **Apply ethical reasoning to software decisions** - Develop a framework for identifying and responding to
   situations where you are asked to write software that is unsafe, unethical, or deceptive

---

### Junior → FAANG: Which Objectives to Prioritize First

Objectives 2, 3, and 4 (safety interlocks, redundant sensor voting, numerical error prevention) produce the most concrete interview and portfolio material. A Go implementation of a mutex-based safety interlock that makes unsafe states unrepresentable at the type level is a distinct portfolio artifact that most candidates do not have. It demonstrates both concurrency discipline and domain modeling skill simultaneously. Objective 7 (organizational failure patterns) is the highest-value objective for behavioral interviews: the management antipatterns in this chapter (schedule pressure overriding engineer safety concerns, normalization of deviance, single person holding critical knowledge) map directly to FAANG behavioral questions about handling disagreement with management, raising quality concerns, and pushing back on unrealistic deadlines.

### Senior @ FAANG: Objectives 7 and 8 as Staff Engineer Core Competencies

At L6, objectives 7 and 8 are not supplementary: they are the primary competencies that distinguish staff engineers from senior engineers in safety-adjacent domains. Recognizing organizational failure patterns means you can identify when your team is in the early stages of the normalization of deviance that precedes every catastrophic failure in this chapter: the first time a known defect is deferred because of schedule pressure, the first time a test suite is weakened to make a deadline, the first time a safety interlock is bypassed "temporarily." The staff engineer's job is to intervene at the first instance, not after the pattern has normalized. Objective 8 (ethical reasoning) is a bar-raiser competency: FAANG bar-raisers ask about situations where you disagreed with a product or technical direction on ethical grounds. The Volkswagen case (objective 8) is the most extreme example in this chapter, but the ethical obligation to refuse to write software you know is unsafe or deceptive applies at every scale.
