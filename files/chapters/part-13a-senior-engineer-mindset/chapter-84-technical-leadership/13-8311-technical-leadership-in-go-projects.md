## 84.12 Technical Leadership in Go Projects

### Go-Specific Leadership Patterns

Technical leadership in Go projects requires understanding Go's philosophy and applying it consistently across teams. Go's emphasis on simplicity, explicit error handling, and composition over inheritance creates a unique set of standards that technical leaders must establish and enforce. The example below demonstrates a production-grade service that follows idiomatic Go patterns, from constructor injection for testability to structured logging with correlation IDs. As a technical leader, establishing these patterns early prevents each team member from inventing their own approach, which leads to inconsistency and harder-to-maintain code.

```go
// Example: Establishing Go Standards for Your Team

package standards

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"
)

// StandardService demonstrates idiomatic Go patterns that
// technical leaders should establish across their teams.
type StandardService struct {
    // Dependencies are injected through constructor
    repo    Repository
    cache   Cache
    logger  *slog.Logger
    metrics MetricsCollector

    // Configuration is explicit
    config Config
}

// Config shows how to structure service configuration
type Config struct {
    RequestTimeout time.Duration
    MaxRetries     int
    CacheTTL       time.Duration
}

// DefaultConfig provides sensible defaults - a key leadership decision
func DefaultConfig() Config {
    return Config{
        RequestTimeout: 30 * time.Second,
        MaxRetries:     3,
        CacheTTL:       5 * time.Minute,
    }
}

// NewStandardService demonstrates constructor injection pattern
// that tech leads should mandate for testability
func NewStandardService(
    repo Repository,
    cache Cache,
    logger *slog.Logger,
    metrics MetricsCollector,
    config Config,
) *StandardService {
    return &StandardService{
        repo:    repo,
        cache:   cache,
        logger:  logger,
        metrics: metrics,
        config:  config,
    }
}

// Error handling pattern that tech leads should establish
var (
    ErrNotFound     = errors.New("resource not found")
    ErrInvalidInput = errors.New("invalid input")
    ErrInternal     = errors.New("internal error")
)

// ProcessItem shows standard error handling and logging patterns
func (s *StandardService) ProcessItem(ctx context.Context, id string) (*Item, error) {
    // 1. Input validation at the boundary
    if id == "" {
        return nil, fmt.Errorf("%w: id cannot be empty", ErrInvalidInput)
    }

    // 2. Context timeout handling
    ctx, cancel := context.WithTimeout(ctx, s.config.RequestTimeout)
    defer cancel()

    // 3. Structured logging with correlation ID
    logger := s.logger.With(
        slog.String("operation", "ProcessItem"),
        slog.String("item_id", id),
    )

    // 4. Metrics instrumentation
    start := time.Now()
    defer func() {
        s.metrics.RecordLatency("process_item", time.Since(start))
    }()

    // 5. Check cache first (performance pattern)
    if item, ok := s.cache.Get(ctx, id); ok {
        logger.Debug("cache hit")
        s.metrics.Increment("cache_hit")
        return item, nil
    }
    s.metrics.Increment("cache_miss")

    // 6. Fetch from repository with proper error handling
    item, err := s.repo.Get(ctx, id)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            logger.Info("item not found")
            return nil, err
        }
        logger.Error("failed to get item", slog.String("error", err.Error()))
        return nil, fmt.Errorf("%w: %v", ErrInternal, err)
    }

    // 7. Update cache
    if err := s.cache.Set(ctx, id, item, s.config.CacheTTL); err != nil {
        // Cache errors are logged but don't fail the request
        logger.Warn("failed to update cache", slog.String("error", err.Error()))
    }

    logger.Info("item processed successfully")
    return item, nil
}

// Item represents a domain entity
type Item struct {
    ID        string
    Data      map[string]any
    CreatedAt time.Time
    UpdatedAt time.Time
}

// Repository interface shows how to define clean boundaries
type Repository interface {
    Get(ctx context.Context, id string) (*Item, error)
    Save(ctx context.Context, item *Item) error
    Delete(ctx context.Context, id string) error
}

// Cache interface for caching layer
type Cache interface {
    Get(ctx context.Context, key string) (*Item, bool)
    Set(ctx context.Context, key string, item *Item, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}

// MetricsCollector interface for observability
type MetricsCollector interface {
    Increment(name string)
    RecordLatency(name string, duration time.Duration)
}
```

### Establishing Code Review Standards

Technical leaders should define clear code review guidelines. Without explicit standards, code reviews become inconsistent, one reviewer blocks on naming preferences while another misses a concurrency bug. By categorizing feedback into blocking issues (must fix), non-blocking suggestions (should fix), and nits (author's choice), you create a shared language that makes reviews faster, fairer, and more focused on what actually matters for production safety.

```markdown
# Go Code Review Standards (Tech Lead Document)

## BLOCKING Issues (PR cannot merge)

### 1. Concurrency Safety
- Race conditions (must be tested with -race)
- Goroutine leaks (missing context cancellation)
- Improper channel usage (deadlock potential)

### 2. Error Handling
- Ignored errors (except explicit _ with comment)
- Missing error context (raw errors without wrapping)
- Panic in library code

### 3. Security
- SQL injection potential
- Untrusted input not validated
- Secrets logged or exposed
- Missing TLS/authentication

### 4. Resource Management
- Missing deferred cleanup (close, unlock)
- Context not propagated
- Missing timeouts on external calls

## NON-BLOCKING Suggestions

### 1. Naming
- Unexported when could be exported
- Inconsistent naming patterns
- Overly abbreviated names

### 2. Structure
- Large functions that could be split
- Missing documentation on exported types
- Inconsistent package organization

### 3. Performance
- Unnecessary allocations (could use sync.Pool)
- Inefficient string concatenation
- Missing buffer reuse

## NITs (Author's Choice)

- Style preferences not in gofmt
- Alternative approaches of equal merit
- Variable naming within acceptable range
```

### Technical RFC Template for Go Projects

An RFC (Request for Comments) is a formal proposal document that invites structured feedback before a major technical decision is made. For Go projects, the RFC template below covers everything from API design with Go code samples to migration strategy and operational considerations. Having a standard template ensures that every proposal addresses the same set of concerns, making it easier for reviewers to evaluate proposals consistently and reducing the chance of overlooking critical aspects like rollback plans or security implications.

````markdown
# RFC: [Title]

**Author:** [Your Name]
**Status:** Draft | In Review | Accepted | Implemented
**Created:** 2025-01-15
**Last Updated:** 2025-01-20

## Summary

One paragraph summary of the proposal.

## Motivation

### Problem Statement
What problem are we solving? Include metrics and user impact.

### Current State
How does the system work today? What are the limitations?

### Goals
- Goal 1: Specific, measurable outcome
- Goal 2: Another measurable outcome

### Non-Goals
- Explicitly list what this RFC does NOT address

## Technical Design

### Architecture Overview

The proposed design introduces a dedicated library layer between the calling service and the database, enforcing a clean separation of concerns and preventing business logic from leaking directly into query code. This three-tier arrangement makes the library independently testable and allows future consumers to reuse the same data-access logic without duplicating it across services.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Service   │────▶│   Library   │────▶│  Database   │
│             │     │   (new)     │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
```

### API Design

The public surface of the new feature is expressed as a minimal Go interface with a single `Process` method, keeping the contract small and making mocking straightforward in tests. Accepting a `context.Context` as the first argument ensures callers can propagate deadlines and cancellations through the entire call chain without retrofitting later.

```go
// Example API that this RFC proposes

package newfeature

type Service interface {
    // Process handles the main workflow
    Process(ctx context.Context, req *Request) (*Response, error)
}

type Request struct {
    // Fields with documentation
}

type Response struct {
    // Fields with documentation
}
```

### Data Model Changes

The schema change introduces a new table rather than altering an existing one, which avoids locking production tables and allows the migration to be deployed independently of application code. Using a UUID primary key instead of an auto-incrementing integer prevents ID enumeration and makes the table safe to distribute across multiple database shards in the future.

```sql
-- New tables or schema changes
CREATE TABLE new_table (
    id UUID PRIMARY KEY
    -- other fields
);
```

### Migration Strategy

1. Phase 1: Deploy new code with feature flag disabled
2. Phase 2: Enable for 1% of traffic
3. Phase 3: Gradually increase to 100%
4. Phase 4: Remove old code path

## Alternatives Considered

### Alternative A: [Name]
- Description
- Pros: ...
- Cons: ...
- Reason not chosen: ...

### Alternative B: [Name]
- Description
- Pros: ...
- Cons: ...
- Reason not chosen: ...

## Operational Considerations

### Monitoring
- New metrics to add
- New alerts to create
- Dashboard updates

### Rollback Plan
- How to roll back if issues arise
- Data migration rollback steps

### Performance Impact
- Expected latency change
- Expected throughput change
- Load test results

## Security Considerations

- Authentication/authorization changes
- Data privacy implications
- Threat model updates

## Testing Strategy

- Unit test coverage requirements
- Integration test scenarios
- Load/stress test plan

## Timeline and Milestones

| Phase | Description | Duration |
|-------|-------------|----------|
| Phase 1 | Implementation | - |
| Phase 2 | Testing | - |
| Phase 3 | Rollout | - |

## Open Questions

1. Question that needs discussion?
2. Another question?

## References

- Link to related design docs
- External resources
````

### Junior → FAANG: Go-Specific Leadership as a Differentiator

Most engineers applying to FAANG Go roles demonstrate proficiency with goroutines, channels, and standard library patterns. Few demonstrate Go-specific leadership: the ability to enforce idiomatic Go across a team, build tooling that guides the codebase toward consistency, or make principled decisions about where Go's simplicity constraints should be respected vs where they need extension.

For your interview, be able to articulate at least one Go-specific technical standard you advocated for on your team. Examples: enforcing `errcheck`, establishing a shared logging interface, standardizing context propagation patterns, or agreeing on a struct embedding policy. The specificity shows that your Go experience includes team-level thinking, not just personal productivity.

### Senior @ FAANG: Go Project Architecture as an Organizational Standard

At staff level in Go-heavy organizations, you are expected to define and govern the architectural standards that keep dozens of Go services coherent as they evolve independently. This includes: module boundary policies, internal package naming conventions, shared interface standards for common concerns (logging, tracing, config), and the criteria for extracting a shared library vs keeping logic in individual services.

The hardest governance problem in Go at scale is the shared library dilemma. Too few shared libraries and every team reinvents common patterns with subtle incompatibilities. Too many and the coordination overhead of versioned dependencies becomes a bottleneck. The staff engineer who can articulate a principled policy for when to extract, how to version, and how to deprecate shared Go libraries is solving a real organizational problem that most Go platform teams struggle with.

Document your Go architectural decisions in ADRs. Future engineers maintaining these services will encounter the same tradeoffs and will make worse decisions without the context of why the current approach was chosen.

---
