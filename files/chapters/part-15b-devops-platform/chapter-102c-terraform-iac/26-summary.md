## Summary

- **State management is foundational**: remote state with S3 and DynamoDB, encryption at rest, versioning enabled, and access control via IAM roles with least privilege are non-negotiable prerequisites for any team using Terraform in production. State corruption is rare but catastrophic without versioning and locking.

- **`for_each` over `count` for stability**: using list index as resource identity causes cascading destroy and recreate when elements are inserted or removed mid-list. Map keys are stable resource addresses regardless of collection order, always prefer `for_each` with a `map` or `set` for multi-instance resources.

- **Modules are the unit of reuse and testing**: keep modules small and single-purpose. Large monolithic modules create slow plans, wide blast radii, poor reusability, and configurations that cannot be tested in isolation. Compose small focused modules in environment-level root configurations.

- **Terratest provides real infrastructure confidence**: `terraform validate` catches syntax errors. Terratest catches logic errors, wrong subnet associations, missing IAM permissions, security groups blocking expected traffic. Write Terratest for every module intended for production use, and run tests against a dedicated test account in CI.

- **Directory-per-environment outperforms workspaces at scale**: workspaces share provider configurations and module versions, making them unsuitable for true production environment isolation. Separate directories with Terragrunt enable per-environment version pinning, separate AWS accounts with independent IAM roles, and isolated blast radii.

- **Atlantis enforces the GitOps contract**: no engineer should run `terraform apply` locally against production. Atlantis creates an immutable audit trail of every plan and apply attached to GitHub PR comments, enforces peer review before any infrastructure change, and eliminates the divergence risk of unreviewed local applies.

- **Pin everything, providers, modules, and the Terraform binary itself**: unpinned provider versions silently break configurations on major upgrades. Commit `.terraform.lock.hcl` to Git. Treat provider upgrades as deliberate, reviewed dependency changes requiring a changelog review, not transparent background operations.

- **Dynamic blocks and complex variable types reduce duplication at module boundaries**: `dynamic` blocks eliminate copy-pasted nested blocks. `map(object(...))` variables create self-documenting, type-safe module interfaces. `optional()` fields in object types enable backward-compatible module evolution. Master these patterns before adding Terragrunt to solve DRY problems.

- **OpenTofu offers a license-safe migration path**: for organizations that cannot accept BSL restrictions, OpenTofu is a drop-in replacement through Terraform 1.5.x compatibility. State file format is identical. All registry providers are compatible. Migration requires only replacing the `terraform` binary with `tofu` and regenerating the provider lock file.

- **Infrastructure code demands the same engineering rigor as application code**: code review via Atlantis, testing with Terratest, static analysis with tflint and tfsec, policy enforcement with OPA/Conftest, and dependency management with pinned versions and lock files are all as critical for `.tf` files as for `.go` files. Teams that treat infrastructure as a second-class codebase accumulate configuration debt that manifests as production outages.

---

### Junior → FAANG: Summary as a Study Checklist

Each bullet point in this summary is an interview topic. Before any platform engineering interview, verify you can speak concretely to all ten. The ones most commonly tested at L4 and L5 are: remote state (Q1 in most infrastructure screens), `for_each` vs `count` (Q2 in most screens), module design (Q3), and Atlantis/plan-before-apply (Q4).

The final bullet point ("infrastructure code demands the same engineering rigor as application code") is the philosophical foundation that the interviewer is testing when they ask "how would you improve your team's infrastructure reliability?" The answer is a disciplined adoption of the engineering practices listed: code review, testing, static analysis, policy enforcement, and dependency management. Candidates who answer this question with "write more documentation" are missing the systemic point.

The OpenTofu bullet is the most recent addition and is tested infrequently, but knowing the license context and being able to explain the migration path demonstrates that you follow infrastructure news and understand the organizational implications of tooling decisions.

### Senior @ FAANG: Summary as a Platform Engineering Maturity Model

At L6, this summary is a maturity model. Organizations move through it roughly in the order listed: state management is solved first (it is the prerequisite for everything else), then module reusability, then multi-environment scaling, then testing, then environment isolation, then GitOps enforcement. Organizations that skip stages accumulate technical debt that compounds: a team that skips testing (Terratest) and goes straight to GitOps enforcement (Atlantis) has automated the application of untested infrastructure changes, which is more dangerous than the manual process it replaced.

The maturity model framing is useful in staff-level interviews when asked "how would you assess the IaC program at a company you just joined?" The answer is: map the current practices against each item in this summary, identify the first gap, and build the case for addressing that gap before the next one. The first gap is almost always state management (local state in version control) or testing (no Terratest coverage). The second gap is almost always policy-as-code. The third is almost always GitOps enforcement. Following this sequence is more effective than trying to implement all practices simultaneously.

The final observation for L7 candidates: the progression from state management to GitOps enforcement is not a technical journey. It is an organizational change management journey. Each stage requires not just implementing a tool but changing how engineers think about their relationship to production infrastructure. The staff engineer's job is to make the new practice the path of least resistance, not to mandate it and enforce compliance. Building automation that makes the correct practice easier than the incorrect one is the single most useful contribution at this level.

---

Next, continue your platform engineering journey with [Chapter 102D: GitOps & Deployment Strategies](../chapter-102d-gitops-deployment/00-introduction.md).

