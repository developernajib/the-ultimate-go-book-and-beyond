## 102C.22 FAANG Senior Infrastructure Interview Questions

### Q1 (Amazon, L6): How do you design Terraform state for a multi-account, multi-region AWS org?

One S3 bucket per account for state, with a DynamoDB lock table per region. Use `terraform_remote_state` sparingly. Prefer a shared-outputs SSM parameter layer so modules stay loosely coupled. Enforce KMS-CMK encryption on the bucket and block public access at the account level. Use separate state files per environment and per blast-radius boundary (network, data, compute).

### Q2 (Google, L5): Your apply hangs on a destroy-then-create for an RDS replica. Diagnose.

Likely a provider bug or a dependency cycle after a schema change. Run `terraform plan -refresh-only` first to confirm drift. Use `-target` only for recovery, never as a workflow. Inspect `terraform state list` and the graph (`terraform graph | dot`). If the provider is stuck on a long-running AWS operation, check CloudTrail for the underlying API call rather than killing the process.

### Q3 (Meta, E6): How do you validate Terraform modules at scale?

Terratest for behavior, `terraform validate` and `tflint` for static checks, Checkov/tfsec for policy, Conftest/OPA for custom rules. Run them in a matrix over supported provider versions. Gate merges on `terraform plan` output parsed for resource churn and on cost-estimate thresholds (Infracost).

### Q4 (Netflix, Senior): When do you choose Pulumi over Terraform?

When the team is polyglot and wants real testing in Go/TypeScript, when you need dynamic resource generation that HCL makes awkward, or when you need tight integration with existing application code. Terraform wins for operator familiarity, provider breadth, and declarative simplicity.

### Q5 (Apple, ICT5): How do you handle secrets in Terraform state?

Assume state is plaintext. Encrypt at rest with KMS, restrict IAM access, never commit state. Prefer resources that reference Secrets Manager/Vault by ARN rather than materializing secret values. For unavoidable sensitive outputs, mark `sensitive = true` and scrub from logs. Rotate any secret that ever touched an un-audited workstation.

---

### Junior → FAANG: Reading Between the Lines of FAANG Interview Questions

Each question above is labeled with a company and level. These labels tell you what the interviewer is actually evaluating, not just the surface topic.

Q1 (Amazon, L6) is a system design question framed as an infrastructure question. The interviewer is evaluating whether you think in systems (blast radii, coupling, throughput) rather than in configurations (which HCL to write). The answer is a design, not a recipe: state topology decisions, cross-stack coupling choices, security controls. Junior engineers answer with "use S3 and DynamoDB." Senior engineers answer with "here is how I would design the state topology for your organizational scale."

Q2 (Google, L5) is a debugging methodology question. Google values systematic diagnosis. The answer starts with `terraform plan -refresh-only` to understand current state, uses `-target` only as a recovery tool (explicitly named as not a workflow), and uses `terraform graph | dot` to visualize the dependency graph. The key signal Google is looking for is that you reach for observability tools before you reach for workarounds.

Q3 (Meta, E6) is a scale question disguised as a testing question. The answer covers a testing pyramid: static analysis (zero cloud API calls), narrow integration tests (single module), end-to-end tests (full stack). Meta is evaluating whether you think about the cost-speed tradeoff at scale, not just whether you know Terratest exists.

Q4 (Netflix) is a technology selection judgment question. Netflix has a strong engineering culture around picking the right tool for the job. The answer must acknowledge both tools' genuine strengths rather than expressing a preference. Candidates who say "always Terraform" or "always Pulumi" without acknowledging the tradeoffs do not pass this question.

Q5 (Apple, ICT5) is a defense-in-depth security question. Apple is evaluating your security posture around infrastructure credentials. The answer layers controls (encryption, access restriction, avoid materialization, rotation) rather than relying on any single mechanism. The phrase "assume state is plaintext" is the key framing that demonstrates security sophistication.

### Senior @ FAANG: FAANG Questions as Bar-Raiser Signals

At bar-raiser level, these five questions are insufficient to evaluate an L6 candidate. Bar-raisers extend each question with follow-up probes that separate L5 answers from L6 answers.

For Q1: the follow-up is "how would you migrate from a monolithic state file to the sharded topology you described without causing an outage?" The L6 answer covers a phased migration: identify the least-coupled resources to extract first (usually monitoring or DNS, which other stacks consume but do not depend on), write the extraction runbook, execute during a low-traffic window with rollback criteria defined, and verify zero drift after each extraction phase. The L5 answer describes the target state but not the migration path.

For Q3: the follow-up is "how do you prevent test accounts from accumulating orphaned resources over time?" The L6 answer covers resource tagging policies with expiry timestamps, a cleanup Lambda with a documented exception process for long-running test resources, cost alerts at the test account level, and a monthly resource inventory review. The L5 answer describes `defer terraform.Destroy` and assumes it always runs.

For Q5: the follow-up is "a developer's laptop was stolen. What is your incident response procedure for infrastructure secrets that may have been in Terraform state files on that laptop?" The L6 answer covers identifying which state files the developer had access to (via IAM access logs), rotating all credentials that appeared in those state files (using the `ignore_changes` pattern to avoid triggering resource replacement), revoking the developer's IAM credentials immediately, auditing CloudTrail for any anomalous API calls in the hours before and after the incident, and updating the access control model so state files are not accessible from developer workstations in the future. This answer demonstrates incident response experience and systemic thinking simultaneously.
