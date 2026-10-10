## 102F.12 Mid-Chapter Synthesis: Core Architecture Recap

Platform engineering is the discipline that makes large engineering organizations scale without sacrificing developer velocity or reliability. The Internal Developer Platform - built on Backstage for discovery, golden path templates for standardization, Crossplane for self-service infrastructure, and ArgoCD for deployment - reduces the cognitive overhead of modern cloud-native development.

**The platform team's goal**: Make the right thing the easy thing. Security, observability, reliability, and operational best practices should be defaults that teams get automatically, not requirements they must implement themselves.

**Key takeaways for FAANG interviews**:
1. Platform engineering reduces cognitive load - extraneous load (K8s, CI/CD, observability setup) not intrinsic load (domain problems)
2. Backstage is the de facto standard for internal developer portals in 2026 - understand the catalog, scaffolder, and plugin model
3. Golden paths work by being easier than the alternative - if teams bypass the platform, the platform has failed
4. DORA metrics are the platform team's success metrics - measure deployment frequency, lead time, MTTR, change failure rate
5. Platform as a product: customer = internal developer. Measure NPS, adoption rate, time-to-onboard

### Junior → FAANG: Turning This Summary Into Interview Preparation

The five key takeaways are a compressed version of the chapter. To turn them into interview-ready talking points, expand each one with a concrete example.

Takeaway one (cognitive load): "Before we had the platform, every new service required a developer to spend three days configuring Kubernetes YAML, setting up CI, and configuring observability. That is extraneous cognitive load. After the platform, they run one command and get all of that pre-configured. The platform redirects that time to the actual business problem."

Takeaway two (Backstage): "Backstage is the developer portal that shows all services, their owners, their documentation, and their operational health. It also provides the scaffolding workflow where a developer fills out a form and gets a fully configured repository and CI/CD pipeline. The catalog-info.yaml file is how every service registers itself in the catalog."

Takeaway three (golden paths): "A golden path only works if it is easier than the alternative. If developers are opening tickets instead of using the platform, or writing custom Dockerfiles instead of using the template, the platform team has a product problem. Adoption rate is the primary health metric."

Takeaway five (platform as product): "The platform team's customers are internal developers. That means we run developer surveys, maintain a public roadmap, have SLAs for our services, and hold office hours for feedback. We measure our success by developer NPS and the time it takes a new team to get their first service to production."

### Senior @ FAANG: What the Summary Does Not Say

The summary covers the "what" well but omits two "how" concerns that senior engineers are expected to address proactively.

The first is the technology lifecycle problem. Every component listed in this chapter (Backstage, Crossplane, ArgoCD, Cilium) is evolving rapidly. Backstage releases a new version monthly with potential breaking changes to the plugin API. Crossplane compositions must be updated when AWS providers release new API versions. The platform team's internal product includes a commitment to keeping these components current, which means ongoing investment in testing and upgrade pipelines. A platform that is not maintained becomes a liability faster than a manually managed infrastructure stack, because the platform touches every team simultaneously.

The second is the organizational change management problem. Shipping a golden path template is a technical task. Getting two hundred existing services to migrate to it is an organizational change management challenge. Senior engineers in platform roles spend more time on migration strategy, communication plans, automated migration tooling, and stakeholder management than on the initial technical implementation. A summary of platform engineering that focuses only on the initial build omits the harder and more lasting work of platform adoption and evolution at scale.
