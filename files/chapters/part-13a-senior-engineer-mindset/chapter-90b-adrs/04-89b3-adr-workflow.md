## 90B.3 ADR Workflow

An ADR is only as useful as the process that surrounds it. Without a clear workflow, ADRs either never get written or never get reviewed, and in both cases the team loses the benefit of documented decisions. This section walks you through who is responsible for writing ADRs, how the review process works, what tools are available to manage them, and how an ADR moves through its lifecycle from initial proposal to eventual retirement. If you are introducing ADRs to a team for the first time, this is the section to share with your colleagues.

### Who Writes ADRs

ADRs are written by the engineer who champions a decision - typically the technical lead for a project or the senior/staff engineer driving an architectural change. However, anyone can propose an ADR, including junior engineers who identify a decision that needs to be made explicitly.

The writer's responsibilities:

1. **Draft the ADR** in the proposed state with full context, alternatives, and rationale
2. **Circulate for review** - share with all stakeholders before accepting
3. **Incorporate feedback** - address concerns and update the ADR accordingly
4. **Drive to acceptance** - ensure all stakeholders are heard and the decision is finalized
5. **Maintain the ADR** - update status when the decision is deprecated or superseded

At large organizations, a staff engineer or architect may be responsible for reviewing all ADRs to ensure consistency and catch cross-cutting concerns. This review should be lightweight - the goal is sanity-checking, not gatekeeping.

### Review Process

An effective ADR review process has three gates:

**Gate 1: Technical Accuracy (24-48 hours)**
The draft is reviewed by engineers who will implement the decision. They verify that the technical claims are accurate, the alternatives were fairly evaluated, and the consequences are complete. This is a factual review, not a consensus-building exercise.

**Gate 2: Stakeholder Alignment (48-72 hours)**
The ADR is shared with all teams affected by the decision. This includes engineering teams who consume the service, platform teams who operate it, and security/compliance if applicable. The goal is to surface objections before the decision is accepted.

**Gate 3: Final Acceptance**
Once objections are resolved and all stakeholders have had reasonable time to review, the ADR author changes the status to Accepted and merges the document. In contentious cases, a formal approval (GitHub review approval, Notion comment, etc.) may be required.

The total review window should be no more than one week for most ADRs. Longer reviews indicate either an under-specified ADR or a fundamental disagreement that needs escalation, not more review time.

### Tooling

**adr-tools (Command Line)**

`adr-tools` is the original CLI for managing ADRs as flat files in a repository. Installation and usage:

```bash
# Install
brew install adr-tools  # macOS
# Or clone and add to PATH

# Initialize ADR directory in a Go project
cd /path/to/your-go-service
adr init docs/adr

# Create a new ADR
adr new "Use PostgreSQL for user service"
# Creates: docs/adr/0001-use-postgresql-for-user-service.md

# Create an ADR that supersedes another
adr new -s 1 "Migrate user service to CockroachDB"
# Creates new ADR and updates ADR-0001 status to Superseded

# List all ADRs
adr list

# Generate a table of contents
adr generate toc
```

The generated template gives you a starting point:

```markdown
# 1. Use PostgreSQL for user service

Date: 2024-01-15

## Status

Proposed

## Context

[Fill in context here]

## Decision

[Fill in decision here]

## Consequences

[Fill in consequences here]
```

The consequences section is where intellectual honesty distinguishes a useful ADR from a rubber-stamp document. Every architectural decision involves trade-offs. If a choice has no downsides, either the analysis is shallow or there was no real decision to make. This section should enumerate both the positive outcomes you expect (faster log aggregation, consistent field names across services) and the genuine costs (migration effort for existing services, a learning curve for engineers unfamiliar with the new library, tooling changes needed in CI). Future engineers reading the ADR need to understand what you knowingly accepted, so they can evaluate whether those trade-offs still hold when circumstances change.

**GitHub as ADR Platform**

For teams already using GitHub, storing ADRs as markdown files in a `docs/adr/` directory and using Pull Requests for review is the most natural workflow.

Advantages:
- Review is integrated with existing PR workflow
- History is in git (when was the decision made, who approved it)
- Links between ADRs and code are in the same system
- Search works across ADRs and code simultaneously

A typical GitHub ADR workflow:

```bash
# Create feature branch for ADR
git checkout -b adr/use-zerolog-for-structured-logging

# Create ADR file
touch docs/adr/0004-use-zerolog-for-structured-logging.md

# Write the ADR (using your editor)
# ...

# Submit PR with ADR as the only change
git add docs/adr/0004-use-zerolog-for-structured-logging.md
git commit -m "docs(adr): propose zerolog for structured logging"
git push origin adr/use-zerolog-for-structured-logging

# Open PR, request reviews from affected teams
# After approval, merge and status becomes Accepted
```

A useful GitHub Actions workflow to validate ADR formatting:

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/adr/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check ADR format
        run: |
          for file in docs/adr/*.md. do
            # Ensure required sections exist
            if ! grep -q "^## Status" "$file"; then
              echo "ERROR: $file missing ## Status section"
              exit 1
            fi
            if ! grep -q "^## Context" "$file"; then
              echo "ERROR: $file missing ## Context section"
              exit 1
            fi
            if ! grep -q "^## Decision" "$file"; then
              echo "ERROR: $file missing ## Decision section"
              exit 1
            fi
            if ! grep -q "^## Consequences" "$file"; then
              echo "ERROR: $file missing ## Consequences section"
              exit 1
            fi
            echo "OK: $file"
          done
```

**Notion as ADR Platform**

For teams using Notion as their primary documentation platform, ADRs fit naturally as a database with properties for Status, Date, Author, and affected services.

Notion ADR database properties:
- `Title` (text): Short decision title
- `Status` (select): Proposed / Accepted / Deprecated / Superseded
- `Date` (date): When the decision was accepted
- `Author` (person): Who wrote the ADR
- `Services` (multi-select): Which services are affected
- `Tags` (multi-select): Database / Protocol / Security / Observability / etc.

The advantage of Notion is discoverability - filtered views like "All accepted ADRs affecting the payments service" or "All security-related ADRs" are trivial to build. The disadvantage is that ADRs are decoupled from the code they document.

A pragmatic approach: store ADRs as markdown in the repository (for history and co-location) and sync them to Notion or Confluence for discoverability. Tools like `repo-to-notion` or simple CI scripts can automate this sync.

### ADR Lifecycle

An ADR passes through four states during its lifetime:

```
Proposed → Accepted → Deprecated
                    ↘ Superseded
```

**Proposed**: The ADR has been written and is under review. No decisions have been finalized. Implementation should not begin while an ADR is in Proposed state.

**Accepted**: The ADR has been reviewed, objections have been addressed, and stakeholders have agreed. This is the normal state for an active architectural decision. Implementation proceeds based on an Accepted ADR.

**Deprecated**: The decision documented in the ADR is no longer applicable, but it was not replaced by a new decision. Example: a service was decommissioned, so the ADR documenting its database choice is now deprecated. The ADR is not deleted - it remains as historical record.

**Superseded**: A new ADR has replaced this one. The status is updated to "Superseded by ADR-XXXX" and the new ADR's "Replaces ADR-XXXX" field is populated. Example: ADR-001 chose PostgreSQL, ADR-015 chose CockroachDB for global distribution. ADR-001 is superseded by ADR-015.

Never delete an ADR. The history of what was decided and why is valuable even - especially - when the decision was wrong.

### Junior → FAANG: Understanding Workflow Before Proposing It

The workflow described in this section requires buy-in from engineers who have been making decisions informally for years. The hardest part of introducing ADRs to a team is not the format or the tooling. It is convincing experienced engineers that the overhead is worth it. The most effective argument is not abstract ("good orgs do this"). It is concrete: point to a specific recent decision that caused confusion or a specific incident where missing documentation contributed to the problem.

As a junior engineer proposing an ADR workflow, make it as low-friction as possible. Start with a simple template, a single designated directory, and a one-sentence norm: "write an ADR for any decision that would take more than five minutes to explain in a code review." Let the practice grow from there. Proposing a complex workflow with multiple approval stages to a team that has never written an ADR will produce rejection and resentment.

### Senior @ FAANG: Workflow Design as Change Management

Introducing a formal ADR workflow into an organization that has been operating informally is a change management exercise, not a technical one. The technical part, picking a format and directory structure, takes an afternoon. The change management part takes six months to a year.

The FAANG-scale approach that has worked consistently: start with a pilot team, run the workflow for one quarter, collect concrete evidence of value, then use that evidence to expand adoption. An ADR that prevented a 40-person-hour debate because the answer was already documented is worth more as an adoption argument than any amount of theoretical reasoning.

Workflow authority is the most political aspect of ADR implementation. At Amazon, technical decisions within a two-pizza team are owned by that team, and the ADR approval workflow reflects that: team lead approval is sufficient. Decisions that span multiple teams require a higher approval authority, which at Amazon is often an architecture review board or a principal engineer in the affected domain. Designing the workflow without explicitly mapping decision scope to approval authority produces a process that either blocks decisions unnecessarily or rubber-stamps decisions that should have had broader review.

The "never delete" principle in this section is more important than it appears. The impulse to delete superseded ADRs is natural: the directory gets cluttered, old decisions look embarrassing in retrospect, and the historical context seems irrelevant. But deleted ADRs reintroduce exactly the problem ADRs are designed to solve: a future engineer has no way to know whether a superseded approach was considered and rejected, or simply never considered. Preservation of the full history, with clear status transitions, is what transforms ADRs from personal notes into organizational memory.

---
