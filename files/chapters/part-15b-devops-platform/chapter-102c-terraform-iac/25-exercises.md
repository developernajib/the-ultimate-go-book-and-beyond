## Exercises

### Exercise 1: Multi-Region Active-Active Deployment

Design a Terraform module that deploys an application to two AWS regions simultaneously:
- VPC in each region with matching CIDR structure (10.0.0.0/16 in us-east-1, 10.1.0.0/16 in us-west-2)
- VPC peering between regions for private service-to-service communication
- Route53 latency-based routing pointing to ALBs in both regions
- RDS Global Database (primary in us-east-1, read replica in us-west-2) with automated failover
- Global DynamoDB table for session data with multi-region replication
- Write a Terratest that verifies: both regions respond to HTTPS health checks, Route53 latency routing resolves to the nearest region from both US coasts

### Exercise 2: Zero-Downtime RDS Migration

An existing RDS PostgreSQL 13 instance needs upgrading to PostgreSQL 15 with zero application downtime:
- Research the upgrade path (13 to 14 to 15, or verify if direct 13 to 15 is supported for your instance class)
- Use `create_before_destroy` lifecycle and blue/green RDS cluster approach
- Implement traffic cutover using Route53 CNAME weighted routing (start 90/10, then 0/100)
- Write a Terratest validating: old DB accepts writes during migration, logical replication keeps new DB within 10 seconds lag, cutover to 100% new DB produces no application errors
- Document the state surgery steps: how the old resource address transitions to the new one in state

### Exercise 3: Custom Terraform Provider in Go

Build a minimal Terraform provider in Go for a fictional internal team management API:
- Implement `resource "internalapi_team" {}` with full CRUD lifecycle and proper error handling
- Use the Terraform Plugin Framework (`github.com/hashicorp/terraform-plugin-framework`)
- Add import support so existing teams can be imported with `terraform import`
- Implement `data "internalapi_teams" {}` that lists and filters all teams
- Write acceptance tests using `resource.Test` from `terraform-plugin-testing`
- Configure `dev_overrides` in `~/.terraformrc` for local development without registry publishing

### Exercise 4: Policy-as-Code with OPA and Conftest

Implement an OPA/Conftest policy layer that blocks non-compliant Terraform plans before they reach Atlantis:
- No RDS instances with `deletion_protection = false` in any workspace tagged "production"
- All S3 buckets must have `server_side_encryption_configuration` defined
- ECS task definitions must have `readonly_root_filesystem = true` for all containers
- No security group rules allowing `cidr_blocks = ["0.0.0.0/0"]` on port 22 (SSH)
- EC2 instances must use AMIs from an OPA data file allowlist (updated by security team quarterly)

Write Rego policies, integrate with `conftest` for local and CI usage, and add a GitHub Actions step that runs `terraform show -json tfplan > plan.json && conftest test --policy policy/ plan.json` on every PR.

### Exercise 5: Terragrunt with AWS Organizations

Model a real-world AWS Organizations structure using Terragrunt:
- 4 accounts: management, security, shared-services, production
- Management: Service Control Policies, account vending machine via Control Tower
- Security: GuardDuty master account, Security Hub aggregator, CloudTrail organization trail
- Shared-services: ECR, Route53 hosted zones, ACM certificates, Transit Gateway hub
- Production: EKS cluster pulling images from shared ECR, routing traffic via Transit Gateway

Implement `terragrunt run-all plan` with proper `dependency` blocks ensuring production applies after shared-services outputs are available. Document the circular dependency scenario: production ECR pull-through cache needs the production account ID for the ECR resource policy, but production is defined after shared-services.

### Exercise 6: Complete GitOps Infrastructure Pipeline

Implement a full GitOps infrastructure delivery pipeline integrating all chapter concepts:
1. **Terraform modules**: VPC, EKS cluster, RDS PostgreSQL, ElastiCache Redis, S3 buckets, IAM roles with IRSA annotations for pod-level AWS access
2. **Terratest**: module integration tests with `t.Parallel()`, idempotency verification, HTTP endpoint validation against deployed services
3. **Atlantis**: self-hosted on EKS (solve the bootstrap problem: local apply for EKS cluster first, then migrate state). Configure `atlantis.yaml` with `apply_requirements: [approved, mergeable]`
4. **OPA/Conftest**: policies enforced in a pre-Atlantis CI step that blocks non-compliant plans before they reach the review stage
5. **Drift detection**: scheduled GitHub Actions workflow running `terraform plan` nightly, posting the plan output to a Slack channel if changes are detected
6. **Operational runbooks**: document the procedures for onboarding a new microservice (creating ECS service, IAM role, Route53 record), rotating RDS credentials without downtime, and recovering from a locked or corrupted state file

---

### Junior → FAANG: Prioritizing the Exercise Set

Six exercises is a full engineering sprint. If you have limited time, complete Exercise 3 (OPA/Conftest policies) and Exercise 1 (multi-region deployment) before the others. Exercise 3 is the highest signal in interviews because policy-as-code is listed in nearly every senior platform engineering job description but is rarely practiced by candidates below L5. Working through Rego policy syntax and `conftest` integration gives you a concrete skill that most candidates claim but cannot demonstrate.

Exercise 1 (multi-region active-active) is the most architecturally complex and the most likely to generate substantive portfolio project conversations in interviews. A working two-region deployment with Route53 latency routing and a Global RDS database is a significant achievement. Document your architectural decisions (why latency routing rather than failover routing, why Aurora Global rather than a read replica, how you handle split-brain scenarios during a regional outage) as an ADR in the repository.

For Exercise 6 (GitOps pipeline): this is the capstone that ties all other skills together. The bootstrap problem in the Atlantis requirement (how do you use Terraform to provision the cluster that will run Terraform?) is a canonical infrastructure engineering challenge. Document your bootstrap procedure clearly: which resources are provisioned manually in the first apply, which are migrated to remote state, and what the full recovery procedure is if the Atlantis cluster needs to be rebuilt.

### Senior @ FAANG: Using Exercises to Drive Staff-Level Portfolio Work

At L6, exercises are not just practice problems. They are the seed of real architectural contributions. Each exercise above maps to a staff-level deliverable:

Exercise 1 (multi-region) maps to a business continuity architecture document: the decision to use active-active vs. active-passive, the RTO and RPO targets that drove the RDS Global Database choice, the cost model comparing single-region and multi-region for the specific traffic profile, and the runbook for executing a regional failover. Writing this document for a real system is an L6-level artifact.

Exercise 4 (OPA/Conftest) maps to a compliance control catalog: for each policy you write, document the security requirement it enforces (PCI DSS, SOC 2, CIS Benchmark), the failure mode it prevents, and the exemption process for cases where the policy must be bypassed with documented justification. This control catalog is the artifact that satisfies auditors without requiring manual evidence collection.

Exercise 5 (Terragrunt with AWS Organizations) maps to an account vending machine design: the automated pipeline that provisions a new AWS account with all baseline security, networking, and Terraform remote state infrastructure in under 10 minutes. This is the platform capability that enables a large engineering organization to create new product teams without a multi-week infrastructure setup process. Building a working implementation of this is a principal-level portfolio contribution at most organizations.
