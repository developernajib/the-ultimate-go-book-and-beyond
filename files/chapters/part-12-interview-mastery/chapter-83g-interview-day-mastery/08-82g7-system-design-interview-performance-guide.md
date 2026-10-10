## 83G.7 System Design Interview: Performance Guide

System design interviews test different skills than coding interviews, and the performance strategies are different. The main danger is not blanking on an algorithm --- it is rambling without structure, going too deep on unimportant details, or failing to address the core requirements.

### The 45-Minute Timeline (Precise Breakdown)

Forty-five minutes sounds like plenty of time until you spend twelve minutes on requirements and realize you have no time left for deep dives. Interviewers mentally track your pacing, a candidate who reaches the scaling discussion signals senior-level breadth, while one still explaining the data model at minute 30 signals that they cannot prioritize. The breakdown below is a concrete budget, not a loose guideline: treat each phase boundary as a hard cut and move on even if the current section feels incomplete.

```
SYSTEM DESIGN INTERVIEW TIMELINE

Minutes 0-5:   REQUIREMENTS AND SCOPE
                ├── Restate the problem
                ├── Ask clarifying questions
                ├── Define functional requirements (what it does)
                ├── Define non-functional requirements (scale, latency, availability)
                └── Confirm scope with interviewer: "Is there any area
                    you'd like me to focus on?"

Minutes 5-10:  CAPACITY ESTIMATION
                ├── Users: daily active users, peak concurrent users
                ├── Storage: data per user × users × retention period
                ├── Bandwidth: requests per second, data per request
                └── Keep estimates rough (powers of 10)
                    "With 10M DAU and 10 requests per user per day,
                     we need ~1,000 RPS average, ~3,000 RPS peak."

Minutes 10-20: HIGH-LEVEL DESIGN
                ├── Draw the main components (clients, load balancers,
                │   services, databases, caches, queues)
                ├── Show the data flow for the primary use case
                ├── Identify the database schema (key tables/collections)
                └── Choose between SQL and NoSQL with reasoning

Minutes 20-35: DEEP DIVE
                ├── Pick 2-3 components to deep dive
                │   (or let the interviewer choose)
                ├── Discuss trade-offs at each decision point
                ├── Address bottlenecks and how to resolve them
                ├── Discuss caching strategy (what, where, invalidation)
                ├── Discuss data partitioning/sharding strategy
                └── Address failure modes and recovery

Minutes 35-42: SCALING AND EVOLUTION
                ├── How the system handles 10x growth
                ├── Monitoring and alerting strategy
                ├── How to deploy changes safely
                └── Future features and how the design accommodates them

Minutes 42-45: WRAP-UP
                ├── Summarize the design
                ├── Acknowledge trade-offs and alternatives
                └── Ask questions about the interviewer's experience
```

### When to Go Deep vs. Stay Broad

The most common mistake in system design interviews is spending too much time on one component and never getting to others. Watch for these signals:

**Go deeper when:**
- The interviewer asks follow-up questions about a component
- The component is the core of the system (e.g., the matching algorithm in a ride-sharing system)
- You are explaining a trade-off that demonstrates depth

**Stay broad when:**
- You have not covered all major components yet
- The interviewer says "Let's move on" or "What about [other component]?"
- You are spending more than 5 minutes on a single component without interviewer engagement

**What to Say when transitioning:**
> "I could go deeper on the caching layer, but let me first make sure I've covered the end-to-end flow. I'll come back to caching details if we have time."

### Handling "What If We Need to Scale to 1B Users?"

This question is designed to test whether you can think about scale-specific problems. Do not panic. Follow a framework:

> "Scaling from 10M to 1B users changes several things. First, a single database won't handle the write throughput, so I'd shard by user ID using consistent hashing. Second, our API servers need to be stateless so we can horizontally scale behind a load balancer. Third, I'd introduce a CDN for static content and a caching layer --- probably Redis --- for frequently accessed data. Fourth, I'd consider switching from synchronous to asynchronous processing for non-critical paths using a message queue like Kafka."

### When the Interviewer Challenges Your Design

This is expected. They are testing your ability to defend or adapt your decisions.

**What to Say:**
> "That's a fair concern. The trade-off I was considering was [X vs. Y]. I chose [X] because [reason], but if [Y] is more important in this context, I'd switch to [alternative approach]."

> "You're right that my current design doesn't handle that case well. One way to address it would be to add a [component]. The cost would be [trade-off], but I think it's worth it for [benefit]."

**What NOT to Say:**
> "I don't know." (Say "I haven't considered that. Let me think about it.")

> "My design is correct." (Never be defensive. Be open to alternatives.)

> "I'm not sure that matters." (The interviewer brought it up. It matters to them.)

### Recovery When You Realize Your Design Has a Flaw

Mid-explanation, you realize there is a fundamental problem with your design. A single database cannot handle the required throughput. Or your caching strategy creates consistency issues.

**What to Say:**
> "Actually, now that I think about it, this design has a problem with [X]. The write throughput to this single database would be about 100K writes per second, which exceeds what a single Postgres instance can handle. Let me restructure this: I'll shard the database by [criteria] and add a message queue for write buffering."

Self-correcting mid-interview is a strong positive signal. It demonstrates architectural awareness and the maturity to acknowledge and fix mistakes. Do not try to hide the flaw.

### The Whiteboard/Drawing Strategy

In system design interviews, your diagram is not just an illustration --- it is the primary artifact the interviewer evaluates. A well-organized diagram demonstrates clarity of thought. A messy, cramped diagram signals confused thinking, even if the underlying design is sound.

**Whiteboard layout (in-person):**

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│  TOP-LEFT CORNER:              TOP-RIGHT CORNER:                  │
│  Requirements                  Capacity estimates                 │
│  - Functional: FR1, FR2       - 10M DAU                           │
│  - Non-functional: NFR1       - 1K RPS avg, 3K peak               │
│                                - 5TB storage / year               │
│                                                                   │
│  ───────────────────────────────────────────────────────────────  │
│                                                                   │
│  CENTER (largest area):                                           │
│  Architecture diagram                                             │
│  [Client] → [LB] → [API] → [DB]                                   │
│                    ↓                                              │
│               [Cache]  [Queue] → [Worker]                         │
│                                                                   │
│  ───────────────────────────────────────────────────────────────  │
│                                                                   │
│  BOTTOM:                                                          │
│  Database schema (key tables and relationships)                   │
│  API endpoints (if discussed)                                     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Drawing tips for virtual interviews:**

- Use a drawing tool you have practiced with (Excalidraw, draw.io, or the built-in whiteboard in the interview platform)
- Use boxes for services, cylinders for databases, arrows for data flow
- Label every arrow with what data flows through it
- Color-code if possible: blue for read path, red for write path
- Keep components spaced apart so you can add connections later

**What to Say while drawing:**
> "Let me sketch the high-level architecture. I'll start with the client making a request, which hits our load balancer, then routes to our API service. The API service talks to both a cache layer and the primary database. For asynchronous operations, I'll use a message queue with worker consumers."

Narrate as you draw. Silent drawing creates awkward pauses and prevents the interviewer from following your reasoning.

### The "I Would Consider" Phrase That Shows Depth

One of the most powerful phrases in a system design interview is "I would consider." It signals that you are aware of alternatives and trade-offs without committing to a lengthy tangent.

**Examples:**

> "For the database, I'm going with PostgreSQL because we need strong consistency for financial transactions. I would also consider DynamoDB if we later need to prioritize write throughput over consistency."

> "I'm using a single leader replication model here. I would consider multi-leader if we expand to multiple geographic regions and need low-latency writes globally."

> "For caching, I'm placing a Redis layer in front of the database. I would consider a write-through cache if we wanted to simplify cache invalidation at the cost of write latency."

Each "I would consider" takes 10 seconds but demonstrates that you understand the design space beyond the choice you made. Interviewers specifically look for this kind of depth awareness.

### Defending Your Decisions with Trade-Offs

When the interviewer challenges a design decision, never respond with just "because it's better." Always frame your response as a trade-off.

**The trade-off formula:**

> "I chose [X] over [Y] because in this context, [benefit of X] is more important than [benefit of Y]. The cost is [downside of X], which I'd mitigate by [mitigation strategy]."

**Example:**

> "I chose SQL over NoSQL here because our data has strong relational properties --- users have orders, orders have items --- and we need ACID transactions for the checkout flow. The trade-off is that SQL won't scale writes as easily as a NoSQL solution. I'd mitigate that by using read replicas for query load and eventually sharding by customer ID if write volume exceeds a single primary."


### Junior → FAANG: System Design Interview Performance Fundamentals

System design interview performance requires managing time across the design dimensions: requirements (5 min), estimation (5-10 min), high-level design (10-15 min), deep dive (10-15 min), and summary/trade-offs (5 min). Most candidates run out of time before the deep dive, which is where the most interesting evaluation happens. The fix: keep the estimation phase brief (back-of-envelope, not precision arithmetic) and move to the high-level design quickly, reserving time for the deep dive discussion that distinguishes prepared candidates from unprepared ones.

### Senior @ FAANG: System Design Performance at the L6 Bar: Driving the Narrative

At the L6 level, the system design interview is a collaborative conversation that you should be driving, not responding to. The L6 signal is proactively directing the discussion toward the most interesting technical challenges: 'I want to focus on the fan-out problem, because that's the hardest part of this design at the stated scale. Let me spend 10 minutes on that and then we can discuss any other areas you're interested in.' This kind of explicit agenda-setting with the interviewer demonstrates confident ownership of the conversation. It also signals that you can prioritize in a complex design discussion, which is exactly what you will need to do as a senior engineer leading design reviews.

---
