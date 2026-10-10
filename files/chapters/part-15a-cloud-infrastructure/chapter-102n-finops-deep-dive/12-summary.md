## 102N.10 Mid-Chapter Synthesis: Core Concepts Recap

| Topic | Key Concept |
|-------|-------------|
| Cost Explorer API | `GetCostAndUsage`, group by SERVICE/TAG, daily/monthly granularity |
| Cost allocation | Mandatory tags → Cost Explorer grouping → chargeback reports |
| Rightsizing | CloudWatch CPU/memory metrics → instance spec comparison |
| Anomaly detection | z-score on sliding window baseline. AWS Cost Anomaly Detection |
| Data transfer | NAT → VPC endpoints, cross-AZ → same-AZ. S3 lifecycle |
| Savings Plans | Compute SP: any EC2+Fargate+Lambda. 30-40% savings |
| Budgets | Set monthly limits with % alerts at 80% actual + 100% forecast |
| Storage tiering | Standard → IA (30d) → Glacier (90d) → Deep Archive (365d) |

---

### Junior → FAANG: Summary as a FinOps Interview Preparation Checklist

The summary table is a self-assessment checklist. For each row, verify you can explain the concept, implement it in code, and give a concrete example of when you would apply it. "Anomaly detection: z-score baseline comparison" should map to being able to explain the z-score algorithm, describe the sensitivity/threshold tradeoff, and give an example of a cost anomaly it would catch (a runaway Lambda function) and one it might miss (a gradual 10% month-over-month increase that stays within the baseline).

The storage tiering row is a commonly underestimated optimization. S3 Intelligent-Tiering automates this transition automatically for objects larger than 128KB, charging $0.0025/1000 objects for the monitoring fee. For S3 buckets with predictable access patterns (log archives that are accessed only for the first 30 days), manual lifecycle policies are more cost-efficient than Intelligent-Tiering because they avoid the per-object monitoring charge. Knowing when to use Intelligent-Tiering vs. explicit lifecycle policies is the kind of nuance that differentiates a cost-aware engineer from one who applies patterns without understanding the tradeoffs.

### Senior @ FAANG: FinOps Summary as a Platform Maturity Audit

At staff level, the summary table is an audit checklist for the organization's FinOps platform maturity. Evaluate each topic: does the organization have tooling that addresses it? Is the tooling used by all teams or only some? Is the outcome measured (savings realized, anomalies detected, recommendations adopted)?

A mature FinOps platform has: automated tagging enforcement (every resource tagged within 24 hours of creation or blocked from creation), cost allocation reports available to every team on demand, anomaly detection with sub-24-hour MTTD for spikes above $1K/day, rightsizing recommendations with greater than 50% adoption rate, and Savings Plans coverage above 70% of steady-state compute spend. Organizations that have all five of these in place are in the top quartile of cloud cost efficiency. Organizations that have none are spending 40-60% more on cloud than they need to. The staff engineer's FinOps contribution is advancing the organization toward the five-metric standard with a concrete, sequenced implementation plan that prioritizes the highest-ROI investments first.
