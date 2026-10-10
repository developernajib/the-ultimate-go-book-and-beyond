## 102.11 IaC Quick Reference

This cheat sheet consolidates the most frequently used Terraform, Pulumi, and GitOps commands into a single reference, organized by tool and workflow stage. Having these commands memorized reduces context switching when moving between tools during infrastructure incidents or onboarding new environments. The patterns section captures the idioms, remote state configuration, workspace management, and drift detection, that differentiate production-grade IaC usage from simple scripts.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE AS CODE CHEAT SHEET                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  TERRAFORM COMMANDS                                                     │
│  ─────────────────                                                      │
│  terraform init      Initialize, download providers                     │
│  terraform plan      Preview changes                                    │
│  terraform apply     Apply changes                                      │
│  terraform destroy   Tear down infrastructure                           │
│  terraform state     Inspect/modify state                               │
│  terraform import    Import existing resources                          │
│                                                                         │
│  PULUMI COMMANDS                                                        │
│  ───────────────                                                        │
│  pulumi new          Create new project                                 │
│  pulumi up           Deploy changes                                     │
│  pulumi preview      Preview changes                                    │
│  pulumi destroy      Tear down                                          │
│  pulumi stack        Manage stacks                                      │
│  pulumi config       Manage configuration                               │
│                                                                         │
│  GITOPS COMMANDS                                                        │
│  ───────────────                                                        │
│  argocd app sync     Force sync application                             │
│  argocd app diff     Show diff from Git                                 │
│  flux reconcile      Force reconciliation                               │
│  flux get sources    List sources                                       │
│                                                                         │
│  BEST PRACTICES                                                         │
│  ──────────────                                                         │
│  ✓ Remote state with locking                                            │
│  ✓ Secrets in external managers                                         │
│  ✓ Environment isolation                                                │
│  ✓ Plan before apply                                                    │
│  ✓ Modular, reusable code                                               │
│  ✓ Version pinning for providers                                        │
│  ✓ Tagging for cost allocation                                          │
│                                                                         │
│  DIRECTORY STRUCTURE                                                    │
│  ───────────────────                                                    │
│  infra/                                                                 │
│  ├── modules/           Reusable components                             │
│  │   ├── vpc/                                                           │
│  │   └── app/                                                           │
│  ├── environments/      Per-env configuration                           │
│  │   ├── dev/                                                           │
│  │   ├── staging/                                                       │
│  │   └── prod/                                                          │
│  └── shared/            Cross-env resources                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Quick Reference as On-Call and Onboarding Resource

Keep this quick reference accessible during infrastructure work and on-call rotations. The most commonly needed commands during an incident are the diagnostic ones: `terraform show` (current state), `terraform plan -target=resource` (plan for a specific resource), and `pulumi stack --show-secrets` (current stack state with secret values). Knowing these commands without looking them up saves critical minutes during time-sensitive incidents.

The workspace and state management commands are the ones most frequently forgotten and most important to know correctly. `terraform workspace select production` followed by `terraform plan` targets the production workspace. Getting the workspace wrong and applying to the wrong environment is a serious incident that is preventable by naming workspaces explicitly and verifying them before every apply.

### Senior @ FAANG: Quick Reference as the Basis for Platform CLI

At L6/L7, this quick reference is the specification for a platform CLI that wraps these commands with organizational guardrails. Instead of running `terraform apply` directly, engineers run `platform deploy --service=myapp --env=production`, which: verifies the caller has permission to deploy to production, checks for open incidents before proceeding, runs the plan and posts it to a Slack channel for review, requires an approval from a designated reviewer, applies with audit logging, and sends a deployment notification. This wrapper converts the raw IaC commands into an organization-controlled deployment pipeline that enforces the standards in this quick reference automatically.
