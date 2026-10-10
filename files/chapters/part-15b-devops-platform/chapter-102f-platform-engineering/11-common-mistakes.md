## 102F.9 Common Mistakes

### 1. Building a Platform Nobody Uses

The most common platform engineering failure is building in a vacuum: the team designs what they think developers need, delivers it, and then watches adoption stagnate. Effective internal platforms are discovered through direct observation. Shadowing developers, measuring where time is lost. Not through assumption. The contrast below illustrates the difference between a top-down announcement approach and a feedback-driven one that starts from real developer pain.

```
WRONG: Build in isolation, announce it's ready, wonder why nobody uses it.

CORRECT: Developer-led development.
  1. Shadow developers for one week - observe their pain points
  2. Build the one thing that saves the most time
  3. Eat your own dog food: use the platform for the platform itself
  4. Track adoption metrics and interview non-adopters
  5. Iterate based on feedback, not assumptions
```

### 2. Making the Platform a Bottleneck

When every infrastructure change must be reviewed and approved by the platform team, the platform becomes a slow-moving gate rather than an accelerator. The platform team's role is to build self-service tooling with safe guardrails, then step back and let product teams operate independently. Centralizing approvals destroys the developer velocity the platform was created to improve.

```
WRONG: All infrastructure changes go through the platform team (gatekeeping)

CORRECT: Self-service. The platform team builds tooling; teams use it autonomously.
  Platform team = product team building for internal developers
  NOT: central operations team that must approve every change
```

### 3. Over-Engineering Before You Have Users

Platform teams often fall into the trap of assembling a full Backstage portal, Crossplane infrastructure abstractions, and a service mesh before a single developer has asked for any of them. Building elaborate tooling before the user base exists wastes months of effort on features nobody will adopt in the near term. The correct approach is iterative: identify the single highest-friction problem, solve it well, measure adoption, and only add the next layer when the previous one is proven.

```
WRONG: Build Backstage + Crossplane + service mesh + everything before anyone asks.

CORRECT: Start with the highest-pain-point problem.
  Week 1: Survey developers. What takes the most time?
  Week 2: Solve the top problem (often: consistent CI/CD templates)
  Month 1: Add second feature based on usage + feedback
  Month 3: Add Backstage catalog ONLY after services can self-register
```

### 4. Ignoring Platform Reliability

A platform that goes down silently. With no SLOs, no alerting, and no incident process. Erodes developer trust faster than any missing feature would. The CI/CD pipeline, service catalog, and deployment tooling are production infrastructure for your engineering organization, and they deserve the same operational rigor as customer-facing systems. Defining explicit availability targets, maintaining runbooks, and tracking platform incidents against an error budget makes reliability a first-class concern rather than an afterthought.

```
WRONG: Platform has no SLOs and goes down with no incident process.

CORRECT: The platform IS production infrastructure.
  - Platform SLO: 99.9% availability for core services (catalog, CI/CD, deploy)
  - Incident process: paging for platform outages
  - Runbooks for platform components
  - Error budget: track platform incidents' impact on developer velocity
```

### Junior → FAANG: These Mistakes as Interview Anti-Patterns

Platform engineering behavioral interviews frequently ask "tell me about a time the platform failed to meet its goals." The four mistakes in this section are the four most common answers, and knowing them lets you frame your responses more precisely.

Mistake one (building in a vacuum) is tested by the question "how do you decide what to build next?" The correct answer references user research: shadowing developers, analyzing support tickets, running surveys. The wrong answer is "we decided based on our own assessment of what was needed" without any mention of developer feedback.

Mistake two (becoming a bottleneck) is tested by "how does your team scale its impact?" If every change goes through a platform team approval, the platform team becomes the bottleneck that limits the velocity of every team it serves. The correct model is self-service with guardrails: teams can do things themselves, and the platform team has automated checks that prevent unsafe configurations without requiring human review.

Mistake three (over-engineering) is tested by asking you to design a platform for a hypothetical fifty-engineer organization. The wrong answer starts with Backstage plus Crossplane plus service mesh in the first week. The right answer starts with the question "what is the single most time-consuming infrastructure task for these developers?" and solves only that, measuring adoption before adding the next capability.

Mistake four (ignoring platform reliability) is tested by asking "what SLOs does your platform have?" If the answer is "we don't have SLOs," that is a red flag for any platform engineering role. The platform is production infrastructure. It must be treated as production infrastructure.

### Senior @ FAANG: The Deeper Pattern Behind Each Mistake

At the L6 level, these mistakes are not individual failures to be avoided. They are systemic failure modes that emerge from organizational dynamics.

Mistake one (building in a vacuum) is caused by a misaligned incentive structure. If the platform team is evaluated on features shipped rather than adoption rate, they will ship features that satisfy their own technical vision rather than developer needs. The fix is organizational: redefine the platform team's success metric as developer satisfaction and golden path adoption, not lines of code or pull requests merged.

Mistake two (platform as bottleneck) is caused by a trust deficit between the platform team and product teams. When the platform team does not trust product teams to make safe infrastructure decisions, they insert human review gates. The resolution is to build automated policy enforcement (OPA admission controllers, Crossplane validation constraints) that enforces safety without requiring human approval for every request. The platform team's job is to make it structurally impossible to create unsafe configurations, not to review every configuration by hand.

Mistake three (over-engineering) is caused by the platform team optimizing for technical elegance rather than adoption velocity. A beautiful Crossplane composition that nobody uses provides zero value. At the staff level, the discipline required is ruthless prioritization: build only what has evidence of demand (measured in support tickets, developer interviews, or adoption metrics), and resist the pull toward technical completeness for its own sake.

Mistake four (ignoring reliability) is the one that destroys developer trust most rapidly. When the CI/CD system goes down during a release freeze and the platform team has no runbook and no on-call rotation, product teams lose confidence in the platform as a production substrate. Recovering that trust takes months. The structural fix is to include platform services in the organization's SRE practices from the beginning: define SLOs before shipping, create runbooks before anything goes wrong, and add the platform to the PagerDuty on-call rotation when any core capability ships. The platform team must hold itself to the same reliability standards it imposes on the teams it serves.
