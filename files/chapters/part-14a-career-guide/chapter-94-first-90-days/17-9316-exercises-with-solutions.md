## Exercises

These exercises put the concepts from this chapter into practice by placing you in realistic onboarding scenarios. Working through them before you start a new job, or even during your first week, will help you think through situations you are likely to encounter. Each exercise includes a detailed solution that demonstrates the kind of structured thinking that distinguishes engineers who onboard successfully from those who struggle.

### Exercise 1: Create Your Personal 30-60-90 Day Plan

**Scenario:**
You're starting as a mid-level backend engineer at a Series B startup (200 employees, engineering team of 40). The company builds a B2B SaaS product for inventory management. Your team of 6 owns the order processing service. Create a detailed 30-60-90 day plan.

**Your Task:**
1. Define specific goals for each period
2. List concrete activities and deliverables
3. Identify key relationships to build
4. Plan feedback checkpoints

**Solution:**

```markdown
# 30-60-90 Day Plan: Order Processing Team

## Context:
- Role: Mid-Level Backend Engineer
- Company: Series B SaaS startup, 200 employees
- Team: Order Processing (6 engineers)
- Tech Stack: Go, PostgreSQL, Kafka, Kubernetes (assumed)

---

## Days 1-30: LEARN

### Goals:
1. Fully functional development environment by Day 3
2. Understand order processing domain and data flow by Day 14
3. Ship first bug fix or small feature by Day 21
4. Meet all team members and key stakeholders by Day 30

### Week-by-Week Plan:

**Week 1: Setup and Orientation**
- Day 1: HR, laptop, accounts, meet manager and buddy
- Day 2: Dev environment, clone repos, read READMEs
- Day 3: Run services locally, verify full flow works
- Day 4-5: Read team docs, understand order lifecycle

Deliverables:
- [ ] Working local environment
- [ ] Notes on order processing flow
- [ ] 1:1s scheduled with all team members

**Week 2: Deep Learning**
- Trace an order end-to-end through the system
- Understand database schema
- Review last 20 PRs to learn patterns
- Shadow a code review with senior engineer

Deliverables:
- [ ] Architecture diagram (my understanding)
- [ ] Questions document reviewed with mentor
- [ ] First code review comment (even if small)

**Week 3: First Contribution**
- Pick starter task from backlog
- Write code following team patterns
- Submit PR, respond to feedback
- Participate in sprint ceremonies

Deliverables:
- [ ] First PR submitted
- [ ] Attend retro and provide one observation

**Week 4: Consolidate**
- First PR merged
- Second task started
- 30-day check-in with manager
- Document gaps in my knowledge

Deliverables:
- [ ] At least one PR merged
- [ ] 30-day feedback received
- [ ] Knowledge gaps identified

### Key Relationships (Days 1-30):
| Person | Role | Goal |
|--------|------|------|
| Manager | Direct manager | Alignment, feedback |
| Buddy | Senior engineer | Questions, guidance |
| Team members | Peers (6) | 1:1 with each |
| PM | Product Manager | Understand roadmap |
| Adjacent lead | Payments team lead | Understand integration |

---

## Days 31-60: CONTRIBUTE

### Goals:
1. Complete 3+ meaningful PRs independently
2. Give substantive code reviews
3. Understand business context and customer needs
4. Identify one improvement opportunity

### Week-by-Week Plan:

**Week 5-6: Independence**
- Take on medium-complexity task without hand-holding
- Participate actively in planning and estimation
- Review PRs and provide useful feedback
- Meet with PM to understand customer problems

**Week 7-8: Broaden**
- Skip-level 1:1 with engineering manager
- Meet leads from dependent teams (payments, inventory)
- Understand on-call and start shadowing
- 60-day check-in with manager

### Deliverables:
- [ ] 3+ PRs merged
- [ ] Code reviews given that teammates found valuable
- [ ] Skip-level completed
- [ ] Identified improvement to propose

---

## Days 61-90: IMPACT

### Goals:
1. Own and deliver a significant feature or project
2. Propose and get buy-in for improvement
3. Join on-call rotation (at least secondary)
4. Help onboard a future new hire or intern

### Week-by-Week Plan:

**Week 9-10: Ownership**
- Lead implementation of feature end-to-end
- Make technical decisions with appropriate consultation
- Communicate progress proactively

**Week 11-12: Leadership**
- Present improvement proposal to team
- Complete first on-call shift
- Help newer team member
- 90-day review with manager

### Deliverables:
- [ ] Feature shipped to production
- [ ] Improvement proposal written and discussed
- [ ] On-call capable
- [ ] Clear goals for next quarter

---

## Success Metrics:
- Technical: 5+ PRs merged, code review feedback positive
- Relationships: Know everyone on team, met 5+ people outside team
- Domain: Can explain order processing to new hire
- Impact: Shipped at least one user-visible feature
```

---

### Exercise 2: Building Relationships When Remote

**Scenario:**
You've just started a fully remote position. Your team of 8 is distributed across 4 time zones (PST, EST, GMT, IST). Your manager is in a different time zone than you. Design a relationship-building strategy for your first 30 days.

**Your Task:**
1. Plan how you'll connect with each team member
2. Handle the time zone challenges
3. Build relationship with remote manager
4. Create opportunities for informal connection

**Solution:**

```markdown
# Remote Relationship Building Strategy

## Team Mapping:

| Person | Role | Time Zone | Overlap with me (EST) |
|--------|------|-----------|----------------------|
| Manager | Eng Manager | PST | 12pm-5pm EST |
| Alice | Senior Engineer | GMT | 9am-12pm EST |
| Bob | Senior Engineer | PST | 12pm-5pm EST |
| Carol | Engineer | EST | Full overlap |
| Dave | Engineer | IST | 8am-10am EST |
| Eve | Engineer | PST | 12pm-5pm EST |
| Frank | Junior | GMT | 9am-12pm EST |
| Grace | Junior | EST | Full overlap |

## Strategy by Week:

### Week 1: Foundation

**Day 1-2: Manager Relationship**
- Schedule recurring 1:1 during overlap (Tues 3pm EST)
- Send daily end-of-day update (async)
- Over-communicate, under-assume

**Day 3-5: Immediate Connections**
- Virtual coffee with same-timezone folks first (Carol, Grace)
- These become my "anchor" relationships
- Schedule 1:1s with others for Week 2

### Week 2: Expand

**Time Zone-Friendly Schedule:**
| Person | Scheduled 1:1 | My Sacrifice |
|--------|---------------|--------------|
| Alice (GMT) | 10am EST Tue | None |
| Dave (IST) | 8:30am EST Thu | Early meeting |
| Bob (PST) | 2pm EST Mon | None |
| Eve (PST) | 3pm EST Wed | None |
| Frank (GMT) | 11am EST Fri | None |

**1:1 Format:**
- 25 minutes
- Camera on
- Questions prepared:
  - "What's your background?"
  - "What should I know that isn't in the docs?"
  - "What's the best way to reach you for quick questions?"
  - "Any tips for a new remote team member?"

### Week 3-4: Deepen

**Informal Connections:**
- Virtual coffee (no agenda) with Carol and Grace weekly
- Join any existing social channels/events
- Propose "random coffee" pairing for the team

**Async Relationship Building:**
- React to messages in team channel
- Share interesting learnings publicly
- Thank people publicly when they help
- Contribute to non-work channels

## Manager Relationship Strategy:

### Synchronous:
- Weekly 1:1 (30 min) - sacred, never skip
- Monthly career check-in (separate from weekly)

### Asynchronous:
- Daily end-of-day update in Slack (3 bullets max)
- Weekly summary document (Friday)
- Proactive questions in our DM channel

### Update Format:

A consistent daily update format solves the "out of sight, out of mind" problem that remote and async engineers face. By capping it at three bullets you respect your manager's time while still creating a written record that proves momentum, which matters during performance reviews when your manager needs concrete examples of your contributions.

```
📅 Daily Update - [Date]
✅ Completed: [1-2 items]
🔄 In Progress: [1-2 items]
❓ Blocked/Questions: [if any]
```

### Weekly Summary:

The weekly summary serves a strategic purpose beyond status reporting: it trains your manager to associate you with completed work and forward momentum rather than questions and blockers. Saving complex questions for the 1:1 (noted explicitly in the template) ensures you get the focused discussion time those questions deserve instead of a quick Slack reply that may be misinterpreted.

```
📊 Week of [Date]
Highlights:
- Completed X
- Learned Y
- Met Z

Next Week:
- Planning to A
- Need help with B

Questions for 1:1:
- [Save meaty questions for face time]
```

## Time Zone Tips:

### For Early Morning (Dave - IST):
- Schedule for beginning of my day (8am EST)
- Treat it like gym - consistent commitment
- Worth it for the relationship

### For Late Evening (if needed):
- Rare, but offer flexibility occasionally
- "I'm happy to shift my schedule for this one"

### Async-First Defaults:
- All non-urgent communication via async
- Clear indication of urgency in messages
- Response time expectations set clearly

## Measuring Success:

### After 30 days, I should:
- [ ] Know something personal about each teammate
- [ ] Have clear communication rhythm with manager
- [ ] Feel comfortable asking questions to anyone
- [ ] Have identified 2-3 "go-to" people for help
- [ ] Participated in at least one non-work interaction
```

---

### Exercise 3: Handling a Difficult First 90 Days

**Scenario:**
You're at day 45 and things aren't going well:
- Your manager seems too busy for regular 1:1s
- The codebase is much harder to understand than expected
- A senior engineer on the team seems skeptical of your abilities
- You've only shipped one small PR

**Your Task:**
1. Diagnose what's going wrong
2. Create a recovery plan
3. Plan difficult conversations
4. Set realistic expectations for days 45-90

**Solution:**

```markdown
# 45-Day Recovery Plan

## Diagnosis:

### Problem 1: Manager Unavailability
**Symptoms:**
- 1:1s frequently canceled
- Little feedback received
- Unclear if on track

**Root Cause Options:**
a) Manager is genuinely overloaded
b) I'm not communicating proactively enough
c) This is how they manage (hands-off)

**Assessment:** Need to determine which

### Problem 2: Codebase Difficulty
**Symptoms:**
- Slower than expected ramp-up
- Only 1 PR in 45 days
- Feeling lost in the code

**Root Cause Options:**
a) Codebase is genuinely complex
b) My approach to learning isn't working
c) I need more help than I've asked for

**Assessment:** Probably combination of all three

### Problem 3: Skeptical Senior Engineer
**Symptoms:**
- Seems dismissive in interactions
- Tough code reviews
- Doesn't offer help

**Root Cause Options:**
a) They're skeptical of everyone new
b) I've done something to damage trust
c) Misreading the situation (they're just direct)

**Assessment:** Need to address directly

---

## Recovery Plan:

### Week 6: Reset

**Manager Conversation:**
Agenda for next 1:1 (make it happen):

"I want to check in on how I'm doing. I've noticed:
- We've missed a few 1:1s
- I've only shipped one PR in 45 days
- I want to make sure I'm meeting expectations

Questions:
- How do you think I'm ramping up?
- Any concerns I should know about?
- What would help us stay connected given your schedule?
- What should I focus on for the next 45 days?"

**Codebase Strategy Shift:**
Current approach isn't working, so change it:

1. Request dedicated pairing time (1hr/day for a week)
2. Focus on ONE area deeply vs. trying to understand everything
3. Ask for simpler tasks to build confidence
4. Create documentation as I learn (contributes while learning)

**Senior Engineer Conversation:**
Request a 1:1:

"I'd value your perspective. I'm at day 45 and want to
accelerate my ramp-up. You know this codebase deeply.
Could I get 30 minutes of your time to understand:
- What should I focus on learning?
- What common mistakes do new engineers make?
- How can I be most useful to the team?"

Approach: Seek their advice, not approval

### Week 7-8: Execute

**Daily Focus:**
- Morning: 2 hours focused coding/learning
- Midday: PR or code review activity
- Afternoon: One relationship conversation
- EOD: Update to manager (async)

**Weekly Goals:**
- Week 7: 1 PR shipped, 2 code reviews
- Week 8: 2 PRs shipped, 3 code reviews, doc contribution

### Week 9-12: Catch Up

**Revised 90-Day Goals:**
Given the rough start, adjust expectations:

Original goals (unrealistic now):
- Lead a significant feature
- 5+ PRs
- Full independence

Revised goals (realistic):
- 4 PRs total (3 more from now)
- One meaningful contribution beyond code
- Clear understanding of one system area
- Improved relationships, especially with senior

---

## Difficult Conversation Scripts:

### With Manager:
"I want to be transparent: I feel like I'm behind where I
should be at day 45. I've only shipped one PR. I want to
understand:
- Is this a concern, or is this within normal range?
- What can I do differently?
- How can we make sure we have more regular touch points?"

### With Skeptical Senior:
"I've noticed our interactions have been brief. I'd love to
get your perspective on how I can improve. You've been here
longer and know what it takes to succeed. What advice would
you give someone at day 45 who wants to accelerate?"

(If they share concerns, thank them genuinely and act on it)

### With Skip-Level (if needed):
"I wanted to introduce myself and share how my first weeks
have been. I've faced some challenges ramping up [be honest]
and I'm working with [manager] on getting on track. I wanted
you to hear it directly from me rather than be surprised."

---

## Success Criteria for Days 45-90:

### Technical:
- [ ] 4 PRs total shipped
- [ ] Code reviews providing value
- [ ] Can explain one system in detail

### Relationships:
- [ ] Regular manager communication restored
- [ ] Senior engineer relationship improved
- [ ] Skip-level introduced

### Perception:
- [ ] Manager says I'm "on track" by day 90
- [ ] No surprises at review

### Personal:
- [ ] Feeling less stressed
- [ ] Clear path forward
- [ ] Know what success looks like
```

### Junior → FAANG: Working Through Onboarding Exercises as Simulation Practice

The exercises in this section are most valuable when worked through before starting a new role rather than during it. If you are between jobs, use them as simulation: pretend you are in the scenario described, write your planned response, and then compare with the solution. The gap between your response and the solution is the preparation work remaining.

Pay particular attention to exercises that involve difficult interpersonal situations: disagreeing with a technical decision in your first month, managing a tense conversation with a senior engineer who gives you confusing feedback, or handling a production incident you do not fully understand. These are the situations where the right behavior is non-obvious and where early-career engineers most often make mistakes that damage their standing.

### Senior @ FAANG: Extending Exercises to Staff-Level Scenario Planning

At senior level, extend each exercise with a staff-level constraint: how would your answer change if you were responsible for three teams instead of one, if you were making a decision that affected an organization-wide platform rather than a single service, or if you had to build consensus across teams with conflicting technical opinions.

The staff-level extension to the "how do you handle a production incident" exercise: how do you manage communication to stakeholders across three teams simultaneously, how do you make a go/no-go decision when you do not have all the information you need, and how do you ensure the post-mortem produces systemic improvements rather than individual-level blame. These are the scenarios that distinguish staff-level operational judgment from senior individual contributor judgment, and practicing them explicitly before you need them is the most effective preparation available.

---
