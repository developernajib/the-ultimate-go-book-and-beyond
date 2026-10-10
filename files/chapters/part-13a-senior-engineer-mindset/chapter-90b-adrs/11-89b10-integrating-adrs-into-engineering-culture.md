## 90B.10 Integrating ADRs into Engineering Culture

Having the right templates and tools is necessary but not sufficient. The real challenge is making ADRs a natural part of how your team works, rather than a box-checking exercise that engineers resent. This section covers practical integration points: embedding ADR prompts into your pull request workflow, using ADRs during onboarding, connecting them to your developer portal, and establishing lightweight governance that scales from a five-person startup to a FAANG-scale organization. The goal is to make ADRs so embedded in daily engineering work that writing them feels like a natural extension of making the decision itself.

Writing good ADRs is a craft. Building a culture where ADRs are written consistently, reviewed seriously, and consulted habitually is an organizational challenge. This section covers the practices that separate teams where ADRs are alive and valuable from teams where they are a checkbox compliance exercise.

### ADRs in the Pull Request Process

The most reliable forcing function for ADR creation is the pull request template. When a PR introduces a new dependency, a new architectural pattern, or a cross-service interface, the template should prompt for an ADR link.

```markdown
<!-- .github/pull_request_template.md -->

## Summary
[What does this PR change?]

## Type of Change
- [ ] Bug fix
- [ ] Feature
- [ ] Refactoring
- [ ] New dependency
- [ ] Architectural change

## Architectural Decision Record
If this PR introduces a new dependency, changes an interface, or makes a
hard-to-reverse architectural choice:
- [ ] Not applicable
- [ ] ADR link: [docs/adr/NNNN-title.md](link)
- [ ] ADR in progress - link: [PR #NN]

PRs with "Architectural change" checked and no ADR link will not be merged.
```

This is a light-touch enforcement mechanism: it does not block PRs for trivial changes, but it creates a visible gap when an architectural change arrives without a decision record.

### Architecture Review Boards

At organizations of 500+ engineers, informal ADR review does not scale. Architecture Review Boards (ARBs) - or Architecture Review Committees - provide a structured forum for reviewing high-stakes ADRs.

**How Google approaches it**: Google's Architecture Review Process (ARP) distinguishes between "design docs" (detailed technical designs) and "launch reviews" (production readiness). ADR-equivalent records are part of the launch review package. A committee of senior and staff engineers reviews decisions that affect multiple teams or establish new platform patterns.

**How Amazon approaches it**: Amazon's "two-pizza team" structure means most architectural decisions are made within a single service team. But decisions that establish new shared platform patterns - a new event schema standard, a new inter-service authentication mechanism - go through a Principal Engineer review. The review artifact is a six-pager (Amazon's prose-based design document format), which serves the same purpose as an ADR.

**Lightweight ARB for mid-size teams**: A 50-engineer engineering organization does not need a formal committee. A weekly "architecture hour" where proposed ADRs are discussed and advanced to Accepted (or returned for revision) achieves the same function with minimal overhead. The key discipline is that decisions do not advance without discussion - the review is not asynchronous rubber-stamping.

### ADRs for Startup Teams

At a five-person startup, a formal ADR process adds overhead that can slow a team that needs to ship fast. The practice should be adapted, not abandoned.

**The minimal viable ADR process for startups**:

1. Write ADRs only for decisions that are hard to reverse and would confuse a new hire. Target: one ADR per month, not one per week.
2. Use the shortest possible format - Nygard's original four-section format is sufficient.
3. Store ADRs in `docs/adr/` from day one. The cost of setting up the directory is zero. The cost of retrofitting ADRs into a messy documentation structure at Series B is high.
4. No formal review process. The CTO reads proposed ADRs and comments in a PR. The author merges after 48 hours if no blocking objection is raised.

The startup team that writes twelve ADRs in its first year will find them invaluable when onboarding its first senior hire. The new engineer can read the ADR history and understand why the system looks the way it does in an afternoon - a task that otherwise requires weeks of pairing with founding engineers.

### Backstage Integration: Showing ADRs in the Service Catalog

Backstage (Spotify's open-source developer portal, now a CNCF project) supports a TechDocs plugin that renders markdown documentation from repositories. Integrating ADRs into Backstage makes them discoverable to non-engineering stakeholders and searchable across the organization.

**catalog-info.yaml configuration**:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: order-service
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  type: service
  lifecycle: production
  owner: team-platform
```

**mkdocs.yml for TechDocs**:

```yaml
site_name: Order Service Documentation
nav:
  - Home: index.md
  - Architecture:
      - ADR Index: adr/README.md
      - ADR-0001 Database Selection: adr/0001-database-selection.md
      - ADR-0002 Event Schema: adr/0002-event-schema.md
      # Additional ADRs added here as they are created
plugins:
  - techdocs-core
```

With this configuration, every engineer in the organization can search "order service ADR" in the Backstage search bar and find the complete ADR history of the service. At Spotify, this discoverability is cited as one of the primary reasons engineers actually read ADRs rather than ignoring them.

### ADRs as Onboarding Infrastructure

The highest-value use of a mature ADR corpus is onboarding. A new engineer who reads the ADR history of a service can answer three questions that otherwise require weeks of archaeology:

1. **Why does this system look this way?** (ADR history explains the evolution)
2. **What alternatives were considered and rejected?** (prevents "why didn't we just use X?" rabbit holes)
3. **What constraints no longer apply?** (Deprecated and Superseded ADRs identify decisions ready to be revisited)

**A structured onboarding ADR review exercise**: Assign new engineers to read the ADR history and write a one-page "decision archaeology" document summarizing:
- The three most significant decisions in the system's history
- One decision they would reconsider given current context (and why)
- One constraint visible in ADRs that they believe has changed

This exercise accomplishes two things: it onboards the engineer into the system's history, and it surfaces ADRs that may be candidates for supersession. The exercise is used at Stripe and Cloudflare in modified forms.

### Requiring ADR Links for New Dependencies

Every new external dependency is an architectural decision. Adding a new library creates a coupling that is hard to undo. Teams that require an ADR (or a lightweight decision note) before introducing a new dependency catch a surprising number of cases where the dependency is unnecessary.

**Dependency ADR criteria**: An ADR is required for a new dependency if it meets any of the following:

- It adds a new data store or message broker (always requires ADR)
- It adds a new authentication or authorization mechanism
- It introduces a new concurrency model
- It is a framework (as opposed to a library) - i.e., it calls your code rather than your code calling it
- It creates a new vendor lock-in vector

For Go, the `go.sum` file can be checked in CI for new additions, triggering a check that verifies an ADR link exists in the PR:

```bash
# In CI, compare go.sum against base branch
git diff origin/main...HEAD -- go.sum | grep '^+' | grep -v '^+++' | \
  while read line; do
    pkg=$(echo "$line" | awk '{print $1}' | sed 's/^+//')
    echo "New dependency detected: $pkg"
  done
```

This check does not block the PR automatically. It flags the addition so the reviewer knows to look for an ADR. The social pressure of the flag is often sufficient.

### Junior → FAANG: Cultural Integration as a Long Game

ADR practices fail not because they are technically wrong, but because they are not integrated into the workflows engineers already use. The CI check that flags new dependencies, the PR template that asks "does this change require an ADR," the onboarding checklist that includes "read the ADR corpus" are all integration mechanisms. Each one reduces the friction of the practice and increases the probability that it becomes habitual.

As a junior engineer advocating for ADRs, focus on one integration point at a time. Proposing five new workflow changes simultaneously will produce pushback. Proposing one, demonstrating its value for a quarter, and then proposing the next will compound.

The PR template check is the most effective starting point because it catches decisions at exactly the moment they are being made, before the engineer moves on to the next task. A PR template that includes "Did this decision require an ADR? Link: ___" creates a low-friction forcing function that costs the reviewer nothing to act on.

### Senior @ FAANG: ADRs as Culture Measurement

An organization's ADR practice is a leading indicator of its engineering culture maturity. Organizations with functioning ADR practices have implicitly answered several organizational health questions in the affirmative: engineers trust that documentation will be read and respected, leaders reward careful decision-making over fast decision-making, and the team has enough psychological safety to document the consequences of decisions that later turn out to be wrong.

Conversely, organizations that cannot sustain an ADR practice despite repeated attempts are usually exhibiting symptoms of deeper cultural problems: a blame culture that discourages honest documentation of negative consequences, a "ship fast, document never" incentive structure, or a lack of senior engineering involvement in establishing norms. Diagnosing the culture problem is the first step to fixing the ADR practice.

At FAANG, the most durable ADR cultures are ones where the practice is modeled by staff and principal engineers in highly visible decisions. When a principal engineer at Google publishes a detailed ADR for a platform decision and references it in all-hands discussions, that signal propagates through the organization. When the practice only exists at the team level and is never modeled by leadership, it tends to atrophy during periods of high delivery pressure.

The social pressure mechanism described in the CI check for new dependencies is an important design choice: it nudges rather than mandates. FAANG engineering cultures that have tried to mandate ADRs through hard blockers (a PR cannot be merged without an accepted ADR for certain change types) have found that the result is a proliferation of minimal, perfunctory ADRs written to clear the gate rather than to document reasoning. The nudge model, where the check flags but does not block, combined with strong cultural modeling from senior engineers, produces higher-quality ADRs than the mandate model.

---
