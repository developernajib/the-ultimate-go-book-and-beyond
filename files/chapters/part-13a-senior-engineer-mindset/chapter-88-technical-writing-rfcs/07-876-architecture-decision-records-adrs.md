## 88.6 Architecture Decision Records (ADRs)

### ADR Template

An Architecture Decision Record (ADR) is intentionally lightweight compared to an RFC. Its purpose is to capture a single decision along with the context that led to it, so that future engineers can understand why the system works the way it does. ADRs are especially valuable for decisions that seem obvious today but will be puzzling six months from now when the context has changed. The template below is deliberately short - an ADR should take 15 to 30 minutes to write, not days.

```markdown
# ADR-XXXX: [Short Title]

**Date**: YYYY-MM-DD
**Status**: Proposed | Accepted | Deprecated | Superseded
**Deciders**: [Names]
**Superseded by**: [Link to new ADR if applicable]

## Context

What is the issue that we're addressing?
What forces are at play?

## Decision

What is the change that we're proposing?

## Consequences

What becomes easier or harder because of this decision?

### Positive

- ...

### Negative

- ...

### Neutral

- ...
```

### ADR Examples

Seeing a concrete example makes the ADR format much easier to understand than reading the template alone. The following example shows how a team documented their choice of PostgreSQL as their primary database. Notice how the Context section captures the specific requirements that drove the decision, and the Consequences section honestly lists both the benefits and the drawbacks. This level of specificity is what makes an ADR useful to future readers.

```markdown
# ADR-001: Use PostgreSQL for Primary Database

**Date**: 2025-01-15
**Status**: Accepted
**Deciders**: Alice, Bob, Charlie

## Context

We need to choose a primary database for the new payments
service. Requirements:
- ACID transactions for financial data
- Complex queries for reporting
- Team expertise in SQL

## Decision

We will use PostgreSQL 17 as our primary database.

## Consequences

### Positive
- Team has strong PostgreSQL experience
- Excellent query capabilities for our reporting needs
- Strong ecosystem and community support

### Negative
- Need to manage infrastructure (or use managed RDS)
- Horizontal scaling requires careful planning (sharding)

### Neutral
- Standard SQL, easy to find talent
```

---
