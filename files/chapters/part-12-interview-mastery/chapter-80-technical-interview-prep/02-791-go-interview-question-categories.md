## 80.1 Go Interview Question Categories

### Understanding What Interviewers Look For

Go interviews are deliberately layered: early rounds test whether a candidate knows the language, while later rounds probe whether they think in Go idioms rather than translating habits from other languages. Interviewers distinguish candidates who reach for goroutines and channels as a natural solution from those who treat them as exotic features. The five-level hierarchy below maps to this progression, knowing which level you are being assessed at helps you calibrate the depth of your answer.

```
┌──────────────────────────────────────────────────────────────────┐
│                  GO INTERVIEW ASSESSMENT                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Level 1: Syntax & Basics                                        │
│  ├── Variable declarations, types, control flow                  │
│  ├── Functions, methods, interfaces                              │
│  └── Error handling basics                                       │
│                                                                  │
│  Level 2: Idiomatic Go                                           │
│  ├── Composition over inheritance                                │
│  ├── Accept interfaces, return structs                           │
│  └── Error handling patterns                                     │
│                                                                  │
│  Level 3: Concurrency                                            │
│  ├── Goroutines and channels                                     │
│  ├── Synchronization primitives                                  │
│  └── Context and cancellation                                    │
│                                                                  │
│  Level 4: Internals & Performance                                │
│  ├── Memory model, GC, scheduler                                 │
│  ├── Escape analysis, inlining                                   │
│  └── Profiling and optimization                                  │
│                                                                  │
│  Level 5: System Design with Go                                  │
│  ├── Production patterns                                         │
│  ├── Distributed systems                                         │
│  └── Trade-offs and decision making                              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Knowing Which Level You Are Being Tested At

The five-level assessment hierarchy in this section is your calibration map. A mistake many junior candidates make is answering a Level 1 question (syntax and types) with a Level 3 answer (runtime internals), which wastes time and can come across as rote memorization rather than genuine understanding. Conversely, answering a Level 3 question with a Level 1 response signals insufficient depth.

Prerequisite gap to close: most candidates transitioning from other languages do not naturally think about Go's type system as distinct. Practice the difference between method sets on value receivers versus pointer receivers until it is intuitive, not recalled. This distinction surfaces in almost every interface-related interview question.

Practical habit: before each practice session, identify which category of question you are drilling and explicitly note the expected depth level. After each attempt, self-assess whether your answer matched the level. This meta-awareness accelerates calibration faster than volume alone.

### Senior @ FAANG: Category Awareness as Interview Strategy

For senior candidates, the five-level hierarchy is not just a map of what you know. It is a tool for managing interview pacing and demonstrating strategic thinking.

When a senior interviewer asks a question that appears to be Level 2 (standard library and patterns), a bar-raiser candidate recognizes that the expected answer range extends into Level 3 or Level 4. The signal is not whether you know the answer but whether you proactively volunteer the deeper context. For example, a question about `sync.RWMutex` is nominally Level 2, but the senior bar requires discussing the reader starvation problem, the difference in performance characteristics versus `sync.Mutex` under read-heavy workloads, and when to prefer atomic operations instead.

Governance implication: at L6 and above, FAANG companies expect engineers to actively calibrate interview rubrics. If you are applying at senior or staff level, be prepared for a question in the behavioral round about how you have contributed to raising the engineering bar through your team's interview process. This is a direct signal of L6-level organizational impact.

Platform thinking applied to categories: the question category framework also maps to production system concerns. Level 4 (concurrency and synchronization) and Level 5 (runtime internals) categories are exactly where production incidents originate at scale. Interviewers at senior level are assessing whether your category knowledge translates into production judgment, not just interview performance.
