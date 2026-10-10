## 106.4 Cost Monitoring

### Cost Metrics

Cost monitoring requires translating infrastructure resource consumption into dollar values that engineers can reason about. The `CostTracker` below records per-request cost estimates as Prometheus metrics, computed from the request's CPU time, memory allocation, and external API calls, enabling cost attribution at the service and endpoint level.

```go
package cost

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // Resource usage metrics for cost attribution
    cpuUsage = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "app_cpu_usage_cores",
            Help: "CPU usage in cores",
        },
        []string{"service", "team", "environment"},
    )

    memoryUsage = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "app_memory_usage_bytes",
            Help: "Memory usage in bytes",
        },
        []string{"service", "team", "environment"},
    )

    requestCost = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "app_request_cost_microdollars",
            Help: "Estimated cost per request in microdollars",
        },
        []string{"service", "endpoint"},
    )

    externalAPICost = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "external_api_cost_microdollars",
            Help: "Cost of external API calls in microdollars",
        },
        []string{"provider", "operation"},
    )

    storageCost = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "storage_cost_dollars_per_month",
            Help: "Monthly storage cost in dollars",
        },
        []string{"type", "service"},
    )
)

// Cost per request estimation
type CostEstimator struct {
    cpuCostPerHour    float64 // $/core-hour
    memoryCostPerHour float64 // $/GB-hour
}

func NewCostEstimator() *CostEstimator {
    return &CostEstimator{
        cpuCostPerHour:    0.04, // Example: AWS on-demand pricing
        memoryCostPerHour: 0.01,
    }
}

func (e *CostEstimator) EstimateRequestCost(cpuSeconds, memoryGBSeconds float64) float64 {
    cpuCost := (cpuSeconds / 3600) * e.cpuCostPerHour
    memoryCost := (memoryGBSeconds / 3600) * e.memoryCostPerHour
    return cpuCost + memoryCost
}

// Track external API costs
func TrackExternalAPICall(provider, operation string, costMicrodollars float64) {
    externalAPICost.WithLabelValues(provider, operation).Add(costMicrodollars)
}

// Example: OpenAI API cost tracking
func TrackOpenAICall(inputTokens, outputTokens int) {
    // GPT-4 pricing example: $0.03/1K input, $0.06/1K output
    inputCost := float64(inputTokens) * 0.03 / 1000 * 1000000  // microdollars
    outputCost := float64(outputTokens) * 0.06 / 1000 * 1000000
    TrackExternalAPICall("openai", "gpt-4", inputCost+outputCost)
}
```

### Junior → FAANG: Unit Economics Is the First Step in Cost Monitoring

Cost monitoring starts with unit economics: cost per request, cost per active user, cost per GB processed. Without these denominators, absolute spend numbers are uninterpretable. A service that costs $10,000 per month might be extremely efficient (if it serves 10 billion requests) or wildly wasteful (if it serves 10,000 requests). Adding a `service_cost_per_request_microdollars` metric, computed daily from the AWS Cost Explorer API and exported to Prometheus, enables dashboards that show cost efficiency trends alongside latency and error rate trends.

The microdollars unit (cost in millionths of a dollar) is the correct precision for per-request costs at high throughput. At 100,000 requests per second, a cost of $0.001 per request is $100 per second, roughly $8.6M per day. Tracking at dollar precision would show zero for most individual request samples.

### Senior @ FAANG: Cost Monitoring as an Engineering Health Signal

At L6, cost monitoring metrics are part of the same Prometheus and Grafana stack as reliability metrics. Every service dashboard includes: cost per request (trend over time), cost per unit of business value (cost per order placed, cost per active user per day), and external API cost breakdown by provider and model. These panels sit alongside the latency and error rate panels because cost regression is as important as performance regression.

The external API cost tracking pattern shown above is particularly important for services that consume LLM APIs. GPT-4 and similar models have per-token pricing that scales directly with request complexity and response length. A single prompt change that doubles the output token count doubles the API cost for every call. Without per-request API cost tracking, this regression is invisible until the monthly bill arrives. With tracking, an alert fires within hours when the rolling average API cost per request exceeds a threshold, enabling the team to roll back or optimize before the monthly cost impact accumulates.

The cost monitoring system must account for pricing changes by the cloud provider and API vendors. Hard-coding the OpenAI price per token in application code (as shown in the example) requires a code deploy every time pricing changes. The production approach is to store pricing in a configuration file that is reloaded at runtime, allowing pricing updates without service restarts.

---
