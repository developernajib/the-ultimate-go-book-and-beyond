## 89.8 Production Pitfalls: Large Refactoring Mistakes

### Pitfall 1: The Big Bang Rewrite

**Real Incident Report**: A team decided their legacy system was unmaintainable. They convinced leadership to allocate 9 months for a complete rewrite. At month 8, the new system was 60% feature-complete, the old system had 8 months of bug fixes the new system didn't have, and the team was burned out. The project was canceled. The legacy system is still running.

**The Anti-Pattern**:
- "Let's rebuild it from scratch"
- Stopping all feature work for the rewrite
- Underestimating the hidden functionality in legacy code
- Not delivering value until the rewrite is "complete"

**The Better Approach**:
```markdown
# Strangler Fig Pattern

## Instead of:
Old System → (9 months of darkness) → New System

## Do:
Old System
  ↓ (1 month) Extract authentication → New Auth
  ↓ (1 month) Extract user service → New Users
  ↓ (1 month) Extract payments → New Payments
  ... continue incrementally

## Benefits:
- Deliver value continuously
- Learn and adjust approach
- Can stop at any point with value delivered
- Lower risk at each step
- Team maintains momentum

## The rule:
If you can't ship something useful in 2-3 months,
your scope is too big.
```

**Key Insight**: Netscape's big-bang rewrite of Navigator 4→6 nearly killed the company. Martin Fowler's "Strangler Fig Application" pattern exists because of countless similar failures.

### Pitfall 2: Refactoring Without Measuring the Problem

**Real Incident Report**: A team spent 6 months "improving" a service's architecture. After completion, they had no data showing the old system was actually problematic, and no data showing the new system was better. When asked "was it worth it?", they couldn't answer. Leadership lost confidence in the team's judgment.

**The Anti-Pattern**:
- "The code is ugly" as justification
- Refactoring based on aesthetics, not impact
- Not defining success criteria before starting
- Unable to measure improvement afterward

**The Better Approach**:
```markdown
# Refactoring Business Case Template

## Before Approval:

### Problem Quantification:
- Current incidents related to this system: [X/month]
- Developer time spent on workarounds: [X hours/week]
- Feature velocity impact: [X% slower than baseline]
- Operational cost: [$X/month in inefficiency]

### Success Criteria:
- Reduce incidents from X to Y
- Reduce developer time from X to Y hours/week
- Improve feature velocity by X%
- ROI: Costs [$X], saves [$Y/year]

## After Completion:

### Measurement:
- Did incidents decrease? By how much?
- Did velocity improve? By how much?
- Was the ROI realized?

### If you can't measure it, don't do it.
Or be explicit: "This is a bet on future maintainability"
```

**Key Insight**: Amazon's frugality principle applies to engineering effort. If you can't justify the investment with expected returns, you probably shouldn't make it.

### Pitfall 3: No Rollback Plan

**Real Incident Report**: A team migrated from MySQL to PostgreSQL. Halfway through, they discovered PostgreSQL handled a critical query differently, causing subtle data issues. They had already dropped the MySQL tables. The "rollback" required restoring from backups and replaying 3 days of writes. Total incident duration: 47 hours.

**The Anti-Pattern**:
- "We won't need to rollback"
- Burning bridges before migration is proven
- Treating migration as one-way door
- Not testing rollback procedure

**The Better Approach**:
```go
// Dual-write pattern for safe migrations

type MigrationPhase int

const (
    PhaseOldOnly MigrationPhase = iota  // Write to old, read from old
    PhaseDualWrite                       // Write to both, read from old
    PhaseShadowRead                      // Write to both, read from old, compare new
    PhaseNewPrimary                      // Write to both, read from new
    PhaseNewOnly                         // Write to new only, old decommissioned
)

// Each phase is reversible except the last one
// Never delete old data until new is proven

/*
Rollback Plan Template:

Phase 1 (Old Only): No rollback needed
Phase 2 (Dual Write): Stop dual write, continue with old
Phase 3 (Shadow Read): Same as phase 2
Phase 4 (New Primary): Switch read back to old
                       (data is identical due to dual write)
Phase 5 (New Only): POINT OF NO RETURN
                    Only reach this after extended Phase 4 success

Always test rollback at each phase BEFORE proceeding to next phase.
*/
```

**Key Insight**: Stripe's infrastructure team never does irreversible migrations in one step. Every migration has a tested rollback at every phase.

### Pitfall 4: Underestimating Hidden Dependencies

**Real Incident Report**: A team refactored a "simple" internal API used by one service. After deployment, 14 other services broke. The API had been documented for one use case but was being called by many services that had copy-pasted the integration code. The "one service" was actually 14.

**The Anti-Pattern**:
- Trusting documentation over observation
- Not discovering all consumers before changing
- Assuming internal APIs are scoped correctly
- Not using feature flags for gradual rollout

**The Better Approach**:
```markdown
# Dependency Discovery Checklist

## Before ANY refactor:

### Code-level discovery:
□ grep/search for all references to changed code
□ Check for reflection/dynamic calls
□ Review all consumers of APIs being changed
□ Look for copy-pasted integration code

### Runtime discovery:
□ Add logging to see who actually calls the API
□ Check distributed tracing for all callers
□ Review network traffic patterns
□ Look at authentication tokens to identify consumers

### Human discovery:
□ Ask: "Does anyone else use this?"
□ Send preview of changes to #engineering
□ Review recent incidents for unexpected dependencies

### Gradual rollout:
□ Feature flag the new path
□ Roll out to 1% of traffic
□ Monitor for unexpected errors
□ Expand gradually with monitoring

## Trust, but verify:
Documentation says 1 consumer.
Observation says 14 consumers.
Always believe observation.
```

**Key Insight**: Hyrum's Law states that with enough users, every observable behavior of your system will be depended on by someone. Assume there are more dependencies than documented.

### Pitfall 5: Migration Without Communication

**Real Incident Report**: A platform team started a 6-month migration. They sent one email at the start. Product teams had no visibility into progress or deadlines. Three teams planned features depending on the old system. When the old system was deprecated, those features had to be re-planned at the last minute. Two quarters of roadmap disruption.

**The Anti-Pattern**:
- One announcement at the start, silence during execution
- Not giving teams time to plan for migration
- No clear timeline or checkpoints
- Surprising teams with deprecation

**The Better Approach**:
```markdown
# Migration Communication Plan

## At Kickoff:
- Announce migration with rationale
- Share high-level timeline
- Identify affected teams
- Create dedicated channel/page for updates

## Weekly/Bi-weekly:
- Progress update: "Phase 2 of 4 complete"
- Timeline updates: any changes to dates
- Blocker callouts: what might slip
- Next milestone: what's coming

## At Each Phase:
- What completed
- What changed from plan
- Impact to dependent teams
- Updated timeline

## Deprecation Notices:
- 6 months notice: "Old system will be deprecated [date]"
- 3 months notice: "Migration deadline approaching"
- 1 month notice: "Final migration window"
- 1 week notice: "Old system turning off [date/time]"

## Communication Channels:
- Email for major milestones
- Slack/chat for weekly updates
- Wiki/page for status dashboard
- Team meetings for affected teams
```

**Key Insight**: Lack of communication is the #1 cause of migration conflict at large companies. Over-communicate - the annoyance is less costly than surprise.

### Quick Reference: Refactoring Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Big bang rewrite | 9 months of darkness, then failure | Strangler fig, incremental delivery |
| No measurements | "Code is ugly" justification | Quantify problem, define success criteria |
| No rollback | Irreversible migration, then problems | Dual-write, test rollback at each phase |
| Hidden dependencies | Break 14 services, expected 1 | Discover all consumers, gradual rollout |
| Silent migration | Surprise deprecation | Communicate at every phase |
| No sunset date | Old system lives forever | Set deadlines, enforce deprecation |

### Junior → FAANG: Pitfalls as Interview Framing

FAANG interviewers explicitly look for pitfall awareness. "What would you do differently?" is a standard follow-up to any project story. Prepare an honest answer that names a specific pitfall you encountered or nearly encountered, names the lesson you drew from it, and describes the behavior change you made as a result. Candidates who say "everything went smoothly" are either not being honest or have not led anything challenging enough. Interviewers prefer the former to the latter.

Hyrum's Law (any observable behavior will be depended on by someone) is a concept that signals production-systems thinking. Drop it into the right interview answer and you will stand out: "We discovered three callers depending on a timing behavior of the old API that was not in the spec. That's Hyrum's Law in action, and it's why we ran shadow mode for six weeks instead of two."

### Senior @ FAANG: Pitfall Prevention as a Platform Responsibility

At staff level, your job is not just to avoid pitfalls on your own project. It is to design systems that prevent these pitfalls org-wide. The "hidden dependencies" pitfall is solved at the platform level by service mesh observability (every call is traced) and a service dependency graph that is automatically maintained. The "no sunset date" pitfall is solved by a deprecation enforcement framework that blocks new integrations with deprecated APIs at code review time.

The silent migration pitfall is the most preventable at senior level and the most commonly overlooked. Staff engineers who run successful migrations at scale treat communication as a product: the migration dashboard is designed so that affected teams can self-serve their status rather than emailing you. The RFC includes a communication schedule, not just a technical design. The deprecation notice is sent to a mailing list and tracked for acknowledgment, not just posted once and forgotten. This level of communication design is what separates migrations that finish from migrations that die from organizational entropy.

---
