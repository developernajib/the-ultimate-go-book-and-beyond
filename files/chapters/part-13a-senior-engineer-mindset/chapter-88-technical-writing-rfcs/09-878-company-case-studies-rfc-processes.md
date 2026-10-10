## 88.8 Company Case Studies: RFC Processes

### Google's Design Doc Culture

Google is famous for its design doc culture, where written proposals drive decisions:

```
GOOGLE DESIGN DOC PROCESS:

1. WHEN TO WRITE A DESIGN DOC:
   - Any project taking > 1 engineer-month
   - Any change affecting > 1 team
   - Any new service or significant feature
   - When you want feedback before coding

2. GOOGLE DESIGN DOC STRUCTURE:
   ┌────────────────────────────────────────────────────────────┐
   │  TITLE: [Project Name] Design Document                     │
   │  Author: [Name] | Reviewers: [Names] | Status: [Draft...]  │
   ├────────────────────────────────────────────────────────────┤
   │  OVERVIEW (1 paragraph max)                                │
   │  What are we building and why?                             │
   │                                                            │
   │  CONTEXT                                                   │
   │  Background, why now, related work                         │
   │                                                            │
   │  GOALS AND NON-GOALS                                       │
   │  Explicit about scope                                      │
   │                                                            │
   │  DETAILED DESIGN                                           │
   │  System design, APIs, data model                           │
   │                                                            │
   │  ALTERNATIVES CONSIDERED                                   │
   │  What else did you consider and why not?                   │
   │                                                            │
   │  CROSS-CUTTING CONCERNS                                    │
   │  Security, privacy, accessibility                          │
   │                                                            │
   │  MIGRATION PLAN                                            │
   │  How do we get from here to there?                         │
   └────────────────────────────────────────────────────────────┘

3. REVIEW PROCESS:
   - Share with small group first (2-3 trusted reviewers)
   - Iterate based on feedback
   - Broader distribution for comments
   - Discussion period (typically 1-2 weeks)
   - Final decision meeting if needed
   - Document approved → start implementation
```

```go
// Example: Google-style Design Doc for a Go Service

/*
=============================================================================
Design Document: Rate Limiting Service
=============================================================================

Author: alice@google.com
Reviewers: bob@google.com, carol@google.com
Status: Approved
Last Updated: 2025-01-15

OVERVIEW
--------
This document describes the design of a centralized rate limiting service
that will replace per-service rate limiting logic across our backend.

CONTEXT
-------
Currently, each service implements its own rate limiting:
- 15 different implementations
- Inconsistent behavior (some token bucket, some leaky bucket)
- No global view of client usage
- Difficult to update limits quickly

GOALS
-----
1. Single source of truth for rate limits
2. < 1ms p99 latency impact
3. Support for 1M+ requests/second
4. Real-time limit adjustment without deploys

NON-GOALS
---------
1. Replacing API gateway (out of scope)
2. Billing or quota management
3. Per-endpoint limits (phase 2)

DETAILED DESIGN
---------------
*/

// Core interface
type RateLimiter interface {
    // Allow checks if request should be allowed
    // Returns remaining quota and wait time if limited
    Allow(ctx context.Context, req *AllowRequest) (*AllowResponse, error)
}

type AllowRequest struct {
    ClientID    string            // Who is making the request
    Resource    string            // What resource are they accessing
    Cost        int64             // How much quota to consume (default 1)
    Metadata    map[string]string // Additional context
}

type AllowResponse struct {
    Allowed      bool          // Should we allow this request?
    Remaining    int64         // Remaining quota
    ResetAt      time.Time     // When quota resets
    RetryAfter   time.Duration // If not allowed, when to retry
}

// Implementation uses Redis for distributed state
type RedisRateLimiter struct {
    client     *redis.ClusterClient
    config     *ConfigWatcher       // Real-time config updates
    localCache *ristretto.Cache     // Local cache for hot paths
}

/*
ALTERNATIVES CONSIDERED
-----------------------
1. Library-based approach
   Pros: No new service, simple
   Cons: Still inconsistent, no global view
   Rejected: Doesn't meet goal #1

2. API Gateway rate limiting
   Pros: Industry standard
   Cons: Gateway doesn't have app context
   Rejected: Need application-level limits

3. Envoy ext_authz
   Pros: Standardized
   Cons: Additional latency, complexity
   Deferred: May adopt for edge limits

MIGRATION PLAN
--------------
Phase 1 (Weeks 1-4): Deploy service, shadow mode
Phase 2 (Weeks 5-8): Migrate 3 high-traffic services
Phase 3 (Weeks 9-12): Full migration, deprecate old code
*/
```

### Amazon's PRFAQ and Working Backwards

Amazon's unique approach to technical writing: write the press release first.

```
AMAZON'S PRFAQ PROCESS:

"Working Backwards" from the customer announcement:

1. PRESS RELEASE (1 page)
   Write as if launching to customers:
   - What is it?
   - Why does it matter to customers?
   - How does it work?
   - Quote from leadership
   - Quote from customer

2. FAQ (1-5 pages)
   Answer tough questions:
   - Customer questions
   - Internal questions
   - Technical questions
   - Business questions

3. PURPOSE:
   - Forces customer-centric thinking
   - Clarifies the "why" before the "how"
   - Aligns team on success criteria
   - Identifies gaps in thinking

AMAZON PRFAQ TEMPLATE:
┌─────────────────────────────────────────────────────────────────┐
│  PRESS RELEASE                                                  │
│                                                                 │
│  [City, Date] - Amazon Web Services, Inc. announces [Product],  │
│  a [category] that enables customers to [benefit].              │
│                                                                 │
│  [Problem statement - what pain are customers experiencing?]    │
│                                                                 │
│  [Solution - how does this solve it?]                           │
│                                                                 │
│  "Quote from VP explaining why this matters"                    │
│                                                                 │
│  [How it works - high level]                                    │
│                                                                 │
│  [Availability and pricing]                                     │
│                                                                 │
│  "Quote from beta customer about value"                         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  FAQ                                                            │
│                                                                 │
│  CUSTOMER QUESTIONS:                                            │
│  Q: How is this different from [competitor]?                    │
│  Q: How much does it cost?                                      │
│  Q: How do I get started?                                       │
│                                                                 │
│  INTERNAL QUESTIONS:                                            │
│  Q: Why are we building this now?                               │
│  Q: What's the TAM?                                             │
│  Q: What's the competitive moat?                                │
│                                                                 │
│  TECHNICAL QUESTIONS:                                           │
│  Q: What's the architecture?                                    │
│  Q: How does it scale?                                          │
│  Q: What are the dependencies?                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Meta's RFC Process

Meta (formerly Facebook) takes a lighter-weight approach to RFCs compared to Google. Their philosophy emphasizes speed and iteration: get your proposal in front of people quickly, gather feedback in the open, and iterate rapidly rather than polishing a document in isolation. This approach works well in Meta's fast-moving engineering culture where teams ship code multiple times per day and decisions need to keep pace with development velocity.

```
META (FACEBOOK) RFC PROCESS:

1. RFC STRUCTURE AT META:
   - Lighter weight than Google design docs
   - Focus on getting feedback quickly
   - Iterate in the open

2. META RFC TEMPLATE:
   ┌─────────────────────────────────────────────────────────────┐
   │  RFC: [Title]                                               │
   │  Status: Draft | Proposed | Accepted | Implemented          │
   │  Author: [Name]                                             │
   ├─────────────────────────────────────────────────────────────┤
   │  # Summary                                                  │
   │  One paragraph describing the proposal                      │
   │                                                             │
   │  # Motivation                                               │
   │  Why should we do this?                                     │
   │                                                             │
   │  # Detailed Design                                          │
   │  Technical details                                          │
   │                                                             │
   │  # Alternatives                                             │
   │  What else did you consider?                                │
   │                                                             │
   │  # Rollout Plan                                             │
   │  How will this be deployed?                                 │
   │                                                             │
   │  # Open Questions                                           │
   │  Things still to be decided                                 │
   └─────────────────────────────────────────────────────────────┘

3. REVIEW PROCESS:
   - Propose in task/diff comment
   - Tag relevant people
   - 1-week comment period
   - Decision documented in task
   - No formal approval board
```

```go
// Example: Meta-style RFC

/*
RFC: Migrate News Feed Cache to TAO

Status: Proposed
Author: @engineer
Reviewers: @caching-team @newsfeed-team

# Summary

Migrate News Feed's Redis-based cache to TAO, Meta's distributed
object store, to improve consistency and reduce operational burden.

# Motivation

Current state:
- News Feed uses 50 Redis clusters for caching
- Consistency issues during failover (reported 12 times in Q4)
- Each team manages their own Redis config
- No cross-region replication

TAO provides:
- Built-in consistency guarantees
- Cross-region replication
- Managed by infrastructure team
- Better observability

# Detailed Design
*/

// Current implementation
type RedisFeedCache struct {
    clusters []*redis.Client  // 50 clusters, manual sharding
}

func (c *RedisFeedCache) Get(userID int64) (*Feed, error) {
    cluster := c.clusters[userID % 50]  // Manual sharding
    data, err := cluster.Get(ctx, feedKey(userID)).Bytes()
    if err != nil {
        return nil, err  // No fallback
    }
    return unmarshalFeed(data)
}

// Proposed TAO implementation
type TAOFeedCache struct {
    client *tao.Client  // Single client, TAO handles sharding
}

func (c *TAOFeedCache) Get(userID int64) (*Feed, error) {
    obj, err := c.client.Get(ctx, tao.Key{
        ObjectType: "feed_cache",
        ObjectID:   userID,
    })
    if err != nil {
        // TAO provides automatic fallback to stale data
        return nil, err
    }
    return obj.(*Feed), nil
}

/*
# Rollout Plan

Week 1-2: Deploy TAO integration in shadow mode
Week 3-4: 1% traffic to TAO (dual-read, compare results)
Week 5-6: 50% traffic to TAO
Week 7-8: 100% traffic, deprecate Redis
Week 9-10: Decommission Redis clusters

# Open Questions

1. How to handle the 2TB of existing cached data?
   Proposal: Let it expire naturally, TAO will warm

2. Cost comparison?
   Need TAO team input on capacity requirements
*/
```

### Stripe's RFC Culture

Stripe is known for having one of the highest bars for written communication in the tech industry. Their RFCs are polished documents that go through multiple drafts before sharing, and the company expects clear, precise language as a baseline competency for senior engineers. Because Stripe builds financial infrastructure where correctness is paramount, their RFC process places special emphasis on idempotency, error handling, retry semantics, and backwards compatibility - topics that every API-focused RFC must address explicitly.

```
STRIPE RFC CHARACTERISTICS:

1. HIGH BAR FOR WRITING
   - RFCs are polished documents
   - Multiple drafts before sharing
   - Clear, precise language expected

2. STRIPE RFC FORMAT:
   ┌─────────────────────────────────────────────────────────────┐
   │  # RFC: [Number] - [Title]                                  │
   │                                                             │
   │  **Author**: [Name]                                         │
   │  **Status**: Draft | Review | Accepted | Superseded         │
   │  **Created**: [Date]                                        │
   │  **Implementation**: [Link to code if accepted]             │
   │                                                             │
   │  ## Abstract                                                │
   │  [2-3 sentence summary]                                     │
   │                                                             │
   │  ## Motivation                                              │
   │  [Why is this needed?]                                      │
   │                                                             │
   │  ## Specification                                           │
   │  [Detailed technical spec]                                  │
   │                                                             │
   │  ## Rationale                                               │
   │  [Why this design?]                                         │
   │                                                             │
   │  ## Backwards Compatibility                                 │
   │  [Migration and compatibility]                              │
   │                                                             │
   │  ## Reference Implementation                                │
   │  [Code examples or prototype]                               │
   └─────────────────────────────────────────────────────────────┘

3. EMPHASIS ON IDEMPOTENCY
   Every Stripe RFC for APIs must address:
   - Idempotency behavior
   - Retry semantics
   - Error handling
   - Backwards compatibility
```

```go
// Example: Stripe-style RFC with emphasis on correctness

/*
RFC-0234: Idempotent Payment Intent Creation

Author: @payments-engineer
Status: Accepted
Created: 2025-01-10

## Abstract

This RFC specifies the idempotency behavior for the PaymentIntent
creation endpoint, ensuring safe retries and consistent behavior
across all client libraries.

## Motivation

Customers report confusion about idempotency key behavior:
- When does a key "expire"?
- What happens on parameter mismatch?
- How to handle partial failures?

## Specification
*/

// IdempotencyKey behavior
type IdempotencyBehavior struct {
    KeyLifetime     time.Duration // 24 hours
    KeyScope        string        // Per-account
    OnMismatch      MismatchBehavior
    OnPartialFail   PartialFailBehavior
}

const (
    // If idempotency key reused with different params
    MismatchReturnError MismatchBehavior = iota

    // If request partially succeeded (e.g., record created but webhook failed)
    PartialFailReturnCached PartialFailBehavior = iota
)

// CreatePaymentIntent with idempotency
func (s *PaymentService) CreatePaymentIntent(
    ctx context.Context,
    req *CreatePaymentIntentRequest,
) (*PaymentIntent, error) {
    // 1. Check for existing idempotency key
    existing, err := s.idempotencyStore.Get(ctx, req.IdempotencyKey)
    if err == nil {
        // Key exists - validate params match
        if !existing.ParamsMatch(req) {
            return nil, &stripe.Error{
                Code:    "idempotency_key_in_use",
                Message: "Idempotency key reused with different parameters",
            }
        }
        // Return cached response
        return existing.Response, nil
    }

    // 2. Acquire lock on idempotency key
    lock, err := s.idempotencyStore.Lock(ctx, req.IdempotencyKey)
    if err != nil {
        return nil, fmt.Errorf("acquire idempotency lock: %w", err)
    }
    defer lock.Release()

    // 3. Double-check (another request may have completed)
    existing, err = s.idempotencyStore.Get(ctx, req.IdempotencyKey)
    if err == nil {
        return existing.Response, nil
    }

    // 4. Create the PaymentIntent
    pi, err := s.createPaymentIntentInternal(ctx, req)
    if err != nil {
        // Store error response for idempotency
        s.idempotencyStore.Set(ctx, req.IdempotencyKey, &IdempotencyRecord{
            Params:   req,
            Error:    err,
            Created:  time.Now(),
        })
        return nil, err
    }

    // 5. Store successful response
    s.idempotencyStore.Set(ctx, req.IdempotencyKey, &IdempotencyRecord{
        Params:   req,
        Response: pi,
        Created:  time.Now(),
    })

    return pi, nil
}

/*

## Rationale

Q: Why 24-hour key lifetime?
A: Balances customer retry needs with storage costs.
   Analysis shows 99.9% of retries happen within 1 hour.

Q: Why error on parameter mismatch?
A: Silent success could mask bugs in customer code.
   Explicit error helps customers debug issues.

## Backwards Compatibility

No breaking changes. New behavior only applies when
idempotency key is provided.
*/
```

### Netflix's ADR Practice

Netflix favors lightweight Architecture Decision Records (ADRs) over heavyweight RFCs for most decisions. Their engineering culture values autonomy and speed, so the documentation process is designed to capture decisions without creating bottlenecks. ADRs at Netflix follow a simple three-section format (Context, Decision, Consequences) that an engineer can write in under 30 minutes. The goal is not to seek permission but to create a durable record that future engineers can reference when they need to understand why the system was built a certain way.

```
NETFLIX ADR (Architecture Decision Record) PRACTICE:

Netflix uses lightweight ADRs for documenting decisions:

TEMPLATE:
┌─────────────────────────────────────────────────────────────────┐
│  # ADR [Number]: [Title]                                        │
│                                                                 │
│  Date: [Date]                                                   │
│  Status: [Proposed | Accepted | Deprecated | Superseded]        │
│                                                                 │
│  ## Context                                                     │
│  What is the issue that we're seeing that is motivating this    │
│  decision or change?                                            │
│                                                                 │
│  ## Decision                                                    │
│  What is the change that we're proposing and/or doing?          │
│                                                                 │
│  ## Consequences                                                │
│  What becomes easier or more difficult to do because of this    │
│  change?                                                        │
└─────────────────────────────────────────────────────────────────┘

EXAMPLE:
```

```markdown
# ADR 47: Use gRPC for Internal Service Communication

Date: 2025-01-15
Status: Accepted

## Context

Our internal services currently use a mix of REST and Thrift.
This causes:
- Inconsistent error handling across services
- Multiple serialization libraries to maintain
- No standard for streaming (needed for new playback features)
- Schema evolution challenges

## Decision

We will standardize on gRPC for all new internal service
communication. Existing services will migrate over 18 months.

Specifically:
- gRPC-Go for Go services
- Connect-Go for services needing HTTP/1.1 compatibility
- Buf for schema management and breaking change detection

## Consequences

### Positive
- Unified schema language (protobuf)
- Built-in streaming support
- Better tooling for schema evolution
- Consistent error codes

### Negative
- Learning curve for teams unfamiliar with gRPC
- Browser support requires Connect or gRPC-Web
- More complex debugging (binary protocol)

### Neutral
- Performance is similar to Thrift
- Migration will require dedicated engineering time
```

### Key Insights Across Companies

Despite their different cultures and processes, the major technology companies converge on a remarkably consistent set of principles for technical writing. Whether you work at a startup or a large enterprise, these patterns apply universally. The insights below distill the common threads from Google, Amazon, Meta, Stripe, and Netflix into actionable best practices that you can adopt regardless of your organization's size or maturity.

```
┌──────────────────────────────────────────────────────────────────┐
│        TECHNICAL WRITING BEST PRACTICES FROM FAANG               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. WRITE BEFORE CODE                                            │
│     All companies use design docs BEFORE implementation          │
│     "Hours of coding can save minutes of planning" (inverted)    │
│                                                                  │
│  2. FRONT-LOAD THE IMPORTANT STUFF                               │
│     Summary/Abstract first                                       │
│     Readers can stop early if not relevant                       │
│                                                                  │
│  3. EXPLICIT ALTERNATIVES                                        │
│     All templates require "Alternatives Considered"              │
│     Shows thoughtful decision-making                             │
│                                                                  │
│  4. MIGRATION PLANS                                              │
│     How do we get from here to there?                            │
│     Often forgotten but critical                                 │
│                                                                  │
│  5. RECORD DECISIONS                                             │
│     ADRs create institutional memory                             │
│     Future teams understand context                              │
│                                                                  │
│  6. ITERATE BEFORE SHARING WIDELY                                │
│     Get early feedback from 2-3 trusted reviewers                │
│     Polish before broad distribution                             │
│                                                                  │
│  7. SET CLEAR STATUS                                             │
│     Draft → Review → Accepted → Implemented                      │
│     Readers know what stage the doc is in                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---
