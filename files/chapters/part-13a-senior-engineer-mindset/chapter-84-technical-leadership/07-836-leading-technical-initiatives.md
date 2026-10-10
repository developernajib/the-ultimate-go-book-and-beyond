## 84.6 Leading Technical Initiatives

### Initiative Lifecycle

Leading a technical initiative is fundamentally different from completing a task or even owning a feature. An initiative spans weeks or months, involves multiple people and teams, and requires you to manage the full lifecycle from identifying the problem through to maintaining the solution. The seven-phase lifecycle below gives you a repeatable playbook. Most failed initiatives skip one or more of these phases, typically the "Define" phase (rushing into building before the problem is clear) or the "Maintain" phase (declaring victory and walking away before the solution is stable).

```
┌──────────────────────────────────────────────────────────────────┐
│              TECHNICAL INITIATIVE LIFECYCLE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. IDENTIFY                                                     │
│     ├── Recognize the problem or opportunity                     │
│     ├── Validate that it's worth solving                         │
│     └── Get initial stakeholder interest                         │
│                                                                  │
│  2. DEFINE                                                       │
│     ├── Write clear problem statement                            │
│     ├── Define success criteria                                  │
│     ├── Identify constraints and requirements                    │
│     └── Initial scoping                                          │
│                                                                  │
│  3. PROPOSE                                                      │
│     ├── Write RFC/design doc                                     │
│     ├── Gather feedback from stakeholders                        │
│     ├── Address concerns and iterate                             │
│     └── Get formal approval                                      │
│                                                                  │
│  4. PLAN                                                         │
│     ├── Break into workstreams                                   │
│     ├── Identify dependencies                                    │
│     ├── Assign owners (not necessarily yourself)                 │
│     └── Set milestones and checkpoints                           │
│                                                                  │
│  5. EXECUTE                                                      │
│     ├── Lead without doing everything yourself                   │
│     ├── Unblock contributors                                     │
│     ├── Track progress and communicate status                    │
│     └── Adjust plans as needed                                   │
│                                                                  │
│  6. LAND                                                         │
│     ├── Complete rollout                                         │
│     ├── Measure against success criteria                         │
│     ├── Document outcomes and learnings                          │
│     └── Celebrate wins, acknowledge contributors                 │
│                                                                  │
│  7. MAINTAIN                                                     │
│     ├── Ensure ongoing ownership                                 │
│     ├── Address issues and iterate                               │
│     └── Plan for evolution or deprecation                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Example: Leading an Observability Initiative

To make the initiative lifecycle concrete, here is a realistic example of leading an observability platform initiative from start to finish. Notice how each phase builds on the previous one, and how the timeline spans roughly six months. Pay attention to how the leader delegates workstreams to others rather than trying to build everything themselves, this is a hallmark of effective technical leadership at the staff level and above.

```
INITIATIVE: Implement full observability platform

PHASE 1: IDENTIFY (Week 1-2)
- Document current observability gaps
- Gather incident data showing impact
- Get buy-in from SRE lead and engineering manager

PHASE 2: DEFINE (Week 3-4)
- Write problem statement with metrics
- Success criteria: MTTD < 5 min, MTTR < 30 min
- Constraints: Must work with existing infra

PHASE 3: PROPOSE (Week 5-8)
- Write RFC with 3 options (build vs buy vs hybrid)
- Present at architecture review
- Incorporate feedback, get approval for Option B

PHASE 4: PLAN (Week 9-10)
- Workstream 1: Metrics (Maria leads)
- Workstream 2: Logging (Bob leads)
- Workstream 3: Tracing (Chen leads)
- Workstream 4: Dashboards (You lead)
- Milestone: Pilot on auth service by Week 16

PHASE 5: EXECUTE (Week 11-20)
- Weekly sync with workstream leads
- Bi-weekly update to stakeholders
- Address blockers (procurement, training, etc.)

PHASE 6: LAND (Week 21-24)
- Roll out to all services
- Measure: MTTD now 3 min (target met)
- Document runbooks and training materials
- Present results at engineering all-hands

PHASE 7: MAINTAIN (Ongoing)
- Transfer to SRE team ownership
- Quarterly review of metrics
- Roadmap for next features
```

### Junior → FAANG: Running Your First Technical Initiative

The first time you lead a technical initiative, the most common mistake is underinvesting in the scoping phase. Engineers who are excited to build tend to jump into implementation before the problem is fully understood and the scope is agreed on. By the time the misalignment surfaces, the team has wasted weeks on the wrong thing.

For FAANG interviews, have a concrete example where you led a technical initiative from problem definition through completion. The story should cover: how you defined success, how you broke the work down, how you coordinated with stakeholders, and what you would do differently. The "what would you do differently" part is where maturity shows. The candidate who says "nothing, it went well" reads as low self-awareness. The candidate who says "I underestimated the integration complexity with Team X and would have done a joint discovery session earlier" reads as someone who learned from the experience.

One specific preparation item: be able to describe how you handled a scope change mid-initiative. Almost every real project encounters this. The ability to replan without losing the team's confidence is a concrete leadership skill that FAANG interviewers value.

### Senior @ FAANG: Technical Initiative Leadership at Org Scale

At staff and principal level, the initiatives you lead are multi-team, multi-quarter, and often multi-year. The lifecycle described in this section still applies, but every phase is significantly more complex. Scoping requires negotiating across teams with competing priorities. Planning requires managing dependency chains that span organizations. Execution requires maintaining alignment when team composition changes and priorities shift. Retrospective requires distilling learnings into durable org improvements, not just lessons learned for your own team.

The most important skill at this scale is not project management discipline, though that is necessary. It is maintaining technical clarity and momentum under organizational pressure. Every large initiative hits a point where timelines are at risk, stakeholders are anxious, and there is pressure to cut scope in ways that will create future technical debt. The staff engineer who can hold the line on architectural integrity while still navigating the business constraints, and who can articulate the long-term cost of every tradeoff being proposed, is operating at the level that principal engineer titles require.

Document the initiative architecture as you go. When you exit the initiative (through completion, through rotation, or through organizational change), the team you leave behind should have enough documented context to maintain, extend, and evolve the system without needing to reconstruct your reasoning through archaeology. This is a form of technical leadership that pays dividends long after the initiative is complete.

---
