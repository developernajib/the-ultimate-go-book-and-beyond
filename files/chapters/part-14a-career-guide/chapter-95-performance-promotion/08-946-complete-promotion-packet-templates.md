## 95.7 Complete Promotion Packet Templates

### Google-Style Self-Assessment Template

At Google and similar companies, promotion committees evaluate candidates they have never worked with directly, so your self-assessment must tell a complete story without relying on in-person context. The format below mirrors the level rubric language used in official review systems, which makes it easier for your manager to map your evidence directly to promotion criteria. Quantifying impact with specific metrics, latency improvements, revenue influenced, team-hours saved, transforms subjective claims into verifiable engineering contributions.

```markdown
# Promotion Self-Assessment: [Your Name]
# Current Level: L5 (Senior Software Engineer)
# Target Level: L6 (Staff Software Engineer)
# Review Period: January 2024 - December 2024

## Executive Summary

I have consistently operated at L6 scope over the past 12 months,
leading multi-team initiatives that resulted in $2.4M annual cost
savings, establishing architectural patterns now adopted org-wide,
and growing three engineers to senior level.

## Technical Leadership & Impact

### Project 1: Payment Gateway Redesign (3 teams, 8 months)
**Complexity**: Led architectural redesign of payment processing
system handling $500M daily transaction volume. Required coordination
across Payments, Risk, and Infrastructure teams.

**What I Did**:
- Authored 15-page design doc reviewed by 12 senior engineers
- Facilitated weekly technical sync with 3 team leads
- Made key architectural decision on event sourcing vs CQRS
- Resolved technical disagreements through data-driven analysis

**Impact**:
- Reduced payment latency from 450ms to 120ms (73% improvement)
- Decreased failed payment rate from 2.1% to 0.4%
- Annual cost savings: $1.8M in reduced infrastructure
- System now handles 3x previous transaction volume

### Project 2: Observability Platform (Org-wide initiative)
**Complexity**: Defined and implemented observability standards
for 40+ microservices across the organization.

**What I Did**:
- Created org-wide tracing and metrics guidelines
- Built shared libraries adopted by all teams
- Trained 50+ engineers on observability best practices
- Established SLO framework now used by 8 teams

**Impact**:
- MTTR reduced from 45 minutes to 12 minutes
- On-call burden decreased 60%
- Three teams independently credit this work in their reviews

### Project 3: Developer Experience Improvements
**Complexity**: Cross-functional initiative spanning DevEx,
Infrastructure, and Platform teams.

**What I Did**:
- Identified key developer pain points through surveys and interviews
- Led design and implementation of faster build system
- Mentored team of 2 engineers to deliver CI/CD improvements

**Impact**:
- Build time reduced from 12 minutes to 4 minutes
- Developer satisfaction score increased from 3.2 to 4.5
- Estimated 2,000 developer-hours saved annually

## Mentorship & Developing Others

| Engineer | Starting Level | Current Level | My Role |
|----------|---------------|---------------|---------|
| Alice Chen | L3 (Mid) | L4 (Senior) | Weekly 1:1s, project guidance, promo support |
| Bob Smith | L4 (Senior) | L5 (Senior+) | Tech mentorship, design review coaching |
| Carol Lee | L3 (Mid) | L4 (Senior) | Career coaching, visibility opportunities |

### Mentoring Impact Examples:
- "Alice's L4 promotion packet cited my mentorship specifically.
  She now leads her team's on-call rotation and design reviews."
- "Coached Bob through his first architectural RFC. He now
  runs our team's design review meetings."

## Cross-Team Influence

### Influence Without Authority:
- Convinced 3 teams to adopt my proposed API standards (no mandate)
- Led cross-team incident response for major outage (not my on-call)
- Established testing patterns now used in 12 repositories

### Organizational Contributions:
- Conducted 8 hiring interviews with 75% alignment with committee
- Created onboarding curriculum used by 3 teams
- Presented at internal tech conference (200 attendees)

## Peer Feedback Excerpts

> "Alex consistently thinks at the systems level, not just about
> their own code. Their payment redesign work set the standard
> for how we approach large architectural changes." - Principal Eng

> "One of the best technical mentors I've had. Patient, thorough,
> and helped me see the bigger picture beyond just shipping features."
> - L4 Engineer (mentee)

> "When Alex joins a design review, the whole conversation
> elevates. They ask questions that expose issues we missed."
> - Staff Engineer (peer)

## Areas for Growth

1. **Writing**: Working to make design docs more accessible to
   non-technical stakeholders
2. **Delegation**: Learning to delegate more to grow team capacity
3. **Strategic thinking**: Expanding focus from 6-month to
   18-month roadmap planning

## Conclusion

Over the past year, I have demonstrated L6 scope through:
- Leading multi-team technical initiatives
- Establishing org-wide patterns and standards
- Developing three engineers to higher levels
- Influencing technical decisions beyond my immediate team

I believe I am ready for formal recognition at the Staff level.
```

### Amazon-Style Promotion Document

```markdown
# PROMOTION DOCUMENT
# Candidate: [Name]
# Current Role: SDE II
# Proposed Role: SDE III (Senior SDE)

## EXECUTIVE SUMMARY

[Name] has consistently demonstrated SDE III behaviors over the
past 18 months, including ownership of critical systems (payment
processing), mentorship of junior engineers, and delivery of
high-impact projects that saved $400K annually. Ready for promotion.

## ROLE SCOPE & OWNERSHIP

**Current Scope:**
- Owner of Payment Processing Service (99.95% availability target)
- Technical lead for 3-person feature team
- On-call rotation lead for payments domain (tier 2 escalation)

**SDE III Demonstration:**
- Expanded ownership from single service to full domain (5 services)
- Reduced operational burden 40% through automation
- Established runbooks now used by 8 engineers

## LEADERSHIP PRINCIPLE EVIDENCE

### Customer Obsession
**Situation**: Customers complained about payment confirmation delays.
**Task**: Reduce time between payment and email confirmation.
**Action**:
- Deep-dived metrics, found 90th percentile at 45 seconds
- Proposed and implemented async notification system
- Partnered with email team to optimize delivery
**Result**: p90 reduced from 45s to 8s. Customer complaints dropped 80%.
NPS for payment experience increased from 32 to 67.

### Ownership
**Situation**: Critical payment bug discovered at 2 AM, not my on-call.
**Task**: Issue affecting $2M in stuck payments.
**Action**:
- Joined incident despite not being on-call
- Identified root cause (race condition in retry logic)
- Wrote and deployed fix within 3 hours
- Created runbook and alerts to prevent recurrence
**Result**: Issue resolved before business hours. Zero customer impact.
Added 3 alerts that have caught similar issues 4 times since.

### Invent and Simplify
**Situation**: Payment reconciliation was manual, taking 8 hours weekly.
**Task**: Reduce operational toil while improving accuracy.
**Action**:
- Designed automated reconciliation pipeline
- Used existing AWS services (Step Functions, Lambda)
- Built self-healing mechanism for common discrepancies
**Result**: Reduced weekly effort from 8 hours to 30 minutes (94% reduction).
Accuracy improved from 97% to 99.9%. Saved $50K annually in operational costs.

### Are Right, A Lot
**Situation**: Team debated between two database architectures.
**Task**: Guide team to correct technical decision.
**Action**:
- Built proof-of-concept for both approaches (3 days each)
- Presented data-driven comparison to team
- Facilitated discussion, remained open to counterarguments
- Final recommendation accepted with team consensus
**Result**: Chosen approach (event sourcing) now handles 10x original scale.
Team credits this decision with avoiding 6-month rewrite.

### Learn and Be Curious
**Situation**: No expertise in machine learning on team.
**Task**: Evaluate ML opportunity for fraud detection.
**Action**:
- Self-studied ML fundamentals (evenings, weekends)
- Built prototype fraud detection model
- Partnered with ML team for production implementation
**Result**: Fraud detection improved 40%. Model now in production.
Became team's ML point-of-contact for future projects.

### Hire and Develop the Best
**Situation**: Junior engineer struggling with system design.
**Task**: Accelerate their growth toward SDE II.
**Action**:
- Established weekly 1:1 mentoring sessions
- Co-authored their first design document
- Provided stretch assignments with support
- Advocated for their promotion packet
**Result**: Engineer promoted to SDE II within 9 months (vs. typical 18).
They now mentor others using techniques I taught them.

### Insist on the Highest Standards
**Situation**: Code review quality declining across team.
**Task**: Raise the bar without creating friction.
**Action**:
- Created code review guidelines document
- Instituted "code review of the week" recognition
- Led by example with thorough, constructive reviews
- Tracked and shared code quality metrics
**Result**: Bugs found in production dropped 60%. Team adopted guidelines
voluntarily. Now referenced by other teams.

### Think Big
**Situation**: Payment system approaching capacity limits.
**Task**: Plan for 10x growth over 3 years.
**Action**:
- Authored long-term technical vision document
- Identified 4 major architectural changes needed
- Created phased roadmap with business justification
- Socialized with leadership and got buy-in
**Result**: Vision adopted as team charter. First two phases complete.
System now handles 5x original capacity, on track for 10x.

### Bias for Action
**Situation**: Partner API started failing with no response from their team.
**Task**: Unblock customers waiting for payment processing.
**Action**:
- Made decision to implement fallback in 2 hours (didn't wait for approval)
- Built circuit breaker pattern with manual override
- Communicated approach to leadership while building
**Result**: Customer impact limited to 15 minutes vs. potential 4+ hours.
Pattern now standard for all external dependencies.

### Frugality
**Situation**: Monthly AWS bill increasing 15% month-over-month.
**Task**: Reduce costs without impacting performance or reliability.
**Action**:
- Audited all resources for utilization
- Implemented auto-scaling where missing
- Negotiated reserved instances for steady-state workloads
- Removed unused resources (forgotten experiments, old environments)
**Result**: Reduced monthly costs from $180K to $150K (17% reduction).
Established quarterly cost review process for team.

### Earn Trust
**Situation**: Cross-team project with conflicting priorities.
**Task**: Align three teams on shared deadline.
**Action**:
- Facilitated weekly syncs across team leads
- Transparently shared our dependencies and blockers
- Made commitments and consistently delivered on them
- Escalated risks early, never surprised stakeholders
**Result**: Project delivered on time. All three teams request to work
with me on future projects. Built lasting relationships.

### Dive Deep
**Situation**: Intermittent latency spikes with no obvious cause.
**Task**: Find root cause of P99 latency degradation.
**Action**:
- Analyzed 30 days of metrics data
- Correlated spikes with garbage collection patterns
- Tested hypothesis with memory profiling
- Identified specific code path causing allocations
**Result**: Found and fixed issue (unnecessary object creation in hot path).
P99 improved from 200ms to 50ms. Methodology now used for similar issues.

### Have Backbone - Disagree and Commit
**Situation**: Leadership proposed approach I disagreed with.
**Task**: Advocate for better solution while respecting decision.
**Action**:
- Prepared data-driven alternative proposal
- Presented concerns respectfully in meeting
- Accepted final decision when leadership proceeded
- Executed fully and successfully on chosen approach
**Result**: Project succeeded. Leadership later acknowledged my concerns
were valid and incorporated them in future planning.

### Deliver Results
**Situation**: Q4 commitment at risk due to scope creep.
**Task**: Deliver core functionality on time.
**Action**:
- Identified and proposed scope reduction (20% of features)
- Negotiated with PM on must-haves vs. nice-to-haves
- Increased personal contribution to critical path
- Coordinated daily standups last 2 weeks
**Result**: Core functionality delivered on time. Remaining features
delivered in Q1. Business impact achieved on schedule.

## SUPERPOWERS

1. **System-Level Thinking**: Consistently sees connections between
   components that others miss. Identifies risks early.

2. **Incident Response**: Calm under pressure, methodical debugging,
   excellent communication during outages.

3. **Technical Communication**: Design docs and code reviews are
   models for the team. Clear, thorough, actionable.

## AREAS FOR DEVELOPMENT

1. **Delegation**: Tendency to take on too much personally. Working
   on distributing load more effectively.

2. **Strategic Planning**: Strong on execution, developing longer-term
   strategic thinking (12-18 month horizons).

## PEER & STAKEHOLDER FEEDBACK

> "Gold standard for code reviews. Always finds issues others miss
> while still being constructive and educational." - SDE III (peer)

> "Our most reliable partner on cross-team work. When [Name] commits
> to something, it gets done." - Product Manager

> "Turned around a struggling project. Their technical judgment and
> calm leadership were instrumental." - Engineering Manager

## RECOMMENDATION

Based on 18 months of sustained SDE III performance across all
Leadership Principles, technical impact, and influence beyond
immediate team, I strongly recommend promotion to SDE III.
```

### Junior → FAANG: Using Promotion Packet Templates as a Year-Round Collection Framework

The templates in this section are most useful when used as a collection framework throughout the year rather than a writing template in the week before the review deadline. Each section of the self-assessment maps to a category of work: technical impact, cross-team influence, mentorship and leadership, and process improvement. For each category, you need specific examples with measurable outcomes.

Start with the template at the beginning of each review cycle and treat each section header as a question: do I have a specific example with a measurable outcome for this section. If you do, record it. If you do not, that is your signal about where to direct your work in the coming months. This process of reviewing the template quarterly turns the promotion packet from a retroactive justification exercise into a prospective planning tool.

The most important formatting principle in the self-assessment: every impact statement needs a number. "Improved performance" is not an impact statement. "Reduced p99 latency from 450ms to 85ms by rewriting the connection pool implementation" is an impact statement that a calibration committee can evaluate.

### Senior @ FAANG: Promotion Packet Construction at L6 and the Organizational Scope Test

At senior level, the promotion packet template is a governance document as much as an evidence collection. The structure of the template reflects the promotion committee's evaluation rubric, and every section needs to pass an organizational scope test: does this example demonstrate impact that spans more than my immediate team.

The section on "cross-team influence" is the primary differentiation between L5 and L6 promotion packets. L5 packets contain examples of working collaboratively with other teams on shared projects. L6 packets contain examples of defining technical direction that other teams adopted, identifying systemic problems that spanned team boundaries and driving the resolution, and creating artifacts (standards, libraries, platforms) that other teams use as a dependency.

For Go-specific promotion packets in infrastructure or platform roles: the technical depth section should include evidence of Go-level architectural decisions, not just business outcomes. Evidence that you understood and navigated Go runtime constraints (garbage collection, scheduler behavior, goroutine lifecycle management) in designing a production system demonstrates the technical depth expected at L6 in a Go-focused environment.

---
