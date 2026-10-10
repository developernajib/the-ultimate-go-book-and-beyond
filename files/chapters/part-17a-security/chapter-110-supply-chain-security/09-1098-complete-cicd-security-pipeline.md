## 110.8 Complete CI/CD Security Pipeline

The complete pipeline chains every control from this chapter into one workflow: dependency and license scanning, static analysis, SBOM generation, container scanning, and image signing. Each job is a gate, and an artifact only ships after passing all of them.

```yaml
# .github/workflows/security-pipeline.yml
name: Complete Security Pipeline

on:
  pull_request:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      # Dependency scanning
      - name: Run govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

      # License scanning
      - name: Check licenses
        run: |
          go install github.com/google/go-licenses@latest
          go-licenses check ./...

      # Static analysis
      - name: Run gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -fmt json -out gosec-report.json ./...

      - name: Upload security reports
        uses: actions/upload-artifact@v4
        with:
          name: security-reports
          path: |
            gosec-report.json

  sbom-generation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          format: spdx-json
          output-file: sbom.spdx.json

      - name: Upload SBOM
        uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: sbom.spdx.json

  build-and-scan:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Build container
        run: |
          docker build -t myapp:${{ github.sha }} .

      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: myapp:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'

      - name: Upload Trivy results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Install cosign
        if: startsWith(github.ref, 'refs/tags/')
        uses: sigstore/cosign-installer@v3

      - name: Sign image
        if: startsWith(github.ref, 'refs/tags/')
        env:
          COSIGN_KEY: ${{ secrets.COSIGN_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
        run: |
          # Read the key from the environment, never write it to disk
          cosign sign --yes --key env://COSIGN_KEY myapp:${{ github.sha }}
```

### Junior → FAANG: The Security Pipeline as a Concept

The CI/CD security pipeline is not a single step: it is a sequence of gates, each of which must pass before the artifact can proceed to the next stage. Understanding this model helps you design pipelines that fail fast and fail clearly.

**Gap to close:** Understand the ordering of security steps and why it matters. Dependency scanning runs before tests (no point running tests with known-vulnerable dependencies). SAST runs alongside tests (no point delaying code analysis). Container scanning runs after the image is built (cannot scan before it exists). Signing runs last (the signed artifact is the final product). The pipeline design encodes your security model in executable form.

**First-job habit:** When you add a new security step to a CI pipeline, document what it checks, what exit code indicates a finding, and what the remediation process is. A security step without clear documentation on what to do when it fails is an obstacle that teams route around.

**Interview framing:** When asked to design a secure CI/CD pipeline, describe the stages in sequence: source integrity verification, dependency scanning, SAST, build with reproducibility flags, container scanning, SBOM generation, signing, and deployment with provenance verification. Covering the full pipeline in order demonstrates end-to-end supply chain security thinking.

### Senior @ FAANG: CI/CD Security Pipeline Governance

At senior level, the CI/CD security pipeline is shared infrastructure used by many teams. Consistency, performance, and maintainability are as important as security coverage.

**Shared pipeline templates:** Build a shared CI pipeline template (GitHub Actions reusable workflow, Jenkins shared library) that includes all security steps pre-configured. Teams import the template and get all security steps for free. Teams that customize the template are required to submit a security review for any removed or weakened steps. This approach achieves high consistency with low per-team overhead.

**Performance optimization:** Security pipeline steps add latency to developer feedback cycles. Optimize the pipeline to minimize added latency: run `govulncheck` and SAST in parallel. Cache dependency scan results keyed on `go.sum` hash (skip re-scanning when dependencies have not changed). Run container scanning asynchronously after deployment for low-risk changes (but before promotion to production). The goal is complete security coverage with minimal developer friction.

**Pipeline security itself:** The CI/CD pipeline has broad access to your codebase, build secrets, and deployment environments. Secure the pipeline: use OIDC-based authentication to cloud providers (no long-lived credentials), restrict which branches can trigger which stages (only `main` can trigger production deployments), require approval for production deployments, and audit CI/CD access logs. A compromised CI pipeline is a supply chain attack on your own infrastructure.

---
