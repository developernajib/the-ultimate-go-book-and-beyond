## 106.6 Company Case Studies: FinOps at Scale

### Google: GCP Cost Optimization

Google's approach to cost-efficient Go services on GCP:

```go
// Google Cloud cost optimization patterns
package finops

import (
    "context"
    "fmt"

    budgets "cloud.google.com/go/billing/budgets/apiv1"
    recommender "cloud.google.com/go/recommender/apiv1"
    recommenderpb "cloud.google.com/go/recommender/apiv1/recommenderpb"
    "google.golang.org/api/iterator"
)

// Automatic rightsizing based on GCP recommendations
type GCPCostOptimizer struct {
    recommenderClient *recommender.Client
    budgetClient      *budgets.BudgetClient
    projectID         string
}

func (o *GCPCostOptimizer) GetRightsizingRecommendations(ctx context.Context) ([]Recommendation, error) {
    parent := fmt.Sprintf("projects/%s/locations/global/recommenders/google.compute.instance.MachineTypeRecommender", o.projectID)

    iter := o.recommenderClient.ListRecommendations(ctx, &recommenderpb.ListRecommendationsRequest{
        Parent: parent,
    })

    var recommendations []Recommendation
    for {
        rec, err := iter.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            return nil, err
        }

        recommendations = append(recommendations, Recommendation{
            Resource:     rec.GetContent().GetOperationGroups()[0].GetOperations()[0].GetResource(),
            CurrentType:  extractCurrentType(rec),
            RecommendedType: extractRecommendedType(rec),
            MonthlySavings: extractSavings(rec),
        })
    }
    return recommendations, nil
}

type Recommendation struct {
    Resource        string
    CurrentType     string
    RecommendedType string
    MonthlySavings  float64
}

func extractCurrentType(rec *recommenderpb.Recommendation) string     { return "n1-standard-4" }
func extractRecommendedType(rec *recommenderpb.Recommendation) string { return "n1-standard-2" }
func extractSavings(rec *recommenderpb.Recommendation) float64        { return 48.50 }

// Go-specific: Use Cloud Run for cost-effective serverless
type CloudRunConfig struct {
    MinInstances       int     // Set to 0 for scale-to-zero
    MaxInstances       int
    CPUThrottling      bool    // Throttle CPU when not processing requests
    CPUBoost           bool    // Extra CPU during startup
    ExecutionEnvironment string // gen1 or gen2
}

var OptimalCloudRunConfig = CloudRunConfig{
    MinInstances:       0,      // Scale to zero for cost savings
    MaxInstances:       100,
    CPUThrottling:      true,   // Only pay for CPU during requests
    CPUBoost:           true,   // Fast cold starts for Go
    ExecutionEnvironment: "gen2", // Better performance
}
```

### Uber: Unit Economics

Uber tracks cost per ride for each microservice:

```go
// Uber-style unit economics tracking
package cost

import (
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Cost per trip by service
    costPerTrip = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "uber_cost_per_trip_microdollars",
            Help:    "Infrastructure cost per trip in microdollars",
            Buckets: []float64{100, 500, 1000, 2500, 5000, 10000, 25000},
        },
        []string{"service", "city", "product"},
    )

    // Resource utilization efficiency
    resourceEfficiency = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "uber_resource_efficiency_percent",
            Help: "Percentage of allocated resources actually used",
        },
        []string{"service", "resource_type"},
    )
)

// UnitEconomicsTracker calculates cost per business transaction
type UnitEconomicsTracker struct {
    cpuCostPerCore    float64 // $/core-hour
    memoryCostPerGB   float64 // $/GB-hour
    networkCostPerGB  float64 // $/GB transferred
}

func (t *UnitEconomicsTracker) CalculateTripCost(trip TripContext) float64 {
    var totalCost float64

    for _, service := range trip.ServicesInvolved {
        cpuCost := service.CPUSeconds / 3600 * t.cpuCostPerCore
        memCost := service.MemoryGBSeconds / 3600 * t.memoryCostPerGB
        netCost := service.NetworkGB * t.networkCostPerGB

        serviceCost := cpuCost + memCost + netCost
        totalCost += serviceCost

        // Record per-service contribution
        costPerTrip.WithLabelValues(
            service.Name,
            trip.City,
            trip.Product,
        ).Observe(serviceCost * 1000000) // Convert to microdollars
    }

    return totalCost
}

// Spot instance usage for non-critical workloads
type SpotOptimization struct {
    SpotPercentage     float64 // Target % of compute on spot
    FallbackOnDemand   bool    // Auto-fallback when spot unavailable
    InterruptionBuffer time.Duration // Warning time before spot termination
}

type ServiceUsage struct {
    Name            string
    CPUSeconds      float64
    MemoryGBSeconds float64
    NetworkGB       float64
}

type TripContext struct {
    City             string
    Product          string
    ServicesInvolved []ServiceUsage
}
```

### Netflix: Titus Cost Management

Netflix's container platform with cost awareness:

```go
// Netflix Titus-style cost-aware scheduling
package titus

// JobCostProfile defines cost expectations for a job
type JobCostProfile struct {
    MaxCPU        float64
    MaxMemoryGB   float64
    MaxGPU        int
    BurstAllowed  bool
    SpotEligible  bool
    Priority      Priority
}

type Priority int

const (
    PriorityBatch     Priority = iota // Can be preempted, cheapest
    PriorityService                    // Standard production
    PriorityCritical                   // Never preempt, expensive
)

// Cost multipliers by priority
var costMultiplier = map[Priority]float64{
    PriorityBatch:    0.3, // 70% discount for interruptible
    PriorityService:  1.0,
    PriorityCritical: 2.0, // Premium for guaranteed capacity
}

// ResourceBin for efficient packing
type ResourceBin struct {
    CPUTotal      float64
    CPUUsed       float64
    MemoryTotal   float64
    MemoryUsed    float64
    CostPerHour   float64
}

func (b *ResourceBin) Efficiency() float64 {
    cpuEfficiency := b.CPUUsed / b.CPUTotal
    memEfficiency := b.MemoryUsed / b.MemoryTotal
    return (cpuEfficiency + memEfficiency) / 2
}

// Target 70%+ bin packing efficiency
func (b *ResourceBin) IsEfficient() bool {
    return b.Efficiency() >= 0.70
}
```

### Stripe: Cost Per Transaction

Stripe tracks infrastructure cost per payment:

```go
// Stripe-style payment infrastructure costing
package cost

import (
    "github.com/prometheus/client_golang/prometheus"
)

type PaymentCostTracker struct {
    // Cost per component
    APICost       float64 // Cost per API call
    ProcessorCost float64 // Payment processor fees
    StorageCost   float64 // Data storage cost
    ComplianceCost float64 // PCI compliance overhead
}

// CalculatePaymentCost returns total infrastructure cost for a payment
func (t *PaymentCostTracker) CalculatePaymentCost(payment Payment) CostBreakdown {
    return CostBreakdown{
        Compute:    t.calculateComputeCost(payment),
        Network:    t.calculateNetworkCost(payment),
        Storage:    t.calculateStorageCost(payment),
        Compliance: t.calculateComplianceCost(payment),
        External:   t.calculateExternalCost(payment),
    }
}

func (t *PaymentCostTracker) calculateComputeCost(payment Payment) float64 {
    // More complex payments (3DS, disputes) cost more
    baseCost := 0.0001 // $0.0001 base

    if payment.Requires3DS {
        baseCost *= 2
    }
    if payment.IsInternational {
        baseCost *= 1.5
    }
    if payment.HasDispute {
        baseCost *= 10 // Disputes are expensive
    }

    return baseCost
}

func (t *PaymentCostTracker) calculateNetworkCost(payment Payment) float64    { return 0.00005 }
func (t *PaymentCostTracker) calculateStorageCost(payment Payment) float64    { return 0.00002 }
func (t *PaymentCostTracker) calculateComplianceCost(payment Payment) float64 { return 0.00010 }
func (t *PaymentCostTracker) calculateExternalCost(payment Payment) float64   { return 0.00020 }

type Payment struct {
    AmountCents     int64
    Requires3DS     bool
    IsInternational bool
    HasDispute      bool
    PaymentMethod   string
    Region          string
}

type CostBreakdown struct {
    Compute    float64
    Network    float64
    Storage    float64
    Compliance float64
    External   float64
}

// Margin-aware alerts
var marginAlerts = prometheus.NewGaugeVec(
    prometheus.GaugeOpts{
        Name: "stripe_payment_margin_ratio",
        Help: "Revenue / Cost ratio per payment type",
    },
    []string{"payment_method", "region"},
)
```

### Amazon: Reserved Capacity Planning

Amazon's approach to capacity planning and reservations:

```go
// AWS-style reserved capacity planning
package finops

import (
    "time"
)

type CapacityPlan struct {
    Service       string
    BaselineRPS   float64 // Normal traffic
    PeakRPS       float64 // Peak traffic
    GrowthRate    float64 // Monthly growth %

    // Cost optimization levers
    ReservedPercent float64 // % on reserved instances
    SpotPercent     float64 // % on spot instances
    OnDemandPercent float64 // % on on-demand
}

type InstanceMix struct {
    Reserved float64
    Spot     float64
    OnDemand float64
}

type Savings struct {
    MonthlyBefore float64
    MonthlyAfter  float64
    AnnualSavings float64
}

func (c *CapacityPlan) OptimalMix() InstanceMix {
    // Cover baseline with reserved
    reserved := c.BaselineRPS * 0.8 // 80% of baseline

    // Peak with spot (can handle interruptions)
    spot := (c.PeakRPS - c.BaselineRPS) * 0.7

    // Remainder on-demand
    onDemand := c.PeakRPS - reserved - spot

    return InstanceMix{
        Reserved: reserved,
        Spot:     spot,
        OnDemand: onDemand,
    }
}

// Savings Plan calculator
type SavingsPlanCalculator struct {
    commitmentPeriod time.Duration // 1 or 3 years
    paymentOption    string        // "all_upfront", "partial_upfront", "no_upfront"
}

func (c *SavingsPlanCalculator) CalculateSavings(monthlySpend float64) Savings {
    var discountRate float64
    switch c.paymentOption {
    case "all_upfront":
        if c.commitmentPeriod == 3*365*24*time.Hour {
            discountRate = 0.62 // 62% discount
        } else {
            discountRate = 0.42
        }
    case "no_upfront":
        if c.commitmentPeriod == 3*365*24*time.Hour {
            discountRate = 0.52
        } else {
            discountRate = 0.32
        }
    }

    return Savings{
        MonthlyBefore: monthlySpend,
        MonthlyAfter:  monthlySpend * (1 - discountRate),
        AnnualSavings: monthlySpend * 12 * discountRate,
    }
}
```

**FinOps Practices by Company**:

| Company | Key Practice | Go-Specific Benefit |
|---------|-------------|---------------------|
| Google | Cloud Run scale-to-zero | Fast cold starts, small images |
| Uber | Unit economics per trip | Low memory footprint per request |
| Netflix | Bin packing efficiency | Predictable resource usage |
| Stripe | Cost per transaction | Efficient concurrency model |
| Amazon | Savings Plans | Reserved capacity for stable services |

### Junior → FAANG: What These Case Studies Teach About Interviewing

Each case study above demonstrates a pattern that appears in FAANG interview questions about cost-aware engineering. The Google scale-to-zero case tests whether you understand why Go's fast startup time enables serverless economics that JVM services cannot achieve. The Uber unit-economics case tests whether you can connect code-level efficiency (low memory per request) to business-level metrics (cost per trip). The Netflix bin-packing case tests whether you understand Kubernetes scheduling and how resource request predictability affects packing efficiency.

When discussing cost in a design interview, use the framework from these cases: name the cost driver, quantify the impact, describe the solution, and state the result. "We discovered that our service was spending 30% of CPU in GC, optimized allocations using sync.Pool, and reduced CPU cost by 25%" is a complete answer. "We made some Go optimizations" is not.

### Senior @ FAANG: Migration Patterns and Organizational Lessons from the Cases

At L6, the most important lesson from these case studies is not the technical solution but the organizational prerequisite. Dropbox's $75M savings from migrating off AWS was possible only because they had service-level cost attribution data with enough fidelity to make the build-vs-buy decision with confidence. Without that data, the risk of the migration would have been unquantifiable and the project would not have been approved.

Netflix's bin packing efficiency required a multi-year investment in consistent resource request discipline across hundreds of teams. The technical tooling (VPA, custom schedulers) is the visible part. The organizational work (standardizing resource request profiles, building review processes for resource request changes, creating incentives for right-sizing) is the invisible prerequisite that most organizations skip, producing tooling that exists but is not used consistently enough to achieve bin packing efficiency.

For a staff-level interview, the case study discussion should go one level deeper: not just "Uber uses unit economics" but the organizational model that makes unit economics actionable: cost dashboards embedded into each product team's weekly engineering review, with a standing agenda item for any team whose cost per trip trends upward for two consecutive weeks.

---
