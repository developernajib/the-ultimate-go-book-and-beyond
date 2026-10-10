## 52B.12 Company Case Studies

### Uber: Trip Domain

*Primary source: Uber Engineering Blog, "Domain-Oriented Microservice Architecture at Uber" (2020) and "Designing Uber's Next-Gen Trip Execution Engine" (2021).*

Uber's core domain is the trip. At its heart, a Trip is an aggregate: it has a `TripID`, a `RiderID`, a `DriverID`, an `Origin` and `Destination` (value objects), a `Fare` (value object: price + surge multiplier), and a status lifecycle: `Requested → Accepted → InProgress → Completed / Canceled`.

Uber uses bounded contexts to separate their platform's concerns:

- **Dispatch Context**: Matching riders to drivers. The `Driver` in this context is a candidate with location and availability - very different from the `Driver` in the earnings context.
- **Fare Context**: Calculating trip price. Surge pricing algorithms, promo codes, and split fare are all in this context.
- **Earnings Context**: Tracking driver payments. A driver here has a balance, payout history, and tax documents.
- **Safety Context**: Flagging trips for review, incident management. An entirely separate model.

The ubiquitous language within the Dispatch Context is precise: "surge multiplier", "eta", "acceptance rate", "dispatch radius". These terms appear consistently in code, in conversations with domain experts (the operations team), and in documentation.

Key DDD lesson from Uber: the **consistency boundary** of the Trip aggregate is carefully chosen. Uber does not put the driver's overall earnings inside the Trip aggregate - that would create a massive, hard-to-lock aggregate. Instead, when a trip completes, a `TripCompleted` domain event is published, and the Earnings Context handles updating driver earnings separately.

### Netflix: Content and Streaming Contexts

*Primary source: Netflix TechBlog, "Evolution of the Netflix Content Platform Architecture" and "Ready for changes with Hexagonal Architecture".*

Netflix separates their platform into distinct bounded contexts with their own models:

- **Content Catalog Context**: A `Title` is a movie or show with metadata: director, cast, genres, synopsis, ratings. The model is about discoverability.
- **Streaming Context**: A `Title` becomes a `Playback Session` with codec information, bitrate ladders, CDN routing, and DRM license management. The `Title` entity here is stripped down to just what streaming needs.
- **Recommendation Context**: A `Title` is a node in a graph with similarity scores, viewing patterns, and collaborative filtering vectors. The domain experts here are data scientists, and the language is statistical.

Netflix uses an **Open Host Service** pattern extensively - their internal teams can consume a well-documented event stream from the Content Catalog Context to keep their own read models up to date.

Key DDD lesson: Netflix does not have one "Title" entity with 200 fields. They have several `Title` representations, each optimized for its bounded context's needs.

### Shopify: Commerce Domain

*Primary source: Shopify Engineering Blog, "Deconstructing the Monolith: Designing a Modular Monolith with Domain-Driven Design" (2021).*

Shopify structures their platform around the **merchant** as the central entity in most of their core contexts. Their commerce domain is divided into:

- **Storefront Context**: Products, collections, themes. Merchants and their customers interact here.
- **Orders Context**: The full order lifecycle from placement through fulfillment. Shopify's order aggregate is famously complex - it handles multiple currencies, tax jurisdictions, shipping zones, and hundreds of business rules.
- **Payments Context**: Shopify Payments, third-party gateways, fraud analysis. Uses an ACL for each payment gateway.
- **Fulfillment Context**: Warehouse locations, inventory tracking, shipping carriers.
- **Billing Context**: Shopify's own billing of merchants - subscription plans, usage fees, app charges.

Key DDD lesson: Shopify's `Order` aggregate has over 40 state transition rules, making it one of their most complex domain objects. They test the domain logic independently of infrastructure, the Order aggregate test suite runs in milliseconds with no database or HTTP dependencies.

### Junior → FAANG: What to Take from Case Studies Into Your Own Work

Case studies from companies like Uber, Netflix, and Shopify are useful for three specific interview purposes: demonstrating that DDD works at scale (not just as a textbook exercise), providing concrete examples of aggregate boundary decisions under real business constraints, and illustrating the cost of getting context boundaries wrong.

The Uber dispatch/earnings split is the most transferable insight: even when two concepts are closely related (a trip and a driver's earnings), keeping them in separate aggregates with an event-driven integration is the correct call when they have different consistency and throughput requirements. In an interview, use this to justify small aggregate boundaries: "Uber keeps Trip and DriverEarnings separate because updating earnings can be eventually consistent with the trip completion. Making them one aggregate would serialize all writes on the same driver."

The Netflix Title case is useful for explaining why the same concept needs different models in different contexts: "Netflix doesn't have one Title entity with 200 fields. In the Streaming context, Title is a Playback Session. In the Recommendation context, it's a graph node. Forcing one model would produce a god object that serves no context well."

When you describe these examples in interviews, be specific about the pattern name, the boundary justification, and the trade-off accepted. Generic statements like "they broke it into microservices" do not signal DDD knowledge.

### Senior @ FAANG: Extracting Governance Lessons from How Large Systems Evolved

The real senior-level insight from these case studies is not what the final architecture looks like but how it evolved and what governance mechanisms prevented it from becoming a distributed big ball of mud.

**Uber's consistency model as an architectural pattern.** The decision to use domain events to connect the Trip and Earnings aggregates is a saga pattern choice: Uber accepted eventual consistency for driver earnings in exchange for lower lock contention on the Trip aggregate under their extreme write throughput. This is a conscious trade-off documented in architectural decision records. The alternative (one aggregate, one transaction) fails under trip volume because locking a driver-level aggregate for every trip completion serializes all concurrent trips for that driver. The lesson for your own systems: before you accept eventual consistency between two aggregates, document the consistency lag SLO (earnings appear within N seconds of trip completion), the monitoring plan (alert if earnings updates are delayed by more than M seconds), and the compensating mechanism if the event is lost or the handler fails.

**Netflix's Open Host Service as a platform engineering pattern.** Netflix's approach to the Content Catalog as an Open Host Service is a platform engineering decision: one team publishes a stable, versioned event stream, and dozens of other teams build read models from it without coupling to the catalog's internal model. The governance mechanism is schema ownership: the Catalog team owns the event schema, versioned in a schema registry, and downstream teams cannot modify it. Adding a new field requires a Catalog team PR with backward compatibility guaranteed. Removing a field requires a deprecation notice and a migration window. This is the same governance model used for public APIs, applied to internal event streams. Senior engineers at platform-scale companies establish and enforce this governance for every event stream that crosses a team boundary.

**Shopify's aggregate complexity as a staffing signal.** The fact that Shopify's Order aggregate has over 40 state transition rules is not a DDD failure. It is an accurate reflection of the domain's complexity: commerce is genuinely that complex, with tax jurisdictions, currency conversions, partial fulfillment, return windows, dispute resolution, and regional regulations. The DDD lesson is that complexity that is hidden in scattered service methods is still complexity, just invisible. Making it explicit in the aggregate's state machine, tested exhaustively, is strictly better than hiding it. The staffing signal: Shopify assigns their most senior engineers to the Orders domain not because it is technically glamorous but because it is the Core Domain where bugs have the highest business impact. That resource allocation is itself a DDD principle in action.

**What FAANG bar-raisers look for in case study discussions.** At the L6 level, a bar-raiser who asks "tell me about a large-scale DDD system you know of" is not looking for a Wikipedia summary. They want to see that you can identify the Core Domain, name the bounded contexts and their integration patterns, identify the consistency trade-offs that were made and why, and connect the architecture to the team structure that maintains it. Candidates who can do this for a well-known system and then draw parallels to a system they built personally are demonstrating L6-level architectural thinking.

---
