## 102N.8 Mid-Chapter Synthesis: FinOps Quick Reference

| Mistake | Cost Impact | Solution |
|---------|-------------|----------|
| Ignoring data transfer costs | Can exceed compute costs | Architect for same-region, use CDN |
| Uncompressed API payloads | 5-10× higher data transfer | Enable gzip compression |
| Over-provisioned RDS instances | 60-70% wasted spend | Rightsize with CloudWatch metrics |
| Missing S3 lifecycle policies | Unbounded storage growth | Always set lifecycle transitions |
| No cost allocation tags | Can't chargeback to teams | Enforce tags via SCP/policy |
| NAT Gateway for S3 traffic | $0.045/GB instead of free | Use S3 VPC endpoints |
| Multi-AZ dev/staging databases | 2× cost unnecessarily | Single-AZ for non-production |
| On-demand only (no Savings Plans) | 30-40% overspend | Purchase 1yr compute savings plans |
| Not monitoring Reserved Instance utilization | Wasted reservations | Alert on <80% RI utilization |
| Lambda with excessive memory | Higher per-ms cost | Use Lambda Power Tuning |

---

### Junior → FAANG: Mistakes Table as a Pre-Architecture Review Checklist

The common mistakes table is a pre-architecture review checklist. Before proposing any new infrastructure, verify none of these mistakes are embedded in the design. The two highest-cost mistakes for most junior engineers: unintentional cross-AZ traffic (placing a service in one AZ and its database in another without knowing it, paying $0.01/GB for all traffic between them) and missing lifecycle policies (creating an S3 bucket for logs without a lifecycle policy, accumulating years of logs at Standard storage pricing until someone notices the storage line item).

The Savings Plans mistake (on-demand only) typically does not affect junior engineers directly because Savings Plans purchases require authorization, but it is important to understand the mechanism: Savings Plans are purchased at the account or organizational level and automatically apply to matching usage. A junior engineer who understands Savings Plans can flag to their manager that a service they are building will generate consistent compute usage that qualifies for Savings Plans coverage, which is a cost-awareness signal that hiring managers value.

### Senior @ FAANG: Mistake Prevention as Platform Policy

At staff level, the mistakes table is the input to a platform policy and enforcement system. The highest-impact mistakes have automated detection paths. Missing lifecycle policies can be detected by scanning all S3 buckets for missing lifecycle configurations (using the AWS Config rule `s3-lifecycle-policy-check`). Cross-AZ traffic patterns can be detected by analyzing VPC Flow Logs for inter-AZ traffic above a threshold. On-demand spend above a threshold without corresponding Savings Plans coverage can be detected by comparing Cost Explorer on-demand spend to Savings Plans coverage rates.

The organizational posture: classify mistakes by detection difficulty and cost impact, automate detection for the high-impact/low-detection-difficulty mistakes, document and train on the remainder. Every mistake that can be detected automatically should be, because humans reliably miss them in manual reviews. The platform team's goal is to eliminate the preventable expensive mistakes from reaching production, reducing the FinOps team's workload from "find and fix expensive mistakes" to "optimize already-efficient infrastructure."
