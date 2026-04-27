export default `# Start Here, Your Roadmap

This is a big book. You do not need to read all of it. This page tells you exactly where to start based on where you are right now.

---

## If You're a Complete Beginner (New to Programming or New to Go)

**Read these chapters in order:**

1. **Chapter 1**, Why Go? (understand what Go is, how it compares to 18 other languages, and set up your machine)
2. **Chapter 2**, Go Syntax Essentials (variables, types, functions, packages and imports, operators, godoc conventions)
3. **Chapter 3**, Go for Experienced Developers (mental model shifts, skim if new to programming)
4. **Chapter 4**, Types Deep Dive (includes how computers represent types, ASCII, IEEE 754, struct alignment)
5. **Chapter 5**, Pointers and Memory (includes the hardware view of stack and heap, escape analysis)
6. **Chapter 6**, Interfaces

**Then build something.** After Chapter 6, you have enough Go to build a real project. Go to Part XIX (Capstone Projects) and build Project 1: URL Shortener. Come back to Chapter 7+ after you have built something.

**Time estimate:** 2-3 weeks at 2 hours/day.

---

## If You Know Go and Want to Crack Top-Tier Interviews

**Follow this 12-week path:**

| Weeks | What to Study | Chapters |
|-------|--------------|----------|
| 1-2 | Go deep dive and concurrency | Parts I-II (review what you do not know) |
| 3-4 | Data structures and algorithms | Part XI, focus on patterns and templates |
| 5-6 | System design fundamentals | Part X, study 5 design problems in depth |
| 7-8 | More DSA and system design practice | Parts X-B and XI, solve problems daily |
| 9-10 | Behavioral prep and company research | Part XII (ch 82) and company deep dives (ch 83b) |
| 11 | Mock interviews and weak area review | Chapter 83c and coding meta-skills (ch 80.12) |
| 12 | Final week protocol | Chapter 83f.15, day-by-day guide |

**Detailed study plans are in Chapter 83F**, including a 6-month plan if you have more time, and a 4-week emergency plan if you do not.

**What changed in 2026.** The loop is no longer a correctness test. Coding puzzles still appear, but the weight has shifted toward debugging traces, production-incident walkthroughs, and design decisions you have to defend out loud. Even inside one company, different teams calibrate the loop differently, so assume three signal axes land on you: reasoning under ambiguity, operational maturity, and cross-team communication. The study plans in Chapter 83F are already tuned for this.

---

## If You Have 4 Weeks (Emergency Prep)

**Go straight to Chapter 83F.5**, "The 4-Week Emergency Plan." It tells you exactly what to do each day.

**Quick version:**
- Week 1: Grind 30 medium LeetCode problems using the pattern decision tree (ch 80.12)
- Week 2: Study 5 system design problems (Part X-B), one per day, full depth
- Week 3: Behavioral stories (ch 82) and company-specific prep (ch 83b)
- Week 4: Mock interviews and the Final Week protocol (ch 83f.15)

---

## If You're an Experienced Go Developer Going for Senior or Staff

**Focus on these parts:**

- Part X, System Design (this is usually the gap for experienced devs, including ch58 system design interview playbook)
- Part XIII, Senior Engineer Mindset (technical leadership, code reviews at scale, RFCs)
- Part XII, Interview Mastery (behavioral is where senior candidates fail most)
- Part XVIII, C++ Mastery (if targeting Google/Meta, C++ knowledge is a differentiator)
- Optional: Part XXIII, Computer Hardware and Architecture Foundations (chapters 167-169), for engineers who want to reason about performance from first principles

---

## If You're Already a Senior or Staff Engineer at a Top Company

You probably do not need the interview prep parts. You bought this book for depth, not for LeetCode. Three reading tracks are built for you:

**Track A, Language and Runtime Mastery**

- Part III and Parts III-B, III-C (production-ready Go, million-RPS patterns, Green Tea GC internals, memory and CPU optimization, benchmarking at scale, testing in production)
- Part I chapters 4, 5, 6b, 7, 7b, 7c, 7d, 10b (types and hardware representation, pointers and hardware stack/heap view, modern Go features, compiler and runtime internals, unsafe and reflection, CGO and assembly, disaster prevention)
- Part II chapters 11, 13, 15, 16 (goroutine hardware foundations, synchronization primitives, advanced concurrency, antipatterns)
- Optional: Part XXIII chapters 167-169 (memory architecture deep-dive, CPU/OS/concurrency foundations, computer hardware and software foundations)

**Track B, Architecture at Scale**

- Parts V, V-B, V-C (data layer, database ecosystem, caching engineering)
- Part VII (gRPC deep dive)
- Parts VIII, VIII-B, VIII-C, VIII-D (microservices, DDD, message queues, workflow orchestration)
- Parts X, X-B, X-C, X-D (system design fundamentals including scaling to millions and database selection, 20 real problems, distributed systems extended, multi-region and disaster recovery)
- Parts XV, XV-B, XV-C (cloud, DevOps platform, networking protocols)

**Track C, Staff-Track Leadership and Strategy**

- Parts XIII and XIII-B (senior mindset, architecture patterns, ADRs, staff archetypes)
- Part XIV-B (migration and modernization, strangler fig, anti-corruption layers at org scale)
- Parts XVI, XVI-B (observability and SRE at scale, SLO engineering)
- Parts XVII, XVII-B (security posture, compliance and regulatory)
- Optional but recommended: Part XVIII (C++) if your fleet is polyglot, Part XX (eBPF) for platform and kernel-adjacent work, Part XXI (AI/ML) for LLM-native product surfaces, Part XXIII (hardware foundations) for performance-debugging depth

**How to use the tracks.** Pick the track that matches the problem on your desk this quarter. Read two or three chapters, try the senior-track callouts, then come back for a different track when the next problem lands. This book is a reference for your career, not a linear course once you pass the entry bar.

---

## How This Book Is Structured

\`\`\`
Parts I-XII:    Core Go and Interview Prep (the main path)
Parts XIII-XVII: Advanced Career Topics (senior/staff level)
Part XVIII:      C++ Deep Dive (industry differentiator)
Part XIX:        Capstone Projects (hands-on practice)
Part XX:         eBPF & Linux Internals (optional)
Part XXI:        AI & Machine Learning (optional)
Part XXII:       Blockchain & Web3 (optional)
Part XXIII:      Computer Hardware & Architecture Foundations (optional)
Appendices:      Quick Reference (A-L)
\`\`\`

**Each chapter follows the same structure:**
- Introduction: what you will learn and why it matters
- Core sections: concepts with production-quality Go code
- Company case studies: how top tech companies handle this in practice
- Common mistakes: pitfalls to avoid
- Interview questions: what you might be asked
- Exercises: hands-on practice with solutions

---

## One Rule

**Do not just read. Build.**

After every 2-3 chapters, write code. The capstone projects in Part XIX map to specific book sections. If you read without coding, you will understand the concepts but fail the interview. The interview tests execution under pressure, and that only comes from practice.

**Working with AI tools.** Use Copilot, Claude Code, Cursor, or similar assistants while learning and while building. Do not use them to generate answers you have not worked through yet. The interview bar in 2026 is higher, not lower, because interviewers assume you had AI help during prep and want to see you reason without it. Build with AI, then close the tab and solve the problem from scratch at least once. That is the difference between people who got hired in 2026 and people who did not.

---
`;
