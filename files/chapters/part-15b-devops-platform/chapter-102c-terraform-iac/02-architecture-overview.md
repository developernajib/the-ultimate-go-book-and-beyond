## Architecture Overview

Terraform manages infrastructure as a directed acyclic graph of resource dependencies, storing the computed state in an S3 backend protected by a DynamoDB lock table that prevents concurrent `apply` operations from corrupting state. HCL configuration files are organized into reusable modules sourced from the Terraform Registry or a private VCS path, and a Terragrunt DRY layer eliminates per-environment boilerplate by inheriting shared variable definitions from `_envcommon`. The resulting workflow progresses from VPC and subnet provisioning through security groups and load balancers to application-tier resources (ECS, RDS, ElastiCache), with each layer depending on outputs from the previous one.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Terraform Workflow & State Management                │
└──────────────────────────────────────────────────────────────────────────┘

  Developer / CI Pipeline
  ┌──────────────────────┐               ┌──────────────────┐
  │  terraform plan      │──── reads ──► │  Terraform State │
  │  terraform apply     │               │  (S3 + DynamoDB) │
  │  terraform destroy   │◄── writes ─── │                  │
  └──────────────────────┘               └──────────────────┘
           │                                      │
           ▼                               State Lock (DynamoDB)
  ┌──────────────────────┐                prevents concurrent applies
  │  HCL Configuration   │
  │  ├── main.tf         │
  │  ├── variables.tf    │               Module Registry
  │  ├── outputs.tf      │         ┌────────────────────────┐
  │  └── modules/        │──uses──►│  terraform-aws-modules │
  └──────────────────────┘         │  github.com/terraform  │
                                   │  registry.terraform.io │
           │                       └────────────────────────┘
           ▼
  ┌──────────────────────────────────────────────────────┐
  │                   AWS Infrastructure                 │
  │                                                      │
  │  VPC ──► Subnets ──► Security Groups                 │
  │              │                                       │
  │              ├──► ALB ──► ECS Cluster                │
  │              │              └──► ECS Service         │
  │              │                    └──► Tasks         │
  │              ├──► RDS (Multi-AZ)                     │
  │              └──► ElastiCache (Redis)                │
  └──────────────────────────────────────────────────────┘

  Terragrunt DRY Structure:
  live/
  ├── _envcommon/          # shared configs
  ├── dev/
  │   ├── vpc/
  │   ├── database/
  │   └── app/
  └── prod/
      ├── vpc/
      ├── database/
      └── app/
```

---

### Junior → FAANG: Reading the Architecture Diagram

When you first look at the architecture diagram above, focus on the data flows rather than the boxes. The critical path is: HCL files describe desired state, Terraform reads the state file to determine what already exists, the plan computes a diff, and apply executes only the delta. The DynamoDB lock table sits in that flow as a mutex: no second apply can start until the first one finishes and releases the lock.

The Terragrunt DRY structure at the bottom of the diagram answers a question that trips up junior engineers: "If I change a shared module, how do I know which environments are affected?" The answer is `terragrunt run-all plan` from the root. Every child that depends on that module will show a plan with the computed changes. You do not need to mentally trace dependencies because the dependency graph is encoded in the `dependency` blocks.

In interviews, being able to sketch this architecture on a whiteboard and explain why each component exists (versioning on S3 for rollback, encryption for secrets in state, DynamoDB for concurrency control) demonstrates production awareness beyond what most junior candidates show.

### Senior @ FAANG: State Topology as a First-Class Design Concern

The simple diagram above shows one state file. A production organization managing hundreds of teams has a state topology that is itself a design artifact requiring architectural review. At staff level, you answer questions like:

**Cross-stack coupling.** `terraform_remote_state` creates a hard read dependency from the consumer stack to the provider stack's S3 bucket. This seems convenient but creates coupling: the consumer cannot plan without network access to the producer state, secret rotation in the producer can break consumer plans, and you cannot move the producer state without updating all consumers. The alternative is publishing stack outputs to SSM Parameter Store as typed, versioned parameters. Consumers read from SSM rather than directly from state, which decouples the dependency and allows the producer state to be reorganized without consumer changes.

**State locking as a throughput bottleneck.** In a monorepo where 30 engineers push changes daily, a single state file becomes a serialization bottleneck. Every plan and apply acquires the DynamoDB lock. If an EKS node group update takes 20 minutes, all other plans against the same state are blocked. The solution is not faster hardware. It is finer-grained state sharding. The design principle: state boundaries should align with team boundaries and change frequency, not with infrastructure type. A team that deploys their service 10 times a day should have their own state file that never blocks the networking team doing a quarterly routing change.

**Module registry as an architectural boundary.** The `Module Registry` box in the diagram represents an important interface: the line between infrastructure producers (platform team, module authors) and infrastructure consumers (application teams). At L6, you design this interface explicitly: what can consumers configure, what is enforced by the module regardless of caller input, and what governance happens at the registry level (required tests, approval workflow, deprecation policy). Getting this interface wrong means either over-constraining consumers (they fork modules) or under-constraining them (they bypass the module and write raw resources, defeating the governance model).
