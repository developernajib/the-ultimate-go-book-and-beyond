## 102C.16 Advanced IaC Interview Questions

---

**Q16: How does Terratest ensure test isolation, and what happens if a test fails mid-apply?**

Test isolation relies on unique resource names per test run. Use `random.UniqueId()` or timestamp-based suffixes in all resource names so parallel CI runs (multiple open PRs each triggering tests) do not conflict on the same AWS account. If a test fails mid-apply: `defer terraform.Destroy(t, opts)` is registered before `InitAndApply`, so it runs regardless of outcome - panic, `t.Fatal`, or timeout. The deferred destroy calls `terraform destroy -auto-approve` and cleans up whatever was provisioned before the failure. For expensive resources (RDS takes ~8 minutes to create), use `test_structure` stages so you can iterate on assertion code by setting `SKIP_deploy=true` without paying the creation cost on every run.

---

**Q17: What is Terraform state locking, and how do you handle a stale lock?**

State locking prevents concurrent operations from corrupting the shared state file. With S3 + DynamoDB: when an operation begins, Terraform writes a lock record to the DynamoDB table containing the lock ID, caller identity, and timestamp. Concurrent operations fail with a lock error showing who holds the lock and since when. The lock releases on completion regardless of success or failure. A stale lock occurs when the process is killed before releasing it (EC2 runner crashes, network interruption mid-apply). Resolution: `terraform force-unlock <lock-id>` deletes the DynamoDB item. Safeguard: create a CloudWatch alarm that fires when a DynamoDB lock item is older than 30 minutes - this indicates a stuck pipeline needing investigation. Never run force-unlock without first confirming no Terraform process is actively applying.

---

**Q18: How do you handle Terraform module versioning in a monorepo versus separate repositories?**

**Separate module repos** (recommended for large organizations): each module has its own Git repository tagged with semantic versions (`v1.2.0`). Callers reference `source = "git::https://github.com/org/terraform-aws-vpc.git?ref=v1.2.0"` or via the Terraform Registry. Benefits: independent versioning, clear changelogs, consumers control upgrade timing. **Monorepo**: modules live in `modules/` and are referenced by relative path - no versioning, callers always use the latest version. Simplest for small teams. The risk is that any module change immediately affects all callers. **Best practice in both cases**: pin module versions explicitly in production workspaces, use `ref=main` only in development. Automate upgrade PRs with Renovate Bot or Dependabot. Never reference `ref=main` in production - it violates reproducibility and can cause unreviewed changes to deploy automatically.

---

**Q19: How do you detect and remediate Terraform drift in production?**

Drift occurs when infrastructure is modified outside Terraform (AWS Console, CLI, AWS auto-healing). Detection: run `terraform plan` on a schedule (daily CI job with no apply step) - any non-empty plan output indicates drift. `terraform refresh` updates state to reflect actual infrastructure and shows what diverged from the desired configuration. Remediation options: (1) **import** the out-of-band change if it was intentional - `terraform import aws_security_group.web sg-12345` brings the resource under Terraform management without recreating it. (2) **re-apply** to restore desired state if the change was unauthorized. (3) **update HCL to match** the change and import - treating the manual change as a deliberate configuration update. Prevention: use AWS Service Control Policies (SCPs) to block direct console modifications of production infrastructure and enforce all changes through Terraform pipelines (IaC as the only door into production).

---

**Q20: Compare CDKTF versus plain HCL for a team managing 50+ microservices.**

At 50+ microservices, HCL hits its abstraction ceiling: each service needs a module invocation with 15+ variable assignments, and `for_each` over service configuration maps becomes unwieldy and hard to audit. CDKTF advantage at scale: define a `MicroserviceConstruct` once, instantiate it 50 times with compile-time type checking - a typo in a variable name is a build error caught in seconds, not a `terraform plan` failure 3 minutes into CI. Shared infrastructure patterns become importable Go packages versioned with `go.mod` and standard semver. Unit testing uses `go test` directly on the synthesized JSON without Terratest wrappers. Downsides: generated provider bindings add compilation overhead (large `vendor/` directory), bindings occasionally lag provider releases by weeks, and debugging requires understanding both Go code and the generated JSON. Recommendation: use CDKTF for homogeneous application infrastructure (50 similar Fargate services), keep foundational infrastructure (VPCs, accounts, DNS, organization IAM) in plain HCL where the Terraform Registry module ecosystem provides the most value.

---

### Junior → FAANG: Preparing for the Advanced Question Set

Questions 16 through 20 represent the depth of infrastructure knowledge expected at L5 interviews and above. If you are preparing for your first platform or DevOps engineering role, prioritize Q17 (state locking) and Q19 (drift detection) because they test production awareness that most junior candidates lack.

For Q17: practice saying the full sequence out loud. "State locking writes a record to DynamoDB with the caller identity and timestamp. A concurrent apply reads the record, sees the lock is held, and fails with an error showing who holds it and since when. If the locking process crashes, the record remains and subsequent applies fail. `terraform force-unlock <lock-id>` removes the record manually. You should only do this after confirming no apply is actually in progress, and you should set up a CloudWatch alarm for lock items older than 30 minutes."

For Q19: understand the three remediation options and when each applies. Import is for intentional changes you want to keep. Re-apply is for unauthorized changes you want to revert. Update HCL to match and import is for intentional changes that were made manually and need to be codified. The interviewer is testing whether you can distinguish these cases, not just list the commands.

### Senior @ FAANG: Advanced Questions as System Design Conversations

At L6, each of these questions opens into a system design conversation. Q16 (Terratest isolation) becomes: "Design a test infrastructure platform for 30 module repositories with a shared test account." The complete answer covers resource tagging for cleanup, quota management for parallel runs, cost budgeting per test suite, and the PR-level test caching strategy (when can you skip re-running a test because nothing relevant changed).

Q18 (module versioning monorepo vs. separate repos) at L6 is an organizational structure question. The answer depends on your team's ownership model: monorepo works when a single platform team owns all modules (fast iteration, easy refactoring, but bottleneck risk). Separate repos work when teams own their own infrastructure modules (autonomy and independent versioning, but cross-module changes require coordinating multiple repos). At bar-raiser level, you describe the hybrid: a monorepo for foundational infrastructure modules owned by the platform team, separate repositories for service-specific modules owned by product teams. The registry is the integration point between them.

Q20 (CDKTF vs. HCL for 50 microservices) is a technology selection ADR at L6. The complete answer includes: the migration path (new services use CDKTF constructs, existing services stay in HCL until a complexity threshold is hit), the governance model for the construct library (who owns it, how is it versioned, what is the deprecation process), the policy-as-code integration (Conftest runs on synthesized JSON from both HCL and CDKTF), and the team skill investment (CDKTF requires Go proficiency, assess current team skills before recommending adoption). Presenting this level of structured thinking is what distinguishes L6 responses from L5 responses.
