## Summary

- **Infrastructure as Code (IaC)**: Declare infrastructure in version-controlled files to enable repeatable, reviewable, and auditable provisioning - eliminating manual snowflake configurations.
- **Terraform**: HCL-based, provider-agnostic tool with a mature ecosystem. uses a plan/apply workflow and stores desired state in a remote backend with locking to prevent concurrent mutations.
- **Pulumi**: Uses general-purpose languages (Go, TypeScript, Python) for infrastructure. enables reuse of existing libraries, type-safe resources, and standard testing frameworks.
- **Remote state management**: Store Terraform state in S3/GCS/Azure Blob with DynamoDB/GCS locking. Never commit state files to version control as they contain sensitive values.
- **Modules and reusability**: Extract repeated patterns (VPC, app cluster, RDS) into versioned modules. pin module versions in consuming configurations to prevent surprise upgrades.
- **Environment isolation**: Maintain separate state backends per environment (dev/staging/prod) and use workspace or directory-per-env patterns to prevent accidental cross-environment changes.
- **Secrets in IaC**: Never store secrets in `.tf` files or Pulumi stacks. reference external secret managers (Vault, AWS Secrets Manager) and pass values at apply-time.
- **GitOps with ArgoCD/Flux**: Push IaC changes through pull requests. GitOps controllers reconcile the cluster continuously, making Git the single source of truth for both app and infrastructure state.
- **Drift detection**: Schedule regular `terraform plan` or `pulumi preview` runs in CI to detect out-of-band changes made via the cloud console and alert before they cause incidents.
- **Tagging strategy**: Apply consistent resource tags (team, environment, cost-center, service) at the module level to enable accurate cost attribution, access policies, and automated cleanup.

### Junior → FAANG: This Summary as a New Project Checklist

Apply these principles sequentially when starting any new infrastructure project. The first two (version-controlled IaC, remote state) are prerequisites for everything else. The module design principle prevents future refactoring pain. The tagging strategy enables cost attribution from day one (retrofitting tags to existing resources is painful). Drift detection prevents the configuration from becoming a historical artifact rather than the current truth.

The most common shortcut that causes long-term pain: skipping modules because the configuration is "simple" at the start. Infrastructure that starts simple rarely stays simple, and refactoring from a monolithic root configuration into modules after the fact is a multi-day project that requires careful state manipulation to avoid destroying existing resources.

### Senior @ FAANG: IaC Summary as an Infrastructure Maturity Standard

At L6/L7, this summary defines the infrastructure maturity standard for the organization. Each bullet point maps to a specific audit check: is all infrastructure in version control (verified by CSPM scanning for unmanaged resources), is state managed remotely with locking (verified by policy check on all Terraform configurations), are modules used consistently (verified by a codebase scan for copy-pasted resource blocks), is drift detected and reported (verified by a scheduled job that runs and reports plan output).

The infrastructure maturity assessment, run quarterly against these standards, provides the organizational health signal for infrastructure quality. Organizations that consistently meet all standards have predictable, safe, and cost-effective infrastructure. Organizations that drift from these standards accumulate technical debt that eventually manifests as incidents, compliance failures, and budget surprises. The staff engineer who maintains these standards and drives remediation of gaps is providing organizational infrastructure risk management at the L6/L7 level.

---

**Next Chapter: [Chapter 102B: Networking Deep Dive for Senior Go Engineers](../chapter-102b-networking-deep-dive/00-introduction.md)** - Master protocol-level networking in Go, TCP connection lifecycles, connection pooling, mTLS, HTTP/2 multiplexing, HTTP/3 QUIC, and kernel-level socket diagnostics.

