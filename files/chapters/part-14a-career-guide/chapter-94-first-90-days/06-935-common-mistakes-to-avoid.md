## 94.5 Common Mistakes to Avoid

New hires tend to fall into the same set of traps regardless of their experience level or the company they join. Understanding these anti-patterns before you start helps you recognize them in your own behavior and course-correct early. Most of these mistakes come from good intentions, wanting to prove yourself, not wanting to bother people, or trying to add value quickly, but they backfire because they ignore the social dynamics of joining an established team.

```
┌──────────────────────────────────────────────────────────────────┐
│              NEW HIRE ANTI-PATTERNS                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. TRYING TO CHANGE EVERYTHING IMMEDIATELY                      │
│     "At my last company we did it better..."                     │
│     → Wait 90 days before proposing major changes                │
│     → Understand WHY things are the way they are                 │
│                                                                  │
│  2. NOT ASKING ENOUGH QUESTIONS                                  │
│     Afraid to look dumb                                          │
│     → It's expected that you'll ask questions                    │
│     → Better to ask than to guess wrong                          │
│                                                                  │
│  3. ASKING WITHOUT TRYING FIRST                                  │
│     Immediately asking how to do everything                      │
│     → Try to figure it out first (15-30 min)                     │
│     → Ask with context: "I tried X and Y..."                     │
│                                                                  │
│  4. ISOLATING YOURSELF                                           │
│     Heads down, no relationship building                         │
│     → Schedule 1:1s proactively                                  │
│     → Join team social activities                                │
│                                                                  │
│  5. OVERPROMISING                                                │
│     Saying yes to everything to impress                          │
│     → Be realistic about what you can deliver                    │
│     → Under-promise, over-deliver                                │
│                                                                  │
│  6. NOT DOCUMENTING                                              │
│     Not writing down what you learn                              │
│     → Keep notes on everything                                   │
│     → Improve documentation as you learn                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: The Mistakes That Damage Reputation Earliest

The most damaging early-career mistake is not technical: it is over-claiming competence and then under-delivering. When asked "can you handle this," the correct answer is almost always "I think so, let me try it and flag to you if I run into something I am unsure about" rather than an unqualified yes. Unqualified yes followed by a missed deadline or incomplete work damages credibility in a way that is slow to recover. Honest assessment of your current capability followed by successful delivery builds it rapidly.

The second most damaging mistake is invisible struggling. If you are stuck on something for more than two hours, ask for help. FAANG teams are resourced to support onboarding engineers and expect them to need guidance. An engineer who spends a week silently stuck on a problem is not seen as independent: they are seen as not knowing when to ask for help, which is itself a capability gap.

The specific mistake that many Go engineers make is writing idiomatic Go from a different language's mental model. If you are coming from Java or Python, your instinct for abstractions, error handling, and concurrency will not map correctly to Go idioms. Read the Go standard library and the team's existing code before writing new code. Mirroring existing patterns is safer than introducing new ones during your first 90 days.

### Senior @ FAANG: Senior-Level Mistakes and the Overconfidence Trap

The most common senior-level mistake in the first 90 days is moving too fast on technical changes before building organizational credibility. A senior engineer who arrives with genuine expertise and proposes significant architectural changes in the first month will encounter resistance that is not about the technical merits of the proposal. It is about the social and organizational capital required to drive changes in an established system. That capital takes time to build and cannot be shortcut.

The second significant senior-level mistake is underestimating the political complexity of technical decisions at scale. In a small company, a technically superior approach typically wins on its merits. In a large FAANG organization, a technically superior approach can lose to a technically inferior one if the inferior approach has more stakeholder alignment, lower migration cost, or stronger executive sponsorship. Senior engineers who enter a new organization expecting meritocratic technical decision-making often waste political capital on technical arguments when the real blocker is organizational, and then wonder why their clearly correct proposals are not adopted.

The governance practice that mitigates this: before proposing any significant technical change in your first 90 days, identify all the stakeholders whose buy-in is required for the change to succeed, understand each stakeholder's incentives and concerns, and develop a rollout plan that addresses those concerns explicitly. This is not compromise: it is the operating model for driving change at scale.

---
