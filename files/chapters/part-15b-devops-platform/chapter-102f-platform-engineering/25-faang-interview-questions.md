## 102F.23 FAANG Interview Questions: Platform Engineering

### Q1 (Amazon, L6): Define the ROI of a platform team.

Developer time saved per week times loaded cost per engineer, minus platform team cost. Measure via DORA metrics (lead time, deploy frequency, MTTR, change-fail rate) plus SPACE satisfaction scores. At Amazon scale the first-order signal is onboarding time for a new service, target sub-day.

### Q2 (Google, L5): Golden path vs paved road vs self-service. Distinguish.

Golden path is the opinionated default with batteries included. Paved road is a supported set of acceptable options. Self-service is the unrestricted substrate. Teams must be able to step off the golden path without being punished, otherwise the platform ossifies. Measure adoption, not mandate.

### Q3 (Meta, E6): Designing an internal developer portal. What does Backstage give and what must you build?

Backstage gives the catalog, scaffolder, TechDocs, and a plugin framework. You must build authoritative data sources (ownership, on-call, SLOs), the identity integration, and the workflows that turn catalog entries into provisioned infrastructure. Without the data plumbing Backstage is just a wiki.

### Q4 (Netflix, Senior): Team Topologies model for a 50-engineer platform org.

Stream-aligned product teams consume platform services. One platform team owns the core substrate, one enabling team coaches adoption, complicated-subsystem teams own niche components like service mesh or identity. Keep cognitive load explicit, publish team APIs, avoid the "ops team" anti-pattern.

### Q5 (Apple, ICT5): Crossplane vs Terraform for self-service infra.

Crossplane fits a Kubernetes-native control plane where developers provision through CRDs and GitOps. Terraform fits when the primary operator is a platform engineer and the surface is broader than Kubernetes. Crossplane gives continuous reconciliation. Terraform gives plan-apply determinism. Many platforms use both: Crossplane for the app-facing API, Terraform for the foundational cloud account.

### Junior → FAANG: Decoding What These Questions Are Actually Testing

These five questions come from specific FAANG companies at specific levels. Understanding the testing philosophy behind each one helps you calibrate your preparation.

Q1 (Amazon, L6, ROI): Amazon's leadership principle "Frugality" drives this question. Amazon interviewers want to know whether you can justify platform investment in business terms, not technical terms. The expected answer quantifies time saved, translates that to dollars, and compares it to platform team cost. A candidate who answers with technology benefits ("reduced cognitive load", "faster deployments") without financial framing has not fully answered the question.

Q2 (Google, L5, golden path vs paved road): Google's engineering culture values autonomy. The expected answer acknowledges that mandating the golden path kills innovation and that voluntary adoption via genuine value is the correct model. Mentioning "measure adoption, not mandate" shows you understand the cultural alignment requirement.

Q3 (Meta, E6, Backstage design): Meta builds substantial internal tooling (Yarn, Docusaurus, React originally started as internal tools). The expected answer distinguishes what Backstage provides (catalog framework, plugin architecture) from what you must build (authoritative data sources, identity integration, provisioning workflows). "Without the data plumbing Backstage is just a wiki" is the kind of sharp observation that resonates at Meta E6.

Q4 (Netflix, Senior, team topologies): Netflix's "Paved Road" philosophy is well-documented. The expected answer demonstrates familiarity with Team Topologies (stream-aligned, platform, enabling, complicated subsystem) and applies it to a real organizational design. The "avoid the ops team anti-pattern" note is a Netflix-specific concern: Netflix explicitly moved away from a central ops team model toward platform-enabled product team ownership.

Q5 (Apple, ICT5, Crossplane vs Terraform): Apple's infrastructure scale is massive, and this question tests whether you can make principled tool selection decisions rather than defaulting to whatever is popular. The expected answer explains the architectural fit for each tool, describes real trade-offs, and proposes using both in a complementary way. A candidate who argues for one tool and dismisses the other has not thought through the full problem space.

### Senior @ FAANG: The Subtext in Each Question

For L6 and above, FAANG interview questions have subtext that the surface question does not reveal. Understanding the subtext is the difference between a passing answer and a bar-raising answer.

Q1 subtext (Amazon L6): Can you build a financial model that stands up to scrutiny? The ROI calculation involves assumptions about fully loaded engineer cost, time attribution (does every hour saved translate to an hour of product work?), and causality (is the deployment frequency improvement caused by the platform or by other organizational changes?). A bar-raising answer acknowledges these measurement challenges and proposes a methodology for isolating the platform's contribution from confounding factors.

Q2 subtext (Google L5): Have you seen platform mandates fail and do you understand why? The expected answer includes a mechanism for detecting when adoption is stagnating and a process for investigating the root cause. Mentioning "if adoption rate drops, we interview non-adopters to understand the friction" shows operational maturity.

Q3 subtext (Meta E6): Have you built production Backstage integrations or are you describing the documentation? The probe question after this answer will be "tell me about a specific integration you built and what went wrong." Having a concrete story about a catalog sync job that produced duplicate entities, or a plugin that exposed sensitive data due to a missing auth check, is what separates a credible answer from a theoretical one.

Q4 subtext (Netflix Senior): Can you apply Team Topologies to a real organizational scenario rather than reciting definitions? The probe will ask you to describe the interaction model between the platform team and a specific stream-aligned team. What does the XaaS API look like? What happens when the platform team is blocking a product team's delivery? Having a concrete escalation and resolution mechanism shows that you have thought about organizational dynamics, not just team type taxonomy.

Q5 subtext (Apple ICT5): Can you advise on a migration from an existing Terraform-heavy infrastructure to a mixed Crossplane/Terraform model without breaking existing workflows? The probe question will be about the transition path: how do you migrate existing Terraform-managed resources into Crossplane management without causing outages? The answer involves Crossplane's `import` capability and a phased migration strategy, which is a concrete implementation detail that tests whether the candidate has worked with Crossplane in a real migration scenario.
