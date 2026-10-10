## 106.13 Exercises with Solutions

### Exercise 1: Right-Sizing Analysis

**Objective**: Analyze a Go service and recommend resource adjustments.

**Scenario**: You have a Go API service with the following characteristics:
- Current resources: 500m CPU, 512Mi memory
- Actual peak usage: 150m CPU, 180Mi memory
- Average usage: 80m CPU, 120Mi memory
- 10 replicas running 24/7
- On-demand pricing: $0.04/vCPU-hour, $0.01/GB-hour

Calculate current cost, recommended resources, and potential savings.

**Solution**:

```markdown
# Right-Sizing Analysis

Summary: current cost is $182.50/month (10 replicas at 500m/512Mi).
Peak utilization is 30% CPU and 35% memory, an over-provisioning
ratio of 3.3x for CPU and 2.8x for memory. Right-sizing the requests
to 150m/192Mi and adding HPA (average 5 replicas) reduces the cost
to $28.76/month, a saving of $153.74/month (84%).

The full worked solution follows in the next sections: current
state, utilization analysis, recommended resources, additional
recommendations, and the cost savings calculation.
```

### Junior → FAANG: Right-Sizing Math Is a Core Competency

Be able to perform the right-sizing calculation from this exercise mentally in an interview. The formula is: `(requested_resource / actual_p95_usage) = over-provisioning ratio`. A ratio above 2.0 means the service is over-provisioned by 2x or more and is a candidate for right-sizing. In this scenario, CPU is over-provisioned by 3.3x and memory by 2.8x. The cost savings from right-sizing both resources while maintaining a 20% headroom above p95 usage is approximately 50-60% of the current compute cost. Know this ballpark before the interview.

### Senior @ FAANG: Right-Sizing as a Continuous Platform Function

At L6, the right-sizing analysis in this exercise is not a one-time calculation but a continuous platform function. The platform queries Kubernetes metrics (via the metrics API) and cloud billing data weekly, computes the over-provisioning ratio for every service, and generates a prioritized right-sizing report sorted by monthly savings potential. Service teams receive automated PRs with the recommended resource request changes, which they review and merge during their weekly engineering hygiene time. The platform tracks adoption rate (what fraction of recommended right-sizing PRs are merged within 30 days) as a FinOps maturity metric reported to engineering leadership quarterly.


---

### Advanced Cost Instrumentation Exercises


1. **Measure Cost Per Feature with Prometheus Unit Economics**: Instrument a Go service so that you can compute the cost per business transaction. Add a Prometheus counter that increments once per successful order, API call, or user action. Tag the Kubernetes namespace with a `cost-center` label, and write a PromQL expression that divides the estimated hourly cloud cost (stored as a Prometheus gauge updated by an external metrics source) by the transaction rate. Document your methodology and identify which service component contributes the most cost per transaction.

2. **Right-Size Kubernetes Resources Using Observed Metrics**: Deploy a Go service with intentionally over-provisioned resources (e.g., 2 CPU and 2Gi memory for a service that uses 0.1 CPU and 150Mi at peak). Run a realistic load test with `k6` or `hey` to establish a steady-state usage profile. Use Kubernetes Vertical Pod Autoscaler in recommendation mode and compare its suggestions to your own analysis of `container_cpu_usage_seconds_total` and `container_memory_working_set_bytes`. Apply the right-sized values, re-run the load test to confirm no performance regression, and calculate the monthly cost saving assuming the service runs 10 replicas in production.

3. **Profile and Optimize Go Memory Allocations for Cost Reduction**: Use `go tool pprof` to capture a heap profile from a running Go service under load. Identify the top three allocation sites by cumulative bytes. For each site, apply at least one technique: `sync.Pool` for frequently allocated structs, pre-allocated slices with `make([]T, 0, knownCap)`, or struct field reordering to reduce padding. Re-benchmark with `go test -bench=. -benchmem` and confirm allocations per operation dropped by at least 20%. Correlate the Go-level improvement with a reduction in `container_memory_working_set_bytes` under the same load and estimate the resource request reduction now justified.

4. **Implement Cost-Aware Autoscaling**: Configure a Horizontal Pod Autoscaler that scales on a custom Prometheus metric (requests per second per pod) rather than CPU utilization. Set a target value that keeps each pod at 70% of its tested maximum throughput. Add `minReplicas` and `maxReplicas` budget caps and configure scale-down stabilization to prevent thrashing. Run a load pattern that ramps up over 5 minutes, sustains peak for 10 minutes, then ramps down. Record pod starts and stops, calculate compute cost for the period, and compare it to what the cost would have been with a fixed replica count sized for peak load.

5. **Build a Cost Dashboard and Budget Alert**: Create a Grafana dashboard combining cost and performance signals. Required panels: estimated hourly spend derived from replica count × instance cost. Cost per 1,000 transactions over a rolling 1-hour window. Memory efficiency (working set ÷ memory request). CPU efficiency (average usage ÷ CPU request). And a time series showing cost efficiency before and after your right-sizing exercise. Configure a Grafana alert that fires when estimated daily spend exceeds a configurable threshold, sending a Slack notification that includes the current spend value and identifies which panel to investigate first.

6. **Audit and Eliminate External API Cost Waste**: Instrument all outbound HTTP calls in a Go service using a shared `http.Client` wrapper that records call count, latency, and estimated cost per call (configured as a per-provider rate) via Prometheus labels. Run the service under representative traffic for one hour and identify the top three most expensive external call sites by total estimated cost. For each, implement one of: response caching with TTL, request batching, or client-side deduplication. Re-run the same traffic pattern, quantify the cost reduction as a percentage, and verify that p99 latency did not regress.

### Junior → FAANG: Exercise Priority for Maximum Interview Preparation Value

Complete exercises 2 (right-sizing with VPA) and 3 (memory profiling for cost reduction) first. These exercises produce concrete, quantifiable results (monthly cost saving from right-sizing, allocation reduction percentage from profiling) that can be cited directly in behavioral interview questions. "Tell me about a time you reduced infrastructure costs" answered with specific numbers from these exercises is far more credible than a generic answer about cost awareness.

Exercise 5 (cost dashboard) is the third priority. Building a Grafana dashboard that combines cost and performance signals demonstrates the unit economics thinking that FAANG interviewers look for in senior candidates.

### Senior @ FAANG: Exercises as Platform Validation and Team Onboarding

At L6, exercises 4 (cost-aware autoscaling) and 6 (external API cost audit) define the required state for any service that makes significant external API calls or handles variable traffic. The autoscaling exercise should become the platform's HPA configuration template, with the custom metric approach replacing the default CPU-based autoscaling for all services where the correlation between request throughput and CPU is weak (which is most I/O-bound services). The external API cost audit exercise should become a required step in any new service's launch checklist: before going to production, run the audit for one hour under staging traffic and confirm that external API costs are within the projected budget range. Services that skip this step routinely exceed their external API cost budgets within the first month of production traffic.
