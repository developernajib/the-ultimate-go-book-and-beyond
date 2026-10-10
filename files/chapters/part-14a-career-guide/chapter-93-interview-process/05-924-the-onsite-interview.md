## 93.4 The Onsite Interview

### What to Expect

```
TYPICAL ONSITE (4-6 hours):

┌──────────────────────────────────────────────────────────────┐
│ 9:00 AM  │ Welcome & Setup (15 min)                          │
│ 9:15 AM  │ Coding Interview #1 (60 min)                      │
│ 10:15 AM │ Break (15 min)                                    │
│ 10:30 AM │ System Design Interview (60 min)                  │
│ 11:30 AM │ Lunch with Team (45-60 min) [informal]            │
│ 12:30 PM │ Coding Interview #2 (60 min)                      │
│ 1:30 PM  │ Break (15 min)                                    │
│ 1:45 PM  │ Behavioral Interview (45-60 min)                  │
│ 2:45 PM  │ Hiring Manager Interview (45 min)                 │
│ 3:30 PM  │ Wrap-up / Questions (15 min)                      │
└──────────────────────────────────────────────────────────────┘

VIRTUAL ONSITE ADJUSTMENTS:
• Usually same structure, just via video
• Shorter breaks between sessions
• May be split across multiple days
• Request breaks if needed
```

### System Design Tips

```
45-60 MINUTE BREAKDOWN:

REQUIREMENTS (5-7 min):
• Functional: What must the system do?
• Non-functional: Scale, latency, availability
• Constraints: Timeline, team size, existing infra

HIGH-LEVEL DESIGN (10-15 min):
• Core components
• Data flow
• API design

DEEP DIVE (20-25 min):
• Database schema
• Scaling strategy
• Specific component details
• Trade-offs

WRAP-UP (5-10 min):
• Address bottlenecks
• Monitoring and observability
• Future improvements

KEY PRINCIPLES:
• Drive the conversation, don't wait for prompts
• State assumptions explicitly
• Discuss trade-offs, not just solutions
• Draw diagrams to communicate
• Connect technical decisions to requirements
```

### Behavioral Interview Tips

The behavioral round of the onsite rewards preparation more than charisma:

```
USE THE STAR METHOD:

Situation: Set the context (brief)
Task: Your specific responsibility
Action: What YOU did (use "I", not "we")
Result: Quantified outcome

PREPARE 6-8 STORIES COVERING:
□ Technical leadership
□ Conflict resolution
□ Failure and learning
□ Mentoring others
□ Working under pressure
□ Cross-team collaboration
□ Disagreeing with decisions
□ Biggest accomplishment

EXAMPLE:
"Tell me about a time you had to deal with a difficult
technical challenge."

S: "At my previous company, our payment system was
   experiencing 2-second latencies during peak times."

T: "As the lead on the platform team, I was responsible
   for diagnosing and fixing the performance issues."

A: "I first implemented distributed tracing to identify
   bottlenecks. I found N+1 queries in our order service.
   I redesigned the data access layer with batched queries
   and added a caching layer for frequently accessed data."

R: "We reduced p99 latency from 2 seconds to 150ms,
   a 13x improvement. The solution I designed became
   our standard pattern and was adopted by 4 other teams."
```

### Junior → FAANG: Surviving and Performing in a Six-Hour Onsite Loop

The onsite is the round that most early-career candidates underestimate in difficulty and overestimate in what they need to know. The format is not harder algorithmically than the technical screen. It is harder because it demands sustained performance across six hours with context-switching between coding, design, and behavioral conversations. The candidate who is sharp at hour one and exhausted at hour five will lose to a less technically skilled candidate who maintains consistent energy.

Practical preparation: do at least two full mock onsites before the real thing. A full mock means four to six back-to-back sessions with no breaks longer than the ones the actual interview would have. This sounds like excessive preparation but most candidates are genuinely surprised by the energy drain of a real loop and the mock experience is the only way to build the endurance.

For behavioral rounds, prepare seven to eight stories that each demonstrate a different principle, and practice mapping each story to multiple questions. "Tell me about a time you disagreed with a technical decision" and "tell me about a time you had to influence without authority" can often be answered with the same story framed differently. Having a flexible story bank is more efficient than memorizing answers to specific questions.

### Senior @ FAANG: Onsite Design Rounds and Cross-Team Narrative at L6

At L6, the onsite loop is primarily evaluated on system design and behavioral depth, with coding rounds serving more as a competency check than a primary signal. System design rounds at this level are not asking you to draw boxes and arrows. They are asking you to reason about a system's evolution over time: what breaks first at scale, how you would instrument it to know before it breaks, how you would decompose the problem across teams, and what the failure modes are at each layer.

The behavioral component at L6 requires stories with organizational scope. Every story should have an element where your actions changed how other people or other teams worked. The interviewer is not interested in what you personally built. They are interested in what became possible because you were there. "I led the migration from X to Y" is an L5 answer. "I led the migration from X to Y, built the tooling that let five other teams do the same migration without my involvement, and wrote the RFC that became the org-wide standard" is an L6 answer.

Bar-raiser evaluation pattern: bar-raisers are specifically looking for evidence that the candidate operates above the team's current level. If the team is L5-dominant and you are claiming L6, your answers need to demonstrate judgment and scope that the current team members would aspire to rather than recognize as peer-level. This requires genuine reflection on the actual scope of your past work, not just reframing the same work with bigger-sounding language.

---
