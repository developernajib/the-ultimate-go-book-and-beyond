## Implementing Cost Tracking

Cost tracking at the transaction level requires converting external pricing (payment processor fees, infrastructure cost-per-request) into a common unit, here microdollars, so values fit cleanly into Prometheus histograms without floating-point precision loss. By labeling observations with `status` and `payment_method`, you can later break down P99 cost per checkout variant in Grafana and identify which payment path is most expensive relative to its success rate. The histogram buckets are deliberately spaced to capture the long tail of high-value transactions that dominate total cost.

```go
type Checkout struct {
    AmountCents   int64
    Status        string
    PaymentMethod string
}

var (
    checkoutCost = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "checkout_cost_microdollars",
            Buckets: []float64{100000, 500000, 1000000, 2000000, 3000000, 5000000},
        },
        []string{"status", "payment_method"},
    )
)

func TrackCheckoutCost(checkout Checkout) {
    infraCost := 0.001 * 1000000 // microdollars
    paymentCost := (0.30 + (float64(checkout.AmountCents)/100.0)*0.029) * 1000000

    checkoutCost.WithLabelValues(
        checkout.Status,
        checkout.PaymentMethod,
    ).Observe(infraCost + paymentCost)
}
```

### Exercise 3: Cloud Cost Optimization Proposal

**Objective**: Write a cost optimization proposal for leadership.

**Scenario**: Your company spends $50K/month on cloud infrastructure. You've identified $15K in potential savings. Write a proposal.

**Solution**:

```markdown
# Cloud Cost Optimization Proposal

Summary: $15,000/month in identified savings (30% of the $50,000
monthly spend), delivered in 2 sprints for a $20,000 one-time
implementation cost, yielding $180,000/year in ongoing savings.

The full proposal follows in the next sections: executive summary,
current state analysis, proposed optimizations, risk mitigation,
implementation plan, success metrics, resource request, and a
detailed cost breakdown appendix.
```

### Junior → FAANG: The Histogram Bucket Choice Is a Design Decision

The histogram buckets in the cost tracking code above are chosen to capture the range from cheap transactions (100,000 microdollars = $0.10) to expensive high-value transactions (5,000,000 microdollars = $5.00), bracketing the ~$1.75 typical checkout from the scenario. Choosing histogram buckets is a skill: buckets that are too sparse lose distribution information, and buckets that are too granular increase cardinality without adding insight. For cost histograms, use exponential bucket spacing that matches the expected order-of-magnitude range of values.

### Senior @ FAANG: Cost Tracking Labels Require Cardinality Analysis

At L6, every label added to a cost histogram requires cardinality analysis before deployment. The `payment_method` label above is bounded (credit card, debit card, PayPal, Apple Pay, Google Pay), making it safe. If `payment_method` were replaced with `payment_provider_transaction_id`, cardinality would be unbounded and the metric would OOM Prometheus within hours of deployment. All cost metric label sets must be reviewed by the platform team's cardinality governance process before reaching production.
