## 106.7 Production Pitfalls: Cost Engineering Mistakes

### Pitfall 1: Overprovisioning "Just in Case"

**Real Incident Report**: A team provisioned for 10x expected load "just in case." They ran 100 pods for a service that typically needed 10. Monthly cost: $30,000. Actual peak usage: 15 pods. They were paying 6x more than necessary for 3 years before anyone noticed.

**The Anti-Pattern**:
- Provisioning for worst-case without data
- "Better safe than sorry" for compute
- No autoscaling configured
- Never reviewing resource usage

**The Better Approach**:
```yaml
# RIGHT: Autoscaling with appropriate limits
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-service
  minReplicas: 3      # Handle baseline load
  maxReplicas: 50     # Handle peak
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

---
# Also use VPA for right-sizing recommendations
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-service-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-service
  updatePolicy:
    updateMode: "Off"  # Just recommendations, don't auto-apply
```

**Key Insight**: Autoscaling is cheaper than overprovisioning. Configure HPA and use VPA recommendations to right-size.

### Pitfall 2: Not Accounting for Go's Memory Characteristics

**Real Incident Report**: A team set memory limits based on active heap size (50MB). In production, the Go runtime's GC delayed collection, heap grew to 2x, and pods were OOM-killed. They didn't account for Go's default GC behavior.

**The Anti-Pattern**:
```yaml
# WRONG: Memory limit based on heap size alone
resources:
  limits:
    memory: "64Mi"  # Just enough for heap... or so they thought
# Go GC lets heap grow to 2x before collecting
# Result: OOM killed
```

**The Better Approach**:
```yaml
# RIGHT: Account for Go memory behavior
resources:
  requests:
    memory: "128Mi"  # Scheduling guarantee
  limits:
    memory: "256Mi"  # 2x request for GC headroom

# Also set GOMEMLIMIT to help Go manage memory
env:
- name: GOMEMLIMIT
  value: "200MiB"  # Less than limit, gives Go target
- name: GOGC
  value: "50"      # More frequent GC, lower memory
```

```go
// In code, use soft memory limit
import "runtime/debug"

func init() {
    // Tell Go to target memory usage
    debug.SetMemoryLimit(200 * 1024 * 1024) // 200MB
}
```

**Key Insight**: Go's GC by default lets heap grow to 2x before collecting. Set `GOMEMLIMIT` and configure limits accordingly.

### Pitfall 3: Ignoring Egress Costs

**Real Incident Report**: A service made 10 million requests/day to an external API and shipped every full response to an external logging platform. Each response was 30KB. Egress cost: $0.09/GB × 300GB/day = $27/day = $810/month, before the logging platform's own ingest fees. Nobody noticed until the monthly bill surprised finance.

**The Anti-Pattern**:
- Logging full responses
- No compression for external traffic
- Cross-region traffic without awareness
- Not monitoring egress

**The Better Approach**:
```go
// RIGHT: Minimize egress, compress, log smart

// Don't log full responses
log.Info("API response received",
    "status", resp.StatusCode,
    "bytes", len(body),
    // NOT: "body", string(body),
)

// Compress external traffic
client := &http.Client{
    Transport: &http.Transport{
        DisableCompression: false,  // Enable compression
    },
}
req.Header.Set("Accept-Encoding", "gzip")

// Monitor egress
egressBytes.Add(float64(len(body)))
```

```yaml
# Set up egress monitoring
- alert: HighEgressCost
  expr: |
    sum(rate(egress_bytes_total[1h])) * 3600 * 24 * 30 * 0.09 / (1024*1024*1024) > 500
  for: 1h
  annotations:
    summary: "Projected monthly egress cost exceeds $500"
```

**Key Insight**: Egress is invisible until the bill arrives. Monitor bytes out, especially to external services.

### Pitfall 4: Spot/Preemptible Without Graceful Handling

**Real Incident Report**: A team switched to spot instances for 70% savings. The first time instances were reclaimed, 80% of their pods died simultaneously. No graceful shutdown, no draining, no distribution across pools. The savings weren't worth the outage.

**The Anti-Pattern**:
```yaml
# WRONG: All pods on spot, no protection
nodeSelector:
  kubernetes.io/os: linux
  node.kubernetes.io/instance-type: m5.large
tolerations:
- key: "spot"
  operator: "Equal"
  value: "true"
# All pods on spot, all killed when reclaimed
```

**The Better Approach**:
```yaml
# RIGHT: Mixed pools with graceful handling
spec:
  replicas: 10
  template:
    spec:
      topologySpreadConstraints:
      - maxSkew: 2
        topologyKey: "node.kubernetes.io/instance-lifecycle"
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: my-app
      # Spread across spot and on-demand

      terminationGracePeriodSeconds: 90
      # Handle termination notice (spot gives 2 min warning)

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: my-app
              topologyKey: "kubernetes.io/hostname"
```

**Key Insight**: Spot instances require distribution and graceful shutdown. Never put all replicas on spot without handling reclamation.

### Pitfall 5: Not Setting Cost Budgets

**Real Incident Report**: A team's data pipeline had a bug that caused infinite retries to a pay-per-request API. Over a weekend, they made 50 million API calls. Monday's bill: $250,000. No budget alert existed to catch the runaway spend.

**The Anti-Pattern**:
- No budget alerts
- No spend caps
- Runaway processes without limits
- Cost reviewed monthly, not daily

**The Better Approach**:
```hcl
# Terraform: AWS budget alert
resource "aws_budgets_budget" "monthly" {
  name         = "monthly-service-budget"
  budget_type  = "COST"
  limit_amount = "10000"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator = "GREATER_THAN"
    threshold          = 50
    threshold_type     = "PERCENTAGE"
    notification_type  = "ACTUAL"
    subscriber_email_addresses = ["team@example.com"]
  }

  notification {
    comparison_operator = "GREATER_THAN"
    threshold          = 80
    threshold_type     = "PERCENTAGE"
    notification_type  = "ACTUAL"
    subscriber_email_addresses = ["team@example.com", "oncall@example.com"]
  }
}
```

```go
// In code: rate limiting for pay-per-use APIs
limiter := rate.NewLimiter(rate.Limit(100), 100) // 100 req/sec max
if err := limiter.Wait(ctx); err != nil {
    return err
}
// Make API call
```

**Key Insight**: Runaway costs happen fast. Budget alerts at 50%, 80%, and 100% give you time to react before disaster.

### Quick Reference: Cost Engineering Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Overprovision "just in case" | 6x actual cost needed | HPA + VPA for right-sizing |
| Ignore Go memory behavior | OOM kills, over-requests | GOMEMLIMIT, 2x limit vs request |
| Ignore egress | Surprise $800/month | Monitor egress, compress, log less |
| Spot without protection | Mass pod death on reclaim | Mixed pools, graceful shutdown |
| No cost budgets | $250K weekend surprise | Budget alerts at 50%, 80%, 100% |
| No unit economics | Can't predict cost at scale | Cost per request/user/transaction |

### Junior → FAANG: The Two Mistakes That Produce the Largest Surprise Bills

Of the six anti-patterns above, two produce the largest surprise costs and are worth understanding in detail before any interview.

No cost budgets is the most dangerous because it is invisible until the bill arrives. Cloud providers bill in arrears, so a runaway process, an autoscaler misconfiguration, or a logging bug can consume thousands of dollars before anyone notices. Budget alerts at 50%, 80%, and 100% of the monthly budget are the minimum. At 100%, the alert should consider whether to automatically stop non-essential workloads or to notify a cost owner to investigate immediately. Setting these up takes 30 minutes and prevents weekend surprises.

Ignoring egress is the most commonly underestimated cost for services that move data between availability zones, regions, or to external networks. A service that reads from a database in us-east-1 and writes results to an S3 bucket in us-west-2 pays cross-region data transfer costs on every byte. At high throughput, this adds up quickly. The fix is to understand your cloud provider's egress pricing before designing any data flow that crosses AZ or region boundaries.

### Senior @ FAANG: Systematic Pitfall Prevention Across the Organization

At L6, each row in this table is a candidate for automated prevention. Overprovisioning is prevented by the VPA recommendation report and the right-sizing review process. The `GOMEMLIMIT` misconfiguration is prevented by a deployment template that sets `GOMEMLIMIT` to 90% of the container memory limit by default and requires explicit documentation to override. Spot without protection is prevented by the platform's node pool configuration, which always uses mixed pools (70% Spot, 30% on-demand) and requires opt-in approval to use 100% Spot. Budget alerts are provisioned automatically by the platform's service onboarding process, with budget thresholds computed from the service's historical cost baseline or from a default for new services.

The $250K weekend surprise anti-pattern is not just a cost problem. It is a governance failure that indicates the organization lacks a cost escalation process. A mature FinOps process includes: a cost on-call rotation (or shared responsibility assignment) that receives high-severity cost alerts outside business hours, a runbook for common cost emergencies (how to kill a runaway autoscaler, how to enable S3 request logging to identify the source of unexpected API call volume, how to temporarily cap Spot instance requests), and a post-incident review process for cost incidents that follows the same format as reliability post-mortems. Treating cost incidents with the same rigor as reliability incidents is the cultural change that prevents recurrence.

---
