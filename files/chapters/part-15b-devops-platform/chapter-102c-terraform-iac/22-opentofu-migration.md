## 102C.20 OpenTofu Migration

OpenTofu is the open-source fork of Terraform maintained by the Linux Foundation, created after HashiCorp changed Terraform's license to BSL 1.1 in August 2023. It maintains API compatibility with Terraform 1.5.x while adding new features on an independent roadmap.

### Key Differences

| Feature | Terraform (BSL 1.1) | OpenTofu (MPL 2.0) |
|---|---|---|
| License | Business Source License | Mozilla Public License, fully open source |
| State encryption | Terraform Cloud only | Built-in (1.7+) AES-GCM/PBKDF2 |
| Provider registry | registry.terraform.io | registry.opentofu.org (mirrors hashicorp) |
| Policy enforcement | Sentinel (paid add-on) | Native OPA integration on roadmap |
| Governance | HashiCorp-controlled | Linux Foundation Technical Committee |
| Variable/output iteration | Limited | Enhanced for_each on providers (1.7+) |

### Migration Checklist

Migrating from Terraform to OpenTofu is a drop-in binary swap. No state conversion or provider changes are needed because both tools share the same state schema and provider protocol. The critical step is regenerating the `.terraform.lock.hcl` file with `tofu providers lock` to ensure platform-specific checksums are recorded for all target operating systems. CI/CD pipeline changes are limited to replacing the `terraform` binary name with `tofu` in every step.

```bash
# 1. Install OpenTofu
brew install opentofu                                       # macOS
curl --proto '=https' --tlsv1.2 \
  -fsSL https://get.opentofu.org/install-opentofu.sh | sh  # Linux

# 2. Verify OpenTofu reads existing state without conversion
tofu init
tofu plan   # Expected: No changes. Infrastructure is up-to-date.

# 3. Update CI/CD pipelines -- replace binary name only
# Before: terraform init && terraform plan && terraform apply
# After:  tofu init     && tofu plan     && tofu apply

# 4. Regenerate lock file for all target OS/arch combinations
tofu providers lock \
  -platform=linux_amd64 \
  -platform=darwin_amd64 \
  -platform=darwin_arm64
```

### Provider Compatibility

All providers on the Terraform Registry work with OpenTofu, the OpenTofu registry mirrors the Terraform registry at startup and for on-demand downloads:

```hcl
# versions.tf -- identical syntax and source addresses for both tools
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"   # Same source reference
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }
}
```

### State File Compatibility

Terraform and OpenTofu use the identical state format (schema version 4). No migration or conversion is required when switching between tools:

```bash
tofu state list   # Reads existing Terraform state without modification

# Both tools produce the same output format:
# {"version": 4, "terraform_version": "x.y.z", "serial": N, "resources": [...]}
```

For the Terraform Cloud state backend: OpenTofu uses the standard HTTP state backend protocol, so it works with Terraform Cloud's state storage. The UI, Sentinel policies, and private module registry remain HashiCorp-proprietary. Open-source alternatives include Atlantis (PR-based apply), Spacelift, and env0.

---

### Junior → FAANG: Understanding the OpenTofu Landscape

The Terraform license change in August 2023 is a fact that appears in infrastructure engineering interviews, particularly at companies that have strong open-source commitments. Understanding the context matters: HashiCorp changed Terraform's license from MPL 2.0 (permissive open source) to BSL 1.1 (source-available but with commercial restrictions). OpenTofu is the community response, forked from Terraform 1.5.x and maintained under the Linux Foundation.

For your career: the tooling difference is minimal. The commands are the same, state format is the same, providers are compatible. If your employer uses OpenTofu, you use OpenTofu. If they use Terraform, you use Terraform. The practical skill is the same in both cases.

The migration checklist in this section is exactly what you would follow if asked to migrate a team's infrastructure. The critical step that surprises engineers is the lock file regeneration: `tofu providers lock` must be run for all target platforms because the checksums in `.terraform.lock.hcl` are tool-specific and cannot be reused from the Terraform lock file.

For interviews, be able to explain the license distinction concisely: "BSL 1.1 restricts commercial use of the software to offer a competing service. Organizations that are not building a competing service can continue using Terraform under BSL. OpenTofu is the fully open-source alternative."

### Senior @ FAANG: OpenTofu as a Strategic Decision

At L6, the Terraform to OpenTofu migration decision is a governance and risk question, not a technical one. The technical migration is trivially simple (binary swap, lock file regeneration). The governance question is more complex.

**License compliance as an organizational risk.** The BSL 1.1 restriction specifically targets companies offering "a substantially similar functionality" as Terraform. For most organizations using Terraform to provision their own infrastructure, the BSL restriction does not apply. For companies building internal developer platforms, IaC-as-a-service tools, or multi-tenant infrastructure automation, legal counsel should review whether the use case falls within the BSL restriction before continuing on Terraform. At L6, you escalate this to legal rather than making the determination yourself, and you ensure the decision is documented in an ADR with a date and the legal opinion referenced.

**Dependency risk under BSL.** Even for organizations where the BSL restriction clearly does not apply, there is a strategic dependency risk: HashiCorp can modify the BSL terms at any time for future Terraform versions. Organizations that depend on Terraform for critical infrastructure automation are accepting a dependency on HashiCorp's future licensing decisions. The OpenTofu migration eliminates this dependency by switching to a foundation-governed, MPL 2.0 licensed tool with a technical steering committee that cannot unilaterally change the license. At staff level, you weigh this strategic risk against the cost of migration and the maturity gap between OpenTofu and Terraform (OpenTofu has fewer features and a smaller ecosystem at the time of writing).

**OpenTofu's differentiated features as a migration accelerator.** OpenTofu 1.7+ introduced client-side state encryption with AES-GCM, a capability that Terraform only offers through Terraform Cloud (a paid service). For organizations with strict data residency or zero-trust requirements for infrastructure credentials in state files, this feature alone may justify migration. At L6, you evaluate whether your organization's security requirements are met by KMS-encrypted S3 state (Terraform's approach) or whether client-side encryption before the data leaves the executor provides a meaningful additional security layer for your threat model.
