## 110.9 Company Case Studies: Supply Chain Security at Scale

### Google: SLSA Framework

Google proposed SLSA (Supply-chain Levels for Software Artifacts), now maintained under the OpenSSF:

```yaml
# Google-style SLSA Level 3 build
name: SLSA Build
permissions:
  id-token: write  # For signing
jobs:
  build:
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
```

### Uber: Dependency Management

Uber's approach to managing dependencies across 4,000+ microservices:
- Central dependency approval process
- Automated vulnerability scanning
- Internal module proxy for private packages

### Netflix: Container Security

Netflix's Titus platform with integrated supply chain security:
- Image signing and verification
- Runtime vulnerability scanning
- Automated base image updates

### Stripe: Hermetic Builds

Stripe's approach to reproducible, verifiable builds:
- Deterministic build environment
- Build provenance generation
- Cryptographic signing of artifacts

### Amazon: CodeArtifact and ECR

Amazon's public tooling for package and container registry security:
- Private package repositories
- Image scanning with Inspector
- Immutable image tags

**Supply Chain Security by Company**:

| Company | Key Practice | Tools |
|---------|-------------|-------|
| Google | SLSA Framework | Cloud Build, Binary Authorization |
| Uber | Central Dependency Control | Custom proxy, govulncheck |
| Netflix | Container Security | Titus, image scanning |
| Stripe | Hermetic Builds | Bazel, cosign |
| Amazon | Registry Security | CodeArtifact, ECR, Inspector |

### Junior → FAANG: Applying Case Study Lessons to Your Own Practice

The companies in this table made their supply chain security investments in response to real incidents and regulatory pressure. Each approach solves a specific problem at a specific scale.

**Gap to close:** Google's SLSA framework emerged from internal practice before it was open-sourced. The lesson is not "use SLSA" but rather "build attestable provenance for every artifact and verify it at deployment time." The specific mechanism (SLSA, in-toto, custom attestation) matters less than the principle.

**First-job takeaway:** Start with the lowest-cost interventions that provide the highest coverage: `govulncheck` in CI, pinned base images with digest references, and SBOM generation. These three steps address the most common supply chain risks with minimal investment.

### Senior @ FAANG: Benchmarking Against Industry Leaders

At senior level, you benchmark your organization's supply chain security maturity against industry leaders and use the gap to drive roadmap decisions.

**Google's SLSA as a benchmark:** If your organization is at SLSA Level 0 and Google's production workloads are at SLSA Level 3, the gap represents risk and technical debt. Write the business case: what does it cost to reach SLSA Level 1? Level 2? Level 3? What risk does each level mitigate? What is the cost of a supply chain incident at your organization's scale? This analysis drives the investment decision.

**Stripe's hermetic builds:** Hermetic builds (builds that have no network access and reproduce from only the declared inputs) are the gold standard for build security. They prevent supply chain attacks that occur during the build phase (malicious build tools, network-injected dependencies). Achieving hermetic builds requires significant toolchain investment (Bazel or a comparable system) and is the right target for organizations that ship security-critical software. Document whether this investment is appropriate for your organization and timeline.

---
