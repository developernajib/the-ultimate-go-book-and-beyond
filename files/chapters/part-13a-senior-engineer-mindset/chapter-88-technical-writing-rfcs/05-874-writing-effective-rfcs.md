## 88.4 Writing Effective RFCs

### Common RFC Mistakes

Even experienced engineers make predictable mistakes when writing RFCs. These mistakes are not about writing quality - they are about missing essential content or structuring the document in a way that makes it hard for reviewers to evaluate the proposal. Learning to recognize these patterns in your own drafts (and in others' drafts during review) will dramatically improve the quality of technical decisions at your organization.

```
MISTAKE 1: SOLUTION WITHOUT PROBLEM
Bad: Jumps straight into technical solution
Good: Clearly articulates the problem first

MISTAKE 2: ONE OPTION ONLY
Bad: "We should do X" without alternatives
Good: "We considered X, Y, Z. We recommend X because..."

MISTAKE 3: MISSING TRADE-OFFS
Bad: Only lists benefits
Good: Honestly addresses downsides and risks

MISTAKE 4: TOO LONG
Bad: 30 pages that no one reads
Good: Concise with details in appendix or linked docs

MISTAKE 5: VAGUE DETAILS
Bad: "We'll improve performance"
Good: "We'll reduce p99 latency from 500ms to 100ms"

MISTAKE 6: IGNORING MIGRATION
Bad: Describes end state only
Good: Explains how to get there from current state

MISTAKE 7: PREMATURE OPTIMIZATION
Bad: Over-engineered for hypothetical scale
Good: Sized for current needs with scaling path
```

### Building Consensus Through Writing

An RFC is not just a document - it is a process for building agreement among people who may have different priorities, different technical backgrounds, and different opinions about the right path forward. The best RFC authors treat consensus-building as a deliberate activity that starts before the first word is written and continues through the entire review period. The steps below outline a proven approach for each phase of the process.

```
BEFORE WRITING:
1. Talk to stakeholders informally
2. Understand objections upfront
3. Find allies who support your direction
4. Know who the decision-makers are

WHILE WRITING:
1. Address known objections explicitly
2. Give fair treatment to alternatives
3. Acknowledge uncertainty
4. Invite feedback on specific questions

DURING REVIEW:
1. Respond to every comment
2. Thank people for feedback (even critical)
3. Update the doc based on feedback
4. Summarize changes made

IF STUCK:
1. Schedule a sync meeting
2. Focus on what you agree on first
3. Identify specific sticking points
4. Propose experiments or time-boxed trials
```

### Junior → FAANG: The Seven Mistakes as a Self-Review Checklist

Before submitting an RFC for review, run through the seven common mistakes as a checklist. "Solution without problem" is the most frequently violated and the most damaging: reviewers who cannot understand the problem being solved cannot evaluate whether your solution is correct. If your RFC does not open with a clear, specific problem statement, fix that before anything else.

"One option only" and "missing trade-offs" are the two mistakes that consistently reduce RFC quality at the junior level. Engineers who have not yet developed intellectual humility tend to present their preferred solution as the only option and omit the downsides. FAANG reviewers actively look for evidence of genuine alternative consideration. An RFC with three well-researched alternatives and an honest comparison earns more trust than an RFC with one option and no acknowledgment of risk.

The consensus-building process described in this section is also interview preparation. "Talk to stakeholders informally before writing" is the behavior that prevents the most common RFC failure mode: a formally submitted RFC that generates a wave of objections that the author did not anticipate because they did not socialize it first. Building this habit makes you a more effective technical leader.

### Senior @ FAANG: RFC Quality as a Team Technical Maturity Signal

At L6 and above, the quality of RFCs your team produces is a signal of the team's technical maturity that is visible to senior leadership and peer teams.

Teams whose RFCs consistently lack "missing trade-offs" or "migration path" have a technical writing culture problem that usually reflects a deeper problem: engineers are not being rewarded for intellectual honesty, so they optimize for making proposals look good rather than helping the organization make good decisions. Staff engineers who model honest trade-off acknowledgment in their own RFCs, and explicitly praise this quality in others' RFCs during review, shift the incentive structure toward honesty.

The consensus-building process at staff level has a specific governance dimension: the "find allies who support your direction" step is not about building a coalition to override skeptics. It is about pressure-testing your thinking with people who have complementary expertise. A staff engineer who always finds allies easily should be suspicious that they are building echo chambers rather than genuinely diverse review groups. The most valuable RFC feedback comes from engineers who think differently about the problem domain.

RFC length calibration is a governance problem at scale. Organizations that normalize long RFCs, where a 20-page document is the floor rather than the exceptional case, produce reviewer fatigue that leads to rubber-stamp approvals. Staff engineers who actively drive shorter RFCs, and who invest in appendix structure and linked detail rather than inline depth, are doing review throughput optimization that benefits every RFC the organization processes.

---
