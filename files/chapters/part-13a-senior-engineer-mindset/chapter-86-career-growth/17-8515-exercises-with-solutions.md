## Exercises

### Exercise 1: Level Gap Analysis

**Objective**: Identify specific gaps between your current performance and your target level.

**Instructions**: Complete this analysis for your current and target level.

**Solution Example**:

```markdown
# Level Gap Analysis

## Current Level: Senior Engineer (L5)

## Target Level: Staff Engineer (L6)

## Dimension 1: Scope

Current state:
- Own features within my team's service
- Scope typically 2-4 weeks of work
- Impact contained to my team

Target state:
- Own systems across multiple teams
- Scope typically 1-2 quarters
- Impact spans organization

Gap:
- Haven't led cross-team initiatives
- Work stays within team boundaries

Actions:
1. Volunteer for cross-team API standardization project (Q1)
2. Offer to lead integration with payments team (Q2)
3. Propose shared logging library adoption across teams (Q2)

Evidence of progress:
- Led at least one cross-team initiative
- Documented impact beyond my team

---

## Dimension 2: Ambiguity

Current state:
- Solve well-defined problems given by manager/product
- Wait for problems to be assigned

Target state:
- Identify and define problems proactively
- Create clarity from ambiguity

Gap:
- Tend to wait for direction
- Haven't proposed major technical initiatives

Actions:
1. Write RFC for problem I've identified but no one assigned (Q1)
2. Create tech debt prioritization framework for team (Q1)
3. Propose observability improvements I've noticed we need (Q2)

Evidence of progress:
- At least 2 RFCs initiated by me (not assigned)
- Manager feedback noting proactive problem identification

---

## Dimension 3: Influence

Current state:
- Influence within my team
- People ask my opinion on my domain

Target state:
- Influence across org
- Shape technical decisions outside my team

Gap:
- Limited visibility outside team
- Don't participate in cross-team decisions

Actions:
1. Join architecture review committee (Q1)
2. Present at engineering all-hands (Q2)
3. Write internal blog post series on distributed systems (Q1-Q2)

Evidence of progress:
- Invited to architecture reviews for other teams
- Feedback from engineers outside my team citing my influence

---

## Summary Timeline

| Quarter | Focus Areas | Key Actions |
|---------|-------------|-------------|
| Q1 | Visibility, Proactivity | RFC, blog posts, join architecture committee |
| Q2 | Cross-team impact | Lead integration project, present at all-hands |
| Q3 | Consolidate and document | Build promotion packet, gather feedback |
| Q4 | Promotion discussion | Review with manager, submit packet |

## Sponsors to Cultivate
- Sarah (Director) - Schedule monthly 1:1s
- Mike (Staff Eng on Platform) - Collaborate on shared library

## Risks and Mitigations
- Risk: Cross-team project falls through
  Mitigation: Have 2-3 candidate projects, be flexible
- Risk: Blog posts don't get traction
  Mitigation: Share in Slack, present at meetings
```

### Exercise 2: Accomplishment Inventory

**Objective**: Document your accomplishments with quantified impact for promotion discussions.

**Instructions**: List your top accomplishments using this format.

**Solution Example**:

```markdown
# Accomplishment Inventory (Past 12 Months)

## Accomplishment 1: Payment System Redesign
**What**: Led redesign of payment processing pipeline
**Scope**: Team (5 engineers) + integration with 2 other teams
**Impact**:
- Reduced p99 latency from 2.1s to 180ms (91% improvement)
- Decreased failed transactions by 40%
- Saved $150K/year in payment processor fees through batching
**My role**: Technical lead, designed the architecture, coordinated
with payments and fraud teams, reviewed all PRs

## Accomplishment 2: Observability Initiative
**What**: Implemented distributed tracing across services
**Scope**: Affected 6 services across 3 teams
**Impact**:
- Reduced mean time to resolution (MTTR) by 60%
- Enabled debugging that was previously impossible
- Adopted as standard pattern for new services
**My role**: Proposed initiative, wrote RFC, implemented core library,
trained other teams

## Accomplishment 3: Mentorship
**What**: Mentored 2 junior engineers
**Scope**: Individual contributor development
**Impact**:
- Both engineers promoted to mid-level within 12 months
- Created onboarding materials used by 8 new hires
- One mentee now mentoring others
**My role**: Weekly 1:1s, pair programming, code review feedback,
career advice

## Accomplishment 4: Incident Response
**What**: Led response to Black Friday database outage
**Scope**: Company-wide incident
**Impact**:
- Restored service in 23 minutes (SLA was 30)
- Limited revenue impact to ~$50K (estimated $200K/hour at risk)
- Postmortem led to 5 systemic improvements
**My role**: Incident commander, identified root cause, coordinated
rollback, wrote postmortem

## Accomplishment 5: Technical Interviews
**What**: Conducted 40+ technical interviews
**Scope**: Engineering hiring across 4 teams
**Impact**:
- Hired 8 engineers who passed probation
- Zero regrettable hires from my recommendations
- Created system design rubric used by 12 interviewers
**My role**: Interviewer, calibration participant, rubric author

---

## Summary for Promotion Packet

### Quantified Impact:
- $150K/year cost savings (payment system)
- 91% latency improvement (payment system)
- 60% MTTR improvement (observability)
- 2 engineers promoted through mentorship
- 40+ interviews conducted

### Scope Demonstration:
- Technical lead for cross-team initiatives
- Impact across 6+ services and 4 teams
- Incident commander for P0 incident

### Next-Level Work:
- Already operating at Staff level in:
  - Cross-team technical leadership
  - Org-wide influence through standards
  - Mentoring other senior engineers
```

### Exercise 3: Sponsorship Strategy

**Objective**: Create a plan to build sponsor relationships for your career goals.

**Solution Example**:

```markdown
# Sponsorship Strategy Plan

## Current State Assessment
- Current level: Senior Engineer
- Target: Staff Engineer within 18 months
- Current sponsors: My manager (good relationship)
- Sponsor gap: Need 1-2 more senior advocates

## Ideal Sponsor Profiles

### Sponsor 1: Director of Engineering (Sarah)
**Why this person**:
- Runs cross-team architecture decisions
- Sits in Staff promotion discussions
- Has sponsored others to Staff before

**Current relationship**:
- Met briefly at all-hands
- No direct working relationship

**Plan to build relationship**:
- Month 1: Request 30-min intro meeting
  Angle: "I'd love to understand how architecture decisions get made"
- Month 2-3: Volunteer for initiative she cares about
  Option: API standardization project she mentioned
- Month 4-6: Regular informal check-ins
  Update her on cross-team work I'm doing
- Month 7+: Ask directly for sponsorship
  "I'm working toward Staff. Would you be willing to support me?"

**Success indicator**: She knows my work and mentions me in planning discussions

### Sponsor 2: Staff Engineer on Platform Team (Mike)
**Why this person**:
- Respected Staff+ IC, influences IC promotions
- Has visibility into org-wide technical decisions
- Previously advocated for current Staff engineers

**Current relationship**:
- Collaborated once on integration project
- Positive but not deep

**Plan to build relationship**:
- Month 1: Ask for advice meeting
  "I'm working toward Staff, would value your perspective"
- Month 2-3: Collaborate on shared initiative
  Propose: Shared observability library we discussed
- Month 4-6: Regular technical discussions
  Get his review on my RFCs, ask for feedback
- Month 7+: Ask for support
  "Would you advocate for me in calibration?"

**Success indicator**: He proactively mentions me for opportunities

## Maintenance Plan

| Who | Cadence | Format | Topics |
|-----|---------|--------|--------|
| Manager (current sponsor) | Weekly | 1:1 | Career progress, blockers |
| Sarah (target sponsor) | Monthly | Coffee | Cross-team work updates |
| Mike (target sponsor) | Bi-weekly | Slack/docs | Technical collaboration |
| Skip-level | Quarterly | 1:1 | Visibility, feedback |

## Sponsor Deliverables
To make it easy for sponsors to advocate for me, I will prepare:
- [ ] 1-page summary of my accomplishments and impact
- [ ] Clear articulation of gaps I'm closing
- [ ] Specific ask: what I want them to do
- [ ] Regular updates so they have fresh examples

## Timeline
- Months 1-3: Build relationships with target sponsors
- Months 4-9: Deepen relationships through collaboration
- Months 10-12: Ask explicitly for sponsorship
- Months 13-18: Sponsors actively advocate in promotion discussions
```

### Junior → FAANG: Using These Exercises as Interview Prep Rehearsal

The three exercises in this section, gap analysis, accomplishment inventory, and sponsorship strategy, map directly to the three documents that determine a FAANG promotion decision: the level rubric gap assessment, the promo packet, and the sponsor advocacy. Completing them seriously, not as a thought experiment but as a real plan with real names and real timelines, produces both a career development plan and an interview preparation structure.

The accomplishment inventory exercise is the most immediately valuable for external interviews. Candidates who cannot quickly produce five quantified accomplishments from the past 12 months are not ready for a FAANG behavioral loop. Run through this exercise before submitting any application and identify the gaps. Then decide: do you apply now with the stories you have, or invest another quarter in building better evidence?

The sponsorship strategy exercise is usually skipped because it feels presumptuous, but it is the single most underutilized preparation tool. Engineers who have mapped their sponsor relationships before their interview can answer "who is advocating for you and why?" with specificity, which is a question that occasionally appears in senior-level loops and consistently catches unprepared candidates.

### Senior @ FAANG: Running These Exercises at Team Scale

At L6 and above, these exercises become team-level calibration tools rather than individual development activities.

Running a gap analysis workshop with a group of L5 engineers, where each engineer completes the framework and then discusses with a senior peer, surfaces systematic blind spots in how mid-level engineers evaluate their own readiness. Engineers consistently underestimate their cross-team impact and overestimate their strategic thinking. Senior engineers who see this pattern can design specific experiences to close the real gaps rather than the perceived ones.

The accomplishment inventory exercise, run as a team activity where engineers share their inventories with each other and give feedback on how the stories would land in a promotion committee, builds both documentation skills and calibration skills simultaneously. Engineers who hear their peers describe their impact in concrete, quantified terms learn to hold themselves to the same standard. This is more effective than any amount of written guidance about "what good looks like."

The sponsorship strategy exercise at team scale reveals whether your organization's sponsorship is concentrated or distributed. If every engineer's sponsorship plan leads back to the same two or three senior leaders, the team is fragile and those leaders are likely to feel pressured rather than supported. Staff engineers who facilitate a team-level sponsorship mapping exercise can identify the engineers who need additional sponsor relationships and create the opportunities for those relationships to develop organically.

---
