## 90.10 Core Concepts Recap

### Key Takeaways

The staff engineer role is fundamentally about creating leverage, multiplying the effectiveness of the engineers and teams around you in ways that go far beyond what any single person can build alone. The following points capture the most important lessons from this chapter that you should carry forward into your daily work.

1. **Know your archetype** - Tech Lead, Architect, Solver, or Right Hand
2. **Invest in the transition** - First 90 days are critical
3. **Manage your time ruthlessly** - Protect deep work, be selective with meetings
4. **Build influence deliberately** - Relationships, results, communication
5. **Stay technical enough** - Keep coding, stay in reviews
6. **Make your impact visible** - Document, present, share

### Staff Engineer Checklist

Use this checklist as a regular self-assessment to ensure you are operating at staff level and not falling back into senior engineer habits. Review it monthly and be honest with yourself about any items you are not meeting. Each unchecked item represents an area where you may be leaving staff-level impact on the table.

- [ ] Clear understanding of my archetype and scope
- [ ] Regular 1:1s with key stakeholders
- [ ] Protected time for deep work
- [ ] At least one significant initiative I own
- [ ] Mentoring at least one engineer
- [ ] Writing and sharing regularly
- [ ] Tracking and communicating my impact

---

## 90.11 Interview Questions with Detailed Frameworks

### Question 1: "What does a Staff Engineer do that a Senior Engineer doesn't?"

**What interviewers are looking for**:
- Understanding of scope and scale differences
- Appreciation for multiplicative impact
- Awareness of organizational influence

**Strong Answer Framework**:

```
"The key differences between Senior and Staff engineers are in scope,
impact model, and how they create value:

SCOPE DIFFERENCES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Dimension      | Senior Engineer           | Staff Engineer              |
|----------------|---------------------------|-----------------------------|
| Team scope     | One team                  | Multiple teams or org       |
| Time horizon   | Sprint to quarter         | Quarter to years            |
| Ambiguity      | Defined problems          | Define the problems         |
| Impact model   | Individual contribution   | Multiplication through others|
| Decisions      | Technical implementation  | Technical direction         |
| Communication  | Peers and manager         | Leadership and cross-org    |

IMPACT MODEL SHIFT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Senior: Impact = My Output
  'I shipped 3 features and fixed 12 bugs'

Staff: Impact = My Output + (Others' Output × My Enablement)
  'I shipped 1 major system + enabled 8 engineers to deliver 20 features
   faster through the platform I built'

CONCRETE EXAMPLES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. TECHNICAL DIRECTION:
   Senior: 'Should we use Redis or Memcached for this feature?'
   Staff: 'What's our org-wide caching strategy for the next 3 years?'

2. CODE REVIEWS:
   Senior: 'This function could be cleaner'
   Staff: 'This pattern conflicts with our migration plan - here's why'

3. PROBLEMS:
   Senior: 'How do I build this efficiently?'
   Staff: 'What should we even build? What problems are we not seeing?'

4. MEETINGS:
   Senior: Mostly with team, some cross-team
   Staff: Regular interaction with leadership, partner teams, architects

The transition from Senior to Staff is less about being a 'better'
individual contributor and more about expanding the scope of how
you think about and deliver impact.
"
```

---

### Question 2: "Describe a time you had to influence a decision without having authority over the people involved."

**What interviewers are looking for**:
- Influence skills
- Stakeholder management
- Communication and persuasion

**Strong Answer Framework**:

```
"At [Previous Company], I needed to convince 4 teams to adopt a new
service mesh architecture. I had no authority over any of them.

THE SITUATION:
- 4 platform teams, each with different priorities
- Each had valid concerns about migration effort
- No executive mandate to adopt
- My role: Staff engineer on infrastructure team

MY APPROACH:

1. UNDERSTAND THEIR CONCERNS (Week 1-2)
   - Met 1:1 with each tech lead
   - Asked: 'What are your biggest infrastructure pain points?'
   - Discovered: 3 of 4 teams had observability problems
   - Key insight: My solution could solve THEIR problems

2. BUILD ALLIANCES (Week 3-4)
   - Identified Team A as most likely early adopter
   - Offered to do 80% of their migration work myself
   - Proposed: 'Let me prove value with you first'
   - They agreed - now I had one ally

3. CREATE EVIDENCE (Week 5-8)
   - Migrated Team A with minimal disruption
   - Documented: 40% reduction in debugging time
   - Created case study with their lead's endorsement
   - Made results visible in engineering all-hands

4. LEVERAGE SOCIAL PROOF (Week 9-12)
   - Team B came to us after seeing Team A's success
   - Created 'office hours' for migration support
   - Teams C and D followed within 2 months

RESULTS:
- All 4 teams adopted within 3 months
- No executive mandate required
- Teams felt ownership of decision
- Solution was better because of their input

KEY TACTICS I USED:
- Started with their problems, not my solution
- Found one champion to create momentum
- Made success visible to create FOMO
- Did the hard work to reduce their burden
- Gave credit generously
"
```

---

### Question 3: "How do you balance staying technical with Staff-level responsibilities?"

**What interviewers are looking for**:
- Time management
- Understanding of the role
- Practical strategies

**Strong Answer Framework**:

```
"This is one of the central tensions of Staff engineering. Here's how
I approach it:

MY TIME ALLOCATION TARGET:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

| Activity                    | % of Time |
|-----------------------------|-----------|
| Coding and code reviews     | 25-30%    |
| Design and documentation    | 25%       |
| Meetings and coordination   | 20%       |
| Mentoring and 1:1s          | 15%       |
| Strategic work              | 10%       |

STRATEGIES I USE:

1. PROTECTED DEEP WORK BLOCKS
   - 4 hours every Tuesday and Thursday morning
   - Calendar blocked, Slack notifications off
   - This is when I code or do deep design work

2. CODE THAT MATTERS
   - I don't code everything - I choose what to code
   - Focus on: core abstractions, critical paths, prototypes
   - Let others handle: features, bug fixes, routine work
   - My code should multiply others' effectiveness

3. STAY IN CODE REVIEWS
   - Even if I can't write as much code, I read a lot
   - Thorough reviews on architectural decisions
   - Lighter touch on routine changes
   - This keeps me current on the codebase

4. OWN ONE COMPONENT END-TO-END
   - I always have one piece I'm responsible for
   - Currently: our internal service framework
   - I write code, fix bugs, do on-call for this
   - Keeps me grounded in reality

5. PROTOTYPE BEFORE PROPOSING
   - Before writing an RFC, I build a working prototype
   - Proves feasibility, reveals hidden complexity
   - My proposals are stronger because I've done the work

WARNING SIGNS I WATCH FOR:
- 'I haven't looked at that code in weeks'
- My estimates are consistently wrong
- I'm surprised by how things actually work
- Teams hesitate to ask my technical opinion

If I see these signs, I know I need to recalibrate toward
more hands-on work.
"
```

---

### Question 4: "Tell me about a time you disagreed with your leadership on a technical direction. How did you handle it?"

**What interviewers are looking for**:
- Professional disagreement skills
- Judgment about when to push back
- Understanding of organizational dynamics

**Strong Answer Framework**:

```
"At [Company], leadership wanted to build a custom container
orchestration system instead of adopting Kubernetes. I disagreed
strongly but needed to handle it carefully.

THE SITUATION:
- VP of Engineering preferred 'build' over 'buy'
- Arguments: 'Kubernetes is too complex', 'We need custom features'
- At stake: 2 years of engineering effort, ongoing maintenance
- My assessment: This was a mistake that would cost millions

MY APPROACH:

STEP 1: UNDERSTAND THEIR POSITION (Week 1)
- Met with VP to understand the full reasoning
- Asked questions, didn't argue
- Learned: Previous Kubernetes attempt failed due to poor implementation
- Their fear was based on real experience

STEP 2: GATHER DATA (Week 2-3)
- Researched industry adoption (85%+ of similar companies on K8s)
- Analyzed what went wrong in previous attempt
- Calculated TCO: Custom = $4M over 3 years, K8s = $1.5M
- Interviewed engineers from 3 companies who made the switch

STEP 3: BUILD COALITION (Week 3-4)
- Shared findings with 3 senior engineers (they agreed)
- Got buy-in from SRE lead (would own operations)
- Had Director of Platform review my analysis

STEP 4: PROPOSE ALTERNATIVE (Week 4)
- Requested meeting with VP
- Presented not as 'you're wrong' but as 'new information'
- Addressed their specific concerns with specific solutions
- Proposed: Kubernetes with managed service + dedicated platform team
- Offered: I'll lead the migration and be accountable for success

STEP 5: ACCEPT THE DECISION
- VP was persuaded, approved K8s with my proposal
- Key: I proposed a DIFFERENT approach to K8s, not just 'do K8s again'

WHAT IF THEY HAD SAID NO:
If after making my case the decision was still 'build custom',
I would have:
1. Documented my concerns formally (for the record)
2. Committed fully to making the chosen approach succeed
3. Not undermined the decision or said 'I told you so' later
4. Continued to look for opportunities to course-correct

THE OUTCOME:
- K8s migration completed in 6 months
- Platform costs reduced 60%
- VP later cited this as 'good pushback'

KEY PRINCIPLES:
- Disagree with data, not emotion
- Understand their position first
- Offer alternatives, not just criticism
- Commit once the decision is made
- Make it easy for them to change their mind
"
```

---

## Exercises

### Exercise 1: Staff Engineer Archetype Assessment

**Problem**: Assess which Staff Engineer archetype best fits your skills, preferences, and career goals. Create a development plan for your chosen archetype.

**Solution**:

````markdown
# Staff Engineer Archetype Self-Assessment

## Part 1: Honest Self-Evaluation

Score each statement 1-5 (1=Strongly Disagree, 5=Strongly Agree)

### Tech Lead Indicators
[ ] I enjoy being deeply embedded with a team                    ___
[ ] I want to continue shipping code regularly                   ___
[ ] I prefer depth in one area over breadth                      ___
[ ] I'm energized by day-to-day mentoring                        ___
[ ] I like seeing direct team impact from my work                ___
                                                     TOTAL: ___/25

### Architect Indicators
[ ] I think naturally in systems and patterns                    ___
[ ] I enjoy designing standards that others follow               ___
[ ] I want to influence multiple teams                           ___
[ ] I can balance elegant design with pragmatism                 ___
[ ] I communicate well across different groups                   ___
                                                     TOTAL: ___/25

### Solver Indicators
[ ] I love diving into hard, ambiguous problems                  ___
[ ] I prefer autonomous work over team collaboration             ___
[ ] I'm comfortable with high uncertainty                        ___
[ ] I want variety and novelty in my work                        ___
[ ] I can context-switch effectively                             ___
                                                     TOTAL: ___/25

### Right Hand Indicators
[ ] I'm interested in organizational dynamics                    ___
[ ] I can translate between technical and business               ___
[ ] I enjoy strategic, long-term thinking                        ___
[ ] I'm comfortable in lots of meetings                          ___
[ ] I want to multiply leadership impact                         ___
                                                     TOTAL: ___/25

## Part 2: Results Analysis

My highest score archetype: ___________________ (Primary)
My second highest: ___________________ (Secondary)

Common blends:
- Tech Lead + Architect: Technical direction for a domain
- Architect + Solver: Moving between design and hard problems
- Solver + Right Hand: Strategic problem-solving

## Part 3: Gap Analysis

For my primary archetype (Tech Lead example):

| Required Skill              | Current Level | Gap | Development Plan        |
|-----------------------------|---------------|-----|-------------------------|
| Team leadership             | 3/5           | 2   | Lead project end-to-end |
| Code review at scale        | 4/5           | 1   | Process improvements    |
| Mentoring effectiveness     | 2/5           | 3   | Formal mentorship       |
| Partnership with EM         | 2/5           | 3   | Regular sync meetings   |
| Technical decision-making   | 4/5           | 1   | Document decisions      |

## Part 4: 6-Month Development Plan

### Month 1-2: Foundation
- [ ] Meet with current Staff engineers in my target archetype
- [ ] Read "Staff Engineer" by Will Larson
- [ ] Identify one project that exercises archetype skills
- [ ] Start monthly skip-level 1:1s

### Month 3-4: Practice
- [ ] Lead or heavily influence one cross-team initiative
- [ ] Write and publish one technical vision document
- [ ] Mentor one engineer formally (weekly 1:1s)
- [ ] Present technical work to broader audience

### Month 5-6: Demonstrate
- [ ] Own technical direction for a significant project
- [ ] Document impact in Staff-level terms
- [ ] Get feedback from potential sponsors
- [ ] Identify gaps for next development cycle

## Part 5: Evidence Collection

Track these artifacts to demonstrate archetype fit:

For Tech Lead:
- Team health metrics (velocity, quality, morale)
- Code contributions and reviews
- Design decisions and outcomes
- Mentee growth and promotions

For Architect:
- Design documents and RFCs
- Standards and patterns adopted
- Cross-team influence
- Technical roadmaps

For Solver:
- Complex problems solved
- Fire drills resolved
- Novel solutions implemented
- Cross-functional problems addressed

For Right Hand:
- Strategic initiatives led
- Executive presentations
- Org-wide changes influenced
- Technical strategy documents
````

---

### Exercise 2: 90-Day Staff Transition Plan

**Problem**: Create a detailed 90-day plan for transitioning into a Staff Engineer role at a new company.

**Solution**:

````markdown
# 90-Day Staff Engineer Transition Plan

## Week 1: Orientation and Context

### Day 1-2: Administrative and Setup
- [ ] Complete HR onboarding
- [ ] Set up development environment
- [ ] Get access to all relevant systems
- [ ] Review org chart and team structures
- [ ] Schedule 1:1 with manager

### Day 3-5: Context Gathering
- [ ] Meet with manager: Understand expectations and priorities
- [ ] Review team/org OKRs and current initiatives
- [ ] Read company engineering blog posts
- [ ] Access and review key documentation (architecture, RFCs)
- [ ] Identify 10 key people to meet with

Key questions for manager 1:1:
- What does success look like in 90 days? 6 months?
- What are the biggest technical challenges right now?
- Who are the key stakeholders I should build relationships with?
- What authority do I have to make decisions?
- What's the culture around RFCs and design reviews?

## Week 2: Deep Dive on Technical Context

### Technical Discovery
- [ ] Read last 5 major RFCs or design docs
- [ ] Review architecture diagrams
- [ ] Understand service dependencies
- [ ] Identify critical paths and SLAs
- [ ] Review recent incidents and post-mortems

### Codebase Exploration
- [ ] Clone and build main repositories
- [ ] Trace through one end-to-end request flow
- [ ] Review coding standards and style guides
- [ ] Look at test patterns and coverage
- [ ] Understand deployment pipeline

### Documentation I'm Creating
- [ ] Personal onboarding notes (what confused me = what to improve)
- [ ] Questions list for each team/area
- [ ] Initial observations (not recommendations yet)

## Week 3-4: Relationship Building

### Stakeholder Meetings (30 min each)
- [ ] Skip-level manager
- [ ] Engineering Manager partners
- [ ] Product Manager(s) for my area
- [ ] Staff/Principal peers
- [ ] Key senior engineers on related teams
- [ ] SRE/Platform team leads
- [ ] Security team contact

### Questions for Stakeholder Meetings:
1. What's your biggest challenge right now?
2. What do you wish engineering would do differently?
3. What's worked well with Staff engineers in the past?
4. What's one thing you'd love help with?
5. How do you prefer to collaborate?

### Relationship Building Actions:
- [ ] Offer to help with something small (code review, debugging)
- [ ] Follow up on anything you can help with
- [ ] Add value before asking for anything
- [ ] Remember personal details from conversations

## Week 5-6: Initial Contribution

### Quick Win Project
Criteria: Visible, Low risk, Completable in 2 weeks, Demonstrates Staff judgment

Example options:
- Fix a long-standing developer experience issue
- Improve documentation for an area that confused you
- Prototype a solution to a problem identified in discovery
- Automate something manual that teams complain about

My chosen quick win: _________________

### Quick Win Execution:
- [ ] Validate approach with key stakeholder
- [ ] Implement solution
- [ ] Get review and feedback
- [ ] Document and announce
- [ ] Measure impact

### Parallel: Start Longer-Term Thinking
- [ ] Identify 2-3 larger opportunities from discovery
- [ ] Draft initial thoughts (not proposals yet)
- [ ] Discuss with manager to validate direction

## Week 7-8: Establishing Presence

### Design Review Participation
- [ ] Attend 2-3 design reviews
- [ ] Provide thoughtful feedback (not just nitpicks)
- [ ] Ask questions that reveal gaps
- [ ] Share relevant experience from past roles

### Knowledge Sharing
- [ ] Write one internal blog post or tech talk proposal
- [ ] Share lessons from quick win project
- [ ] Document something that wasn't well documented

### Mentorship Start
- [ ] Identify 1-2 engineers who could benefit from guidance
- [ ] Offer informal help (don't force formal relationship yet)
- [ ] Help someone with a code review or design

## Week 9-10: Strategic Contribution

### RFC or Proposal
- [ ] Choose one significant improvement to propose
- [ ] Write draft RFC using company template
- [ ] Get informal feedback before formal review
- [ ] Incorporate feedback, submit for review
- [ ] Present and defend proposal

### Building Momentum
- [ ] Regular 1:1s with key stakeholders established
- [ ] Visible contributions in Slack/meetings
- [ ] Name recognition starting ("Oh, you're the one who...")
- [ ] Quick win impact being recognized

## Week 11-12: Planning Forward

### 6-Month Focus Areas
Work with manager to define:

| Focus Area | Description | Success Metrics |
|------------|-------------|-----------------|
| Primary    | ___________ | ____________    |
| Secondary  | ___________ | ____________    |
| Ongoing    | ___________ | ____________    |

### Self-Evaluation
Honest assessment at 90 days:

| Dimension            | Status | Notes                    |
|----------------------|--------|--------------------------|
| Technical context    | ___/5  | ________________________ |
| Key relationships    | ___/5  | ________________________ |
| Quick win delivered  | Y/N    | ________________________ |
| Trust established    | ___/5  | ________________________ |
| Clear path forward   | ___/5  | ________________________ |

### Adjustments Needed
Based on feedback and observations:
- What's working well?
- What should I do more of?
- What should I stop or do less of?
- What support do I need?

## Success Criteria Checklist

### Minimum (Must achieve by Day 90):
- [ ] Understand technical landscape of my area
- [ ] Have relationships with 10+ key stakeholders
- [ ] Delivered one visible quick win
- [ ] Have clear 6-month priorities agreed with manager
- [ ] Started one longer-term initiative

### Stretch (Great if achieved):
- [ ] RFC approved and implementation started
- [ ] Recognized by name outside my immediate team
- [ ] Mentoring relationship established
- [ ] Identified for one cross-team initiative
- [ ] Skip-level manager knows my work
````

---

### Exercise 3: Staff-Level Impact Documentation

**Problem**: Review your work from the past quarter and document it in Staff-level terms. Create a visibility improvement plan.

**Solution**:

````markdown
# Staff-Level Impact Documentation Template

## Quarter: Q[X] 20XX

---

## Part 1: Work Inventory

### Major Projects/Initiatives

| Project | My Role | Time Spent | Teams Impacted |
|---------|---------|------------|----------------|
| Example: Payment API v2 | Tech Lead | 40% | Payments, Checkout, Mobile |
| _____________________ | ________ | _____ | _________________________ |
| _____________________ | ________ | _____ | _________________________ |

### Artifacts Produced

| Type | Title | Audience | Status |
|------|-------|----------|--------|
| RFC | Payment API v2 Design | Engineering | Approved |
| Design Doc | Caching Strategy | Platform | Draft |
| Tech Talk | Error Handling Best Practices | All Eng | Delivered |
| _________ | _____________________ | ________ | ________ |

### Mentoring/People Work

| Person | Activity | Outcome |
|--------|----------|---------|
| Alex (L4) | Career guidance, code review | Promoted to L5 |
| Sam (L3) | Project guidance | Led first solo feature |
| ________ | __________________ | ________________________ |

---

## Part 2: Reframe as Staff Impact

### Transform from "What I Did" to "Impact I Created"

BEFORE (Senior framing):
"I implemented payment API v2"

AFTER (Staff framing):
"Led Payment API v2, resulting in:
- 40% reduction in integration time for partner teams
- 3 teams unblocked to build new features
- Established patterns adopted by 2 other API redesigns
- Mentored 2 engineers who are now API design experts"

### My Quarter Reframed:

**Initiative 1: _________________**

What I did: ____________________

Staff-level impact:
- Business outcome: ____________________
- Teams enabled: ____________________
- Patterns established: ____________________
- People grown: ____________________

**Initiative 2: _________________**

What I did: ____________________

Staff-level impact:
- Business outcome: ____________________
- Teams enabled: ____________________
- Patterns established: ____________________
- People grown: ____________________

---

## Part 3: Visibility Audit

### Who Knows About My Work?

| Stakeholder Level | Awareness | Evidence |
|-------------------|-----------|----------|
| Direct manager | High | Weekly 1:1s |
| Skip-level | _____ | _____________________ |
| Peer Staff engineers | _____ | _____________________ |
| Partner team leads | _____ | _____________________ |
| Engineering leadership | _____ | _____________________ |
| Product leadership | _____ | _____________________ |

### Visibility Gaps Identified:

1. ____________________
2. ____________________
3. ____________________

---

## Part 4: Visibility Improvement Plan

### Immediate Actions (This Week)

- [ ] Send weekly update email to manager with impact summary
- [ ] Schedule 1:1 with skip-level to share key wins
- [ ] Post summary of Q[X] work in engineering Slack

### This Month

- [ ] Propose tech talk on [topic from this quarter]
- [ ] Write blog post on [lesson learned]
- [ ] Present impact at team/org all-hands

### This Quarter

- [ ] Build sponsorship relationship with Director [Name]
- [ ] Get included in leadership technical discussions
- [ ] Represent team in cross-org initiative

### Communication Templates

**Weekly Update Email:**
```
Subject: [Name]'s Weekly Update - [Date]

This week:
- [Impact 1 in business terms]
- [Impact 2 in business terms]

Blockers:
- [Any blockers with proposed resolution]

Coming up:
- [Key priorities for next week]

Ask:
- [Specific help needed, if any]
```

**Quarterly Impact Summary:**
```
Q[X] Impact Summary - [Name]

TOP 3 IMPACTS:
1. [Business-framed impact with metrics]
2. [Business-framed impact with metrics]
3. [Business-framed impact with metrics]

TEAMS ENABLED:
- [Team]: [How I helped them succeed]

PEOPLE GROWN:
- [Person]: [Growth enabled]

ARTIFACTS CREATED:
- [Links to RFCs, docs, talks]

LEARNINGS FOR THE ORG:
- [Insight others should know]
```

---

## Part 5: Evidence for Future Promotion

### Principal Engineer Criteria Mapping

| Criteria | Evidence from This Quarter | Gap |
|----------|---------------------------|-----|
| Org-wide impact | _____________________ | _____ |
| Technical vision | _____________________ | _____ |
| Industry presence | _____________________ | _____ |
| Mentored Staff eng | _____________________ | _____ |
| Cross-org leadership | _____________________ | _____ |

### Portfolio Building

What artifacts should I preserve?
- [ ] This RFC showed org-wide technical judgment
- [ ] This design doc set a pattern others followed
- [ ] This post-mortem demonstrated system thinking
- [ ] This talk established my expertise in [area]

### Next Quarter Focus

Based on gaps identified, I should focus on:
1. ____________________
2. ____________________
3. ____________________
````

---

## Summary

### Staff Engineer Success Checklist

This checklist provides a complete view of the six dimensions that define staff-level effectiveness. Regularly assess yourself against each dimension and focus your development efforts on the areas where you answer "No." If you can honestly check "Yes" for all six, you are operating at a strong staff level and likely ready to think about the principal track.

| Dimension | Indicator | Self-Assessment |
|-----------|-----------|-----------------|
| Scope | Working across teams, not just within one | □ Yes □ No |
| Impact | Multiplying through others, not just own output | □ Yes □ No |
| Decisions | Owning technical direction, not just implementing | □ Yes □ No |
| Visibility | Known to leadership, not just team | □ Yes □ No |
| Mentoring | Growing others deliberately | □ Yes □ No |
| Technical | Staying hands-on enough to be credible | □ Yes □ No |

### Quick Reference: Staff Engineer Archetypes

The table below provides a quick comparison of the four staff engineer archetypes across the dimensions that matter most for day-to-day work. Use it as a reference when deciding which archetype fits your current situation, keeping in mind that the coding percentage is a rough guideline that varies significantly depending on your organization and team needs.

| Archetype | Primary Focus | Time Horizon | Coding % |
|-----------|---------------|--------------|----------|
| Tech Lead | Team technical success | Sprint to quarter | 40-60% |
| Architect | Domain technical direction | Quarter to year | 20-40% |
| Solver | Hardest org problems | Varies | 40-70% |
| Right Hand | Strategic execution | Year to years | 10-30% |

---

### Part XIII-A Core Track Summary

You've completed the foundational chapters of the Senior Engineer Mindset section:

1. **Chapter 84**: Technical Leadership - Leading without authority
2. **Chapter 85**: System Thinking - Understanding complex systems
3. **Chapter 86**: Career Growth - Path from Senior to Staff+
4. **Chapter 87**: Code Reviews at Scale - Review culture and practices
5. **Chapter 88**: Technical Writing & RFCs - Documents that drive decisions
6. **Chapter 89**: Leading Large Refactors - Managing major migrations
7. **Chapter 90**: Staff Engineer Playbook - Operating at Staff level

**Next in Part XIII-A**: Chapter 90B: Architecture Decision Records (ADRs) - Documenting irreversible technical decisions.

### Junior → FAANG: Using the Summary as a Gap Analysis Tool

A chapter summary is most valuable as a gap analysis, not a review. Read each point and ask: do I have a concrete example of doing this, or only a theoretical understanding? The distance between those two answers is the practical work that needs to happen before you can credibly present yourself as operating at the level described.

Pick one concept from this summary that you have only theoretical familiarity with, and find a way to practice it in the next 30 days. If that concept is "technical strategy documents," find a problem on your team that nobody has written up formally and write the document. Share it. Iterate on it based on feedback. That cycle of writing, sharing, and iterating is the actual practice of staff-level work, and you can begin it at any seniority level.

### Senior @ FAANG: Integrating the Playbook Into Org-Level Practice

The patterns in this chapter are most valuable when they move from individual knowledge to shared organizational practice. A staff engineer who applies these frameworks alone is limited by their individual bandwidth. A staff engineer who teaches these frameworks to the senior engineers around them, integrates them into onboarding materials, and references them in design reviews is multiplying their impact.

The measure of a successful staff engineer is not whether they operated at staff level, but whether the engineers around them grew toward staff-level patterns. If, after two years of a staff engineer's tenure, the senior engineers on adjacent teams write clearer design docs, produce better ADRs, think more carefully about cross-team impact before shipping, and have better instincts about when to escalate versus when to resolve locally, that staff engineer has created lasting organizational value. That kind of impact is what distinguishes L7 performance from L6 performance in calibration committees at every major FAANG company.

---
