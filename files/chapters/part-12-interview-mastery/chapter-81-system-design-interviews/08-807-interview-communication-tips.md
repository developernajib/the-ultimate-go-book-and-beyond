## 81.7 Interview Communication Tips

### Structuring Your Response

A structured response keeps both you and the interviewer oriented throughout a 45-minute design discussion. The six-step sequence below gives you a repeatable framework that prevents the most common failure mode: jumping into component details before establishing requirements and scope.

```
1. REPEAT THE PROBLEM
   "So we're designing a system that..."
   - Shows you understood
   - Gives you time to think

2. ASK CLARIFYING QUESTIONS
   "Before I dive in, I have a few questions..."
   - Shows thoroughness
   - Narrows scope

3. STATE ASSUMPTIONS
   "I'll assume that..."
   - Prevents misunderstandings
   - Shows you're thinking about constraints

4. DRAW HIGH-LEVEL FIRST
   "Let me start with the high-level architecture..."
   - Top-down approach
   - Easy to follow

5. EXPLAIN TRADE-OFFS
   "The trade-off here is..."
   - Shows senior thinking
   - Demonstrates depth

6. INVITE DISCUSSION
   "Would you like me to dive deeper into any component?"
   - Shows collaboration
   - Lets interviewer guide
```

### Common Mistakes to Avoid

Even technically strong candidates fail system design interviews by violating communication fundamentals rather than making architectural errors. Jumping straight into component choices before clarifying scale, consistency requirements, and access patterns signals a lack of real-world experience, senior engineers know that requirements determine architecture, not the other way around. Interviewers actively score on how you handle ambiguity, trade-offs, and failure scenarios, so omitting those discussions leaves points on the table regardless of how sound your design is.

```
❌ Jumping into details without requirements
❌ Not asking clarifying questions
❌ Single solution without alternatives
❌ Ignoring non-functional requirements
❌ Not discussing trade-offs
❌ Forgetting about failure modes
❌ Over-engineering for interview scope
❌ Not managing time well
```

---

### Junior → FAANG: Communication as the Multiplier on Technical Knowledge

Technical knowledge without clear communication produces lower scores in system design interviews than moderate technical knowledge with excellent communication. This is not unfair. It reflects the reality that engineering decisions in industry require clear articulation to be effective: you cannot ship an architecture that your team does not understand and cannot maintain.

The most impactful communication habit for junior candidates: narrate your reasoning, not your actions. "I am drawing a cache here" tells the interviewer nothing. "I am adding a cache in front of the database to handle the 90% read hit rate we estimated. This should reduce database load by an order of magnitude for read traffic" tells the interviewer your analysis, your decision, and your expected outcome. Practice this narration style in every mock session.

Time management entry-level: bring a mental clock to the session. The 45-minute structure is roughly: 5 minutes requirements, 5 minutes estimation, 10 minutes high-level design, 15 minutes deep dive, 10 minutes trade-offs and follow-ups. If you are past the 20-minute mark and still drawing your high-level architecture, you are running behind and need to accelerate.

### Senior @ FAANG: Communication as Session Leadership

For senior candidates, communication tips are not about avoiding mistakes. They are about active session leadership. A senior candidate drives the interview like a technical meeting: they set the agenda explicitly ("let me spend five minutes on requirements, then move to estimation, then design"), they summarize progress at transitions ("I have established the high-level design, I want to go deeper on the database choice now"), and they invite collaboration strategically ("I see two approaches for fan-out, do you want me to go deeper on one, or shall I compare them briefly?").

This leadership behavior signals to the interviewer that you run technical discussions effectively, which is a core senior engineering competency. Engineers who cannot lead a technical meeting without being guided through it are not operating at L5/L6.

Bar-raiser communication signal: the ability to disagree with the interviewer constructively. If an interviewer suggests an alternative you believe is suboptimal, the L6 response is "that is a valid approach. I see two trade-offs with it that pushed me toward my current design: [X] and [Y]. Would you like me to explore your suggestion further?" This demonstrates confidence, openness, and the analytical ability to compare approaches, all of which are L6 bar-raiser signals.
