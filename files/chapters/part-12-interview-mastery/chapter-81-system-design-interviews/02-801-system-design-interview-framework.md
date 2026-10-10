## 81.1 System Design Interview Framework

### The 4-Step Approach

System design interviews fail most often not from technical ignorance but from poor time allocation, candidates dive straight into database sharding before clarifying whether the system even needs persistence. The four-step framework below enforces a discipline: spend the first five minutes narrowing the problem to a concrete scope so every subsequent technical decision is grounded in stated requirements, not imagined constraints. Interviewers reward candidates who surface trade-offs deliberately, so treat each step as a checkpoint where you verbalize your reasoning before moving forward.

```
┌──────────────────────────────────────────────────────────────────┐
│                SYSTEM DESIGN FRAMEWORK                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: REQUIREMENTS (5 minutes)                                │
│  ├── Functional: What must the system do?                        │
│  ├── Non-functional: Scale, latency, availability                │
│  └── Constraints: Budget, timeline, team size                    │
│                                                                  │
│  Step 2: HIGH-LEVEL DESIGN (10 minutes)                          │
│  ├── Core components and their responsibilities                  │
│  ├── Data flow between components                                │
│  └── API design (endpoints, request/response)                    │
│                                                                  │
│  Step 3: DEEP DIVE (15 minutes)                                  │
│  ├── Database schema and scaling                                 │
│  ├── Caching strategy                                            │
│  ├── Specific component architecture                             │
│  └── Trade-offs and alternatives                                 │
│                                                                  │
│  Step 4: SCALE & WRAP-UP (5 minutes)                             │
│  ├── Bottlenecks and how to address them                         │
│  ├── Failure modes and mitigation                                │
│  └── Monitoring and observability                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Requirements Gathering

**Functional Requirements Questions:**
```
✓ Who are the users? How many?
✓ What are the core features?
✓ What are the read/write patterns?
✓ Is real-time required or eventual consistency OK?
✓ What data needs to be stored?
```

**Non-Functional Requirements Questions:**
```
✓ How many requests per second (RPS)?
✓ What's the acceptable latency (p99)?
✓ What availability is required (99.9%? 99.99%)?
✓ How much data? Growth rate?
✓ Geographic distribution needs?
```

**Back-of-Envelope Calculations:**
```
1 million users
├── 10% daily active = 100,000 DAU
├── Each user makes 10 requests/day = 1M requests/day
├── 1M requests / 86,400 seconds ≈ 12 RPS average
├── Peak = 3x average = 36 RPS
└── With growth buffer (5x) = design for 200 RPS

Storage (if each user stores 1KB):
├── 1M users × 1KB = 1GB
├── 5 years with 20% growth/year = ~2.5GB
└── Design for 10GB to be safe
```

---

### Junior → FAANG: Building Framework Fluency Before Problem Fluency

The 4-step framework is the scaffolding that keeps a system design session from collapsing into a rambling discussion. Junior candidates who skip the framework spend their 45 minutes reacting to interviewer probes rather than driving the design. The framework gives you agency.

Practice the framework on non-technical analogies first. "Design a library" (requirements: what books, how many users, borrowing vs reading-in-place, estimation: how many books per day, peak times, design: catalog, circulation desk, shelf organization, deep dive: overdue books, reservations). This trains the framework as a thinking tool, not just an interview format.

Common junior gap: skipping the requirements step. Many candidates hear "design a rate limiter" and immediately start drawing boxes. The requirements step is where you discover constraints that change the entire design: is this per-user or per-endpoint, what is the expected QPS, should it be distributed or single-node? Getting these wrong means redesigning mid-session.

### Senior @ FAANG: The Framework as Communication Protocol

At senior level, the framework is also a communication protocol. When you explicitly announce "I am now moving to the estimation phase," you give the interviewer a clear signal to either redirect you or follow you. This meta-communication demonstrates that you are managing the session, not just responding to it.

The requirements step at L5/L6 goes beyond functional requirements. Senior candidates proactively identify non-functional requirements: latency SLOs, availability targets, consistency requirements, security constraints, and regulatory compliance implications. These are the requirements that drive architectural decisions at the platform level, and missing them signals that the candidate thinks at the application layer rather than the system layer.

ADR connection: the framework's final step (deep dive and optimization) is the moment for ADR-level thinking. "I started with a monolithic service for simplicity. Now that we have established the 10M QPS write requirement, I want to discuss extracting the write path into a separate service to scale it independently. Here are the trade-offs." This kind of architectural decision, articulated with explicit reasoning, is exactly the format of an ADR and demonstrates the same discipline.

Staff-level framework evolution: L7 candidates do not just use the framework, they refine it for their domain. A staff engineer who has designed ten distributed systems at scale might extend the standard framework with a "failure mode enumeration" phase and a "operational day-two concerns" phase. Being able to explain why these additions matter, and when to use them, demonstrates that your framework is learned, not just borrowed.
