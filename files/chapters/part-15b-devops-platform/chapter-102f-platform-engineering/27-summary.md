## Summary

- **Backstage** provides a unified Internal Developer Portal that surfaces the software catalog, TechDocs, scaffolding templates, and operational health in one place - dramatically reducing context-switching and making the platform the natural home for all engineering knowledge.

- **catalog-info.yaml** is the contract between a service and the platform: it declares ownership, dependencies, APIs, and links to dashboards and runbooks - making the catalog self-maintaining without any manual data-entry workflows.

- **Custom Backstage plugins** backed by Go services enable teams to surface domain-specific data (DORA metrics, SLA burn rates, cost attribution) directly inside the catalog entity page, keeping developers in one tool rather than switching between Grafana, PagerDuty, and GitHub.

- **The Platform CLI** (`platform create`, `platform deploy`, `platform status`) abstracts infrastructure complexity behind a developer-friendly interface. It is the primary driver of golden path adoption because it makes the right way the easiest way.

- **Golden paths** succeed when the platform team treats them as products: the path must be easier than the alternative, well-documented, and continuously improved based on developer feedback - enforcement through gates alone breeds resentment and shadow IT.

- **DORA and SPACE metrics** together give a complete picture of engineering effectiveness: DORA measures delivery performance (deployment frequency, lead time, change failure rate, MTTR) while SPACE captures developer wellbeing and system efficiency (satisfaction, CI duration, onboarding time, meeting load).

- **Platform as a Product** means the platform team operates with a product mindset: internal customers, a public roadmap, quarterly planning with developer input, usage telemetry, and formally documented SLAs for every XaaS offering - the accountability structure that builds organizational trust.

- **Internal SLAs with error budget tracking** hold the platform team accountable to the same reliability standards they impose on product teams. When error budgets are exhausted, new feature work pauses in favour of reliability investment, signaling that the platform takes its own reliability seriously.

- **Shadow IT is a product signal**: when developers build their own tooling around the platform, it indicates gaps in capability, discoverability, or ergonomics - the right response is empathetic investigation and platform improvement, never top-down mandates or punitive policy enforcement.

- **Platform team KPIs** - golden path adoption rate, time-to-production, developer satisfaction eNPS, self-service rate, and CI pipeline P95 duration - should be published quarterly to the entire engineering organization as a public commitment to continuous improvement and developer productivity.

### Junior → FAANG: Building Your Platform Engineering Narrative

This extended summary is the most complete single-page description of a mature Internal Developer Platform in the chapter. Use it to build a coherent narrative for interviews.

The narrative structure that works best for junior interviews: context, problem, solution, evidence. Context: as an engineering organization grows past fifty engineers, infrastructure complexity scales faster than headcount. Problem: developers spend increasing time on extraneous tasks (Kubernetes configuration, CI setup, observability) rather than domain problems. Solution: the Internal Developer Platform abstracts this complexity through a service catalog (Backstage), golden path templates (scaffolding), self-service provisioning (Crossplane), and a developer-facing CLI. Evidence: organizations that have implemented this pattern (Spotify, Netflix, Mercado Libre) have reduced service onboarding from weeks to hours and improved deployment frequency dramatically.

The catalog-as-contract bullet point is the most testable for junior interviews. "catalog-info.yaml declares ownership, dependencies, APIs, and links to dashboards and runbooks." Know what each field is for and why self-maintenance matters (teams commit their own metadata rather than submitting to a central registry).

The shadow IT bullet point is counterintuitive but memorable: "when developers build their own tooling around the platform, it indicates gaps in capability, discoverability, or ergonomics." This reframes shadow IT as a platform feedback signal rather than a compliance problem. In an interview, this demonstrates mature product thinking.

### Senior @ FAANG: The Summary as a Platform Engineering Manifesto

Read as a manifesto rather than a checklist, this summary describes the operational model of a platform team that has solved both the technical and organizational dimensions of internal developer platforms.

The SLA and error budget point is the one most commonly absent in organizations that have the technical implementation right but the operational model wrong. A platform team that has built Backstage, golden paths, and Crossplane but has no error budgets and no PagerDuty on-call rotation is a platform team that will lose developer trust the first time its CI/CD pipeline goes down during a critical release. Error budgets are not just a reliability mechanism. They are an organizational commitment to treating platform reliability with the same seriousness as customer-facing service reliability.

The "shadow IT as a product signal" point is the key insight for a staff engineer leading a platform team. When a team builds their own Terraform modules instead of using Crossplane, the instinct is to enforce compliance. The correct response is curiosity: what about the Crossplane composition made it insufficient for this team's needs? Was the documentation unclear? Was the provisioning too slow? Was a required configuration option missing? The answer determines whether the fix is documentation, performance optimization, or a new composition. Treating shadow IT as a product failure to be diagnosed rather than a policy violation to be punished is the mindset that drives continuous platform improvement.

The public KPI commitment point is the one that requires the most organizational courage. Publishing metrics that show the platform team falling short of targets (adoption rate at 72% when the target is 90%) is uncomfortable. But it is exactly this accountability that builds long-term organizational trust. A platform team that only publishes metrics when they are positive is not a platform team that has internalized the product mindset. It is a team optimizing for favorable perception rather than actual improvement.

---

### Next Chapter

Ready to dive deeper into securing containerized workloads and service discovery architectures? Continue to [Chapter 102G: Container Security & Service Discovery](../chapter-102g-container-security-service-discovery/00-introduction.md).

