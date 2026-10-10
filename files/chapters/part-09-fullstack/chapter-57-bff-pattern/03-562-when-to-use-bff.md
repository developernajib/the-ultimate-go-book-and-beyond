## 57.2 When to Use BFF

The BFF pattern adds operational complexity. Each BFF is an independent service that must be deployed, monitored, and maintained. That cost is justified only when the differences between client needs are significant enough that a shared API would require constant compromise. The decision criteria below help you evaluate whether BFF is the right fit for your architecture.

### Use BFF When:

1. **Multiple distinct frontend applications** with different data shape requirements. A web dashboard that renders nested object graphs and a mobile app that needs flat, minimal payloads are fundamentally different consumers. Serving both through one API means the mobile app downloads fields it never uses, wasting bandwidth and battery.
2. **Mobile apps need optimized payloads.** Mobile networks have higher latency and lower throughput than wired connections. A BFF can pre-aggregate data that would otherwise require multiple round trips, reducing the number of HTTP requests from the device.
3. **Different authentication requirements per client.** An admin panel may require multi-factor authentication and session-based auth, while a public mobile app uses OAuth2 with refresh tokens. Separating these into distinct BFFs keeps the auth logic simple in each service rather than tangled in shared conditional branches.
4. **Frontend teams want autonomy over their API.** When the web team needs a new field in the dashboard response, they can add it to their BFF without coordinating with the mobile team or waiting for the platform API team's sprint cycle.
5. **Complex aggregations specific to UI views.** If a single page requires data from four or five downstream services stitched together, that aggregation logic belongs in a BFF rather than in the client or in a general-purpose API that other clients do not need.
6. **Different release cycles for different clients.** Mobile apps ship on app store schedules. web apps deploy continuously. A BFF lets each client evolve its API contract independently.

### Don't Use BFF When:

1. **Single frontend application.** If you only have a web app, a well-designed REST or GraphQL API is sufficient. The BFF layer adds deployment and monitoring overhead with no benefit.
2. **All clients need the same data shape.** If your mobile and web clients consume identical response structures, a shared API with content negotiation handles it without duplication.
3. **Team is too small to maintain multiple services.** Each BFF is a service with its own CI/CD pipeline, health checks, and on-call rotation. A team of three engineers maintaining four BFFs will spend more time on infrastructure than on product features.
4. **Simple CRUD operations without aggregation needs.** If your API is straightforward create-read-update-delete with no cross-service aggregation, BFF adds a network hop and code duplication for no gain.

### Junior -> FAANG: Applying the Decision Criteria in Practice

The "use BFF when / don't use BFF when" lists above are the framework. The tricky part is applying them when the situation is ambiguous. Here are three worked examples to build intuition.

Scenario A: an e-commerce startup with a web app and a React Native mobile app sharing 90% of the same UI patterns. Both render a product grid, a checkout flow, and an order history screen. The payloads differ slightly (mobile omits two description fields). This does not justify BFF overhead. Use a single API with optional fields and client-side filtering. The cost of running two services exceeds the benefit.

Scenario B: a streaming platform adding a TV app to its existing web and iOS products. The TV app requires a completely different home screen structure (pre-loaded rows, no search bar, D-pad-optimized navigation), a different image aspect ratio (16:9 instead of 1:1), and a different auth flow (device code, not browser OAuth). Three distinct clients with divergent contracts and different auth. BFF is justified.

Scenario C: a B2B SaaS with a customer-facing web app and an admin portal for internal support staff. The admin portal exposes PII, billing data, and internal system metrics that must never appear in the customer-facing API. A separate admin BFF provides a clean security boundary enforced at the code level, not just at the ACL level. BFF is justified on security grounds alone.

A first-job habit: before proposing BFF, enumerate the concrete differences between clients on a whiteboard. If you cannot fill more than three lines, you probably do not need BFF yet.

### Senior @ FAANG: Threshold Criteria and ADR Governance

At senior level, "when to use BFF" is a decision that should be captured in an ADR with explicit threshold criteria so that future engineers can evaluate new client surfaces consistently without reopening the whole debate each time.

A well-formed threshold definition might read: "A new BFF is introduced when a client surface meets at least two of the following criteria: (1) its response payload shape diverges from existing clients by more than 30% of fields, (2) it requires a distinct authentication and authorization flow, or (3) it is owned by a team with an independent release cadence. (4) it has payload size or latency constraints that require different caching or aggregation strategies than existing BFFs."

This kind of explicit criteria prevents two failure modes. The first is BFF proliferation, where every new screen or feature gets its own BFF because "it's different enough." The second is BFF avoidance, where client teams share a BFF that should have been split, causing the shared BFF to accumulate all the problems of the general-purpose API it was meant to replace.

The "team is too small" criterion deserves more nuance than a simple cutoff. The real question is whether the team can sustain the operational burden: on-call rotation for the BFF, monitoring and alerting, CI/CD pipeline maintenance, and security patching. A team of four engineers can realistically maintain one BFF alongside their client. Two BFFs becomes a stretch. Three is almost always too many. Staffing decisions and BFF proliferation decisions must be made jointly, not in isolation.

At L7, the "when to use BFF" question becomes "when should we consolidate BFFs." As product lines mature and clients converge, two BFFs that were distinct at launch may drift toward serving the same data shapes. Consolidation reduces operational overhead but risks recreating the general-purpose API problem. The bar-raiser question is: can you identify the signals that indicate consolidation is appropriate versus the signals that indicate the clients are genuinely converging and BFF separation is no longer paying for itself?

---
