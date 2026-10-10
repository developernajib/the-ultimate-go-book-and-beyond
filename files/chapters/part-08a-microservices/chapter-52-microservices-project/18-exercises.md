## Exercises

1. **Add Elasticsearch search.** Replace the PostgreSQL `ILIKE` search in the product service with an Elasticsearch-backed search that supports faceted filtering by category, brand, and price range. Use the transactional outbox pattern to keep the index synchronized with the products table.

2. **Build a shipping service.** Create a new service that accepts `order.paid` events, generates a tracking number, and publishes `order.shipped` and `order.delivered` events. Integrate with the order service so that order status reflects shipment state.

3. **Implement a review service.** Build a service where authenticated users can submit ratings and text reviews for products they have purchased. Aggregate the average rating and expose it through a gRPC endpoint that the product service can query.

4. **Add a recommendation engine.** Create a service that records product views and purchases, then uses collaborative filtering (users who bought X also bought Y) to return personalized product suggestions. Consume `order.paid` events to update purchase history.

5. **Build an admin dashboard service.** Expose HTTP endpoints for listing all orders (with filtering by status and date range), updating product inventory, and disabling user accounts. Protect all endpoints with a role-based check that requires the `admin` JWT role.

6. **Integrate Prometheus and Jaeger.** Add Prometheus counters and histograms to every service (requests total, request duration, error rate). Add OpenTelemetry tracing with Jaeger as the backend. Verify that a single order-creation request produces a trace spanning the order, inventory, and payment services.

7. **Deploy to Kubernetes.** Write Kubernetes Deployment and Service manifests for each microservice. Use ConfigMaps for environment variables, Secrets for database credentials, and a readiness probe on each service's `/health` endpoint. Verify that `kubectl apply` brings up the full platform.

8. **Write end-to-end integration tests.** Use `testcontainers-go` to start PostgreSQL, Redis, and Kafka in Docker. Boot all services in-process, then execute the full order flow: register a user, add products to the cart, create an order, process payment, and verify the order status transitions through each saga step.

### Junior → FAANG: How to Choose and Sequence These Exercises

Eight exercises is a semester of work if you approach them sequentially. Approach them strategically: pick the two or three that address your weakest areas and do those thoroughly rather than all eight superficially.

**Exercises 1 and 8 are the highest FAANG leverage.** OpenTelemetry tracing (exercise 1) and testcontainers-based integration tests (exercise 8) are skills that FAANG hiring managers explicitly value and that most candidates underinvest in. A candidate who can walk through how they added distributed tracing and what they learned from the traces, or describe an integration test strategy that spins up real infrastructure, signals production-ready thinking.

**Exercise 3 (review service) is a good bounded context design drill.** Designing a review service forces you to answer: who owns a review (user service? product service? a new review service?), what invariants must hold (a user can only review a product they purchased, one review per product per user), and how do you enforce those invariants without a cross-service transaction? This is a well-scoped system design problem that you can practice end-to-end in a few hours.

**Exercise 7 (Kubernetes) is the infrastructure maturity exercise.** If you have never written Kubernetes manifests, this exercise closes a gap that appears in senior-level interviews. The minimum viable version: a Deployment, a Service, a ConfigMap, a Secret reference, and a readiness probe for one service. Repeat for a second service. The pattern is the same for all eight.

**For interview preparation, do exercise 5 (admin dashboard) under time pressure.** Give yourself 90 minutes to design, implement, and test the admin endpoint for listing orders with role-based access control. This is the kind of scope-limited engineering task that appears in FAANG coding interviews. The time pressure reveals where your gaps are faster than any tutorial.

### Senior @ FAANG: Using These Exercises as Staff-Level Design Documents

Each exercise is also a design document waiting to be written. For exercises 2 through 7, practice writing the ADR before writing the code. The ADR should answer: what problem does this service solve, what are the alternative approaches, what are the data ownership boundaries, what events does it produce and consume, and what failure modes require handling?

**Exercise 4 (recommendation engine) is a machine learning boundary problem.** A collaborative filtering recommendation engine requires: a feature store for user-item interaction data, a training pipeline, a model serving infrastructure, and a fallback for cold-start (new users with no history). The question is where the service boundary sits. The recommendation service owns the ML model serving. The feature store is a separate platform concern. The training pipeline is a data engineering concern. Drawing these boundaries, and justifying why they are drawn where they are, is the kind of cross-functional architectural thinking that appears in L6/L7 design reviews.

**Exercise 6 (Prometheus and Jaeger) is a platform observability exercise.** The staff-level version of this exercise is not "add metrics to each service" but "define the observability contract for the platform: which metrics are mandatory for every service, what naming convention is required, what cardinality limits apply to labels, and how are dashboards provisioned automatically for new services?" Write this policy as a one-page document. The policy determines whether the observability exercise is a one-time implementation or a scalable platform pattern.

**Exercise 8 (integration tests) is the highest organizational leverage.** A testcontainers-based integration test suite that exercises the full order flow is a platform investment: it catches cross-service regressions before they reach staging. At FAANG, this test suite is owned by the platform team, runs in CI on every pull request across all services, and has an SLA for test execution time (under 10 minutes for the critical path). The staff-level contribution is designing the test suite as a shared platform artifact, with documentation for how to add new scenarios and a review process for test-suite changes.

---
