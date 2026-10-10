## 102.8 Mid-Chapter Synthesis: Infrastructure as Code Review

### IaC Best Practices

The most costly IaC mistakes are operational rather than syntactic: storing state locally breaks team collaboration and loses change history, checking secrets into version control exposes credentials permanently even after deletion, and applying infrastructure changes without a plan step causes irreversible resource replacements. Remote state with locking prevents concurrent apply conflicts. separating environments into distinct state backends ensures a staging change cannot accidentally destroy production resources.

```
┌──────────────────────────────────────────────────────────────────┐
│               INFRASTRUCTURE AS CODE BEST PRACTICES              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CODE ORGANIZATION:                                              │
│  □ Use modules for reusable components                           │
│  □ Separate environments (dev/staging/prod)                      │
│  □ Use variables for environment-specific values                 │
│  □ Keep secrets out of version control                           │
│                                                                  │
│  STATE MANAGEMENT:                                               │
│  □ Use remote state (S3, GCS, Pulumi Cloud)                      │
│  □ Enable state locking                                          │
│  □ Encrypt state at rest                                         │
│  □ Backup state regularly                                        │
│                                                                  │
│  CI/CD INTEGRATION:                                              │
│  □ Plan on PR, apply on merge                                    │
│  □ Use GitOps for Kubernetes deployments                         │
│  □ Automate image updates                                        │
│  □ Include drift detection                                       │
│                                                                  │
│  SECURITY:                                                       │
│  □ Use IAM roles, not static credentials                         │
│  □ Enable encryption everywhere                                  │
│  □ Follow least privilege principle                              │
│  □ Audit infrastructure changes                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Takeaways

1. **Choose the right tool** - Terraform for multi-cloud, Pulumi for Go teams
2. **GitOps for Kubernetes** - ArgoCD or Flux for declarative deployments
3. **Separate concerns** - Infrastructure code separate from application code
4. **Automate everything** - From provisioning to deployments
5. **Version everything** - Infrastructure changes should be reviewable

---

### Junior → FAANG: IaC Best Practices as Day-One Habits

The best practices in this summary are most powerful when applied from the first line of infrastructure code, not retrofitted to existing configurations. Starting with remote state, modular design, and CI-enforced plan review is far cheaper than migrating to these practices after a monolithic configuration has been in production for a year.

The priority order for first-job application: remote state and locking (security and reliability), plan review in CI (safety), modular design (maintainability), drift detection (reliability over time). These can be set up in a single afternoon for a new project and save significant operational pain later.

### Senior @ FAANG: IaC as the Infrastructure Programming Model

At L6/L7, IaC is not a tool or a practice: it is the infrastructure programming model. Every resource in the organization's cloud estate should be traceable to an IaC configuration in a version-controlled repository. Any resource that exists in the cloud but not in IaC is shadow infrastructure: unreviewed, unaudited, and potentially non-compliant.

The platform team's mechanism for eliminating shadow infrastructure: mandatory IaC review for all new cloud resources (enforced by cloud policies that require specific tags applied only by approved IaC pipelines), drift detection that reports all unmanaged resources, and a remediation process for resources discovered to be shadow infrastructure (import into IaC or schedule for deletion). This zero-shadow-infrastructure standard is an aspiration at most organizations but a reality at mature platform teams at FAANG companies.
