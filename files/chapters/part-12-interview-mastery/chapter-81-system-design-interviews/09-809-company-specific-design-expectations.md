## 81.8 Company-Specific Design Expectations

### Google System Design Focus

Google emphasizes scale, distributed systems, and clean abstractions:

```
COMMON GOOGLE DESIGN QUESTIONS:
1. Design Google Search
2. Design YouTube/Video Streaming
3. Design Google Maps
4. Design Google Drive
5. Design Gmail

WHAT GOOGLE LOOKS FOR:
┌─────────────────────────────────────────────────────────────────┐
│ Scale Awareness                                                 │
│ - Billions of users                                             │
│ - Petabytes of data                                             │
│ - Global distribution                                           │
├─────────────────────────────────────────────────────────────────┤
│ Clean Abstractions                                              │
│ - Well-defined APIs                                             │
│ - Clear service boundaries                                      │
│ - Interface-based design                                        │
├─────────────────────────────────────────────────────────────────┤
│ Distributed Systems Knowledge                                   │
│ - Consensus (Paxos, Raft)                                       │
│ - Replication strategies                                        │
│ - Partition tolerance                                           │
├─────────────────────────────────────────────────────────────────┤
│ Cost Efficiency                                                 │
│ - Compute vs storage trade-offs                                 │
│ - Caching strategy ROI                                          │
│ - Cold vs hot data tiering                                      │
└─────────────────────────────────────────────────────────────────┘

GOOGLE DESIGN TEMPLATE:

1. Requirements Gathering (5 min)
   - Functional requirements
   - Non-functional: scale, latency, availability

2. High-Level Design (10 min)
   - Major components
   - Data flow

3. Deep Dive (20 min)
   - Pick 1-2 components to detail
   - Discuss algorithms, data structures
   - Handle edge cases

4. Scale & Reliability (10 min)
   - How to scale each component
   - Failure modes and recovery
```

**Example: Google Maps Design Framework**

```
REQUIREMENTS:
- 1B daily active users
- Real-time traffic updates
- Turn-by-turn navigation
- Search for places
- Street view integration

HIGH-LEVEL ARCHITECTURE:
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────►│  API Layer  │────►│  Services   │
│  (Mobile)   │     │   (gRPC)    │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
        ┌──────────────┬───────────────┬──────┴──────┐
        ▼              ▼               ▼             ▼
  ┌──────────┐  ┌──────────┐   ┌──────────┐  ┌──────────┐
  │ Routing  │  │ Traffic  │   │  Search  │  │  Tiles   │
  │ Service  │  │ Service  │   │ Service  │  │ Service  │
  └──────────┘  └──────────┘   └──────────┘  └──────────┘

KEY ALGORITHMS:
- Routing: A* with real-time traffic weights
- Traffic: Cell tower triangulation + GPS aggregation
- Search: Inverted index with geo-filtering
- Tiles: Hierarchical quadtree with pre-rendering
```

### Meta System Design Focus

Meta emphasizes social features, real-time updates, and content delivery:

```
COMMON META DESIGN QUESTIONS:
1. Design Facebook News Feed
2. Design Instagram Stories
3. Design WhatsApp Messaging
4. Design Facebook Live
5. Design Facebook Marketplace

META EVALUATION CRITERIA:
┌─────────────────────────────────────────────────────────────────┐
│ Social Graph Handling                                           │
│ - Friend relationships at scale                                 │
│ - Efficient graph traversal                                     │
│ - Privacy boundaries                                            │
├─────────────────────────────────────────────────────────────────┤
│ Content Ranking                                                 │
│ - Engagement prediction                                         │
│ - Personalization                                               │
│ - Freshness vs relevance balance                                │
├─────────────────────────────────────────────────────────────────┤
│ Real-Time Updates                                               │
│ - Push vs pull trade-offs                                       │
│ - Fan-out strategies                                            │
│ - Eventual consistency handling                                 │
├─────────────────────────────────────────────────────────────────┤
│ Content Moderation                                              │
│ - Automated detection                                           │
│ - Human review workflow                                         │
│ - Appeal process                                                │
└─────────────────────────────────────────────────────────────────┘

EXAMPLE: NEWS FEED DESIGN

Fan-out on Write (used for normal users):
┌────────────┐
│   User A   │ posts
│   (post)   │
└─────┬──────┘
      │
      ▼
┌────────────────────────────────────────────┐
│          Fan-out Service                   │
│   Write to all followers' feeds            │
└─────────────┬──────────────────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
┌───────┐ ┌───────┐ ┌───────┐
│Feed B │ │Feed C │ │Feed D │  (followers)
└───────┘ └───────┘ └───────┘

Fan-out on Read (used for celebrities):
┌────────────┐
│ Celebrity  │ posts → Single write to post store
│   (post)   │
└────────────┘

┌────────────┐
│   User B   │ reads feed
└─────┬──────┘
      ▼
┌─────────────────────────────────────────────┐
│          Feed Assembly Service              │
│   Merge: regular posts + celebrity posts    │
└─────────────────────────────────────────────┘
```

### Amazon System Design Focus

Amazon emphasizes reliability, customer experience, and operational excellence:

```
COMMON AMAZON DESIGN QUESTIONS:
1. Design Amazon.com E-commerce
2. Design AWS S3
3. Design Amazon Prime Video
4. Design Amazon Alexa
5. Design Amazon Logistics/Delivery

AMAZON EVALUATION CRITERIA (tied to Leadership Principles):
┌─────────────────────────────────────────────────────────────────┐
│ Customer Obsession                                              │
│ - User experience during failures                               │
│ - Graceful degradation                                          │
│ - Clear error messaging                                         │
├─────────────────────────────────────────────────────────────────┤
│ Operational Excellence                                          │
│ - Monitoring & alerting                                         │
│ - Runbook documentation                                         │
│ - Automated recovery                                            │
├─────────────────────────────────────────────────────────────────┤
│ Frugality                                                       │
│ - Cost optimization                                             │
│ - Resource utilization                                          │
│ - Build vs buy decisions                                        │
├─────────────────────────────────────────────────────────────────┤
│ Dive Deep                                                       │
│ - Technical depth in chosen areas                               │
│ - Edge case handling                                            │
│ - Root cause analysis thinking                                  │
└─────────────────────────────────────────────────────────────────┘

EXAMPLE: E-COMMERCE CHECKOUT DESIGN

Idempotency for Payment Processing:
┌─────────────────────────────────────────────────────────────────┐
│                    Order Service                                │
│                                                                 │
│  1. Generate idempotency_key = hash(user_id + cart_id + time)   │
│  2. Check if key exists in processed_orders                     │
│  3. If exists: return cached result                             │
│  4. If not: process payment                                     │
│  5. Store result with idempotency_key                           │
│  6. Return result                                               │
└─────────────────────────────────────────────────────────────────┘

Saga Pattern for Distributed Transactions:
┌────────────┐    ┌────────────┐    ┌────────────┐
│  Reserve   │    │  Process   │    │  Update    │
│ Inventory  │───►│  Payment   │───►│  Shipping  │
└─────┬──────┘    └─────┬──────┘    └─────┬──────┘
      │                 │                 │
      │ Compensation:   │ Compensation:   │
      ▼                 ▼                 ▼
┌────────────┐    ┌────────────┐    ┌────────────┐
│  Release   │◄───│   Refund   │◄───│   Cancel   │
│ Inventory  │    │  Payment   │    │  Shipment  │
└────────────┘    └────────────┘    └────────────┘
```

### Netflix System Design Focus

Netflix emphasizes streaming at scale and resilience:

```
COMMON NETFLIX DESIGN QUESTIONS:
1. Design Netflix Video Streaming
2. Design Content Recommendation System
3. Design Netflix CDN (Open Connect)
4. Design A/B Testing Platform
5. Design Content Encoding Pipeline

NETFLIX EVALUATION CRITERIA:
┌─────────────────────────────────────────────────────────────────┐
│ Resilience & Chaos Engineering                                  │
│ - Design for failure                                            │
│ - Circuit breakers                                              │
│ - Graceful degradation                                          │
├─────────────────────────────────────────────────────────────────┤
│ Streaming Optimization                                          │
│ - Adaptive bitrate streaming                                    │
│ - Buffer management                                             │
│ - CDN placement strategy                                        │
├─────────────────────────────────────────────────────────────────┤
│ Personalization at Scale                                        │
│ - Recommendation algorithms                                     │
│ - A/B testing infrastructure                                    │
│ - Real-time feature updates                                     │
├─────────────────────────────────────────────────────────────────┤
│ Global Scale                                                    │
│ - Multi-region deployment                                       │
│ - Data replication strategy                                     │
│ - Regional failover                                             │
└─────────────────────────────────────────────────────────────────┘

EXAMPLE: VIDEO STREAMING DESIGN

Adaptive Bitrate Streaming:
┌─────────────────────────────────────────────────────────────────┐
│                        Video Storage                            │
│                                                                 │
│   Source Video → Transcoding Pipeline → Multiple Qualities      │
│                                                                 │
│   ┌─────────────┬─────────────┬─────────────┬─────────────┐     │
│   │   4K HDR    │   1080p     │   720p      │   360p      │     │
│   │  25 Mbps   │   8 Mbps    │   4 Mbps    │   1 Mbps     │     │
│   └─────────────┴─────────────┴─────────────┴─────────────┘     │
└─────────────────────────────────────────────────────────────────┘

Client-Side Bitrate Selection:
┌───────────────────────────────────────────────────────────────┐
│                     ABR Algorithm                             │
│                                                               │
│  1. Measure current bandwidth                                 │
│  2. Check buffer level                                        │
│  3. Select quality: quality = f(bandwidth, buffer, history)   │
│  4. Request next segment at chosen quality                    │
│                                                               │
│  Buffer Target: 30-60 seconds                                 │
│  Min Quality Switch Interval: 10 seconds                      │
└───────────────────────────────────────────────────────────────┘
```

### Stripe System Design Focus

Stripe emphasizes reliability, correctness, and developer experience:

```
COMMON STRIPE DESIGN QUESTIONS:
1. Design Payment Processing System
2. Design Subscription Billing System
3. Design Fraud Detection System
4. Design API Rate Limiting
5. Design Webhook Delivery System

STRIPE EVALUATION CRITERIA:
┌─────────────────────────────────────────────────────────────────┐
│ Financial Correctness                                           │
│ - Exactly-once payment processing                               │
│ - Audit trail completeness                                      │
│ - Reconciliation capabilities                                   │
├─────────────────────────────────────────────────────────────────┤
│ API Design Excellence                                           │
│ - RESTful best practices                                        │
│ - Idempotency support                                           │
│ - Versioning strategy                                           │
├─────────────────────────────────────────────────────────────────┤
│ Reliability at All Costs                                        │
│ - 99.999% availability target                                   │
│ - Zero data loss                                                │
│ - Graceful degradation                                          │
├─────────────────────────────────────────────────────────────────┤
│ Security by Design                                              │
│ - PCI DSS compliance                                            │
│ - Encryption everywhere                                         │
│ - Minimal data exposure                                         │
└─────────────────────────────────────────────────────────────────┘

EXAMPLE: IDEMPOTENT PAYMENT DESIGN

Idempotency Key Flow:
┌────────────────────────────────────────────────────────────────┐
│  Client Request                                                │
│  POST /v1/charges                                              │
│  Idempotency-Key: abc123                                       │
│  AmountInCents: 10000 ($100)                                   │
└─────────────────────┬──────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────────────────────┐
│  Idempotency Layer                                             │
│                                                                │
│  1. Lock on idempotency_key                                    │
│  2. Check if key exists in store                               │
│     - If YES: return stored response                           │
│     - If NO: process request                                   │
│  3. Store response with key                                    │
│  4. Release lock                                               │
└─────────────────────┬──────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  Payment Processing                                             │
│                                                                 │
│  1. Validate request                                            │
│  2. Reserve amount (auth)                                       │
│  3. Submit to payment network                                   │
│  4. Capture response                                            │
│  5. Update ledger                                               │
└─────────────────────────────────────────────────────────────────┘

Key Expiry: 24 hours (replay window)
```

---

### Junior → FAANG: Company-Specific Signals That Differentiate Candidates

Research into company-specific design expectations is one of the highest-ROI preparation activities for junior candidates. Google's emphasis on Bigtable, Spanner, and Borg as design references means that knowing these systems at the "what problem they solve and why" level lets you reference them naturally. Meta's focus on data consistency across a social graph means you should understand the trade-offs between strong and eventual consistency for social features specifically.

Practical research approach: for each company you are interviewing with, find one public system design paper or engineering blog post that describes a real system. Read it with the question "what design decisions were made and why?" rather than "how does this system work?" This gives you specific, company-relevant examples to reference during the interview.

Entry-point signal: candidates who reference company-specific systems ("I notice Stripe's engineering blog mentions they use idempotency keys for payment deduplication, that is the pattern I am applying here") demonstrate preparation and industry awareness that generic candidates do not have.

### Senior @ FAANG: Company Design Expectations as Cultural Fit Signal

For senior candidates, the company-specific design expectations are not just interview prep topics. They are indicators of the engineering culture you are evaluating. If Stripe's emphasis on correctness and financial data integrity resonates with your engineering values, that is a signal about cultural fit. If Google's emphasis on globally consistent distributed systems matches your deepest technical interests, that is relevant information for your decision.

Specifically for system design at senior level: each company has design patterns that are considered idiomatic and those that are considered anti-patterns. Google tends to trust Bigtable and Spanner for most storage needs. Proposing a novel database choice requires strong justification. Meta expects designs that account for the social graph's influence on access patterns, so a design that ignores friend relationships in a feature that touches social content will be questioned. Knowing these cultural design preferences and addressing them proactively is an L5/L6 differentiator.

ADR culture varies by company and is itself a signal: some companies have rigorous RFC or design doc review processes where every significant system change is documented, reviewed by peers and senior engineers, and stored in a searchable archive. Others have more informal processes. Asking about the design review process during the "questions for you" section of a senior interview demonstrates that you operate in that kind of disciplined engineering environment and expect to continue doing so.
