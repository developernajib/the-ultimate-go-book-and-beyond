## 93.1 The Interview Pipeline

### Typical Interview Stages

Most software engineering interviews follow a predictable multi-stage funnel designed to filter candidates progressively, with each stage increasing in time investment from both sides. Understanding this pipeline lets you prepare the right material for the right moment, saving behavioral stories for the onsite loop rather than the recruiter screen, and reserving system design depth for rounds where the interviewer has the technical background to evaluate it. Knowing that the onsite loop is typically the final decision gate also tells you where to focus the bulk of your preparation energy.

```
┌──────────────────────────────────────────────────────────────────┐
│                  INTERVIEW PIPELINE                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STAGE 1: RECRUITER SCREEN (30-45 min)                           │
│  ├── Role overview and expectations                              │
│  ├── Your background and interests                               │
│  ├── Compensation expectations                                   │
│  └── Process and timeline                                        │
│                                                                  │
│  STAGE 2: TECHNICAL SCREEN (45-60 min)                           │
│  ├── Coding problem (easy-medium)                                │
│  ├── Maybe light system design                                   │
│  ├── Technical discussion                                        │
│  └── Your questions                                              │
│                                                                  │
│  STAGE 3: ONSITE / VIRTUAL LOOP (4-6 hours)                      │
│  ├── 2-3 Coding Interviews                                       │
│  ├── 1-2 System Design                                           │
│  ├── 1 Behavioral Interview                                      │
│  ├── Hiring Manager Interview                                    │
│  └── Possibly: Culture/Values interview                          │
│                                                                  │
│  STAGE 4: DECISION & OFFER                                       │
│  ├── Debrief meeting (hiring team)                               │
│  ├── Offer or rejection                                          │
│  └── Negotiation (if offer)                                      │
│                                                                  │
│  Timeline: Usually 2-4 weeks total                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Pipeline Diagram as a Preparation Roadmap

This four-stage pipeline is the most important piece of structural knowledge early-career candidates are missing. Most junior engineers prepare generically: they study algorithms for weeks and then walk into a recruiter screen unprepared to answer "tell me about yourself" coherently. The pipeline diagram inverts this mistake.

Map your preparation to stages explicitly. Stage 1 requires a polished two-minute narrative, research on the company's business and engineering challenges, and a clear statement of compensation expectations. Stage 2 requires fluency in medium-difficulty coding problems with continuous narration. Stage 3 requires system design depth, behavioral story preparation mapped to leadership principles, and the ability to maintain energy and clarity across four to six back-to-back conversations. Stage 4 is not a preparation challenge but a negotiation challenge, which is covered in a separate chapter.

The two to four week timeline noted in the diagram is a practical constraint. If you are in active interviews at multiple companies, you need a system for tracking where you are in each pipeline and when decisions are expected. A simple spreadsheet with company name, current stage, next action, and expected timeline is sufficient and prevents the common mistake of letting offers expire while waiting on competing pipelines to close.

### Senior @ FAANG: How the Pipeline Differs at L6 and Above

The diagram is accurate but incomplete for senior candidates. At L6 and above, the loop design itself changes. Coding rounds are often replaced with or supplemented by architecture deep-dives where you are asked to walk through a significant system you designed or a major technical decision you made. The behavioral panel is more likely to include a hiring manager who is evaluating organizational fit, not just technical capability. And the debrief meeting involves a hiring committee that reviews the full packet, not just individual round scores.

A structural difference that matters for governance: at L6 and above, bar-raisers are often senior staff or principal engineers who are specifically evaluating whether you would raise the team's technical bar. They are asking whether you bring capabilities or judgment the team currently lacks. This means your answers should reveal what you know that is not already obvious from the team's current output. If you are interviewing for a platform engineering role, demonstrate knowledge of platform maturity models, developer experience metrics, and production incident governance patterns. If you are interviewing for a distributed systems role, demonstrate knowledge of consistency models, CAP theorem tradeoffs in specific real systems, and the operational complexity of different consistency guarantees at scale.

---
