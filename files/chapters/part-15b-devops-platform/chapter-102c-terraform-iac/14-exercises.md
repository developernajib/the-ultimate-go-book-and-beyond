## 102C.12 Mid-Chapter Practical Exercises

### Exercise 1: VPC Module with Terratest

Build a `modules/vpc` Terraform module and a `test/vpc_test.go` that validates:
- Correct CIDR assignment per subnet
- Private subnets have NAT gateway routes (not IGW routes)
- Public subnets have IGW routes
- DNS hostnames and DNS support enabled on VPC
- Correct number of subnets created per AZ count

### Exercise 2: ECS Service with Auto-Scaling

Extend the ECS service module to support:
- Scale-out based on custom SQS queue depth metric (not just CPU)
- Scale-to-zero for non-production environments (min_capacity=0)
- Blue/green deployment support via `deployment_controller = "CODE_DEPLOY"`
- CloudWatch alarms for: CPU > 80%, memory > 85%, no healthy targets

### Exercise 3: Multi-Environment Terragrunt Setup

Create a Terragrunt project for 3 environments (dev/staging/prod) managing:
- VPC with different CIDR ranges per environment
- RDS with different instance classes
- ECS with different task counts
- Route53 DNS entries
- Use `run-all plan` to verify all environments can plan without errors
- Add OPA policy that prevents `db.t3.micro` in production

---

### Junior → FAANG: Making Exercises Count

The three exercises above are ordered by difficulty and time investment. Exercise 1 (VPC module with Terratest) is the most important for job interviews because it combines two skills that appear together in almost every platform engineering role: writing a well-structured Terraform module and testing it with real infrastructure. Complete this exercise before applying anywhere.

The key validation to add beyond the listed requirements is the idempotency check: apply the module, immediately run `terraform plan`, and assert that the exit code is 0 (no changes). Write this assertion in your Terratest test as a named sub-test. If you submit a portfolio project with this check present, it signals genuine production awareness to any technical reviewer.

For Exercise 3 (Terragrunt), the OPA policy requirement is what separates the exercise from a standard tutorial. Research `conftest` and the `terraform plan -json` output format. The policy needs to parse the plan JSON and find any `aws_db_instance` resource with `instance_class` matching `db.t3.micro`. Writing this in Rego and integrating it into a local `make plan` target demonstrates the policy-as-code skill that appears in most FAANG platform engineering job descriptions.

### Senior @ FAANG: Extending Exercises to Staff-Level Artifacts

The exercises above test individual module skills. At staff level, the equivalent exercise is designing the infrastructure governance layer that governs all modules across an organization. Extend Exercise 3 into a full governance design:

Define a module stability tier system: stable modules (published to the internal registry, semver tagged, Terratest-gated), experimental (available but not registry-published, no SLA on breaking changes), and deprecated (pinned at current version, automated PRs to callers to upgrade, removal date published). Write the ADR for why the three tiers are sufficient and what policies govern promotion between tiers.

For Exercise 1, extend the Terratest suite to include a contract test that asserts the output interface will not break existing callers. Define a `ContractTest` function that lists every required output name, its expected format (regex for resource IDs), and minimum cardinality requirements. Run this test in a separate CI stage that blocks major version publication to the registry. Document the process for what happens when a required output must be renamed: a deprecation period with both the old and new names present simultaneously, followed by removal in the next major version.

For Exercise 2 (ECS auto-scaling), the staff-level extension is designing the handoff boundary between Terraform (provisioning) and the runtime control plane (Application Auto Scaling). Write a runbook that defines exactly which attributes are owned by Terraform (task definition CPU and memory, IAM roles, security groups, log group, load balancer target group) and which are owned by the autoscaler at runtime (desired count, current running count). Document what happens during a Terraform apply when the autoscaler has scaled the service to 15 tasks but the module default is 3: the `ignore_changes = [desired_count]` lifecycle rule preserves the autoscaler's value, and only a deliberate removal of that rule would let Terraform override it.
