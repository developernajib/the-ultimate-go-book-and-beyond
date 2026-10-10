## 85.5 System Archetypes

### Common System Patterns

System archetypes are recurring structural patterns that produce predictable behavior across different domains. Recognizing which archetype is at work in a situation is powerful because each archetype has a known leverage point: "Shifting the Burden" tells you to stop treating the symptom and fix the root cause, while "Tragedy of the Commons" tells you to make the shared resource and its governance explicit. The six archetypes below cover the most common patterns encountered in software engineering organizations.

```
┌──────────────────────────────────────────────────────────────────┐
│                   SYSTEM ARCHETYPES                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. LIMITS TO GROWTH                                             │
│     Pattern: Growth hits a constraint                            │
│     Tech example: Scaling hits database limits                   │
│     Solution: Identify and address the constraint early          │
│                                                                  │
│  2. SHIFTING THE BURDEN                                          │
│     Pattern: Quick fix weakens fundamental solution              │
│     Tech example: Adding cache to fix slow queries               │
│                   instead of fixing the queries                  │
│     Solution: Address root cause, not just symptoms              │
│                                                                  │
│  3. ERODING GOALS                                                │
│     Pattern: Standards slip under pressure                       │
│     Tech example: "We'll add tests later" becomes never          │
│     Solution: Maintain standards explicitly                      │
│                                                                  │
│  4. ESCALATION                                                   │
│     Pattern: Competing actions lead to arms race                 │
│     Tech example: Teams add more caching, all competing          │
│                   for same resources                             │
│     Solution: Collaborative optimization                         │
│                                                                  │
│  5. SUCCESS TO THE SUCCESSFUL                                    │
│     Pattern: Winner gets more resources, widens gap              │
│     Tech example: Popular service gets all investment,           │
│                   others starve                                  │
│     Solution: Intentional resource allocation                    │
│                                                                  │
│  6. TRAGEDY OF THE COMMONS                                       │
│     Pattern: Individual optimization degrades shared resource    │
│     Tech example: Each team adds logging, fills disk             │
│     Solution: Manage shared resources explicitly                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Applying Archetypes

When you encounter a persistent problem, one that keeps returning despite repeated fixes, the archetype framework gives you a structured way to diagnose the underlying structure. The case below works through a common situation: a system that keeps getting slower despite optimizations. Running through each archetype systematically reveals whether you are hitting a fundamental limit, applying a symptomatic fix that is weakening the real solution, or dealing with eroding quality standards under delivery pressure.

```
CASE: System Performance Degradation

SYMPTOM:
"The system keeps getting slower despite our optimizations"

ARCHETYPE ANALYSIS:

1. LIMITS TO GROWTH?
   - Are we hitting infrastructure limits?
   - Check: Database connections, network bandwidth, memory

2. SHIFTING THE BURDEN?
   - Are we patching symptoms instead of root causes?
   - Example: Adding cache instead of fixing N+1 queries

3. ERODING GOALS?
   - Have performance standards slipped?
   - Example: "Good enough" latency keeps increasing

4. TRAGEDY OF THE COMMONS?
   - Is shared infrastructure being abused?
   - Example: Everyone logs to same Elasticsearch

DIAGNOSIS:
After analysis, found:
- Shifting the Burden: Multiple caching layers hide bad queries
- Tragedy of the Commons: Logging overwhelming shared infra

INTERVENTIONS:
1. Query review process (address root cause)
2. Log sampling and quotas per service (manage commons)
3. Performance budgets per endpoint (prevent eroding goals)
```

### Junior → FAANG: Using Archetypes to Pattern-Match in Interviews

System archetypes are cognitive shortcuts for recognizing structural problems quickly. When you can identify "this is a tragedy of the commons" or "this is escalation" in a system design interview, you can immediately propose the correct structural intervention rather than fumbling toward a solution.

Practice pattern-matching your existing systems against the archetypes in this section. Most production systems exhibit at least two or three. The tragedy of the commons appears in any shared resource without usage quotas. Escalation appears in any competitive caching or rate-limiting interaction. Eroding goals appears in any team that progressively accepts worse performance metrics over time.

In an interview, naming the archetype before proposing the solution demonstrates structural thinking: "This looks like a tragedy of the commons pattern, where the shared database is being treated as a free resource. The structural fix is to introduce per-service quotas with a governance process for exceptions."

### Senior @ FAANG: Archetypes as Organizational Diagnostic Tools

At staff level, system archetypes apply not just to technical systems but to organizational systems. "Fixes that fail" is a common organizational archetype: a team resolves a crisis by adding headcount, which reduces the pressure to fix the underlying process, which means the crisis recurs at higher cost. "Shifting the burden" appears when infrastructure teams solve developer problems by adding tooling layers rather than improving developer capability.

Recognizing these organizational archetypes allows staff engineers to propose structural interventions rather than symptomatic fixes. The conversation shifts from "we need more oncall rotation members" to "we need to address the underlying reliability deficit that is making oncall unsustainable." That structural framing is the difference between a senior engineer recommendation and a staff engineer recommendation.

---
