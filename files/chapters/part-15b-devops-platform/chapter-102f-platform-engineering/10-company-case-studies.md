## 102F.8 Company Case Studies

### Spotify - Backstage Origin Story

Spotify created Backstage in 2016 to solve a chaos problem: 2000 services, 1600 engineers, and no consistent way to find documentation, check service health, or understand dependencies. Before Backstage, the answer to "who owns this service?" required Slack archaeology.

**Adoption strategy**: Spotify made Backstage the path of least resistance by integrating it with everything engineers already used daily: Jira (see tickets for this component), GitHub (see PRs), PagerDuty (see incidents), Grafana (see dashboards). Backstage didn't replace tools - it unified them behind one interface.

**The catalog as a forcing function**: Backstage plugins only work if the `catalog-info.yaml` is correct. This created incentive for teams to keep metadata accurate. Spotify added automation: PR checks ensure `catalog-info.yaml` is valid, and Lighthouse (their internal DORA metrics tool) tracks service quality including catalog completeness.

**Open-sourcing outcome**: Spotify open-sourced Backstage in 2020. By 2026, it's adopted by Airbnb, Netflix, American Airlines, Zalando, DoorDash, and 1000+ other organizations. The Backstage community has built 200+ plugins for every major tool.

---

### Mercado Libre - IDP Reducing Onboarding from Weeks to Hours

Mercado Libre (Latin America's largest e-commerce platform) has 12,000+ engineers deploying 1000+ microservices. Before their IDP, onboarding a new service took 2-3 weeks: security reviews, RBAC setup, CI/CD configuration, monitoring setup, runbook creation - all manual.

**Their platform ("Fury")**: A complete self-service portal where creating a new service takes 20 minutes. Fury handles: repository creation, CI/CD pipeline, Kubernetes namespace with RBAC, observability setup, PagerDuty team assignment, security scan configuration. Teams receive a ready-to-deploy service with one form submission.

**Cost attribution**: Fury tags every resource with team, service, and cost-center. Monthly reports show each team their infrastructure cost breakdown. This drove a 40% reduction in over-provisioned resources as teams could see their bill.

---

### Zalando - Tech Radar and Golden Paths

Zalando (European e-commerce) maintains a public tech radar and internal golden paths for their 3000+ engineers.

**Tech radar categories**: Adopt (recommended), Trial (promising but evaluate carefully), Assess (explore cautiously), Hold (avoid for new projects). The radar is reviewed quarterly. Golden paths exist for "Adopt" tier technologies.

**Golden path enforcement**: Zalando's cluster admission webhook rejects deployments from non-golden-path repositories (those missing required CI checks). Teams CAN go off-golden-path, but they must get explicit approval - the default is the golden path.

### Junior → FAANG: What These Case Studies Teach You About Platform Strategy

Case studies in interviews are not trivia. Interviewers reference Spotify and Netflix to test whether you can extract the transferable principle, not whether you memorized the story.

The Spotify case study teaches the integration strategy. Backstage succeeded not because it was a better documentation tool but because it integrated with every tool developers already used. When a developer could see their GitHub PRs, Jira tickets, PagerDuty incidents, and Grafana dashboards all from one interface, Backstage became indispensable. The lesson: a platform is adopted when it reduces tool-switching, not when it adds another tool to the stack.

The Mercado Libre case study teaches the ROI framing. Reducing service onboarding from two weeks to twenty minutes is a compelling business case that any engineering leader can understand. The cost attribution feature (teams see their own infrastructure bill) demonstrates a second ROI dimension: the platform pays for itself by eliminating over-provisioned resources. For a junior engineer in an interview, being able to describe platform value in terms of time saved and cost reduced (not in terms of technology features) is a differentiating skill.

The Zalando case study teaches the enforcement strategy. Their tech radar creates a shared vocabulary (Adopt, Trial, Assess, Hold) that teams use when evaluating new technologies. The golden path enforcement via admission webhook is notable because it is a hard gate: the webhook rejects deployments from non-golden-path repositories. This is more aggressive than Spotify or Netflix, which rely on incentives. Understanding the trade-offs between incentive-based and gate-based enforcement is a nuanced interview topic.

### Senior @ FAANG: Deconstructing the Leverage Ratios

The most important number in the Netflix case study is not mentioned explicitly: eight platform engineers supporting seven hundred product engineers, approximately a ninety to one leverage ratio. At the senior level, leverage ratio is the fundamental metric for evaluating platform team investment.

A platform team that supports a twenty-to-one ratio (five platform engineers for one hundred product engineers) is leaving value on the table: the platform is either too narrow (only solving a few problems) or too bespoke (requiring hand-holding for each team). A platform team at a hundred-to-one ratio may be understaffed and producing a brittle platform that breaks when any component fails. The target leverage ratio for a mature platform team is roughly fifty to one hundred product engineers per platform engineer, and achieving that ratio requires that the platform be genuinely self-service, not "self-service with five Slack messages for support."

The Zalando tech radar is a governance artifact that deserves scrutiny at the L6 level. The quarterly review cadence means technology decisions are revisited regularly. The four categories (Adopt, Trial, Assess, Hold) create explicit signals that prevent technology sprawl: teams are not free to choose any tool they want because the tech radar communicates organizational consensus. The platform team builds golden paths only for Adopt-tier technologies. This creates a virtuous cycle: the tech radar drives standardization, standardization enables the platform team to build high-quality tooling, and high-quality tooling drives further adoption of standardized technologies.

The admission webhook enforcement at Zalando (rejecting deployments from non-golden-path repositories) is a bar-raiser signal for how seriously an organization takes platform standards. Most organizations rely on incentives and documentation. Few use hard enforcement. The trade-off is developer trust: if the webhook ever has a false positive and blocks a legitimate deployment, the platform team loses credibility. Running enforcement webhooks requires the same SRE practices as any other production dependency: high availability, clear error messages, a documented override path, and rapid incident response when the webhook itself fails.
