## Exercises

### Exercise 1: Write an RFC for Technical Standard

**Scenario**: Your organization has 12 microservices, each handling errors differently. Some panic, some return status codes, some return error types. You want to propose a standard error handling pattern.

**Task**: Write a complete RFC proposing an error handling standard for Go services.

**Solution**:

````markdown
# RFC-2025-003: Standardized Error Handling for Go Services

**Author:** [Your Name]
**Status:** Draft
**Created:** 2025-01-15

## Summary

Establish a consistent error handling pattern across all Go
microservices using structured errors with codes, gRPC status
mapping, and standardized logging.

## Motivation

### Problem Statement

Our 12 microservices handle errors inconsistently:
- 4 services panic on certain errors (causing restarts)
- 5 services return raw error strings (no categorization)
- 3 services have custom error types (incompatible)

This causes:
- P1 incidents from panics: 3 in last quarter
- Average debugging time: 45 minutes (vs industry 15 min)
- Customer-facing error messages: inconsistent and often cryptic

### Goals

1. Zero panics in business logic (panics only in main.go)
2. All errors have category (user error, system error, etc.)
3. Error codes map consistently to HTTP and gRPC status
4. Structured logging for all errors
5. Consistent customer-facing error messages

### Non-Goals

- Changing existing API contracts (backward compatible)
- Implementing retry logic (separate RFC)
- Error monitoring/alerting (covered by observability RFC)

## Technical Design

### Error Package

A shared `apperror` package solves the cross-cutting problem of translating the same domain error into different wire formats (HTTP status codes for REST handlers, gRPC status codes for RPC handlers) without scattering that mapping logic throughout every service. The `Code` type acts as the canonical, protocol-agnostic error category. The `Error` struct wraps a root cause via `Cause` so that `errors.As` and `errors.Is` still traverse the chain correctly, preserving Go's standard error unwrapping contract while adding structured context like `Operation` and `Details` for structured logging.

```go
package apperror

import (
    "errors"
    "fmt"
    "net/http"

    "google.golang.org/grpc/codes"
)

// Code represents the category of error
type Code string

const (
    CodeInvalidInput   Code = "INVALID_INPUT"
    CodeNotFound       Code = "NOT_FOUND"
    CodeAlreadyExists  Code = "ALREADY_EXISTS"
    CodePermissionDenied Code = "PERMISSION_DENIED"
    CodeUnauthenticated Code = "UNAUTHENTICATED"
    CodeInternal       Code = "INTERNAL"
    CodeUnavailable    Code = "UNAVAILABLE"
)

// Error is the standard error type for all services
type Error struct {
    Code       Code              // Category
    Message    string            // Human-readable message
    Details    map[string]any    // Additional context
    Cause      error             // Wrapped error
    Operation  string            // What operation failed
}

func (e *Error) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("%s: %s: %v", e.Operation, e.Message, e.Cause)
    }
    return fmt.Sprintf("%s: %s", e.Operation, e.Message)
}

func (e *Error) Unwrap() error {
    return e.Cause
}

// HTTPStatus maps error code to HTTP status
func (e *Error) HTTPStatus() int {
    switch e.Code {
    case CodeInvalidInput:
        return http.StatusBadRequest
    case CodeNotFound:
        return http.StatusNotFound
    case CodeAlreadyExists:
        return http.StatusConflict
    case CodePermissionDenied:
        return http.StatusForbidden
    case CodeUnauthenticated:
        return http.StatusUnauthorized
    case CodeUnavailable:
        return http.StatusServiceUnavailable
    default:
        return http.StatusInternalServerError
    }
}

// GRPCCode maps error code to gRPC code
func (e *Error) GRPCCode() codes.Code {
    switch e.Code {
    case CodeInvalidInput:
        return codes.InvalidArgument
    case CodeNotFound:
        return codes.NotFound
    case CodeAlreadyExists:
        return codes.AlreadyExists
    case CodePermissionDenied:
        return codes.PermissionDenied
    case CodeUnauthenticated:
        return codes.Unauthenticated
    case CodeUnavailable:
        return codes.Unavailable
    default:
        return codes.Internal
    }
}

// Constructor functions
func InvalidInput(operation, message string) *Error {
    return &Error{Code: CodeInvalidInput, Operation: operation, Message: message}
}

func NotFound(operation, message string) *Error {
    return &Error{Code: CodeNotFound, Operation: operation, Message: message}
}

func Internal(operation string, cause error) *Error {
    return &Error{
        Code:      CodeInternal,
        Operation: operation,
        Message:   "an internal error occurred",
        Cause:     cause,
    }
}

// IsCode checks if an error is of a specific code
func IsCode(err error, code Code) bool {
    var appErr *Error
    if errors.As(err, &appErr) {
        return appErr.Code == code
    }
    return false
}
```

### Usage Pattern

The pattern below shows how the service layer and HTTP handler each interact with `apperror` at their own layer of concern without reaching into each other's domain. The service constructs typed errors using the constructor functions (`InvalidInput`, `NotFound`, `Internal`), keeping business logic free of HTTP concepts. The handler then uses `errors.As` to unwrap the `*apperror.Error` and call `HTTPStatus()`, so the transport-layer status code decision is made once, at the boundary, rather than being hard-coded in every service method.

```go
// In service layer
func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    if id == "" {
        return nil, apperror.InvalidInput("GetUser", "user ID is required")
    }

    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, apperror.NotFound("GetUser", "user not found")
        }
        return nil, apperror.Internal("GetUser", err)
    }

    return user, nil
}

// In HTTP handler
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.GetUser(r.Context(), chi.URLParam(r, "id"))
    if err != nil {
        var appErr *apperror.Error
        if errors.As(err, &appErr) {
            h.respondError(w, appErr.HTTPStatus(), appErr)
        } else {
            h.respondError(w, http.StatusInternalServerError, err)
        }
        return
    }
    h.respondJSON(w, http.StatusOK, user)
}
```

## Migration Strategy

1. **Week 1-2**: Add error package to shared library
2. **Week 3-4**: Pilot migration with 2 low-risk services
3. **Week 5-8**: Gradual migration of remaining services
4. **Week 9-10**: Remove old error patterns, update linting

## Alternatives Considered

### Alternative A: Use sentinel errors only
- Pros: Simple, standard Go pattern
- Cons: No categorization, no rich context
- Rejected: Doesn't solve categorization problem

### Alternative B: Use cockroachdb/errors
- Pros: Battle-tested, feature-rich
- Cons: Heavy dependency, learning curve
- Rejected: Our needs are simpler, prefer owned code

## Open Questions

1. Should error codes be numeric (HTTP-like) or string-based?
   **Recommendation**: String-based for readability

2. How should we handle error localization?
   **Recommendation**: Defer to separate RFC, use codes for now

## Success Metrics

- Zero panics from business logic (currently 3/quarter)
- MTTR for errors: <20 minutes (currently 45 minutes)
- All errors have structured logs within 3 months
````

---

### Exercise 2: Stakeholder Mapping for Cross-Team Initiative

**Scenario**: You want to introduce a shared API gateway for all services. Currently, each team manages their own ingress.

**Task**: Create a stakeholder map identifying key people, their interests, concerns, and your strategy for each.

**Solution**:

````markdown
# Stakeholder Map: Shared API Gateway Initiative

## Key Stakeholders

### 1. Maria - Platform Team Lead
**Interest**: Reduce operational complexity
**Potential Concerns**: Team bandwidth, maintenance ownership
**Current Position**: Likely supportive (aligns with platform mission)
**Strategy**:
- Position gateway as platform team's core offering
- Propose that platform team owns the gateway
- Show how this elevates platform team's importance
**Engagement**: Early ally, involve in design from day 1

### 2. Chen - Payments Tech Lead
**Interest**: Performance, reliability (payments is latency-sensitive)
**Potential Concerns**: Added latency from gateway, single point of failure
**Current Position**: Skeptical (past bad experience with gateways)
**Strategy**:
- Lead with performance data showing <5ms overhead
- Show failure isolation design
- Propose payments gets priority routing
- Offer pilot with their non-critical endpoints first
**Engagement**: Address concerns early, make them a design partner

### 3. Alex - Security Lead
**Interest**: Centralized security controls, compliance
**Potential Concerns**: Gateway becomes attack surface
**Current Position**: Likely supportive (easier auditing)
**Strategy**:
- Lead with security benefits (WAF, rate limiting, auth)
- Involve security in architecture review
- Commit to security audit before production
**Engagement**: Early ally, get formal sign-off

### 4. Jordan - SRE Lead
**Interest**: Operational simplicity, reliability
**Potential Concerns**: Another system to operate, on-call burden
**Current Position**: Neutral (sees pros and cons)
**Strategy**:
- Show reduction in total systems (12 ingresses → 1)
- Commit to thorough runbooks and monitoring
- Offer SRE involvement in operational design
- Propose gradual rollout with easy rollback
**Engagement**: Partner on operational requirements

### 5. DevEx Team (several engineers)
**Interest**: Developer productivity, self-service
**Potential Concerns**: Slowing down deployments, bottleneck
**Current Position**: Potentially resistant (autonomy concerns)
**Strategy**:
- Design self-service configuration (GitOps)
- Show how gateway simplifies common tasks (auth, logging)
- Ensure zero-touch for standard deployments
**Engagement**: Demo self-service UX, involve in design

### 6. VP of Engineering (Sarah)
**Interest**: Cost reduction, team efficiency, reliability
**Potential Concerns**: Execution risk, team disruption
**Current Position**: Will support if data is strong
**Strategy**:
- Present ROI (cost savings, reduced incidents)
- Show buy-in from technical leaders
- Propose phased approach with checkpoints
**Engagement**: Brief after technical consensus built

## Influence Map

An influence map plots every stakeholder on two axes (their organizational power and their level of interest in your initiative), so you can allocate relationship-building effort strategically rather than treating all stakeholders equally. High-power, high-interest people like Maria (Platform) and Jordan (SRE) need frequent, detailed engagement because they can both block your work and actively accelerate it. High-power but low-interest people like Sarah (VP Eng) only need to be informed at key milestones: burdening them with operational detail wastes their attention and signals poor judgment.

```
                    HIGH POWER
                        │
     Alex (Security)    │    Sarah (VP Eng)
     [Support]          │    [Inform last]
                        │
  LOW ──────────────────┼────────────────── HIGH
  INTEREST              │                 INTEREST
                        │
     DevEx Team         │    Maria (Platform)
     [Manage closely]   │    Chen (Payments)
                        │    Jordan (SRE)
                        │    [Key partners]
                    LOW POWER
```

## Engagement Sequence

| Week | Activities |
|------|------------|
| 1 | 1:1 with Maria (ally), get initial buy-in |
| 1 | 1:1 with Alex (ally), get security perspective |
| 2 | 1:1 with Chen (skeptic), understand concerns deeply |
| 2 | 1:1 with Jordan (neutral), understand ops requirements |
| 3 | Draft design incorporating feedback |
| 3 | Share draft with allies for review |
| 4 | Working session with Chen to address performance |
| 4 | Working session with DevEx on self-service UX |
| 5 | Architecture review with all stakeholders |
| 6 | Executive brief to Sarah (VP) with consensus |
````

---

### Exercise 3: Mentor Struggling Engineer

**Scenario**: A mid-level engineer named Sam has been on your team for 6 months. Their code quality is good but they rarely speak up in design discussions, avoid code reviews, and seem disengaged. Their skip-level revealed they're considering leaving.

**Task**: Create a mentoring plan to understand the root cause and address it.

**Solution**:

```markdown
# Mentoring Plan: Sam (Mid-Level Engineer)

## Initial Hypothesis

Based on symptoms:
- Good code quality but low engagement
- Avoids team interactions (design, reviews)
- Considering leaving

Possible root causes (need to validate):
1. Imposter syndrome / confidence issue
2. Doesn't feel valued or heard
3. Not interested in current work
4. Conflict with team member
5. Career growth concerns
6. Personal issues outside work

## Phase 1: Diagnosis (Week 1-2)

### 1:1 Conversation Structure

**Create psychological safety first:**
"Sam, I wanted to check in. I've noticed you seem less engaged
lately, and I want to make sure I'm supporting you well. This
is confidential and I'm here to help, not judge."

**Open-ended exploration:**
- "How are you feeling about work lately?"
- "What parts of your work are most/least energizing?"
- "I noticed you've been quieter in design discussions.
   What's going on there for you?"
- "Where do you see your career going?"
- "What would make this job better for you?"

**Listen for:**
- Tone (frustrated, sad, defensive, resigned)
- Specific incidents vs general feelings
- What they care about
- What they're avoiding

### Observation

- Review their recent PRs and code
- Note interactions in Slack and meetings
- Talk to their closest collaborator (carefully)

## Phase 2: Tailored Intervention

*Adjust based on diagnosis. Here's an example if root cause
is confidence/imposter syndrome:*

### If: Confidence Issue

**Week 3-4: Build safe participation**
- Assign them to present a small topic at team meeting
- Pair program on a design task (you facilitate, they lead)
- Ask their opinion explicitly in meetings:
  "Sam, you worked on something similar. What do you think?"

**Week 5-6: Structured growth experiences**
- Assign a small, high-visibility project they can own
- Set them up for success with clear requirements
- Celebrate wins publicly, give feedback privately

**Week 7-8: Expand scope**
- Have them lead a code review session
- Include them in architecture discussions
- Ask them to mentor a new hire on their area

### If: Not Feeling Valued

**Week 3-4: Recognition and clarity**
- Share specific examples of their good work
- Explain how their work fits the bigger picture
- Connect them with stakeholders who benefit from their work

**Week 5-6: Increase influence**
- Give them decision authority on something meaningful
- Include them in planning discussions
- Ask for their input before making team decisions

### If: Wrong Role/Work

**Week 3-4: Exploration**
- Discuss what work would be more interesting
- Explore rotation to another project/team
- See if current role can be reshaped

## Success Metrics

After 8 weeks, look for:
- [ ] Speaks up at least once per design discussion
- [ ] Submits code reviews proactively
- [ ] Expressed interest in staying (in skip-level)
- [ ] Takes on stretch assignment voluntarily
- [ ] General energy seems improved

## Fallback Plan

If after 8 weeks there's no improvement:
- Have honest conversation about fit
- Explore transfer to different team
- Support their job search if that's best for them
- Document performance concerns if needed
```

### Junior → FAANG: Treating Exercises as Real Work Samples

The exercises in this section are not academic. Treat each one as a real deliverable: write the RFC as if it will be reviewed by your team, draft the design doc as if it will be linked from a Jira ticket, give the architectural critique as if it will be shared with the original author. The quality of your output when you treat it as real is substantially higher than when you treat it as practice, and that quality difference is detectable in interviews.

When a FAANG interviewer asks "do you have any work samples you can share?", having a real (or anonymized) RFC, design doc, or ADR from one of these exercises gives you a concrete artifact to reference. The candidate who says "here is an RFC I wrote for a technical standard on my team" has a structural advantage over the candidate who only describes their work verbally.

### Senior @ FAANG: Calibrating Exercise Scope to Staff-Level Expectations

When doing the exercises at senior level, calibrate the scope of your deliverable upward. A junior engineer writing an RFC for "introducing a new Go linting rule" is solving a team-level problem. A staff engineer approaching the same exercise should be writing an RFC for "standardizing Go linting policy and enforcement across all services in the platform org, with a rollout strategy, exception handling process, and 12-month adoption metrics." The difference in scope is the difference in level.

Use these exercises to practice the artifacts that staff engineers are expected to produce: architecture review documents, technical strategy memos, cross-team migration plans, and engineering effectiveness frameworks. These are the documents that bar-raisers reference when deciding whether a candidate is operating at L6 or L7 scope. Having practiced producing them under time pressure is direct preparation for the on-site writing exercise that many staff-level FAANG loops now include.

---
