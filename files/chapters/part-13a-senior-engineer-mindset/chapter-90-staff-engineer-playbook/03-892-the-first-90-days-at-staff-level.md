## 90.2 The First 90 Days at Staff Level

### Transition Challenges

The transition from senior to staff is one of the most disorienting career shifts in software engineering because the metrics of success change fundamentally. What made you successful as a senior engineer, such as high code output and clear task execution, is no longer sufficient at staff level. Understanding these common challenges upfront helps you recognize them as normal parts of the transition rather than signs that you are failing.

```
┌──────────────────────────────────────────────────────────────────┐
│              COMMON STAFF TRANSITION CHALLENGES                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. LESS STRUCTURE                                               │
│     Senior: Clear tasks, defined scope                           │
│     Staff: Find your own work, define your own scope             │
│     Tip: Create your own structure and priorities                │
│                                                                  │
│  2. LESS IMMEDIATE FEEDBACK                                      │
│     Senior: PR merged, feature shipped, visible progress         │
│     Staff: Impact takes months, less tangible output             │
│     Tip: Define intermediate milestones                          │
│                                                                  │
│  3. MORE AMBIGUITY                                               │
│     Senior: Requirements provided                                │
│     Staff: You define the requirements                           │
│     Tip: Embrace ambiguity as the job, not obstacle              │
│                                                                  │
│  4. MORE MEETINGS                                                │
│     Senior: Code most of the day                                 │
│     Staff: Meetings, 1:1s, reviews fill calendar                 │
│     Tip: Protect coding time, be selective about meetings        │
│                                                                  │
│  5. IMPOSTER SYNDROME                                            │
│     "Do I belong here?" "Everyone else seems smarter"            │
│     Tip: You were promoted for a reason, give yourself time      │
│                                                                  │
│  6. VISIBILITY PRESSURE                                          │
│     Senior: Your manager saw your work                           │
│     Staff: Many leaders need to see your impact                  │
│     Tip: Proactively share work, write about it                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### First 90 Days Plan

Your first 90 days at staff level set the foundation for your long-term success in the role. The plan below follows a deliberate progression: first listen and learn, then contribute and build credibility, and finally lead and influence. Rushing straight to "leading" without the listening phase is one of the most common mistakes new staff engineers make, because you need context and relationships before your opinions carry weight.

```
DAYS 1-30: LISTEN AND LEARN

Week 1-2:
□ Meet with manager to understand expectations
□ Review org chart and key stakeholders
□ Read recent RFCs, design docs, ADRs
□ Understand current technical strategy

Week 3-4:
□ 1:1s with team leads across your scope
□ Understand current pain points
□ Identify quick wins (visible, low risk)
□ Start building relationships

DAYS 31-60: CONTRIBUTE AND BUILD

Week 5-6:
□ Deliver on one quick win
□ Propose one improvement (RFC or initiative)
□ Attend architecture reviews, participate
□ Mentor at least one engineer

Week 7-8:
□ Lead or heavily contribute to design review
□ Identify longer-term opportunity
□ Build coalition for proposed improvement
□ Share learnings (blog post, tech talk)

DAYS 61-90: LEAD AND INFLUENCE

Week 9-10:
□ Own decision on meaningful technical issue
□ Drive one initiative from proposal to progress
□ Establish regular 1:1s with key stakeholders
□ Check in with manager on perception

Week 11-12:
□ Define your 6-month focus areas
□ Get buy-in on your priorities
□ Set measurable goals
□ Reflect on what's working, adjust
```

### Junior → FAANG: Applying the 90-Day Framework Before You Are Staff

The 90-day onboarding pattern is useful even at junior levels. When you join a new team, the instinct is to start shipping as quickly as possible to prove you belong. That instinct leads to shipping the wrong things. Spend the first 30 days listening: read the codebase, shadow oncall, attend cross-team syncs without speaking. Write down everything that seems broken or surprising. At 30 days, you have a list that senior engineers on the team have stopped seeing because familiarity has made it invisible. That list is disproportionately valuable.

The 30-60 phase, proposing and getting buy-in, teaches you a skill critical to staff work: making a recommendation that survives contact with people who have different incentives than you. Practice writing short proposals (one page) that state the problem, the options, the recommendation, and the expected outcome. The habit of writing proposals before acting is what distinguishes senior engineers from staff engineers more reliably than any technical skill.

### Senior @ FAANG: Why the First 90 Days at Staff Determines the Next Three Years

New staff engineers at FAANG who skip listening and rush to deliver fall into a failure pattern that is almost impossible to recover from in the first year: they establish a reputation as someone who ships fast but does not understand the org. That reputation filters the problems they get brought into, which filters their impact, which filters their promo case. The 90-day investment in listening is not a soft-skills nicety. It is the highest-value technical decision of the first year.

The "identify the most important problem" phase requires a skill that is not taught in most engineering programs: qualitative research across organizational boundaries. The best staff engineers in their first 90 days conduct structured listening tours, interviewing 15 to 30 engineers and engineering managers across adjacent teams with a consistent set of questions about where they feel blocked, what technical debt keeps resurfacing in incidents, and what work nobody is chartered to do. The pattern analysis across those interviews is where the most valuable insights emerge.

At Google, new L6 hires are explicitly told that the first 90 days should produce a written "state of the domain" document, not a shipped feature. That document, shared with the engineering director, is the artifact that calibrates the org's expectations for the staff engineer's scope and establishes early credibility. Engineers who skip this step because they are eager to show technical productivity often find themselves re-explaining their value at their first performance review.

ADR implication: the first major technical decision a new staff engineer makes should be documented formally. Not because the decision is necessarily more important than previous decisions, but because the document demonstrates how the engineer reasons, consults, evaluates tradeoffs, and communicates. It is the first data point the org has for assessing whether this engineer's judgment can be trusted at scale.

---
