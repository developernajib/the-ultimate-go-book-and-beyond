## 102.1 Infrastructure as Code Fundamentals

### IaC Overview

Infrastructure as Code replaces manual, error-prone cloud console operations with versioned, auditable configuration files that can be reviewed in pull requests, rolled back via git, and applied identically across every environment. The fundamental shift is treating infrastructure state as a diff between declared intent and observed reality, tools like Terraform and Pulumi compute this diff and apply only the necessary changes, preventing configuration drift that accumulates when teams manage resources by hand.

```
┌──────────────────────────────────────────────────────────────────┐
│               INFRASTRUCTURE AS CODE BENEFITS                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CORE PRINCIPLES:                                                │
│  ├── Declarative configuration                                   │
│  ├── Version controlled infrastructure                           │
│  ├── Reproducible environments                                   │
│  ├── Self-documenting infrastructure                             │
│  └── Automated provisioning and updates                          │
│                                                                  │
│  TOOLS COMPARISON:                                               │
│  ┌──────────────┬─────────────────┬─────────────────────┐        │
│  │ Tool         │ Language        │ State Management    │        │
│  ├──────────────┼─────────────────┼─────────────────────┤        │
│  │ Terraform    │ HCL             │ Remote/Local        │        │
│  │ Pulumi       │ Go/Python/TS    │ Pulumi Cloud/S3     │        │
│  │ AWS CDK      │ TypeScript/Py   │ CloudFormation      │        │
│  │ Crossplane   │ YAML            │ Kubernetes          │        │
│  └──────────────┴─────────────────┴─────────────────────┘        │
│                                                                  │
│  FOR GO DEVELOPERS:                                              │
│  • Pulumi with Go: Same language for app and infra               │
│  • Terraform: Industry standard, extensive providers             │
│  • Both: GitOps-friendly, state management built-in              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Declarative Versus Imperative Infrastructure

The declarative model (describe the desired state, let the tool figure out how to get there) is the foundation of modern IaC. Terraform, Pulumi, and CloudFormation are all declarative: you specify what you want, and the tool computes the diff against the current state and applies the necessary changes. This is fundamentally different from scripts that issue create/delete/update commands imperatively.

The practical advantage: if you apply the same Terraform configuration twice, the second apply is a no-op (because the actual state already matches the desired state). If you apply a Terraform configuration after making manual changes in the cloud console, Terraform detects the drift and brings the state back to the declared configuration. This convergence property is what makes IaC reliable at scale.

The state file is the mechanism that makes declarative IaC possible: it records the mapping between the declared resources and the actual cloud resources. Losing the state file means Terraform no longer knows which real resources correspond to which declared resources and cannot manage them correctly. State file protection (remote backend with versioning and locking) is the most critical operational concern for any Terraform deployment.

### Senior @ FAANG: IaC Tool Selection and the Module Ecosystem

At staff level, IaC tool selection is a long-term commitment decision. Terraform (HCL, declarative, large ecosystem) and Pulumi (general-purpose languages including Go, declarative with imperative loops and conditions) each have trade-offs that become significant at organizational scale.

The critical evaluation criteria: ecosystem maturity (the available provider ecosystem, the number of community modules), language expressiveness (does the tool's language support the abstractions needed for your module design), and team expertise (how quickly can engineers become productive). For an organization heavily invested in Go, Pulumi with Go is a natural fit: engineers use the same language, the same testing tools, and the same IDE for both application code and infrastructure code.

The module design at organizational scale requires a versioned release process: modules are published with semantic versions, consumers pin to specific versions, and breaking changes require a major version bump with a migration guide. An unversioned module shared between teams is a change management nightmare. The staff engineer responsibility is to establish the module registry, the versioning convention, and the review process before the module ecosystem grows large enough that changes become dangerous.
