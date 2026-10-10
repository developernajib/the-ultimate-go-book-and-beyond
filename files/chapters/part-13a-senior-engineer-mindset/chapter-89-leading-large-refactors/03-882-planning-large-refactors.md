## 89.2 Planning Large Refactors

### The Refactoring Plan

A large refactor without a plan is just chaos with good intentions. Before writing any code, you need to answer five categories of questions: what exactly is changing (and what is not), what can go wrong, how you will migrate incrementally, who is doing the work, and how you will keep everyone informed. Skipping any of these categories is how refactors get abandoned halfway through, leaving the codebase in a worse state than before. The following template is the minimum planning structure you should create for any refactor expected to take more than two weeks.

```
┌──────────────────────────────────────────────────────────────────┐
│              LARGE REFACTOR PLANNING                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SCOPE DEFINITION                                             │
│     ├── What exactly are we changing?                            │
│     ├── What are we NOT changing?                                │
│     ├── What is the end state?                                   │
│     └── How do we know we're done?                               │
│                                                                  │
│  2. RISK ASSESSMENT                                              │
│     ├── What can go wrong?                                       │
│     ├── What's the blast radius of failure?                      │
│     ├── How do we detect problems?                               │
│     └── How do we roll back?                                     │
│                                                                  │
│  3. MIGRATION STRATEGY                                           │
│     ├── Big bang vs gradual migration?                           │
│     ├── What's the transition path?                              │
│     ├── How do we handle the hybrid state?                       │
│     └── What are the milestones?                                 │
│                                                                  │
│  4. RESOURCE PLANNING                                            │
│     ├── Who is working on this?                                  │
│     ├── How long will it take?                                   │
│     ├── What feature work is impacted?                           │
│     └── Who approves the investment?                             │
│                                                                  │
│  5. COMMUNICATION                                                │
│     ├── Who needs to know?                                       │
│     ├── How do we track progress?                                │
│     ├── How do we handle blockers?                               │
│     └── How do we celebrate completion?                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Migration Strategies

There are four main strategies for migrating from an old system to a new one, and choosing the wrong one is a common cause of migration failure. Big bang rewrites are the most tempting but carry the highest risk because everything changes at once. Parallel run, strangler fig, and feature flag approaches each trade longer timelines for lower risk by allowing you to validate the new system incrementally. Understanding when to use each strategy is one of the most important decisions you will make as a migration lead.

```
┌──────────────────────────────────────────────────────────────────┐
│                MIGRATION STRATEGIES                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BIG BANG                                                        │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ Old System ──────────────X──────────── New System       │     │
│  │                          ↑                              │     │
│  │                     Cutover                             │     │
│  └─────────────────────────────────────────────────────────┘     │
│  Good: Simpler, no hybrid state                                  │
│  Bad: High risk, extended downtime, big blast radius             │
│  Use when: Low risk, small system, or no gradual path            │
│                                                                  │
│  PARALLEL RUN                                                    │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ Old System ──────────────────────────────────────────── │     │
│  │                                                         │     │
│  │            New System (read only, compare) ──────────── │     │
│  └─────────────────────────────────────────────────────────┘     │
│  Good: Validate before switch, catch discrepancies               │
│  Bad: Double compute cost, comparison complexity                 │
│  Use when: Critical data, need high confidence                   │
│                                                                  │
│  STRANGLER FIG                                                   │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ Old ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    │     │
│  │ New ░░░░░░░░░░░░░░░░████████████████████████████████    │     │
│  │     Start              Gradual                 Done     │     │
│  └─────────────────────────────────────────────────────────┘     │
│  Good: Incremental, low risk, reversible                         │
│  Bad: Hybrid state complexity, longer timeline                   │
│  Use when: Large system, can't afford downtime                   │
│                                                                  │
│  FEATURE FLAG                                                    │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │ Request → Flag → Old (90%) / New (10%) → Gradual → New  │     │
│  └─────────────────────────────────────────────────────────┘     │
│  Good: Gradual rollout, easy rollback, A/B comparison            │
│  Bad: Flag maintenance, code complexity                          │
│  Use when: Can run both paths, need safe rollout                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Planning as Interview Evidence

The planning checklist in this section is exactly what FAANG interviewers probe with "walk me through how you would approach migrating X." Your answer should cover scope definition, strategy selection with a stated rationale, rollback design, stakeholder identification, and success criteria. Candidates who skip any of these categories read as junior. Practice narrating the full planning arc in under three minutes, because that is the time you have before the interviewer interrupts.

### Senior @ FAANG: Planning as a Scalable Artifact

At L6, the migration plan is not a document you write once. It is a template you create so that the next team can run a comparable migration with 20 percent of the planning effort you invested. The investment in a reusable planning template, with pre-filled risk categories, a standard success-metrics table, and a checklist of discovery steps, is the kind of organizational leverage that gets cited in promotion packets. Ask yourself: if you ran this refactor perfectly but left no reusable artifact, what did the organization learn?

The go/no-go criteria table in this chapter is a governance artifact. At staff level, you should be defining the go/no-go criteria for migration phases across your org, not just for your own project. Standardizing these criteria means that rollback decisions are made on data, not on the judgment of whoever happens to be on call at 2 AM.

---
