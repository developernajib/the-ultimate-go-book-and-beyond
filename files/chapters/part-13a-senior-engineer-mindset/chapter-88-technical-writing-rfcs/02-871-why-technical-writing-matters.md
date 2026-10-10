## 88.1 Why Technical Writing Matters

### Writing as a Superpower

Writing is the single most underrated skill in software engineering. Most engineers focus exclusively on coding ability, but at senior levels, the ability to communicate ideas clearly through writing determines how much influence you have across an organization. A well-written document can align an entire team before any code is written, while poor writing leads to misunderstandings, wasted effort, and decisions that no one truly agreed on. The diagram below illustrates the five key reasons why senior engineers invest heavily in their writing skills.

```
┌──────────────────────────────────────────────────────────────────┐
│             WHY SENIOR ENGINEERS WRITE                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SCALE YOUR IMPACT                                            │
│     ├── Code reaches one team                                    │
│     ├── Docs reach the whole org                                 │
│     └── Writing multiplies your influence                        │
│                                                                  │
│  2. CLARIFY YOUR THINKING                                        │
│     ├── Writing forces precise thinking                          │
│     ├── Reveals gaps in your understanding                       │
│     └── "If you can't explain it simply..."                      │
│                                                                  │
│  3. BUILD CONSENSUS                                              │
│     ├── Async collaboration across time zones                    │
│     ├── Everyone can engage at their own pace                    │
│     └── Creates shared reference point                           │
│                                                                  │
│  4. CREATE INSTITUTIONAL KNOWLEDGE                               │
│     ├── Decisions persist beyond individuals                     │
│     ├── Onboarding becomes self-service                          │
│     └── Reduces "why did we do this?" questions                  │
│                                                                  │
│  5. DEMONSTRATE SENIOR THINKING                                  │
│     ├── Visible evidence of your judgment                        │
│     ├── Shows you can think beyond code                          │
│     └── Career advancement depends on communication              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Types of Technical Documents

As a software engineer, you will encounter several different types of technical documents throughout your career. Each document type serves a specific purpose and has its own structure and audience. Understanding which document to write in which situation is just as important as writing it well. The list below summarizes the most common types you will create or contribute to.

```
DOCUMENTS YOU'LL WRITE:

RFC (Request for Comments):
- Propose significant changes
- Get buy-in before implementation
- Document design decisions

DESIGN DOC:
- Detailed technical design
- Architecture and implementation plan
- Often follows approved RFC

ADR (Architecture Decision Record):
- Record a single decision
- Capture context and alternatives
- Lightweight, focused

RUNBOOK:
- Operational procedures
- How to respond to incidents
- Step-by-step instructions

README:
- Project overview
- Getting started guide
- Quick reference

POSTMORTEM:
- Incident analysis
- Root cause and lessons
- Action items

TECHNICAL BLOG POST:
- Share learnings externally/internally
- Build your brand
- Teach the organization
```

### Junior → FAANG: Choosing the Right Document Type Before You Write

The most common junior-engineer writing mistake is writing a design document when an ADR would suffice, or writing a lengthy RFC when the decision has already been made and just needs to be documented. Understanding the document type taxonomy in this section prevents over-engineering your writing process.

For FAANG interview preparation, focus on being able to produce two document types: a short RFC that proposes a technical direction, and an ADR that records a single past decision. These two artifacts cover the most common writing scenarios in a FAANG behavioral loop and can be produced in 30 to 60 minutes each with practice.

"Clarify your thinking" is the writing purpose that most junior engineers underestimate. The discipline of writing a one-page problem statement before proposing a solution has saved more engineering weeks than any amount of technical skill. Start building this habit now: before your next design discussion, write a one-paragraph problem statement. The exercise will reveal whether you understand the problem well enough to solve it.

### Senior @ FAANG: Building the Document Portfolio That Defines Your Technical Legacy

At L6 and above, your document portfolio is a substantial fraction of your organizational impact. The RFCs you write create alignment that persists after you move to a new area. The ADRs you author give future engineers the context to maintain and evolve systems you designed without calling you for help. The strategy documents you produce shape roadmap priorities for quarters after you authored them.

Staff engineers who treat documentation as a legacy investment actively curate their document portfolio. They update old RFCs when the context changes, mark outdated ADRs as superseded, and ensure that the most important architectural documents are in searchable, accessible locations. Documentation that is technically present but practically inaccessible produces none of the organizational value of truly maintained documentation.

The "scale your impact" dimension of technical writing is also a promotion case dimension. Staff engineer promotion packets that include links to three major RFCs that drove multi-team alignment, along with metrics showing how those decisions improved outcomes, are more compelling than packets that list accomplishments without the written artifacts to back them up. Write documents with your promotion case in mind from the moment you start writing, not retroactively when you are assembling the packet.

---
