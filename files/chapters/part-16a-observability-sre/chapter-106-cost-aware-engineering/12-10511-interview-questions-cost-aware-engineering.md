## 106.12 Interview Questions: Cost-Aware Engineering

### Q1: How would you reduce cloud costs for a Go microservices application?

**What FAANG expects:** FinOps framing: measure first (tag everything, build a cost-per-service dashboard), then optimize in order of ROI, then automate. Name the usual wins: right-sizing pods (HPA/VPA based on real utilization), Spot/Preemptible for non-critical workloads, Savings Plans/Reserved Instances for steady-state, Graviton (ARM) for 20-40% savings on supported workloads. Bonus for citing OpenCost (CNCF, Apache 2.0) as the vendor-neutral cost-allocation standard and for mentioning that Kubernetes cost is dominated by idle nodes (bin-packing + cluster autoscaler).

**Answer:**

Systematic approach in ROI order:

1. **Measure**: tag all resources by service/team/env. Install OpenCost or Kubecost in-cluster. You cannot optimize what you cannot attribute. Without this step everything else is guesswork.
2. **Right-size compute**: HPA on CPU/memory with real utilization targets (60-70%, not default 80%). VPA in recommendation mode first. 30-50% of pod requests are typically over-provisioned.
3. **Spot / Preemptible** for stateless, retriable workloads (batch jobs, CI runners, async workers). 60-90% discount vs on-demand. Pair with pod disruption budgets and fast restart.
4. **Commitments**: Savings Plans (AWS) / Committed Use (GCP) / Reserved Instances for baseline load. Compute Savings Plans beat RIs for flexibility. 1-year no-upfront is the sweet spot.
5. **ARM / Graviton**: 20-40% cheaper than x86 for Go workloads that are already clean (Go cross-compiles trivially). Benchmark before assuming.
6. **Networking**: inter-AZ data transfer is usually invisible and expensive. Pin chatty services to the same AZ or use VPC endpoints. S3 egress, NAT Gateway, and cross-region replication are the three top offenders.
7. **Storage tiering**: S3 Intelligent-Tiering for logs/metrics. Delete what has no query volume.

**Follow-ups:**
- *How do you attribute shared infrastructure cost (control plane, ingress, logging)?* Proportional allocation by namespace or by pod-hour. OpenCost does this automatically. Don't let shared infra become a "nobody's cost" line item that no one optimizes.
- *When does Spot / Preemptible bite you?* Stateful workloads, long-running jobs without checkpointing, or anything with capacity-critical SLOs during AZ-wide reclaims. Use on-demand as a fallback pool with `nodeAffinity` priorities.
- *What is the FinOps loop?* Inform (show cost per team) → Optimize (the steps above) → Operate (budget alerts, anomaly detection, monthly reviews). The FinOps Foundation calls these the three phases. They cycle continuously.

### Q2: How do you prevent a runaway query or job from blowing up your monthly bill?

**What FAANG expects:** Hard budgets + soft alerts. At query time: cost estimation before execution (BigQuery dry-run, Redshift WLM queues). At infra time: per-service budget alerts at 50/80/100% of monthly target. At job time: max-runtime + max-cost ceilings on batch jobs. Bonus for citing AWS Budgets Actions (auto-stop resources at threshold) and for mentioning that Cloud Custodian (YAML policy engine) is how large orgs enforce cost guardrails automatically.

**Answer:**

Layered controls:

1. **Pre-flight cost estimation**: BigQuery `dry_run`, Redshift concurrency scaling limits, Snowflake resource monitors. Reject or warn on queries > N GB scanned.
2. **Budget alerts**: per-service monthly budgets in AWS Budgets / GCP Billing Budgets. Alert at 50% (informational), 80% (escalation), 100% (page). Include forecasted-to-exceed alerts.
3. **Hard quotas**: service quotas per API, per-principal rate limits, Lambda concurrency caps. A single misconfigured service should not consume the org's bill.
4. **Timeboxes on batch jobs**: `ActiveDeadlineSeconds` in Kubernetes. Max execution time in workflow orchestrators (Temporal, Airflow). Pair with cost-per-invocation estimates.
5. **Automated remediation**: AWS Budgets Actions can stop/tag resources at threshold. Cloud Custodian policies enforce "no untagged resources", "terminate idle EC2 > 24h", "require encryption". YAML policy engine, runs as a Lambda.

**Follow-ups:**
- *Anomaly detection vs threshold alerts, which do you ship?* Both. Thresholds catch known-bad (50% over-budget). Anomaly detection (AWS Cost Anomaly Detection, GCP recommenders) catches unknown-bad (new service shipped, 10x usage spike) with ML baselines.
- *How do you hand off a budget breach to an engineer on a Friday evening?* Clear runbook: first identify top delta contributors (cost-explorer grouped by service/tag, usually one line item dwarfs the rest), revert/disable the offender, root-cause in business hours. Page, don't email.
- *Where does chargeback vs showback fit in?* Showback (display cost per team without billing them) is the starting point. Chargeback (actually billing the team's budget) creates real incentives but needs mature tagging and allocation. Most orgs live at showback long-term.

### Q3: When is serverless cheaper than running containers, and when is it a trap?

**What FAANG expects:** Honest framing: serverless wins at low/bursty traffic, spiky workloads, and where ops cost dominates compute cost. It loses at sustained high traffic, long-running computations, and when cold starts matter. Know the break-even: roughly, if you would run a container at > 40-60% utilization all month, containers win on raw compute. Bonus for citing the Prime Video → monolith case study (2023) where replacing a Lambda + Step Functions pipeline with a single ECS service cut costs by 90%, a canonical "when serverless is the wrong tool" example.

**Answer:**

Serverless wins when:
- Traffic is bursty or low (< 100 RPS sustained).
- Invocations are short (< 1 second) and stateless.
- You value ops reduction (no patching, no scaling config, no capacity planning).
- Event-driven glue (S3 triggers, Kinesis consumers, cron). The orchestration cost of running this yourself exceeds compute savings.

Containers / VMs win when:
- Sustained high throughput (> 40-60% constant utilization of equivalent-sized container).
- Long-running or stateful workloads.
- CPU-intensive work where cold starts destroy latency SLO.
- Egress-heavy workloads (Lambda charges per GB-second of memory × duration, and egress separately).

The Prime Video case (2023): their video-analysis pipeline hit Lambda + S3 orchestration costs so high that rewriting as a single ECS monolith cut costs 90%. Lesson: serverless orchestration across many small steps pays per-hop. A monolithic pipeline amortizes that overhead.

**Follow-ups:**
- *How do you model the break-even?* Calculate monthly cost at target throughput for both. Lambda: `(requests × duration × memory × price) + egress`. Fargate/ECS: `(vCPU × hours × price) + (memory × hours × price)`. For anything touching steady load, compute usually wins at ~40-60% utilization.
- *When do cold starts kill serverless?* Latency-SLO-bound user-facing paths under 200ms p99. Provisioned Concurrency (Lambda) and SnapStart (Java, later Python and .NET) help, but Provisioned Concurrency charges even when idle, which erases the serverless pricing advantage.
- *Fargate vs Lambda vs Cloud Run, how do you pick?* Lambda / Cloud Run for request-driven, scale-to-zero. Fargate / Cloud Run Jobs for longer-running containerized workloads without node management. EKS/ECS with nodes once you need GPU, custom kernels, or > 15-min request duration.

### Junior → FAANG: Structuring Cost-Aware Interview Answers

Cost-aware engineering questions in FAANG interviews follow a consistent structure: the interviewer describes a system with a cost problem and asks how you would diagnose and fix it. The winning answer structure is: (1) identify cost drivers (compute, storage, network, external API), (2) establish measurement (what metrics or billing data do you look at first), (3) diagnose the dominant driver (which of the four drivers is largest), (4) propose the fix (right-sizing, caching, tiered storage, serverless migration), (5) quantify the expected impact. Answers that skip the measurement step and jump directly to solutions are marked down because they demonstrate the same mistake as developers who optimize code without profiling.

The Prime Video Lambda-to-ECS case study is worth knowing in detail because it is counterintuitive. Serverless is not always cheaper. The lesson (per-hop orchestration overhead accumulates for pipeline workloads) is the kind of nuanced cost reasoning that distinguishes a prepared candidate from one who treats "use serverless" as a universal cost optimization.

### Senior @ FAANG: Bar-Raiser Signals in Cost-Engineering Interviews

A bar-raiser for an L6 candidate looks for answers that demonstrate organizational thinking rather than just technical correctness. For the right-sizing question, does the candidate mention the governance process (VPA recommendations, weekly cost review, team accountability) or only the technical mechanism (set CPU request to p95 utilization)? For the serverless question, does the candidate mention the organizational decision-making process (build-vs-buy analysis, commitment and lock-in modeling) or only the pricing calculation?

The distinguishing signal is the same as in reliability interviews: the L6 candidate proposes not just a solution for the specific problem but a system that prevents the problem class from recurring. "Set GOMEMLIMIT to 90% of the container memory limit" is an L5 answer. "Enforce GOMEMLIMIT configuration in the deployment template with a validating admission webhook that rejects containers where GOMEMLIMIT is missing or set above 95% of the memory limit" is an L6 answer that prevents the problem for every future service.

---
