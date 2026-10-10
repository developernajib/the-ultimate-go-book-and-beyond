## Overview

FinOps (Financial Operations) is the practice of bringing financial accountability to the variable spend model of the cloud. For Go engineers, this means building cost-aware systems, implementing resource rightsizing, and creating observability tools that connect infrastructure decisions to dollar amounts.

After this chapter you will be able to:
- Query AWS Cost Explorer and GCP Billing APIs from Go
- Build cost allocation and chargeback systems
- Implement resource rightsizing recommendations
- Create cost anomaly detection pipelines
- Design architectures with cost efficiency as a first-class concern
- Build dashboards and alerting for cloud spend
- Optimize Go services for cost: compute, data transfer, storage

---

### Junior → FAANG: FinOps Vocabulary as Interview and Communication Foundation

The FinOps vocabulary in this section (showback, chargeback, unit economics, rightsizing) appears in architecture discussions, incident reviews, and engineering planning meetings at cloud-native companies. Not knowing what "chargeback" means when a senior engineer uses it in a meeting is the kind of knowledge gap that makes you appear less senior than your technical skills warrant. Learn the vocabulary before you need it.

The distinction between showback (informational cost reporting) and chargeback (actual internal billing that affects team budgets) is a common interview topic for platform and infrastructure roles. Showback is a prerequisite for chargeback: you need accurate cost attribution before you can bill internal teams. The engineering challenge in both is the same: allocating shared infrastructure cost (load balancers, NAT gateways, shared databases) to the services that use them, which requires a combination of tagging, usage metrics, and allocation rules.

### Senior @ FAANG: FinOps Program Design as Staff Engineer Deliverable

At staff level, the FinOps overview is a program design starting point. The program has three phases with distinct deliverables. The first phase is visibility: every resource is tagged, cost allocation reports exist at the team level, and shared infrastructure cost is allocated using a documented methodology. The second phase is accountability: every team has a monthly budget, cost regressions surface in engineering reviews, and cost targets are included in capacity planning. The third phase is optimization: unit economics are tracked per product feature, rightsizing recommendations are automated, and cost efficiency is a criterion in architectural reviews.

Most organizations are in phase one or early phase two. The staff engineer's contribution is to advance the organization to the next phase with a concrete implementation plan. Phase one to phase two requires building the alerting and budget infrastructure on top of the tagging and attribution system. Phase two to phase three requires building unit economics instrumentation into services and connecting it to the cost allocation system. Each phase has measurable outcomes: phase one is complete when 95% of cloud spend is attributed to a team, phase two is complete when every team receives weekly cost variance reports, and phase three is complete when cost efficiency targets exist for at least the five highest-spend services.
