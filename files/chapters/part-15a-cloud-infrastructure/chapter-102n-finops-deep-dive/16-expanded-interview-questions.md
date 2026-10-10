## 102N.14 Expanded Interview Questions

**Q: What is FinOps and how does it apply to engineering teams?**

A: FinOps (Financial Operations) is a cultural and operational practice that brings financial accountability to cloud spending. Engineers are given visibility into the cost impact of their architectural and coding decisions. In practice this means: (1) Engineers can see cost dashboards for their services. (2) Cost metrics (`cost_per_request_usd`) are tracked alongside latency and error rate. (3) Cost impacts are evaluated during architecture review. (4) Teams have monthly budgets and are accountable for overruns. The FinOps Foundation defines three personas - Practitioner, Inform, and Optimize - and a Crawl-Walk-Run maturity model for adoption.

**Q: How do you reduce Kubernetes cluster costs without impacting performance?**

A: Four levers in order of impact: (1) Right-size resource requests using VPA recommendations - clusters are typically running at 15-40% utilization due to over-provisioned requests. (2) Enable Karpenter with consolidation policy to bin-pack pods onto fewer nodes automatically. (3) Move stateless workloads to Spot instances - 60-80% cheaper with proper interruption handling. (4) Use namespace-level cost allocation (OpenCost) to identify which teams/services are the largest cost drivers and focus optimization there. The goal is to increase average node CPU utilization from ~30% to 60-70%.

**Q: What is the trade-off between Spot instances and On-Demand?**

A: Spot instances use spare AWS capacity at 60-90% discount but can be reclaimed with a 2-minute notice when AWS needs the capacity back. On-Demand instances are always available and never interrupted but cost full price. The key design question is: can your workload tolerate interruptions? Stateless HTTP servers with graceful drain handlers work well on Spot. Stateful services (databases, ZooKeeper, Kafka brokers) should use On-Demand because they cannot checkpoint and restore state in 2 minutes. Batch jobs and ML training are ideal for Spot if they implement checkpointing. A mixed fleet - on-demand for the minimum baseline capacity, spot for scaling out - is the standard pattern.

**Q: How would you implement cost attribution for a microservices architecture?**

A: Layer the approach: (1) Tag every cloud resource with `service`, `team`, `environment`, `cost-center` tags, enforced via SCPs. (2) Use AWS Cost Explorer grouped by tag to get per-service cloud infrastructure costs. (3) For Kubernetes, deploy OpenCost and aggregate by namespace (map namespaces to services/teams). (4) For shared infrastructure (VPC, NAT Gateway, monitoring), apply allocation rules - proportional-to-usage or equal-split. (5) Build a chargeback system that combines Cost Explorer data and OpenCost data into monthly per-team reports. (6) Instrument application code with `cost_per_request_usd` metrics for per-endpoint attribution.

**Q: What is right-sizing and how do you do it for Go services?**

A: Right-sizing means selecting the cheapest instance type (or resource request) that satisfies the service's performance requirements. For Go services: (1) Profile CPU usage under production load - Go's `pprof` endpoint makes this straightforward. (2) Use CloudWatch metrics to find the 95th-percentile CPU and memory usage over a 2-week window. (3) Add a 30% headroom buffer to the observed peak. (4) Compare the resulting spec to the current instance spec using the AWS Price List API. (5) If the current instance has >50% unused capacity, downsize. For Kubernetes, use VPA in recommendation mode to get suggested requests without automatically applying changes. Common finding: Go services provisioned with 4 vCPU and 8GB memory are actually using 0.3 vCPU and 512MB due to Go's efficient concurrency model.

**Q: How does data transfer cost factor into architecture decisions?**

A: Data transfer is often the largest surprise cost category. Key design rules: (1) Keep services that communicate frequently in the same Availability Zone to avoid cross-AZ charges ($0.01/GB each direction). (2) Use S3 VPC endpoints and DynamoDB VPC endpoints to avoid NAT Gateway charges ($0.045/GB). (3) Use CloudFront or a CDN for static assets - CDN egress is cheaper than S3 direct ($0.0085/GB vs $0.09/GB). (4) Compress all API payloads (gzip/zstd) - reducing payload size by 70% reduces transfer cost by 70%. (5) For multi-region architectures, minimize cross-region data transfer by using read replicas or caches close to users. (6) Use S3 Transfer Acceleration only when the cost is justified by latency requirements.

**Q: What is a Savings Plan vs a Reserved Instance?**

A: Both provide discounts in exchange for a usage commitment. Reserved Instances (RIs) commit to a specific instance type, size, region, and OS - inflexible but straightforward. Savings Plans are newer and more flexible: Compute Savings Plans commit to a dollar/hour spend rate and apply to any EC2 instance type, any region, any OS, plus Fargate and Lambda. EC2 Instance Savings Plans commit to an instance family in a specific region but allow any size and OS within that family. Both offer ~30-40% savings for 1-year terms and up to 66% for 3-year. The recommendation for most organizations: purchase Compute Savings Plans covering ~70% of baseline on-demand spend (baseline = your predictable minimum usage), leave ~30% on on-demand for flexibility, and use Spot for burst capacity.

**Q: How do you detect and respond to a sudden cost spike in production?**

A: Three-layer approach: (1) Reactive: configure AWS Cost Anomaly Detection on all services. It uses ML to detect statistically unusual spend and sends SNS/email alerts. (2) Proactive: instrument services with unit economics metrics (`cost_per_request_usd`). A sudden spike often reflects a traffic pattern change (e.g., bot traffic hitting expensive endpoints) before it shows up in the billing console. (3) Preventive: set AWS Budgets with alerts at 50%, 80%, and 100% of monthly expected spend. When a spike is detected: check which service/resource is the driver via Cost Explorer, correlate with CloudWatch metrics (sudden CPU or network spike), check for unintended data transfer (cross-region replication turned on accidentally), and verify no unintended resource creation (runaway autoscaling, accidental large instance provisioning).

---

### Junior → FAANG: Interview Preparation Pattern for FinOps Questions

The FinOps interview questions in this section follow a pattern: each question has a factual component (what is X?) and a design component (how would you implement X?). Preparing for FinOps interviews means being ready for both components. "What is FinOps?" has a 30-second factual answer (financial accountability for cloud spend, owned by engineering teams). "How would you implement FinOps in a new organization?" requires a structured 5-minute answer covering the three phases (visibility, accountability, optimization) with specific tooling choices and organizational mechanisms for each.

The cost spike detection question is particularly common in on-call interviews, where interviewers evaluate your incident response methodology. The three-layer approach (reactive, proactive, preventive) is a good structure, but the strongest answers also include the investigation sequence: how do you narrow from "cost spike" to "specific resource or service" to "root cause"? The sequence is: Cost Explorer for service-level breakdown, CloudWatch metrics for usage correlation, resource tag search for unintended resource creation. Knowing this sequence demonstrates on-call experience, not just theoretical knowledge.

### Senior @ FAANG: FinOps Interview Design for Hiring Committees

At staff level, you may be asked to contribute FinOps interview questions for a hiring loop. Effective FinOps interview questions for senior and staff roles have three properties: they require systems thinking (not just API knowledge), they have no single correct answer (multiple defensible approaches), and they reveal organizational maturity (how the candidate thinks about cross-functional dependencies).

The best question for staff-level FinOps interviews: "Your organization is spending $5M/month on cloud infrastructure and you have been asked to reduce costs by 20% over 6 months without impacting service reliability. Walk me through your approach." This question reveals: whether the candidate starts with measurement (cost attribution, baseline) or jumps to solutions (rightsizing, Savings Plans). Whether they consider organizational factors (team buy-in, incentive alignment) or only technical factors. And whether they sequence the interventions correctly (Savings Plans purchase is highest ROI for stable workloads, rightsizing requires measurement first, architectural changes require the longest lead time). The sequence and reasoning matter more than the specific tools named.
