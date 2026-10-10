## 102N.20 FinOps Anti-Patterns & Production Pitfalls

FinOps anti-patterns are expensive and surprisingly common. These are the five highest-impact ones, each with a concrete solution.

### Anti-Pattern 1: Treating FinOps as a Finance Problem

**Mistake**: FinOps is delegated entirely to finance or procurement. Engineers never see cost data, make architecture decisions without cost context, and treat quarterly billing reports as someone else's concern.

**Consequence**: Cloud costs grow 30-50% faster than revenue. Cost optimization is batched into quarterly "finance sprints" that engineers resent.

**Solution**: Embed `cost_per_request_usd` in engineering dashboards alongside latency and error rate. Include cost impact in architecture reviews. Give each team ownership of its AWS budget. FinOps is an engineering discipline - finance provides the framework. Engineers provide the leverage.

---

### Anti-Pattern 2: Over-Provisioning Kubernetes Resource Requests

**Mistake**: Requests are set conservatively: `cpu: 2000m, memory: 4Gi` for services routinely using `cpu: 80m, memory: 180Mi`. Kubernetes schedules on *requests* not actual usage, so nodes fill up on paper while running at 10% real utilization.

**Consequence**: A 100-node cluster doing work that 25 nodes could handle - 4x the compute cost.

**Solution**: Deploy VPA in recommendation mode. Set requests to `p95_observed * 1.3`. Never equate requests and limits (prevents bursting). Use `LimitRange` to cap per-pod maximums per namespace.

---

### Anti-Pattern 3: Forgotten Development Resources

**Mistake**: Engineers create RDS instances, NAT Gateways, and EC2 instances for feature branches and forget to delete them. Staging runs 24/7 at production scale.

**Consequence**: 20-35% of cloud spend on idle or near-idle development resources.

**Solution**: Apply a `ttl` tag to every non-production resource. Run a nightly Lambda that terminates EC2 instances and pauses RDS clusters tagged `environment: dev` outside business hours. Set a hard budget alert at $500/month on the dev account.

---

### Anti-Pattern 4: Ignoring Data Transfer Costs

**Mistake**: Services in different AZs exchange large payloads. Logs stream to S3 over the internet. Assets are served directly from S3 at full egress rates. Nobody audits the `DataTransfer` line item.

**Consequence**: Data transfer becomes the second or third largest cost category - a regular monthly surprise.

**Solution**: Audit data transfer in Cost Explorer quarterly. Enforce: same-AZ colocation for services exchanging > 1 GB/day. VPC endpoints for S3, DynamoDB, ECR. CloudFront for static assets. gzip/zstd on internal APIs. PrivateLink for cross-account communication.

---

### Anti-Pattern 5: Committing to Reserved Instances Too Early

**Mistake**: Buying 3-year RIs after 6 weeks in production. Six months later, the team migrates to Fargate. RIs go unused. Marketplace resale recoups only 60-80% of remaining value.

**Consequence**: Locked spend, reduced architectural flexibility, finance loses trust in engineering cost commitments.

**Solution**: Wait 3 months of stable production traffic before committing. Prefer Compute Savings Plans over RIs - they cover any instance type, region, size, and Fargate. Cover only 60-70% of minimum observed baseline. Review SP utilization monthly. Never commit 3-year terms for workloads that may be re-architected.

---

### Junior → FAANG: Anti-Pattern Recognition as Interview Signal

The ability to recognize FinOps anti-patterns without prompting is a strong interview signal. When reviewing an architecture diagram or infrastructure configuration, identifying "this design has cross-AZ traffic between the application tier and the database tier" or "this Lambda function is configured with 3GB of memory but processes small JSON events" without being asked demonstrates the cost-aware engineering mindset that FAANG infrastructure interviews test.

The Savings Plans over-commitment anti-pattern is particularly important for interviews: many engineers assume more Savings Plans coverage is always better. The correct insight is that Savings Plans commitments have a utilization breakeven point: if you commit to more capacity than your baseline usage, you pay for unused capacity. The organizational rule (cover only 60-70% of minimum observed baseline, leave the rest on-demand) provides the buffer for workload variability without over-committing. An interview candidate who can explain this tradeoff without prompting signals production experience with commitment purchasing.

### Senior @ FAANG: Anti-Pattern Prevention as Platform Policy

At staff level, each anti-pattern in this section maps to a platform enforcement mechanism. Untagged resources: enforce via AWS Config rules or SCPs that deny resource creation without required tags. Cross-region data transfer: detect via Cost Explorer dimension filtering on data transfer costs and alert when cross-region transfer exceeds a threshold. Over-committed Savings Plans: detect via Savings Plans utilization reports and alert when utilization drops below 80%. Single-tenant waste: enforce multi-tenancy via platform policies that require shared infrastructure (load balancers, NAT gateways, bastion hosts) to be organizational or team-level resources rather than per-service resources.

The organizational governance framework for anti-patterns: classify each anti-pattern by detection method (automated vs. manual review), enforcement mechanism (hard block vs. soft alert), and remediation timeframe (immediate vs. next sprint vs. next quarter). Automated detection with hard block (SCP denying untagged resources) handles the highest-impact anti-patterns at scale without platform team involvement. Manual review with soft alert (weekly cost anomaly report flagging cross-region transfer spikes) handles anti-patterns that require context before remediation. This classification prevents the common failure mode of trying to automate enforcement for anti-patterns that require contextual judgment, which produces false positives and alert fatigue.
