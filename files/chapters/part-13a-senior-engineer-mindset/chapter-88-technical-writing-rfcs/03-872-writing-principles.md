## 88.2 Writing Principles

### The Pyramid Principle

The Pyramid Principle, originally developed by Barbara Minto at McKinsey, is one of the most effective frameworks for structuring technical writing. The core idea is simple: start with your conclusion first, then support it with key points, and finally provide the detailed evidence underneath. This is the opposite of how most people naturally write (building up to a conclusion), but it respects your reader's time by giving them the most important information immediately. Busy reviewers can stop reading at any level of the pyramid and still have a useful understanding of your proposal.

```
┌──────────────────────────────────────────────────────────────────┐
│                   PYRAMID STRUCTURE                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    ┌─────────────┐                               │
│                    │  CONCLUSION │    ← Start here               │
│                    │(Bottom Line)│                               │
│                    └──────┬──────┘                               │
│                           │                                      │
│            ┌──────────────┼──────────────┐                       │
│            │              │              │                       │
│       ┌────▼────┐   ┌────▼────┐   ┌────▼────┐                    │
│       │ Key     │   │ Key     │   │ Key     │   ← Support        │
│       │ Point 1 │   │ Point 2 │   │ Point 3 │                    │
│       └────┬────┘   └────┬────┘   └────┬────┘                    │
│            │              │              │                       │
│       ┌────▼────┐   ┌────▼────┐   ┌────▼────┐                    │
│       │ Details │   │ Details │   │ Details │   ← Evidence       │
│       │ & Data  │   │ & Data  │   │ & Data  │                    │
│       └─────────┘   └─────────┘   └─────────┘                    │
│                                                                  │
│  Example:                                                        │
│  Conclusion: "We should migrate to PostgreSQL"                   │
│  Key Points: 1) Performance 2) Features 3) Cost                  │
│  Details: Benchmarks, feature comparison, TCO analysis           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Writing Clearly

Clear writing is not about dumbing things down - it is about removing unnecessary complexity so your reader can focus on the ideas that matter. Engineers often confuse complicated writing with sophisticated thinking, but the opposite is true: the clearest writers are the ones who understand their subject deeply enough to explain it simply. The following principles will help you write technical prose that people actually read and understand, rather than skim and misinterpret.

```
PRINCIPLES OF CLEAR TECHNICAL WRITING:

1. FRONT-LOAD THE IMPORTANT STUFF
   Bad:  "After analyzing various options and considering
         the trade-offs... we recommend PostgreSQL."
   Good: "We recommend PostgreSQL. Here's why..."

2. USE SIMPLE WORDS
   Bad:  "We should leverage our synergies to optimize..."
   Good: "We should combine these systems to improve..."

3. SHORT SENTENCES AND PARAGRAPHS
   Bad:  One 100-word paragraph with multiple ideas
   Good: Multiple short paragraphs, one idea each

4. ACTIVE VOICE
   Bad:  "The database was migrated by the team"
   Good: "The team migrated the database"

5. BE SPECIFIC
   Bad:  "Performance will improve significantly"
   Good: "Latency will decrease from 200ms to 50ms"

6. USE LISTS AND STRUCTURE
   Bad:  Dense paragraphs of enumerated items
   Good: Bullet points with clear hierarchy

7. DEFINE JARGON
   Bad:  "We'll use CQRS with event sourcing"
   Good: "We'll use CQRS (Command Query Responsibility
         Segregation), which separates..."
```

### Know Your Audience

One of the most common mistakes in technical writing is writing for yourself instead of your reader. Different audiences need different levels of detail, different vocabulary, and different framing of the same information. An engineer on your team can handle deep implementation details, but a product manager needs business impact and timelines. Writing the same document for both audiences without adjusting your approach guarantees that at least one group will be confused or disengaged. The table below shows how to calibrate your writing for each common audience.

```
┌──────────────────────────────────────────────────────────────────┐
│               AUDIENCE-AWARE WRITING                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ENGINEERS ON YOUR TEAM                                          │
│  ├── Can assume shared context                                   │
│  ├── Deep technical details welcome                              │
│  ├── Focus on implementation specifics                           │
│  └── Reference internal systems directly                         │
│                                                                  │
│  ENGINEERS ON OTHER TEAMS                                        │
│  ├── Explain your domain's context                               │
│  ├── Highlight interfaces and integration points                 │
│  ├── Be explicit about dependencies                              │
│  └── Define team-specific terminology                            │
│                                                                  │
│  ENGINEERING LEADERSHIP                                          │
│  ├── Start with business impact                                  │
│  ├── Summarize technical approach                                │
│  ├── Focus on trade-offs and risks                               │
│  └── Provide timeline and resource needs                         │
│                                                                  │
│  PRODUCT/BUSINESS STAKEHOLDERS                                   │
│  ├── Lead with business value                                    │
│  ├── Minimize technical jargon                                   │
│  ├── Focus on outcomes, not implementation                       │
│  └── Use analogies for technical concepts                        │
│                                                                  │
│  FUTURE READERS (including future you)                           │
│  ├── Don't assume any context                                    │
│  ├── Explain "why" not just "what"                               │
│  ├── Include date and version context                            │
│  └── Link to related documents                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: The Pyramid Principle as Interview Answer Structure

The Pyramid Principle applies directly to verbal interview answers, not just written documents. When a bar-raiser asks "how would you improve the reliability of this service?", the pyramid answer starts with the recommendation: "I would introduce circuit breakers at the three external API boundaries." Then the supporting key points. Then the evidence. Most candidates build up to the conclusion, making the interviewer wait through context before hearing the actual answer. The pyramid structure immediately signals senior-level communication clarity.

Practice rewriting your three best behavioral interview stories using pyramid structure. Start with the bottom line: "I drove a six-week migration that reduced latency by 60%." Then the key points. Then the evidence. This structure is more memorable and more compelling than the chronological narrative most candidates default to.

Active voice, short sentences, and concrete examples are not just style preferences. They are signals of clear thinking. Passive constructions, hedged assertions, and abstract examples consistently appear in writing from engineers who do not yet fully understand their subject matter. If your design documents read as vague, your technical thinking is likely also vague. Writing practice improves both.

### Senior @ FAANG: Writing Principles as Team Standards

At L6 and above, writing principles become cultural norms that you model and then codify into team standards.

The pyramid principle applied to team communication means: all-hands presentations start with the key takeaway. Slack messages start with the request or decision. Incident updates start with the current status and user impact. Teams where senior engineers model this structure consistently develop a communication culture where everyone defaults to bottom-line-up-front, which dramatically reduces the cognitive overhead of consuming information at scale.

Audience calibration is a governance skill at senior levels. Documents that are written for one audience and consumed by another produce misunderstanding, not alignment. Staff engineers who establish explicit audience conventions for their team's documents, "this document is written for engineers with no context in our domain, please provide that context upfront," create a shared standard that improves the quality of every document the team produces.

The "active voice" principle has a specific governance implication: passive constructions conceal responsibility. "The database was misconfigured" hides who misconfigured it and what the failure mode was. "Engineer X misconfigured the connection pool timeout during the Tuesday deploy, causing a cascade failure for 23 minutes" is actionable. Postmortems and incident reports written in active voice produce better action items than those written in passive voice, because responsibility is explicit.

---
