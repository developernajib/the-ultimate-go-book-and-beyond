## 102N.9 FinOps Core Interview Questions

**Q: How do you implement cost chargeback for a multi-team cloud environment?**

A: (1) Enforce mandatory cost allocation tags (Team, Project, Environment, CostCenter) via AWS SCPs or GCP Organization Policies. (2) Query Cost Explorer API grouped by tag. (3) Handle untagged resources with allocation rules (equal split, usage-proportional, or custom weights). (4) Generate monthly reports and send to team leads. (5) Build a dashboard for self-service visibility. Key challenge: shared infrastructure (networking, monitoring) needs explicit allocation rules.

**Q: What's the most common source of surprise cloud bills?**

A: Data transfer, specifically: (1) NAT Gateway charges ($0.045/GB) for traffic to AWS services - solved with VPC endpoints. (2) Cross-region replication - often overlooked in multi-region designs. (3) API Gateway or ALB data processing fees. (4) CloudWatch Logs ingestion - verbose logging in production. (5) RDS snapshot storage exceeding database size. Monitor all of these with Cost Anomaly Detection.

**Q: How do Savings Plans differ from Reserved Instances?**

A: Reserved Instances commit to a specific instance type in a specific region/AZ (less flexible). Savings Plans commit to a dollar/hour usage amount: Compute Savings Plans apply to any EC2 instance type, region, OS, Fargate, and Lambda - most flexible. EC2 Instance Savings Plans apply to a specific instance family in a region. Both offer 30-40% savings over on-demand for 1-year term, up to 66% for 3-year.

---

### Junior → FAANG: FinOps Interview Questions as Cost Literacy Test

The interview questions in this section are used to evaluate cost literacy, not just technical knowledge. "How do you implement cost chargeback?" is a test of whether you understand the data flow (tagging to cost allocation to internal billing) and the organizational challenges (disputed allocations, shared resource attribution) rather than just the AWS API calls. The strongest answers combine the technical implementation with an acknowledgment of the organizational challenges.

The Savings Plans vs. Reserved Instances question is a common cost interview test. The key differentiator: Compute Savings Plans are portable across instance type, region, OS, and apply to Fargate and Lambda. EC2 Instance Savings Plans are scoped to an instance family in a region. Reserved Instances are scoped to a specific instance type in a specific AZ (or region for regional RIs). The right answer for most organizations is Compute Savings Plans for their baseline commit, because the portability allows the commitment to automatically cover workloads that migrate to different instance types or regions without purchasing new commitments.

### Senior @ FAANG: FinOps Bar-Raiser Interview Signals

Bar-raiser signals in FinOps interviews at the senior and staff level: the ability to distinguish between cost reduction (spending less on the same workload) and cost efficiency (getting more value per dollar spent). A candidate who only discusses cost reduction is thinking tactically. A candidate who discusses cost efficiency in terms of unit economics (cost per request, cost per transaction, cost per active user) is thinking strategically.

The highest-signal answer to "how do you build a FinOps culture?" is not about tooling but about incentive design: visibility (teams can see their cost in real time), accountability (cost is a metric in engineering reviews), autonomy (teams can optimize their infrastructure without waiting for a central team), and recognition (cost efficiency improvements are celebrated alongside feature delivery). Tooling enables all four of these but does not create them. The staff engineer who understands this distinction is thinking about the organizational system, not just the technical system, which is the level of thinking that principal engineer roles require.
