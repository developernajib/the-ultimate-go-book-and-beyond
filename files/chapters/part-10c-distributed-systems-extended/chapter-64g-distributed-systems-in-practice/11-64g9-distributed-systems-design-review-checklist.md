## 64G.9 Distributed Systems Design Review Checklist

A design review checklist provides a structured gate that catches common distributed systems mistakes (missing timeouts, absent idempotency, unhandled partition behavior) before they reach production. The following checklist operationalizes the principles covered throughout this chapter into concrete yes/no questions that can be answered from the design document or code review.

```go
package review

func hasTimeoutOnAllHTTPClients() bool { return true }
func hasCircuitBreakersForDownstreamCalls() bool { return true }
func allMutatingOperationsAreIdempotent() bool { return true }
func handlesSIGTERM() bool { return true }

// Before shipping any distributed system component, answer these questions:

type DistributedSystemsReview struct {
    // Section 1: Consistency and Data Integrity
    ConsistencyRequirements string // What consistency level does this data need?
    PartitionBehavior       string // What happens during a network partition?
    ConflictResolution      string // How are concurrent conflicting writes resolved?
    DataVersioning          string // How do you handle schema evolution?

    // Section 2: Failure Modes
    FailureModes            []string // What can fail? (network, node, disk, software)
    CircuitBreakers         bool     // Are circuit breakers in place for downstream calls?
    Timeouts                bool     // Are all network calls bounded by timeouts?
    Retries                 bool     // Are retries idempotent? Is retry backoff jittered?
    Fallbacks               string   // What happens if a downstream is unavailable?

    // Section 3: Observability
    DistributedTracing      bool // Are trace IDs propagated across all calls?
    StructuredLogging       bool // Are logs structured with correlation IDs?
    MetricsDefined          []string // What metrics indicate this system is healthy?
    AlertsDefined           []string // What alerts will wake someone up?
    RunbooksLinked          bool // Are alert runbooks documented?

    // Section 4: Operational
    GracefulShutdown        bool   // Does the service handle SIGTERM correctly?
    HealthChecks            bool   // Are liveness and readiness probes implemented?
    DatabaseMigrations      string // How are DB schema changes applied safely?
    FeatureFlags            bool   // Can dangerous changes be rolled back without deploy?

    // Section 5: Security
    AuthNAuthZ              bool // Are all endpoints authenticated and authorized?
    SecretManagement        bool // Are secrets in vault, not environment variables?
    TLSInternally           bool // Is internal service-to-service traffic encrypted?
    InputValidation         bool // Is all input validated at service boundaries?

    // Section 6: Performance and Scalability
    MaxConcurrency          int           // What is the maximum concurrent request limit?
    BackpressureHandled     bool          // Does the service propagate backpressure upstream?
    DatabaseConnectionPool  int           // Is DB pool sized correctly for expected load?
    CachingStrategy         string        // What is cached and for how long?
    HorizontalScaling       string        // What state must be moved out for horizontal scaling?
}

// Automated review checklist function
func ReviewDistributedComponent(component string) []string {
    var issues []string

    // Check timeout configuration
    if !hasTimeoutOnAllHTTPClients() {
        issues = append(issues, "CRITICAL: HTTP clients missing timeouts - can cause goroutine leaks and cascade failures")
    }

    // Check circuit breakers
    if !hasCircuitBreakersForDownstreamCalls() {
        issues = append(issues, "HIGH: No circuit breakers - single downstream failure can cascade to full outage")
    }

    // Check idempotency
    if !allMutatingOperationsAreIdempotent() {
        issues = append(issues, "HIGH: Non-idempotent mutations without retry deduplication - retries can cause duplicate operations")
    }

    // Check graceful shutdown
    if !handlesSIGTERM() {
        issues = append(issues, "MEDIUM: No SIGTERM handler - in-flight requests dropped on deployment")
    }

    return issues
}
```

### Junior → FAANG: Using the Checklist as a Self-Review Tool

The checklist in this section is most immediately useful to junior engineers as a self-review tool before submitting a pull request or presenting a design. Going through each section and being able to answer "yes, this is implemented and here is where" or "this is not implemented and here is the accepted risk" demonstrates production-readiness thinking that FAANG interviewers and code reviewers look for.

For system design interviews, the checklist doubles as a structure for your final review. After describing your system, spend two minutes walking through the major sections: consistency (what model, why), failure modes (timeouts, circuit breakers, idempotency), observability (tracing, logging, metrics), and security (auth, secrets, input validation). Candidates who structure their design review this way demonstrate that they think about production systems holistically rather than just solving the happy path.

First-job habit: print or bookmark this checklist and use it before every code review you author. The first few times you use it, you will find gaps in your own work. After ten reviews, the checks become automatic.

### Senior @ FAANG: Checklist as a Deployment Gate and Platform Policy

At senior level, a design review checklist has two uses: as a document for pre-deployment review, and as an automated gate in the deployment pipeline. The most impactful use is the second one.

**Automating checklist enforcement.** Many items in the `DistributedSystemsReview` struct can be checked programmatically. Do all HTTP clients have timeouts? Static analysis can check this. Are all outbound calls wrapped in a circuit breaker? The circuit breaker library can instrument itself and expose a metric. Does the service handle SIGTERM? Integration testing can send SIGTERM and verify in-flight requests complete. Staff engineers build these automated checks into the CI/CD pipeline as required passing conditions for promotion to production. Items that cannot be automated become mandatory fields in the deployment request form, reviewed by the tech lead before approval.

**Checklist evolution through post-mortems.** The checklist in this section represents the state of knowledge at a point in time. Post-mortems consistently identify new categories of risk that are not covered. The staff engineer's responsibility is to add new checklist items after each post-mortem, assign ownership for verifying existing items, and remove items that are now enforced by the platform (no longer needing manual verification). The checklist is a living document that gets stronger with each incident, not a static artifact.

**Consistency of checklist application across teams.** A checklist that each team applies differently is not a governance mechanism: it is a suggestion. At FAANG scale, staff engineers work with platform and reliability teams to standardize the checklist across all services, define clear pass/fail criteria for each item, and track aggregate pass rates as an engineering health metric. A team with 60% checklist pass rate is a team with known technical debt. A team with 95% pass rate and automated enforcement has structurally reduced its incident risk. The aggregate metric surfaces priority for platform investment: if 40% of teams fail the "graceful shutdown" check, the right investment is a better framework default, not 40 separate team education efforts.

**L6/L7 design review bar.** In design review panels for senior promotions, the quality of a candidate's distributed systems review is a primary signal. The bar is: can the candidate identify which checklist items are most critical for this specific system, explain the failure mode that each item prevents, and propose a concrete mechanism for verifying compliance? Candidates who apply the checklist as a rote exercise get partial credit. Candidates who reason about which items matter most for the specific system, and why, demonstrate the judgment expected at L6.

---
