## 102F.10 Interview Questions

**Q1: What is platform engineering and how does it differ from DevOps and SRE?**

Platform engineering builds internal products (tools, APIs, platforms) that increase developer productivity by reducing cognitive load. DevOps is a cultural movement breaking silos between development and operations, focused on CI/CD, automation, and shared responsibility. SRE applies software engineering to operations - reliability targets, error budgets, toil reduction. The key distinction: SRE maintains production reliability, DevOps changes how teams collaborate, platform engineering builds products for developers. A platform engineer's customer is the internal developer. Success metric: developer NPS, time-to-first-deployment, self-service adoption rate.

---

**Q2: What is cognitive load in the context of platform engineering?**

Cognitive load theory (John Sweller): working memory is limited. Intrinsic load = complexity inherent in the task. Extraneous load = complexity from poor design. Germane load = processing that builds expertise. Platform engineering eliminates extraneous cognitive load - Kubernetes YAML configuration, CI/CD pipeline setup, networking rules, security configuration. These are necessary but don't make developers better at their domain. A golden path template pre-configures all this so developers focus on domain problems (intrinsic load) rather than infrastructure mechanics (extraneous load).

---

**Q3: What is Backstage and what problem does it solve?**

Backstage is an open-source developer portal (built by Spotify, now CNCF). It solves the "software entropy" problem in large organizations: as the number of services grows, no one knows what exists, who owns it, how it works, or where its documentation is. Backstage provides: (1) Software Catalog - single registry of all services, libraries, APIs, with ownership, documentation links, and health metrics. (2) TechDocs - auto-generated documentation from Markdown in each repo. (3) Scaffolder - create new services from templates with pre-configured CI/CD, K8s manifests, and catalog registration. (4) Plugins ecosystem - integrates with 200+ tools (GitHub, PagerDuty, Grafana, Jira).

---

**Q4: What is the golden path pattern? How do you design one?**

A golden path is the complete, opinionated set of tools and processes for the most common use case - designed to be easier than building it yourself. Design process: (1) identify the common case (e.g., "Go service with PostgreSQL"). (2) define all components (repository template, CI/CD pipeline, Kubernetes manifests, Helm chart, database provisioning, observability configuration). (3) package as a Backstage template or CLI tool. (4) ensure it produces a production-ready result - not just a skeleton that still requires manual steps. (5) update the golden path as best practices evolve - all services pick up improvements automatically. Key principle: make the golden path the path of least resistance, not a restriction.

---

**Q5: How does Crossplane enable self-service infrastructure?**

Crossplane extends Kubernetes with cloud resource management. It defines custom resources (CompositeResourceDefinitions) that map developer-facing abstractions to real cloud resources. A developer creates a `PostgreSQLInstance` YAML in Kubernetes. Crossplane's composition creates the VPC security group, subnet group, parameter group, and RDS instance. The developer only provides: storage size, instance class, and receives connection credentials as a Kubernetes Secret. Benefits: RBAC on infrastructure requests (teams can only create certain types), GitOps for infrastructure (database YAML committed to Git), uniform API regardless of cloud provider, status tracking via Kubernetes.

---

**Q6: What DORA metrics should a platform team track?**

DORA metrics measure software delivery performance: (1) Deployment Frequency - platform goal: increase from weekly to daily for all teams. (2) Lead Time for Changes - platform goal: reduce from days to hours via automated pipelines. (3) Mean Time to Recovery - platform goal: provide runbook automation and deployment rollback tooling to reduce MTTR. (4) Change Failure Rate - platform goal: reduce via automated testing integration and canary deployment support. Platform-specific additions: time to onboard new service, self-service adoption rate (% of resources provisioned without platform team involvement), developer NPS score, platform availability (SLO).

---

**Q7: How would you implement preview environments for a team with 50+ services?**

Preview environments at scale require automation: (1) ArgoCD ApplicationSet with Pull Request generator creates environments automatically when PRs open. (2) each preview environment gets a dedicated namespace (`preview-pr-{number}`) with TTL annotation for auto-cleanup. (3) shared dependencies (databases, Redis) are mocked or use lightweight alternatives (SQLite, in-memory) to reduce cost. (4) DNS wildcard: `*.preview.myorg.com` routes to the preview ingress. (5) ArgoCD label selector limits which services get preview environments - not all 50 services need previews for a backend-only change. (6) Cost guardrails: scale-to-zero after 2 hours of inactivity, delete after 24 hours.

---

**Q8: What is the "platform as a product" mindset?**

Treating the platform as an internal product means: it has customers (developers), a product roadmap (based on customer feedback), release notes (changelog), SLAs (uptime guarantees), and a feedback loop (surveys, office hours, Slack channel). Anti-patterns: building features nobody asked for, no adoption tracking, treating platform work as maintenance rather than product development, no versioning or backward compatibility guarantees. Best practice: the platform team runs a quarterly developer survey, publishes public roadmap, tracks adoption metrics weekly, and holds "platform office hours" where developers can ask questions and provide feedback directly.

### Junior → FAANG: How to Study These Q&A Pairs

These eight questions represent the core vocabulary test for platform engineering roles at mid-size to large companies. For junior roles, depth is not required for every question, but breadth is: you should be able to give a coherent 90-second answer to each one without stumbling on terminology.

The most important question for a junior entering a platform role is Q2 (cognitive load). Interviewers use this question to test whether you understand the purpose of the platform at a conceptual level, not just the technology. If you can explain intrinsic versus extraneous load and give a concrete example from your own experience (a time you spent hours configuring infrastructure instead of writing business logic), you have demonstrated the foundational mindset.

Q4 (golden path design) is a practical design question. Practice sketching a golden path for a Go HTTP service with PostgreSQL: list every component (repository, CI workflow, Dockerfile, Kubernetes manifests, Helm chart, database claim, observability configuration), and explain how each is pre-configured so the developer gets a production-ready service without manual steps. The ability to enumerate this list fluently shows you have thought concretely about what "golden path" actually means.

Q7 (preview environments) is the most technically complex question here and is appropriate for mid-level interviews. The key concepts to cover: ArgoCD ApplicationSet with PR generator for automatic environment creation, TTL annotations for cleanup, wildcard DNS routing, cost controls via scale-to-zero. Knowing that preview environments at scale require all of these is more important than knowing the exact YAML syntax.

### Senior @ FAANG: What Bar-Raisers Look for Beyond the Surface Answers

For L6 and above interviews, these questions are prompts for deeper discussion, not checklist items. A bar-raiser will take any answer and probe the edge cases, failure modes, and organizational trade-offs.

For Q1 (distinguishing DevOps, SRE, platform engineering): a bar-raiser will follow up by asking how these three functions interact at scale. The nuanced answer is that in a mature organization, the platform team builds the infrastructure that makes DevOps practices operationally feasible (CI/CD pipelines, deployment tooling), while the SRE function defines and enforces the reliability standards that the platform must meet. The platform team and SRE team collaborate on platform SLOs: SRE defines the targets, the platform team instruments and reports against them.

For Q5 (Crossplane and self-service infra): the bar-raiser question is "what is the failure mode when the Crossplane controller is unavailable?" If developers cannot provision databases because the controller is down, the platform has a single point of failure that blocks product team work. The sophisticated answer addresses this: the platform team should define an SLO for the Crossplane control plane, have a runbook for controller recovery, and design the developer experience so that transient controller unavailability does not cause permanent failure (claims persist in etcd and are reconciled when the controller recovers).

For Q8 (platform as a product): the bar-raiser question at FAANG is "how do you handle a disagreement between what the platform team wants to build and what developers say they need?" This is a product management question embedded in an engineering interview. The expected answer covers: a structured process for capturing and prioritizing developer feedback, a principle that high-adoption requests take priority over technically interesting but low-adoption features, and a mechanism for escalating unresolved disagreements (quarterly planning review with engineering leadership).
