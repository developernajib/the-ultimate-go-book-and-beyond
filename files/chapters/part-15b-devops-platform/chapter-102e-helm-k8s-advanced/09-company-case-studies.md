## 102E.7 Real-World Case Studies: Kubernetes at Scale

### Spotify - Backstage and Helm at Scale

Spotify manages 2000+ microservices using Helm charts with their Backstage platform as the service catalog. Every service at Spotify has a standardized Helm chart generated from a golden template.

**Golden chart pattern**: Spotify's Platform Engineering team maintains a "golden Helm chart" that all services derive from. Services don't write their own Helm charts - they provide only a `values.yaml` with their specific configuration. The golden chart handles: service discovery, observability sidecar injection, network policies, resource limits, PDBs, and security contexts. When the platform team improves the golden chart (adding a new security feature, updating default resource limits), all 2000 services pick up the improvement on their next deploy.

**Helm chart versioning**: Chart version and app version are tracked separately. Chart version bumps trigger re-evaluation of all services using that chart version. Dependabot-like automation creates PRs to update chart versions across service repos.

---

### Airbnb - Admission Webhooks for Compliance

Airbnb uses mutating and validating admission webhooks extensively to enforce platform standards without requiring each team to implement them manually.

**Resource limit enforcement**: A validating webhook rejects any Pod missing resource limits. Before the webhook, teams would occasionally deploy without limits, causing OOM kills that affected neighbors in the same namespace. The webhook prevented approximately 20 production incidents per quarter.

**Sidecar injection**: A mutating webhook injects their observability sidecar (metrics collection, log forwarding, distributed tracing) into every Pod with the annotation `airbnb.io/observability: enabled`. Teams opt in by adding the annotation - the sidecar implementation is managed by the platform team, transparent to service owners.

**OPA Gatekeeper policies**: Beyond Go webhooks, Airbnb uses OPA Gatekeeper for policy-as-code: required labels, allowed image registries, prohibited hostPath mounts. Policies are committed to Git and applied via GitOps - policy changes are reviewed and auditable.

---

### Pinterest - KEDA for Cost Optimization

Pinterest processes billions of Pin interactions daily using worker services that scale to zero during off-peak hours (3-6 AM Pacific). Without KEDA, they kept workers running at minimum 2 replicas 24/7. With KEDA scaling to zero, they save 40% on worker compute costs.

**Implementation**: recommendation-precompute workers consume from Kafka. KEDA monitors consumer lag. When lag drops to zero (queue empty), KEDA scales workers to 0 after the cooldown period (30 minutes). When a user shows up at 4 AM and triggers recommendations, the first request experiences ~30 second cold start latency (pod scheduling + image pull + app startup). For an async precomputation use case, this is acceptable.

**The 0-to-1 problem**: Scaling from 0 requires KEDA to start at least 1 pod when it detects activationLagThreshold messages. Setting this to a small value like 5 messages (any activity) rather than 0 is the standard choice. The first messages processed may experience higher latency as the pod starts, but this is handled by the Kafka consumer group timeout mechanism.

### Junior → FAANG: Learning From Case Studies as Interview Preparation

The three case studies here are not just trivia. They each illustrate a specific engineering judgment call that interviews probe: Spotify's golden chart pattern shows why you centralize standards rather than trust each team to apply them independently. Airbnb's webhook-enforced resource limits show why automation beats documentation for policy compliance. Pinterest's KEDA scale-to-zero shows that the right architecture depends on the acceptable latency budget, not just the cost savings.

When you read a case study, extract the engineering principle behind the business outcome. The Airbnb statistic of "20 production incidents prevented per quarter" is the kind of concrete business impact framing that FAANG interviewers want to hear when they ask "tell me about a platform improvement you drove." Even if you have not worked at Airbnb, you can apply this framing to work you have done: what problem existed, what automated enforcement you built, and what measurable outcome followed.

The Pinterest cold-start story is important for any interview question about trade-offs. Scale-to-zero is not free. It trades idle compute cost for first-request latency. Knowing that this trade-off exists, knowing how to quantify both sides (cloud cost versus P99 latency SLO impact), and knowing when each side of the trade-off dominates is the kind of nuanced judgment that separates mid-level from senior interview performance.

### Senior @ FAANG: Platform Patterns as Organizational Design

At L6/L7, these case studies are interesting for what they reveal about organizational structure, not just technical architecture. Spotify's golden chart pattern only works because the Platform Engineering team has organizational authority to define and maintain the standard, and application teams have accepted the constraint of not writing their own charts. That is a governance arrangement, not just a technical one. The platform team invested in making the golden chart good enough that teams prefer it to writing their own. That is a product management mindset applied to internal tooling.

Airbnb's webhook approach scales because the policy enforcement is decoupled from the teams being enforced. Each team does not need to know about or comply with the resource limit policy explicitly. The webhook enforces it invisibly. This is the platform engineering ideal: make the right behavior automatic rather than relying on team compliance with documented standards. The corollary is that every place where your platform relies on teams following a runbook is a future incident waiting to happen.

The Pinterest scale-to-zero architecture surfaces a platform thinking question: who owns the cold start latency budget? The platform team provides KEDA as a capability. But the decision to use scale-to-zero for a specific workload is an application team decision with a latency consequence for the business. At staff level, the platform team's job is to expose the trade-off clearly, provide tooling to measure cold start latency, and set organizational guidelines for which workload categories are appropriate for scale-to-zero. The decision itself belongs to the teams closest to the business requirement.

---
