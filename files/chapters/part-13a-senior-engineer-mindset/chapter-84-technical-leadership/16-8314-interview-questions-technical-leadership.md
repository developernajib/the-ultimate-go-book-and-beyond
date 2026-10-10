## 84.15 Interview Questions: Technical Leadership

### Question 1: "Describe a time when you had to influence a technical decision without having authority over the people involved."

**What Interviewers Look For:**
- Understanding of influence vs authority
- Concrete strategies for building consensus
- Ability to navigate disagreement
- Results focus

**Framework for Answering (STAR-L: Situation, Task, Action, Result, Learning):**

```markdown
# Strong Answer Structure

## Situation (30 seconds)
"At my previous company, we had 6 microservices each using
different logging libraries. This caused debugging incidents
to take 3x longer because logs weren't consistent."

## Task (15 seconds)
"I wanted to standardize on structured logging with slog,
but I had no authority over the other teams."

## Action (90 seconds - the meat of the answer)
"My approach had four phases:

1. **Built the case with data**: I analyzed 20 recent incidents
   and showed that inconsistent logging contributed to MTTR.
   I quantified the cost at ~8 engineering hours per incident.

2. **Found allies**: I had 1:1s with senior engineers on each
   team. Two were enthusiastic, two were skeptical, two were
   neutral. I focused on understanding the skeptics' concerns.

3. **Addressed concerns proactively**: The main objection was
   migration effort. I built a migration tool that auto-converted
   80% of logging calls. I also volunteered to help with the
   remaining 20% for any team.

4. **Created safe experimentation**: Proposed a pilot on one
   service. After two weeks, we measured that debugging time
   dropped 40%. This converted the skeptics.

## Result (30 seconds)
"Within 3 months, all 6 services were using consistent
structured logging. Our average MTTR dropped from 45 minutes
to 25 minutes. The pattern was later adopted company-wide."

## Learning (15 seconds)
"I learned that influence comes from making it easy to say yes.
By doing the hard work upfront - the data analysis, the migration
tool, the pilot - I removed barriers to adoption."
```

**Red Flags in Answers:**
- "I convinced my manager to make them do it" (not influence)
- "I just showed them I was right" (no stakeholder awareness)
- "It was obvious so they agreed" (oversimplifies reality)
- No concrete results or metrics

---

### Question 2: "How do you handle technical disagreements with other senior engineers?"

**What Interviewers Look For:**
- Emotional intelligence
- Ability to separate ego from decisions
- Commitment to best outcomes over "winning"
- Structured approach to resolution

**Framework for Answering:**

```markdown
# Strong Answer Structure

## Principle (20 seconds)
"I believe strong opinions, weakly held. I form a clear view
but actively seek to disprove it. Disagreement often means
I'm missing context someone else has."

## Process (60 seconds)
"When I disagree with another senior engineer:

1. **Seek understanding first**: I ask questions to understand
   their reasoning, not to poke holes. 'Help me understand
   why you prefer approach B for the caching layer?'

2. **Find common ground**: Usually we agree on goals and
   disagree on approach. I make the shared goals explicit.

3. **Propose objective criteria**: 'What if we defined the
   decision criteria together? Latency, complexity, cost?'

4. **Experiment over debate**: If we can't agree theoretically,
   I propose we prototype both approaches and measure.

5. **Disagree and commit**: If the other approach is chosen,
   I fully commit to making it succeed. I never say 'I told
   you so' if it fails."

## Example (45 seconds)
"Recently, I disagreed with another staff engineer about
database choice - PostgreSQL vs DynamoDB. We both had valid
points. Instead of debating, we defined criteria (cost at
scale, query flexibility, operational complexity) and
scored each option. PostgreSQL won 7-5. He committed fully
to the choice and has been its biggest advocate since."

## Anti-patterns I Avoid (20 seconds)
"I never escalate prematurely, go around people, or let
disagreements become personal. I've seen those patterns
destroy team trust and lead to worse decisions."
```

---

### Question 3: "Tell me about a time you mentored a struggling engineer. What was your approach?"

**What Interviewers Look For:**
- Coaching vs doing
- Patience and growth mindset
- Ability to diagnose root causes
- Tailoring approach to individual

**Framework for Answering:**

```markdown
# Strong Answer Structure

## Situation (30 seconds)
"A mid-level engineer on my team was struggling to complete
tasks on time. PRs took 3 weeks instead of 1. Other engineers
were frustrated waiting for their code reviews."

## Diagnosis (30 seconds)
"Rather than assume the cause, I observed and asked questions.
The root issue wasn't skill - they were actually quite capable.
It was perfectionism. They'd rewrite code 4-5 times before
submitting, and spent hours on comments in reviews."

## Approach (60 seconds)
"I tailored my mentoring to the specific issue:

1. **Made it safe to be imperfect**: I shared examples of my
   own 'good enough' code that shipped and was fine.

2. **Set explicit time limits**: 'Spend max 2 hours on this.
   Then submit what you have, even if it's not perfect.'

3. **Celebrated progress over perfection**: When they
   submitted a PR after 4 days (down from 15), I praised
   the progress, not the code quality.

4. **Coaching questions**: When they wanted to rewrite,
   I'd ask: 'What's the worst that happens if we ship
   this as-is? Is that worse than the delay?'

5. **Gradual release**: As they built confidence, I
   reduced check-ins from daily to weekly."

## Result (30 seconds)
"Over 3 months, their average PR cycle went from 15 days
to 5 days. More importantly, they became much happier - the
perfectionism had been causing anxiety. They're now a
senior engineer and mentor others on 'shipping beats perfect.'"

## Reflection (15 seconds)
"I learned that mentoring isn't one-size-fits-all. The
same engineer might need coaching on one skill and direct
instruction on another. Diagnosis matters."
```

---

### Question 4: "How do you make technical decisions when you don't have enough information?"

**What Interviewers Look For:**
- Comfort with ambiguity
- Risk assessment ability
- Reversibility thinking
- Action orientation

**Framework for Answering:**

```markdown
# Strong Answer Structure

## Principle (20 seconds)
"Perfect information never exists. The goal is to gather
enough information to make a good decision, while balancing
the cost of delay."

## Framework (60 seconds)
"I use a four-step approach:

1. **Assess reversibility**: Is this a one-way or two-way
   door? One-way doors (data model changes, public APIs)
   get more analysis. Two-way doors (internal implementation,
   feature flags) bias toward action.

2. **Identify what's knowable**: Some information can be
   gathered quickly (team expertise, existing patterns).
   Some takes longer (user research, market analysis).
   Some is inherently unknowable (future requirements).

3. **Define decision criteria**: Before gathering info,
   I define what would make me choose Option A vs B.
   This prevents endless research.

4. **Set a time limit**: 'We'll decide by Thursday with
   whatever information we have.' This forces prioritization
   of the most valuable information."

## Example (45 seconds)
"When choosing between building custom auth vs buying an
identity provider, I had 3 days to decide. I couldn't know
our exact scale in 2 years, but I could assess:
- Current team expertise (low)
- Security requirements (high)
- Likely feature needs (standard)

With this, the 'buy' decision was clear despite not knowing
future scale. We could always migrate if needed (two-way
door), but custom auth bugs would be costly (one-way
consequences)."

## Meta-Principle (15 seconds)
"I've found that speed of decision often matters more than
perfect decision. A good decision made today usually beats
a perfect decision made next month."
```

### Junior → FAANG: Structuring Behavioral Answers for Leadership Questions

The interview questions in this section are behavioral in format, which means the evaluator is listening for the same structure in every answer: what was the situation, what specifically did you do (not "we"), what was the measurable outcome, and what did you learn. The "what specifically did you do" part is where junior candidates most often lose points by defaulting to "we" language that obscures their individual contribution.

Before your interview, write out STAR-format answers for at least four of the questions in this section. Time yourself: a well-prepared answer lands in two to three minutes. Under two minutes usually lacks depth. Over four minutes usually loses the interviewer. Practice until you are consistently in the two-to-three-minute range with concrete details and measurable outcomes.

### Senior @ FAANG: What Bar-Raisers Are Actually Evaluating

At L6+ interviews, the question text is almost irrelevant. The bar-raiser is listening for scope, depth of reasoning, self-awareness, and the ability to abstract the lesson from a specific situation into a generalizable principle. An answer that stays entirely within a single incident and never zooms out to "and here is what I learned about how to handle this class of problem" is presenting at L5 scope even if the incident was large.

Senior interview preparation means identifying three or four signature stories that demonstrate: scope beyond your team, navigating genuine ambiguity, making a consequential decision with imperfect information, and changing the engineering culture or process in a lasting way. Each story should be exercisable across multiple question prompts because the underlying capability transfers. The engineer who has one story per question is brittle. The engineer who has three deep stories that connect to many questions is robust.

The bar-raiser is also evaluating intellectual honesty. Answers that acknowledge what went wrong, what you did not know at the time, and what you would do differently are more convincing than polished narratives of unambiguous success. Real situations are messy. Pretending they were not is a credibility signal in the wrong direction.

---
