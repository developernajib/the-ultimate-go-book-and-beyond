## 102F.17 Common Mistakes (Extended)

### 5. Not Versioning the Golden Path

Treating scaffolding templates as mutable resources invites silent breaking changes that ripple across every service that re-scaffolds. Just as libraries are versioned, platform templates must carry explicit version identifiers with documented stability windows, so teams can opt into upgrades on their own schedule. Deprecation timelines and automated migration tooling remove the friction that would otherwise push teams off the platform entirely.

```
WRONG: Update the scaffolding template; all re-scaffolded services silently
       get breaking changes with no migration path.

CORRECT: Version the golden path explicitly.
  - go-service-template@v1 -> supported until 2027-01
  - go-service-template@v2 -> current, recommended
  Services declare their version in catalog-info.yaml:
    golden-path: go-service/v2
  Breaking changes always come with: changelog, migration guide,
  automated migration PR tooling, and 12-month deprecation window.
```

### 6. Missing Platform SLOs

The platform itself is a product with internal customers, and like any production service it must be held to measurable reliability commitments. Without explicit SLOs and error budgets, platform outages are invisible until developers hit failures late at night with no runbooks to guide recovery. Defining availability targets for CI pipelines, secret injection, and the service catalog. Backed by real alerting. Ensures the platform team treats reliability as a first-class concern.

```
WRONG: CI/CD system goes down; teams discover via failed deployments at 2am.
       Platform team has no pager, no runbooks, no SLOs.

CORRECT: Platform services have explicit SLOs:
  - CI pipeline availability:     99.5% (3.6 hours downtime/month budget)
  - Service catalog API:           99.9%
  - Secrets injection service:     99.99% (blocks deploys if down)
  Platform SLO dashboard: deployment success rate, provision latency p99,
  ArgoCD sync queue depth. PagerDuty alert when error budget burns too fast.
```

### 7. Building for Happy Path Only

A golden path that only addresses the most common use case. Typically a standard Go microservice. Leaves adjacent teams with Python services, ML batch jobs, or data pipelines entirely unsupported. Those teams will either work around the platform or maintain independent tooling, fragmenting operational practices across the organization. Quarterly usage surveys and a policy of converting recurring off-path requests into new golden paths keeps the platform growing in line with real engineering needs.

```
WRONG: Golden path covers "new Go microservice."
       Python services, ML batch jobs, data pipelines: no path.
       Teams going off-path get zero support.

CORRECT: Survey actual usage patterns quarterly.
  Build golden paths for top 5 recurring use cases.
  Track off-path requests as a product backlog.
  Rule: 3 off-path requests for the same pattern -> new golden path.
```

### 8. No Escape Hatch

Mandating the golden path without any mechanism for legitimate deviation breeds resentment and shadow IT, as teams with valid edge cases are forced to secretly work around a platform that can't accommodate them. A lightweight RFC process with a fast approval SLA preserves platform consistency while acknowledging that no template can anticipate every situation. Exceptions that recur frequently are strong signals that a new golden path is needed, turning deviations into platform improvements rather than permanent workarounds.

```
WRONG: Golden path is mandatory. No way to deviate.
       Result: shadow IT, teams work around the platform, frustration.

CORRECT: Explicit escape hatch documented:
  1. Submit short RFC: "Why we need to deviate"
  2. Get platform team approval (1 business day SLA)
  3. Off-path teams own ALL operational burden - no platform support
  4. Review exceptions quarterly; common ones become new golden paths
  Golden path = path of least resistance, not legal requirement
```

### Junior → FAANG: Using These Mistakes to Build a Platform Engineering Mindset

Mistakes five through eight represent more nuanced failure modes than mistakes one through four. They require a developer to have seen platform engineering at some scale before they are fully intuitive.

Mistake five (not versioning the golden path) maps directly to how library versions work in Go. A Go module has a version in `go.mod`. When the module releases a breaking change, it bumps the major version so that consumers can choose when to adopt it. Golden path templates should work the same way. When you see a template without a version marker, that is a maturity gap you can immediately identify and fix.

Mistake six (missing platform SLOs) is something a junior engineer can influence from day one on a platform team. If the team does not have SLOs, the right action is to propose them: "Should we define an availability target for our CI pipeline?" This demonstrates product thinking (the platform is a product with reliability commitments) and proactive ownership (you identified a gap before it became a problem).

Mistake seven (building for happy path only) is the platform team's equivalent of building a feature for a specific user persona without considering edge cases. A Python ML engineer is an edge case from the perspective of a Go microservice golden path. But ignoring edge cases does not make them go away. It makes them build their own tooling. Tracking off-path requests and converting common ones into new golden paths is the product management discipline that prevents platform fragmentation.

Mistake eight (no escape hatch) teaches the most important lesson about platform governance: standards work through consent, not coercion. When teams have a legitimate need that the golden path cannot accommodate, providing a structured process (RFC, approval, explicit ownership transfer) respects their autonomy while preserving platform awareness. A platform that can be legally bypassed with documented consent is more resilient than one that claims to be mandatory and is secretly bypassed without documentation.

### Senior @ FAANG: The Organizational Dynamics Behind Each Mistake

These extended mistakes are organizational failure modes that emerge predictably when platform engineering is implemented without sufficient product and governance discipline.

Mistake five (unversioned templates) is almost always caused by treating the golden path as internal tooling rather than a product API. Internal tooling can change arbitrarily because it is maintained and consumed by the same small team. A product API used by external consumers (in this case, all product teams) requires the same backward-compatibility discipline as a public REST API. The organizational fix is to require a version increment, a changelog entry, and a migration guide for every golden path change that affects existing services. This adds friction to changes, which is the correct behavior: template changes should be deliberate, not casual.

Mistake six (missing SLOs) at scale is a leadership failure, not just a technical oversight. When the platform team does not have SLOs, it signals that leadership treats the platform as internal tooling (best effort) rather than production infrastructure (reliability commitments). A staff or principal engineer joining a platform team that lacks SLOs should make defining and publishing them a first-quarter priority. The conversation with leadership is: "Our CI/CD pipeline is now critical infrastructure for 300 engineers. We should treat it with the same rigor as customer-facing production systems."

Mistake seven (incomplete golden path coverage) at FAANG scale produces measurable fragmentation. A two-year-old platform that covers only Go microservices will have a growing tail of Python services, Java services, and data pipelines all using hand-rolled CI and custom Kubernetes manifests. The technical debt is distributed across hundreds of repositories but is owned by the platform team, which is responsible for the operational consistency of the entire organization. Quarterly coverage reviews with clear criteria for when to build a new golden path (three or more recurring requests for the same pattern) prevent this fragmentation from becoming unmanageable.

Mistake eight (no escape hatch) at FAANG scale produces shadow IT that is invisible to the platform team. When the escape hatch is documented (submit RFC, get approval), the platform team learns which requirements the platform cannot meet. That is valuable product feedback. When the escape hatch is not documented, teams route around the platform silently, and the platform team never learns why adoption stagnated.
