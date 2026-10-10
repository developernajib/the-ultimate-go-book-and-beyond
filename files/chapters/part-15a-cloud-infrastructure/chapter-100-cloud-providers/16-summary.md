## Summary

- **SDK initialization**: Create provider clients once at startup and reuse them - they manage connection pooling and credential refresh internally.
- **IAM roles over static credentials**: Assign IAM roles or workload identity to compute resources. Never embed access keys in code, configs, or container images.
- **Context-based cancellation**: Pass `context.Context` to every SDK call to enforce timeouts and propagate cancellation across cloud service boundaries.
- **Pagination handling**: Cloud list APIs are paginated. Always iterate with paginators or `Next()` loops to avoid silently truncated result sets.
- **Exponential backoff and retries**: Configure SDK retry behavior with jitter. Wrap calls in circuit breakers for resilience against transient cloud-side failures.
- **Presigned URLs**: Generate short-lived presigned URLs for direct client-to-storage transfers, eliminating your service as a data-transfer proxy and reducing egress costs.
- **Encryption at rest and in transit**: Enable SSE-KMS or CMEK on all storage resources and ensure all SDK calls go over TLS. Never disable certificate verification.
- **Multi-region architecture**: Replicate critical data across regions and design failover paths. Use global load balancers and health checks to route around regional outages.
- **Cost optimization**: Use Spot/Preemptible instances for fault-tolerant workloads (up to 90% savings), enable intelligent storage tiering, and implement scale-to-zero where applicable.
- **Managed services over self-hosted**: Prefer managed databases, queues, and caches to reduce operational toil. reserve self-hosted options for strict compliance or performance requirements.

### Junior → FAANG: This Summary as a Cloud Readiness Assessment

These bullet points define production-ready cloud usage for a Go service. Before shipping any cloud-integrated service, verify each point: are credentials sourced from the instance role (not hardcoded)? Is retry logic configured correctly for each SDK client? Are API calls instrumented with traces and latency metrics? Is the IAM policy scoped to exactly the permissions needed?

The managed-services-over-self-hosted principle is especially important for first-job engineers who may be tempted to run databases in containers because it seems simpler to configure. RDS, Cloud SQL, and their equivalents provide automated backups, point-in-time recovery, automated minor version updates, and high availability with read replicas, none of which you get for free when running a database in a container.

### Senior @ FAANG: Summary as a Cloud Governance Framework

At L6/L7, this summary is the foundation of a cloud governance framework. Each bullet point maps to one or more governance controls: mandatory tags enforced by cloud policy, IAM least-privilege enforced by policy analyzer tooling, encryption enforced by Service Control Policies or Organization Policy Constraints, and cost optimization enforced by budget alerts and quarterly reviews.

The governance framework answers the organizational question "how do we ensure every team uses cloud services correctly?" not by relying on individual teams to read documentation, but by making the correct behavior the default and the incorrect behavior fail-fast through automated enforcement. This is the platform team's responsibility, and owning it is an L6/L7 contribution that scales with the organization.

*Next: [Chapter 101: Kubernetes Operators](../chapter-101-kubernetes-operators/00-introduction.md)*
