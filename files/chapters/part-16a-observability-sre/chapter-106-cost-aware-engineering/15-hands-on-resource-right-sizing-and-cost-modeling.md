## Hands-On Resource Right-Sizing and Cost Modeling

Real-world case study analyzing container CPU/memory utilization metrics and projecting multi-million dollar annual savings through vertical pod autoscaling and bin-packing.

---

### Current state


Resources per pod:
- CPU: 500m = 0.5 vCPU
- Memory: 512Mi = 0.5 GB

Total resources (10 replicas):
- CPU: 5 vCPU
- Memory: 5 GB

Monthly cost:
- CPU: 5 vCPU × $0.04/hr × 730 hrs = $146/month
- Memory: 5 GB × $0.01/hr × 730 hrs = $36.50/month
- Total: $182.50/month

### Junior → FAANG: The Cost Baseline Is the Starting Point for Every Optimization

Calculating the current monthly cost before proposing any optimization is a discipline that separates rigorous engineers from ones who optimize without measuring. The calculation above takes two minutes and establishes the baseline. Without it, any claimed savings percentage is unverifiable.

### Senior @ FAANG: Cost Baselines in Multi-Dimension

At L6, the cost baseline includes not just compute but the full allocation: compute, storage, network egress, monitoring/logging pipeline, and external API spend. A service that reduces compute cost by 30% but increases logging volume 3x may be net-neutral in total cost. Comprehensive baselines prevent this common optimization accounting error.


---

### Utilization analysis


Peak utilization:
- CPU: 150m / 500m = 30%
- Memory: 180Mi / 512Mi = 35%

Average utilization:
- CPU: 80m / 500m = 16%
- Memory: 120Mi / 512Mi = 23%

Assessment: Significantly over-provisioned

### Junior → FAANG: Peak vs Average Utilization Both Matter

Right-sizing decisions must use peak utilization, not average. A service at 16% average CPU that peaks at 30% can be safely right-sized to a request that covers the peak with headroom. Using the average (16%) would cause CPU throttling during peak load and degrade user experience. The standard headroom formula is: `new_request = peak_utilization × 1.3`, providing 30% headroom above the observed peak.

### Senior @ FAANG: Utilization Analysis at Percentile Granularity

At L6, utilization analysis uses percentile distributions, not just peak and average. A service whose p99 CPU is 150m but whose p99.9 CPU is 400m needs a request that accounts for the extreme tail, not just the 99th percentile. The right-sizing decision must specify which percentile is used and document the trade-off: higher percentile = more headroom = higher cost = lower risk of throttling during rare spikes.


---

### Recommended resources


For Go services, I recommend:
- CPU request: Average usage + 50% buffer = 80m × 1.5 = 120m
- CPU limit: Peak usage + 30% buffer = 150m × 1.3 = 195m
- Memory request: Average usage + 30% buffer = 120Mi × 1.3 = 156Mi
- Memory limit: Peak usage + 50% buffer = 180Mi × 1.5 = 270Mi

Rounded recommendation:
- CPU: 150m request, 250m limit
- Memory: 192Mi request, 320Mi limit

### Junior → FAANG: Request and Limit Are Different Concepts

The CPU request and CPU limit serve different purposes in Kubernetes. The request determines scheduling (which node the pod lands on and how much CPU is guaranteed). The limit determines the maximum CPU the pod can burst to. Setting request equal to limit ("guaranteed" QoS class) prevents CPU throttling but reduces bin-packing efficiency. Setting request below limit ("burstable" QoS) allows pods to use spare CPU on underutilized nodes but may cause throttling during node-level contention. Most general-purpose services should use burstable QoS with request at p95 utilization and limit at 2x the request.

### Senior @ FAANG: Memory Limits and OOMKill Risk Management

At L6, the memory limit decision requires understanding Go's memory management model. Go's GC grows the heap until `GOMEMLIMIT` is reached, at which point it runs GC more aggressively. The container memory limit must be set above `GOMEMLIMIT` to account for non-heap memory (goroutine stacks, network buffers, CGO memory). A safe configuration is `GOMEMLIMIT = 0.85 × memory_limit`. Without `GOMEMLIMIT`, the Go runtime may grow the heap past the container limit before GC runs, triggering an OOMKill. This is the most common cause of unexpected OOMKills in Go services that appear healthy from a utilization perspective.


---

### Additional recommendations


1. Enable HPA with target CPU utilization of 70%
2. Consider reducing replica count with HPA (min 3, max 15)
3. Set GOMEMLIMIT=250MiB to help Go manage memory

### Junior → FAANG: HPA Requires a Stable Scaling Signal

When configuring HPA, the target CPU utilization percentage is a fraction of the CPU request, not the CPU limit. If the request is set to 150m and HPA target is 70%, HPA will scale up when average CPU across all replicas exceeds 105m. Choose the target carefully: too high (90%) means the service is CPU-throttled before HPA adds replicas. Too low (30%) causes over-scaling and unnecessary cost.

### Senior @ FAANG: HPA and Cluster Autoscaler Interaction

At L6, HPA configuration must account for cluster autoscaler behavior. When HPA scales up and no node has capacity for the new pods, the pods enter Pending state and the cluster autoscaler provisions a new node (3-5 minute latency on most cloud providers). For latency-sensitive services, this provisioning time is unacceptable. The mitigation is to maintain a small buffer of over-provisioned capacity (a low-priority "balloon" deployment that uses spare cluster capacity and is preempted when real pods need the capacity) or to use proactive scaling based on traffic forecasting rather than reactive HPA.


---

### Cost savings calculation


New resources per pod:
- CPU request: 150m = 0.15 vCPU
- Memory request: 192Mi = 0.1875 GB

With HPA (average 5 pods instead of fixed 10):
- CPU: 5 × 0.15 = 0.75 vCPU
- Memory: 5 × 0.1875 = 0.94 GB

New monthly cost:
- CPU: 0.75 vCPU × $0.04/hr × 730 hrs = $21.90/month
- Memory: 0.94 GB × $0.01/hr × 730 hrs = $6.86/month
- Total: $28.76/month

**Savings: $182.50 - $28.76 = $153.74/month (84%)**

### Exercise 2: Unit Economics Calculation

**Objective**: Calculate and optimize cost per business transaction.

**Scenario**: You run an e-commerce checkout service with:
- 100,000 checkouts/day
- Each checkout: 5 API calls, 3 DB queries, 1 external payment API call
- Infrastructure cost: $3,000/month
- External payment API: $0.30 per transaction + 2.9% of transaction value
- Average transaction value: $50

**Solution**:

```markdown
# Unit Economics Analysis

Summary: at 3,000,000 checkouts/month, infrastructure works out to
$0.001/checkout while the external payment API costs $1.75/checkout
($0.30 fixed + 2.9% of $50). Payment processing is 99.94% of total
variable cost, so optimization effort belongs on the payment side,
not the infrastructure side.

The full worked solution follows in the next sections: current costs
breakdown, optimization opportunities, recommendations, and
implementing cost tracking.
```

### Junior → FAANG: An 84% Cost Reduction Is a Story Worth Telling

The right-sizing plus HPA combination in this exercise achieves an 84% cost reduction. That is the kind of result that appears in engineering blog posts and promotion documents. Understand why: fixed 10-replica deployments pay for peak capacity 24/7. HPA with a minimum of 5 replicas pays for off-peak reduced capacity and scales up only when traffic demands it. The combination of right-sizing (3x smaller requests per pod) and dynamic scaling (5 pods on average instead of 10) produces a multiplicative savings effect.

### Senior @ FAANG: Savings Calculations Must Include Implementation Risk

At L6, the 84% savings calculation requires a risk-adjusted correction. Reducing replica count from 10 to a minimum of 3 increases blast radius if multiple pods fail simultaneously: 2 pod failures with a minimum of 3 replicas leaves 1 pod handling 100% of traffic. The right-sizing recommendation must include a minimum replica analysis based on fault tolerance requirements (typically 2 pod failures should leave the service operational, requiring a minimum of 3 replicas), and the savings calculation should note that the minimum replica floor reduces the theoretical savings but is required for the reliability SLO.


---

### Current costs breakdown


### Infrastructure (internal)
$3,000/month ÷ 3,000,000 checkouts/month = $0.001/checkout

### External Payment API
Per checkout:
- Fixed fee: $0.30
- Percentage: $50 × 2.9% = $1.45
- Total: $1.75/checkout

### Total Cost Per Checkout
$0.001 (infra) + $1.75 (payment) = $1.751/checkout

### Monthly Costs
- Infrastructure: $3,000
- Payment processing: $1.75 × 3M = $5,250,000

**Observation**: Infrastructure cost is negligible (0.06% of total).
Payment processing dominates.

### Junior → FAANG: Unit Economics Reveals Where Optimization Matters

The unit economics breakdown in this file is a key insight that many engineers miss: optimizing infrastructure by 50% saves $1,500/month, but optimizing the payment processor contract by 5% saves $262,500/month. Cost optimization energy should follow the unit economics, not the engineer's technical comfort zone. Infrastructure optimization is more interesting to engineers but often less impactful than negotiating vendor contracts.

### Senior @ FAANG: Unit Economics as a Product and Business Conversation Tool

At L6, unit economics analysis is the bridge between engineering and business strategy. The checkout service example shows that payment processing is 99.94% of total variable cost. This is a business-critical insight: if the company can negotiate a better payment processor contract or route transactions to a lower-fee processor for certain transaction types, the savings dwarf any engineering optimization. An L6 engineer who surfaces this analysis to the finance and product teams enables a business decision that an engineering-only perspective would never have identified. This is the definition of staff-level impact: using technical analysis to unlock business value that transcends the engineering domain.


---

### Optimization opportunities


### 1. Payment Processing (High Impact)
- Negotiate volume discount (at 3M/month, should get better rate)
- Target: 2.5% + $0.25 = $1.50/transaction
- Savings: $0.25 × 3M = $750,000/month

### 2. Infrastructure (Low Impact)
- Current: $3,000/month
- Optimized (right-sizing, spot): $1,500/month
- Savings: $1,500/month

### 3. Reduce Failed Checkouts (High Impact)
- Current abandonment at payment: 5%
- Each failed checkout costs infra but no revenue
- Improving success rate by 1% = 30,000 more completions
- Additional revenue: 30,000 × $50 × margin

### Junior → FAANG: Optimization Opportunities Are Not All Engineering Problems

The three optimization opportunities above have different ownership: payment processing negotiation is a finance and business development conversation, infrastructure optimization is an engineering task, and checkout success rate improvement is a product and engineering collaboration. Junior engineers should understand which type of optimization they are being asked to drive and which requires escalation to other functions.

### Senior @ FAANG: Framing Optimization as Business Value, Not Engineering Effort

At L6, presenting optimization opportunities to leadership requires framing in business value terms, not engineering effort terms. "We can save $750K/month by negotiating the payment processor contract" is a business recommendation with a clear ROI. "We can reduce infrastructure costs by 50% through right-sizing" is an engineering recommendation that saves $1,500/month. The contrast in scale makes the prioritization obvious. An L6 engineer who frames both opportunities in the same terms (monthly savings, implementation timeline, confidence level) enables leadership to make rational prioritization decisions rather than defaulting to the engineering work that is most technically interesting.


---

### Recommendations


Priority order:
1. **Renegotiate payment processor contract**: highest ROI
2. **Optimize checkout flow**: reduce abandonment
3. **Infrastructure optimization**: small absolute savings

### Junior → FAANG: Priority Order Is Part of the Recommendation

A list of recommendations without a priority order is not a recommendation. It is a list. Always include priority, rationale, and expected timeline. "Renegotiate payment processor contract (highest ROI, requires business development lead, 60-90 day timeline)" provides actionable context that a bare bullet point does not.

### Senior @ FAANG: Recommendations Must Include Risk and Dependencies

At L6, recommendations include the dependencies that can block execution. Payment processor negotiation depends on volume data from the finance team and typically requires executive sponsorship. Checkout flow optimization requires product prioritization. Infrastructure optimization can proceed independently. Listing these dependencies surfaces the organizational work required alongside the technical work, enabling the team to begin the non-technical tracks in parallel rather than discovering blockers after the engineering work is complete.
