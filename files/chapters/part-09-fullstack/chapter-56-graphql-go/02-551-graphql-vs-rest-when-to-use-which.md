## 56.1 GraphQL vs REST: When to Use Which

GraphQL and REST solve different problems. Choosing the wrong one adds complexity without payoff.

### REST Excels When:

REST and GraphQL solve different API design problems, and choosing incorrectly leads to either under-fetching pain for complex UIs or unnecessary complexity for simple CRUD surfaces. REST shines when resource boundaries are stable, response shapes are predictable, and HTTP caching is a priority. The comparison below lists the concrete conditions under which REST is the more maintainable choice and is not merely a default for teams unfamiliar with GraphQL.

```
┌──────────────────────────────────────────────────────────────┐
│                    USE REST WHEN                             │
├──────────────────────────────────────────────────────────────┤
│  • Simple CRUD operations                                    │
│  • Resources map cleanly to HTTP verbs                       │
│  • Caching is critical (HTTP caching works out of the box)   │
│  • You need maximum simplicity                               │
│  • Team is more familiar with REST                           │
│  • Public API with many different consumers                  │
│  • File uploads are primary use case                         │
└──────────────────────────────────────────────────────────────┘
```

### GraphQL Excels When:

GraphQL's declarative query language earns its complexity when clients have diverse, overlapping data needs that would require many REST endpoints or multiple round trips to satisfy. Mobile clients with bandwidth constraints, dashboard UIs that assemble data from multiple domains, and rapidly evolving frontend requirements all benefit from the flexibility of a single typed schema. The points below identify the specific signal patterns that should push a team toward GraphQL over REST.

```
┌──────────────────────────────────────────────────────────────┐
│                  USE GRAPHQL WHEN                            │
├──────────────────────────────────────────────────────────────┤
│  • Multiple clients need different data shapes               │
│  • Mobile apps need to minimize data transfer                │
│  • Frontend teams want to iterate independently              │
│  • Relationships between entities are complex                │
│  • You're aggregating multiple backend services              │
│  • Real-time subscriptions are needed                        │
│  • You want strongly-typed API contracts                     │
└──────────────────────────────────────────────────────────────┘
```

### The Overfetching/Underfetching Problem

REST's fixed response shapes force a choice between bandwidth-wasting fat responses that include fields most clients ignore, and multiple round trips to fetch related resources the initial response omitted. Both problems compound at scale: overfetching strains mobile networks, and underfetching adds latency waterfalls that are difficult to eliminate without custom endpoints. The side-by-side example below quantifies the savings a GraphQL query achieves for a typical product detail page compared to the equivalent REST calls.

```
REST Approach - Multiple Round Trips:
┌──────────┐     GET /users/123            ┌──────────┐
│  Client  │ ─────────────────────────────►│  Server  │
│          │◄───────────────────────────── │          │
│          │     GET /users/123/posts      │          │
│          │ ─────────────────────────────►│          │
│          │◄───────────────────────────── │          │
│          │     GET /posts/456/comments   │          │
│          │ ─────────────────────────────►│          │
│          │◄───────────────────────────── │          │
└──────────┘     3 round trips             └──────────┘

GraphQL Approach - Single Request:
┌──────────┐     POST /graphql             ┌──────────┐
│  Client  │ ─────────────────────────────►│  Server  │
│          │     {                         │          │
│          │       user(id: 123) {         │          │
│          │         name                  │          │
│          │         posts {               │          │
│          │           title               │          │
│          │           comments { text }   │          │
│          │         }                     │          │
│          │       }                       │          │
│          │     }                         │          │
│          │◄───────────────────────────── │          │
└──────────┘     1 round trip              └──────────┘
```

### Junior -> FAANG: Building a Decision Instinct

The REST vs GraphQL decision looks binary on paper but is rarely clean in practice. Develop an instinct for the signals that push you one way or the other, and be able to articulate them in a design review.

REST is almost always the right answer when: you are building a public API for third-party developers (REST is universally understood and does not require a GraphQL client library), you need HTTP caching at the CDN layer (GET requests with stable URLs cache trivially, GraphQL POST requests do not), or your API surface is a simple set of resources with stable shapes.

GraphQL earns its complexity when: you have three or more client types with different data requirements (web, mobile, admin), your product's frontend team is iterating faster than your backend team can create new endpoints, or you are aggregating data from multiple internal services into a single response.

The most common first-job mistake is choosing GraphQL because it seems modern rather than because it solves a specific problem. Using GraphQL for a simple CRUD admin panel with one client adds schema tooling, a code generation step, complexity limits to configure, and a dataloader layer, for zero additional capability over a REST API.

Interview framing: when asked "REST or GraphQL," always anchor your answer in the concrete characteristics of the system being designed. "It depends" is not an answer. "It depends on whether we have multiple clients with divergent data shapes, and here is how I would evaluate that" is.

### Senior @ FAANG: The ADR for Protocol Selection

At staff level, the REST vs GraphQL decision is not made per endpoint. It is an architectural decision with a documented rationale (an ADR) that applies to a domain or platform. The ADR should capture: what problem the current protocol is failing to solve (the forcing function), what alternatives were evaluated, what the risks of the chosen approach are, and what the rollback plan is if those risks materialize.

Mature organizations do not wholesale replace REST with GraphQL. They run both. REST handles file uploads, webhooks, health checks, and public partner APIs where REST familiarity reduces integration friction. GraphQL handles the product API that internal frontend teams use, where schema introspection and type-safe client generation (via `graphql-codegen` or `genqlient`) eliminate an entire class of type errors.

The bar-raiser signal is knowing the caching limitation precisely: GraphQL queries sent as POST are not cacheable by CDNs without automatic persisted queries (APQ). APQ works by having the client send a GET request with the query hash and variables as URL parameters. The CDN caches the GET response. If the hash is unknown to the server, the client retries with the full query as a POST, and the server stores the mapping. This gives GraphQL CDN cacheability for read-heavy operations without sacrificing query flexibility. Understanding this protocol detail signals that you have thought about GraphQL in production, not just in development.

Another senior concern is the operational cost difference. REST APIs have well-understood monitoring patterns: instrument by route and HTTP method, and you have request volume, error rate, and latency per endpoint. GraphQL collapses everything onto one endpoint. You must instrument at the operation level (query, mutation, subscription by operation name) and at the field level to recover equivalent observability. Teams that adopt GraphQL without updating their monitoring infrastructure often discover performance regressions weeks later when a slow resolver hides behind an operation-level p99 that looks acceptable.

---
