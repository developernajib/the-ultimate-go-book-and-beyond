## 88.5 Design Documents

### Design Doc vs RFC

Beginners often confuse RFCs and design documents, but they serve fundamentally different purposes in the engineering workflow. An RFC asks the question "Should we do this?" and seeks approval for a direction, while a design document asks "How exactly do we build this?" and provides the implementation blueprint. In many organizations, the flow is sequential: an RFC gets approved first, and then a design document is written to guide the actual implementation.

```
RFC:
- Proposes a change/decision
- Seeks approval
- Higher-level, strategic
- "Should we do this?"

DESIGN DOC:
- Details implementation
- Guides execution
- Lower-level, tactical
- "How do we do this?"

Common flow:
RFC approved → Design doc written → Implementation
```

### Design Doc Template

A design document is typically more detailed than an RFC because it needs to contain enough information for engineers to actually build the system. The template below covers the essential sections: architecture, components, data models, API design, error handling, security, testing, and rollout. Not every section will apply to every project, but skipping a section should be a conscious decision rather than an oversight. When in doubt, include the section with a brief note explaining why it is not applicable.

````markdown
# Design: [Feature/System Name]

**Author**: [Name]
**Status**: Draft | In Review | Approved | Implemented
**RFC**: [Link to RFC if applicable]
**Last Updated**: [Date]

## Overview

Brief description of what this design covers.

## Background

Context needed to understand this design.

## Goals

What must this design achieve?

- Goal 1
- Goal 2

## Non-Goals

What is explicitly out of scope?

- Non-goal 1
- Non-goal 2

## Design

### Architecture

[Diagram showing components and interactions]

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│ Client  │────▶│ API     │────▶│ Database│
└─────────┘     └─────────┘     └─────────┘
```

### Components

#### Component A

Purpose, responsibilities, key interfaces.

#### Component B

...

### Data Model

The data model captures the exact schema this proposal will create or modify. Defining it explicitly in the RFC forces early review of column types, constraints, and nullability before any migration is written, catching design mistakes (such as missing indexes on foreign keys or incorrect timestamp handling) while the cost of change is still zero.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL
).
```

### API Design

Specifying request and response types in Go structs rather than prose locks down the contract between producer and consumer teams before a single line of implementation is written. JSON struct tags make the wire format explicit, and reviewers can immediately spot missing fields, wrong types, or inconsistent naming that would otherwise surface as integration bugs weeks later.

```go
// Request/response structures
type CreateUserRequest struct {
    Email string `json:"email"`
}

type CreateUserResponse struct {
    ID    string `json:"id"`
    Email string `json:"email"`
}
```

### Error Handling

How errors are handled and propagated.

### Security Considerations

Authentication, authorization, data protection.

### Testing Strategy

Unit tests, integration tests, load tests.

### Monitoring & Observability

Metrics, logs, traces, alerts.

### Rollout Plan

How will this be deployed?

1. Phase 1: Internal testing
2. Phase 2: 10% rollout
3. Phase 3: 100% rollout

### Rollback Plan

How do we revert if something goes wrong?

## Dependencies

What does this depend on?

## Timeline

| Milestone | Date | Description |
|-----------|------|-------------|
| M1 | Week 1 | Component A complete |
| M2 | Week 3 | Integration tests pass |

## Open Questions

- [ ] Unresolved question 1
- [ ] Unresolved question 2
````

---
