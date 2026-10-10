## 47.9 Interview Questions

### Question 1: How do you decide service boundaries?

**Answer:**

Service boundaries should align with business domains using Domain-Driven Design:

```go
// Framework for determining service boundaries
type BoundaryAnalysis struct {
    // 1. Business Capability Analysis
    Capabilities []BusinessCapability

    // 2. Domain Model Analysis
    Aggregates []Aggregate

    // 3. Team Structure (Conway's Law)
    Teams []Team

    // 4. Change Patterns
    ChangeFrequency map[string]float64
}

// Key questions for each potential boundary:
func AnalyzeProposedBoundary(name string) BoundaryScore {
    return BoundaryScore{
        // Can it be deployed independently?
        IndependentDeployability: evaluateDeployability(name),

        // Does it have a single business owner?
        ClearOwnership: evaluateOwnership(name),

        // Is the data it owns well-defined?
        DataOwnership: evaluateDataBoundary(name),

        // Do changes to it rarely require changes to other services?
        ChangeIndependence: evaluateChangePatterns(name),

        // Can a single team own it?
        TeamSize: estimateTeamSize(name), // Should be 5-9 people
    }
}

// Example: E-commerce domain analysis
/*
Bounded Contexts Identified:
1. User Management (Authentication, Profiles)
2. Product Catalog (Products, Categories, Search)
3. Order Management (Orders, Order Lifecycle)
4. Payment Processing (Transactions, Refunds)
5. Inventory (Stock, Warehouses, Reservations)
6. Shipping (Carriers, Tracking, Delivery)
7. Notifications (Email, SMS, Push)

Anti-pattern to avoid:
- User Service that handles auth, profiles, preferences, and social features
- This is too large - split into Identity Service and User Profile Service
*/
```

**What FAANG expects:** A senior candidate does not rush to decompose. The strong answer opens with "start with a modular monolith unless you have a concrete forcing function" and names the forcing functions explicitly - independent deploy cadence, independent scaling profile (e.g., search QPS is 50x the rest of the app), team-ownership boundary (a team needs to ship without coordinating), compliance isolation (PCI/HIPAA), or polyglot requirements. They reach for DDD vocabulary (bounded context, aggregate, ubiquitous language, context map) and tie each proposed service to exactly one aggregate root with sole write authority over its data. They cite Conway's Law. They explicitly disqualify bad heuristics ("lines of code," "number of endpoints"). Bonus points: they mention event storming as the discovery technique, and they name the service-per-team / two-pizza-team rule from Amazon.

**Follow-ups the interviewer will push on:**
1. *"You have a `User` service and an `Order` service. The Order list page needs to show each customer's name. Walk me through three ways to do this and the tradeoffs."* (Expected: (a) sync API call per order - chatty, rejected. (b) batch `GetUserSummaries`, still sync, acceptable for small lists. (c) subscribe to `user.updated` events and maintain a denormalized `customer_name` column on the order - eventually consistent, best for scale. Candidate should discuss staleness windows and when each is appropriate.)
2. *"When would you merge two microservices back together?"* (Expected: they chat every request, they always deploy together, they share data ownership, or team reorganization put them under one team - all valid reasons to consolidate. Strong candidates cite the Shopify/DHH "modular monolith" reversal as industry precedent.)
3. *"Your teammate wants to split the User service into `UserAuth` and `UserProfile`. What questions do you ask before agreeing?"* (Expected: Do they have different scaling needs? Different teams? Different compliance scopes? Or is this decomposition-for-its-own-sake?)

### Question 2: When should you use synchronous vs asynchronous communication?

**Answer:**

The choice between synchronous and asynchronous communication depends on whether the caller needs an immediate response and whether the operation can tolerate eventual consistency. Synchronous calls (REST or gRPC) suit queries and short request-response interactions where the user is waiting. Asynchronous events suit workflows that span multiple services, long-running operations, or fan-out scenarios where several consumers react to the same event. The framework below encodes these heuristics, followed by a practical example showing sync validation (the user needs immediate feedback) paired with async order processing (downstream services react independently).

```go
// Decision framework for communication patterns
type CommunicationDecision struct {
    Pattern     string
    UseWhen     []string
    AvoidWhen   []string
}

var patterns = []CommunicationDecision{
    {
        Pattern: "Synchronous (REST/gRPC)",
        UseWhen: []string{
            "Response is needed immediately for user experience",
            "Simple request-response with fast latency requirement",
            "Query operations (reads)",
            "Short operation chains (max 2-3 services)",
        },
        AvoidWhen: []string{
            "Long-running operations",
            "When caller doesn't need immediate response",
            "Fan-out to multiple services",
            "Downstream service has high latency or is unreliable",
        },
    },
    {
        Pattern: "Asynchronous (Events/Messages)",
        UseWhen: []string{
            "Eventual consistency is acceptable",
            "Multiple services need to react to same event",
            "Long-running or complex workflows",
            "Services need to be decoupled",
            "Handling high-volume writes",
        },
        AvoidWhen: []string{
            "Immediate response required",
            "Simple request-response patterns",
            "Strong consistency requirements",
            "Debugging and tracing simplicity is priority",
        },
    },
}

// Practical example: Order processing
type OrderWorkflow struct{}

// Sync for immediate validation
func (w *OrderWorkflow) ValidateOrder(ctx context.Context, req *CreateOrderRequest) error {
    // Sync: User needs immediate feedback
    if err := w.validator.Validate(req); err != nil {
        return err // Return error immediately
    }
    return nil
}

// Async for processing after acceptance
func (w *OrderWorkflow) ProcessOrder(ctx context.Context, order *Order) error {
    // Async: Background processing via events
    events := []Event{
        {Type: "order.created", Data: order},
    }

    // These services react asynchronously:
    // - Inventory reserves stock
    // - Payment processes charge
    // - Email sends confirmation
    // - Analytics records metrics

    return w.publisher.PublishBatch(ctx, events)
}
```

**What FAANG expects:** The candidate frames the decision around **user-perceived latency and failure coupling**, not protocol preference. Strong answers open: "sync couples availability and latency across the call graph. async decouples them but requires idempotent consumers and a dead-letter strategy." They default to async for cross-service workflows and to sync only for user-waiting reads or short 2-3-service fan-outs. They name specific technologies with tradeoffs: gRPC > REST for internal calls (HTTP/2, protobuf, streaming, generated clients). Kafka for ordered/partitioned event logs, NATS JetStream for lighter-weight, SQS for cloud-native simplicity. They raise the **transactional outbox** unprompted.

**Follow-ups:**
1. *"Kafka gives at-least-once. How do you prevent a duplicate payment charge when a consumer re-processes a `payment.requested` event?"* (Expected: idempotency key on the payment API plus a dedupe table keyed on `event.ID`, or Kafka's `enable.idempotence=true` + transactions for exactly-once within the broker, with application-level dedupe for end-to-end.)
2. *"Your producer writes to Postgres then publishes to Kafka. The pod crashes between the two writes. What happens and how do you fix it?"* (Expected: transactional outbox pattern - insert event into an `outbox` table in the same DB transaction, then a separate relay (Debezium, or a poller) publishes to Kafka. Candidate should know this pattern by name.)
3. *"When would you choose NATS JetStream over Kafka in 2026?"* (Expected: lower latency, simpler ops, smaller fleet, request-reply patterns, ephemeral or at-most-once semantics, edge deployments. Kafka still wins for ordered high-throughput event logs with long retention.)

### Question 3: How do you handle distributed transactions?

**Answer:**

Traditional ACID transactions cannot span multiple databases owned by different services. The saga pattern replaces a single distributed transaction with a sequence of local transactions, each paired with a compensating action that undoes its effect if a later step fails. Choreography distributes the coordination: each service listens for events and publishes its own, forming an implicit workflow. Orchestration centralizes the coordination in a saga object that executes steps in order and runs compensations in reverse on failure. Choreography works well for simple, linear flows. Orchestration is better when the workflow has branching logic or many steps.

```go
// Option 1: Saga pattern with choreography
type ChoreographedSaga struct {
    eventBus EventBus
}

// Each service publishes events that trigger next step
func (s *InventoryService) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) {
    reserved, err := s.reserveStock(ctx, event.Items)
    if err != nil {
        s.eventBus.Publish(ctx, "inventory.reservation.failed", ReservationFailedEvent{
            OrderID: event.OrderID,
            Reason:  err.Error(),
        })
        return
    }

    s.eventBus.Publish(ctx, "inventory.reserved", InventoryReservedEvent{
        OrderID:       event.OrderID,
        ReservationID: reserved.ID,
    })
}

// Option 2: Saga pattern with orchestration
type OrchestratedSaga struct {
    steps []SagaStep
}

type SagaStep struct {
    Name        string
    Execute     func(ctx context.Context, state *SagaState) error
    Compensate  func(ctx context.Context, state *SagaState) error
}

func (s *OrchestratedSaga) Run(ctx context.Context, state *SagaState) error {
    completedSteps := []int{}

    for i, step := range s.steps {
        if err := step.Execute(ctx, state); err != nil {
            // Compensate in reverse order
            for j := len(completedSteps) - 1; j >= 0; j-- {
                stepIdx := completedSteps[j]
                if compErr := s.steps[stepIdx].Compensate(ctx, state); compErr != nil {
                    // Log compensation failure for manual intervention
                    slog.Error("compensation failed",
                        "step", s.steps[stepIdx].Name,
                        "error", compErr)
                }
            }
            return fmt.Errorf("step %s failed: %w", step.Name, err)
        }
        completedSteps = append(completedSteps, i)
    }

    return nil
}

// Example saga for order processing
var orderSaga = &OrchestratedSaga{
    steps: []SagaStep{
        {
            Name:       "reserve_inventory",
            Execute:    reserveInventory,
            Compensate: releaseInventory,
        },
        {
            Name:       "process_payment",
            Execute:    processPayment,
            Compensate: refundPayment,
        },
        {
            Name:       "schedule_shipping",
            Execute:    scheduleShipping,
            Compensate: cancelShipping,
        },
    },
}
```

**What FAANG expects:** Strong candidates immediately reject two-phase commit across services ("it doesn't scale, it blocks, and XA support is inconsistent") and pivot to **sagas with compensating transactions**. They explain choreography vs orchestration with concrete tradeoffs: choreography for simple linear flows and loose coupling, orchestration when workflows branch or exceed 4-5 steps and you need an auditable state machine. They raise **idempotency of every step and every compensation** unprompted - compensations must tolerate being retried after a partial failure. Bonus: they name Temporal, Cadence, or AWS Step Functions as production-grade orchestration engines rather than hand-rolling.

**Follow-ups:**
1. *"In your saga, the payment step succeeds but the confirmation event is lost in the network. What happens on retry?"* (Expected: the payment service must be idempotent - keyed on saga ID or idempotency key - so the second attempt is a no-op that returns the same payment ID. This is why compensations and steps alike need keys, not only a blind "retry.")
2. *"What if a compensation itself fails permanently?"* (Expected: dead-letter / manual intervention queue, operator runbook, alerting. Real systems have a small number of sagas that genuinely require human resolution. pretending otherwise is naive.)
3. *"Would you use Temporal or hand-roll this in Go?"* (Expected: hand-roll for 3-step linear sagas. Temporal/Cadence when you have branching, long-running waits of minutes-to-days, versioning concerns, or need durable history for compliance. Strong candidates know Temporal's Go SDK gives you deterministic workflow code with automatic state persistence.)

### Question 4: How do you implement service discovery?

**Answer:**

Service discovery lets clients find healthy service instances at runtime without hard-coding addresses. In client-side discovery, the calling service queries a registry (Consul, Eureka) and selects an instance using a local load-balancing strategy. The implementation below caches the instance list locally and uses Consul's blocking queries (long-polling) to receive updates only when instances change, avoiding the overhead of frequent polling. A load-balanced gRPC client ties discovery to connection management, lazily creating and caching `grpc.ClientConn` objects per instance address.

```go
// Client-side discovery implementation
type ServiceDiscovery interface {
    Register(ctx context.Context, service ServiceInstance) error
    Deregister(ctx context.Context, instanceID string) error
    GetInstances(serviceName string) ([]ServiceInstance, error)
    Watch(ctx context.Context, serviceName string, callback func([]ServiceInstance))
}

// Consul-based implementation
type ConsulDiscovery struct {
    client *api.Client
    cache  *sync.Map // Local cache for performance
}

func (d *ConsulDiscovery) GetInstances(serviceName string) ([]ServiceInstance, error) {
    // Check local cache first
    if cached, ok := d.cache.Load(serviceName); ok {
        return cached.([]ServiceInstance), nil
    }

    // Query Consul for healthy instances only
    services, _, err := d.client.Health().Service(serviceName, "", true, nil)
    if err != nil {
        return nil, err
    }

    instances := make([]ServiceInstance, 0, len(services))
    for _, svc := range services {
        instances = append(instances, ServiceInstance{
            ID:      svc.Service.ID,
            Address: svc.Service.Address,
            Port:    svc.Service.Port,
            Tags:    svc.Service.Tags,
            Meta:    svc.Service.Meta,
        })
    }

    d.cache.Store(serviceName, instances)
    return instances, nil
}

// Watch for changes with long-polling
func (d *ConsulDiscovery) Watch(ctx context.Context, serviceName string, callback func([]ServiceInstance)) {
    var lastIndex uint64

    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        services, meta, err := d.client.Health().Service(
            serviceName, "", true,
            &api.QueryOptions{
                WaitIndex: lastIndex,
                WaitTime:  5 * time.Minute,
            },
        )

        if err != nil {
            time.Sleep(5 * time.Second)
            continue
        }

        if meta.LastIndex != lastIndex {
            lastIndex = meta.LastIndex
            instances := convertToInstances(services)
            d.cache.Store(serviceName, instances)
            callback(instances)
        }
    }
}

// Load balancer using discovered instances
type LoadBalancedClient struct {
    discovery ServiceDiscovery
    lb        LoadBalancer
    clients   sync.Map // address -> *grpc.ClientConn
}

func (c *LoadBalancedClient) Call(ctx context.Context, serviceName string, method string, req, resp any) error {
    instances, err := c.discovery.GetInstances(serviceName)
    if err != nil {
        return fmt.Errorf("discovery: %w", err)
    }

    if len(instances) == 0 {
        return ErrNoInstances
    }

    // Select instance using load balancer
    instance := c.lb.Select(instances)

    // Get or create connection
    conn, err := c.getConnection(instance)
    if err != nil {
        return fmt.Errorf("connection: %w", err)
    }

    // Make the call
    return conn.Invoke(ctx, method, req, resp)
}
```

**What FAANG expects:** The 2026 strong answer opens with "what runtime are we on?" and routes the decision accordingly: **Kubernetes Services + DNS + readiness probes** for in-cluster discovery (no registry code, a single `grpc.NewClient("dns:///orders:9090")` with the DNS resolver and round-robin balancer), and **xDS / service mesh** (Istio, Envoy Gateway, Linkerd) for multi-cluster, locality-aware routing, canary splits, and mTLS. **Consul or etcd** for mixed / non-k8s environments. Candidates should know the CAP tradeoffs of registries (Consul is CP, Eureka is AP) and understand that stale discovery cache during a partition is usually *preferable* to no service. They discuss health checks, graceful deregistration on shutdown, and connection warmup.

**Follow-ups:**
1. *"Pods rotate every 10 minutes. How does a long-lived gRPC client avoid sending requests to a dead pod?"* (Expected: gRPC health checking protocol + keepalives, the `round_robin` balancer with periodic re-resolution via the DNS or xDS resolver, plus readiness probes so Kubernetes removes the endpoint from the Service before SIGTERM. Bonus: graceful shutdown - stop accepting new requests, drain in-flight, deregister, then exit.)
2. *"Explain the xDS family - what do LDS, RDS, CDS, and EDS do?"* (Expected: LDS = listeners, RDS = HTTP routes, CDS = clusters (logical upstreams), EDS = endpoints (actual IPs). The control plane pushes updates over gRPC so proxies reconfigure in-memory without restart.)
3. *"Client-side vs server-side discovery - which do you pick for a new system in 2026?"* (Expected: server-side via Kubernetes Services or a mesh sidecar is the default because it keeps discovery logic out of app code. Client-side is justified when you need app-level routing intelligence or are not on a platform that offers server-side.)

### Question 5: What monitoring and observability do you need for microservices?

**Answer:**

The three pillars of observability are metrics, logs, and traces:

```go
// Comprehensive observability setup
type Observability struct {
    metrics *MetricsCollector
    logger  *slog.Logger
    tracer  trace.Tracer
}

// 1. Metrics - What is happening
type MetricsCollector struct {
    requestCounter   *prometheus.CounterVec
    requestDuration  *prometheus.HistogramVec
    activeRequests   *prometheus.GaugeVec
    errorRate        *prometheus.CounterVec

    // Business metrics
    ordersCreated    prometheus.Counter
    paymentAmount    *prometheus.HistogramVec
    inventoryLevel   *prometheus.GaugeVec
}

func NewMetricsCollector() *MetricsCollector {
    return &MetricsCollector{
        requestCounter: prometheus.NewCounterVec(
            prometheus.CounterOpts{
                Name: "http_requests_total",
                Help: "Total HTTP requests",
            },
            []string{"method", "path", "status"},
        ),
        requestDuration: prometheus.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "http_request_duration_seconds",
                Help:    "HTTP request duration",
                Buckets: prometheus.DefBuckets,
            },
            []string{"method", "path"},
        ),
    }
}

// 2. Logs - What happened
func LoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Extract trace context
            traceID := r.Header.Get("X-Trace-ID")

            // Create request-scoped logger
            reqLogger := logger.With(
                "trace_id", traceID,
                "method", r.Method,
                "path", r.URL.Path,
                "remote_addr", r.RemoteAddr,
            )

            // Wrap response writer to capture status
            rec := &statusRecorder{ResponseWriter: w, statusCode: 200}

            next.ServeHTTP(rec, r)

            // Log request completion
            reqLogger.Info("request completed",
                "status", rec.statusCode,
                "duration_ms", time.Since(start).Milliseconds(),
                "bytes_written", rec.bytesWritten,
            )
        })
    }
}

// 3. Traces - Why it happened (distributed context)
func TracingMiddleware(tracer trace.Tracer) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract parent span from headers
            ctx := otel.GetTextMapPropagator().Extract(
                r.Context(),
                propagation.HeaderCarrier(r.Header),
            )

            // Start new span
            ctx, span := tracer.Start(ctx, r.URL.Path,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    attribute.String("http.method", r.Method),
                    attribute.String("http.url", r.URL.String()),
                ),
            )
            defer span.End()

            // Add trace ID to response for debugging
            w.Header().Set("X-Trace-ID", span.SpanContext().TraceID().String())

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// Key metrics for microservices (RED method)
/*
R - Rate:      requests per second
E - Errors:    error rate percentage
D - Duration:  latency percentiles (p50, p95, p99)

Plus service-specific metrics:
- Circuit breaker state
- Connection pool utilization
- Queue depth
- Cache hit rate
*/
```

**What FAANG expects:** The senior answer names the three pillars (metrics, logs, traces) and then *converges* on **OpenTelemetry** as the 2026 instrumentation standard - one SDK emits all three signals with shared trace and span IDs, exported to any vendor backend (Datadog, Honeycomb, Grafana Tempo/Loki/Mimir, New Relic). They cite **RED** (Rate, Errors, Duration) for request-handling services and **USE** (Utilization, Saturation, Errors) for resource-oriented services. They discuss **SLIs, SLOs, and error budgets** as the framework for deciding when to page someone. They raise structured logging with correlation/trace IDs, log cardinality discipline (no unbounded label values in Prometheus metrics), and head-based vs tail-based trace sampling. Bonus: they mention **eBPF-based observability** (Pixie, Cilium Hubble, Parca) as the 2026 trend for zero-instrumentation visibility.

**Follow-ups:**
1. *"Your p99 latency for `/checkout` jumped from 200ms to 2s. Walk me through your investigation."* (Expected: start with the trace - find a representative slow span, see which service owns the time. Check that service's RED metrics and its downstream dependencies. Correlate with deploys, DB slow-query logs, cache hit rate, and upstream retry storms. Candidate should think in trees, not logs.)
2. *"How do you set an SLO for a new service?"* (Expected: derive from user journey (e.g., 99.9% of checkouts complete in under 1s measured over 28 days), turn that into an error budget, alert on burn rate rather than raw threshold crossings. Cite Google SRE book.)
3. *"Prometheus vs OpenTelemetry metrics - which do you ship in 2026?"* (Expected: OTel for instrumentation, but the collector can export to a Prometheus backend. The OTel-native metrics pipeline has matured enough to be the default. Prometheus is still the dominant *backend*. Candidates should know this convergence, not treat them as competitors.)

### Junior → FAANG: Interview Preparation Strategy for Microservices Questions

The five questions in this section represent the core microservices interview syllabus at L3 through L5. The preparation strategy is not to memorize answers but to practice the decision framework out loud until it is fluent.

For service boundaries (Q1): practice drawing the e-commerce bounded context diagram from memory. User, Order, Catalog, Payment, Inventory, Shipping, Notification. For each pair that shares data, write the integration pattern (API call, event subscription, denormalized copy). Time yourself. At L4 you should complete this in under 10 minutes.

For sync vs async (Q2): practice the one-sentence decision rule: "sync when the user is waiting for the response, async when the user is not." Then practice the follow-up: "async requires idempotent consumers because at-least-once delivery means duplicate messages." Both statements should come out without hesitation.

For distributed transactions (Q3): practice the saga explanation with a concrete three-step example (reserve inventory, charge payment, schedule shipping). Name the compensating transactions (release inventory, refund payment, cancel shipping). Practice the choreography version (events trigger next steps) and the orchestration version (a central coordinator runs the steps). Know which to prefer and why.

For service discovery (Q4): practice the Kubernetes answer first because it is the most common environment: DNS name, kube-proxy, readiness probe. Then practice the Consul answer for non-Kubernetes environments.

For observability (Q5): practice naming the three pillars (metrics, logs, traces) and the RED method (Rate, Errors, Duration) without looking them up. Practice describing a specific debugging scenario using all three: "first I check the RED dashboard for the service, then I pull a representative slow trace, then I look at the log lines for that trace ID."

Common junior mistake in these interviews: giving the answer without the tradeoff. Every answer in this section includes both the pattern and its tradeoffs. Practice naming both sides before interviewers prompt you.

### Senior @ FAANG: Bar-Raiser Signals and L6/L7 Interview Differentiation

At L6/L7, the interview questions are the same but the expected depth is qualitatively different. The bar-raiser is looking for specific signals that distinguish a senior individual contributor from a staff-level system thinker.

**Signal 1: organizational before technical.** A staff-level answer to "how do you decide service boundaries?" opens with Conway's Law and the team structure, not with DDD vocabulary. The correct framing: "the first thing I do is look at the org chart. Service boundaries that don't align to team boundaries create coordination overhead that erases the value of decomposition. I'd run an event storming session with the domain experts and the team leads together, not just the engineers."

**Signal 2: naming the reversal.** A bar-raiser answer to any question about microservices adoption mentions the industry reversal: the Prime Video monolith case study, the Shopify modular monolith, Kelsey Hightower's public statements, and the CNCF survey data on consolidation. This demonstrates that the candidate tracks the industry's evolving consensus rather than holding a fixed dogmatic position.

**Signal 3: governance without prompting.** A staff-level answer includes governance mechanisms that were not asked about: ADRs for decomposition decisions, schema registry for event contracts, consumer-driven contract testing for API compatibility, chaos engineering for resilience. These signal that the candidate thinks about sustaining the architecture over time, not just building it once.

**Signal 4: failure mode specificity.** When asked about observability or resilience, a bar-raiser candidate names a specific production incident pattern and the specific mitigation. "Retry storms after partition healing" is more credible than "we had retry issues." "Outbox lag causing delayed event processing during a Kafka broker failover" is more credible than "events were slow." Real incidents have specifics.

**Signal 5: the tradeoff conversation, not the answer.** At L6/L7, the interviewer is not looking for a correct answer. They are looking for the candidate's reasoning process under uncertainty. The strongest signal is when the candidate says "it depends on X, Y, and Z. If X is true, I'd choose A because of P and Q. If Y is true instead, I'd choose B because of R and S. Let me ask: what are your consistency requirements?" This is the behavior of someone who leads design discussions, not someone who implements a spec.

---
