## 99.10 Security Scanning in CI

### Comprehensive Security Pipeline

```yaml
# .github/workflows/security.yaml
name: Security Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6 AM

jobs:
  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck -json ./... > vuln-report.json

      - name: Upload vulnerability report
        uses: actions/upload-artifact@v4
        with:
          name: vulnerability-report
          path: vuln-report.json

      - name: Fail on vulnerabilities
        run: |
          if grep -q '"osv":' vuln-report.json; then
            echo "Vulnerabilities found!"
            cat vuln-report.json | jq '.[]'
            exit 1
          fi

  static-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -fmt=sarif -out=gosec.sarif ./...

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: gosec.sarif

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: TruffleHog
        run: |
          docker run --rm -v "$PWD:/repo" trufflesecurity/trufflehog:latest \
            filesystem /repo \
            --only-verified \
            --fail

      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  container-scan:
    runs-on: ubuntu-latest
    needs: [dependency-scan, static-analysis]
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: docker build -t myapp:scan .

      - name: Trivy scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'myapp:scan'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
          ignore-unfixed: true

      - name: Upload Trivy results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Fail on critical vulnerabilities
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'myapp:scan'
          exit-code: '1'
          severity: 'CRITICAL'
          ignore-unfixed: true

  sbom:
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
```

### Pre-commit Hooks for Security

Shifting security checks left to the developer's local machine catches issues before they reach the remote pipeline, avoiding the feedback delay of a full CI run. The hooks below run `gitleaks` and `detect-private-key` to block accidental credential commits, `gosec` to flag dangerous Go patterns such as weak cryptography or unsanitized shell arguments, and `govulncheck` to reject commits that introduce known CVEs in module dependencies, all enforced automatically on every `git commit`.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: detect-private-key
      - id: check-added-large-files
        args: ['--maxkb=500']

  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks

  - repo: https://github.com/securego/gosec
    rev: v2.18.2
    hooks:
      - id: gosec
        args: ['-exclude-dir=vendor', './...']

  - repo: local
    hooks:
      - id: go-vet
        name: go vet
        entry: go vet ./...
        language: system
        pass_filenames: false

      - id: govulncheck
        name: govulncheck
        entry: govulncheck ./...
        language: system
        pass_filenames: false
```

---

### Junior → FAANG: Security Scanning as a Standard CI Step

Many junior engineers treat security scanning as optional or as something the security team runs separately. Both framings are wrong. Security scanning in CI is the mechanism that catches vulnerabilities before they reach production, and it is most effective when run automatically on every PR, not as a periodic batch scan.

The three scanners that should be in every Go CI pipeline: `govulncheck` (checks Go module dependencies against the Go vulnerability database), `gosec` (static analysis for common Go security mistakes like SQL injection, command injection, and hardcoded credentials), and a container image scanner (trivy or grype) that checks the base image and installed packages for known CVEs. Each scanner catches a different class of vulnerability, and together they provide meaningful coverage.

First-job habit: understand what each scanner checks and what it does not. `govulncheck` does not check container image vulnerabilities. `trivy` does not check Go code patterns. Knowing the scope of each scanner helps you respond appropriately when a scanner flags something and helps you explain the coverage model to reviewers.

### Senior @ FAANG: Security Scanning Pipeline Governance and Vulnerability Management

At staff level, security scanning is not a CI step: it is a vulnerability management program. The difference is that a CI step reports findings but does not ensure they are remediated. A program has owners, SLAs, tracking, and enforcement.

The governance model: critical vulnerabilities (CVSS 9.0+) block the pipeline immediately and require same-day remediation with an exception process for false positives. High vulnerabilities (CVSS 7.0-8.9) produce a warning and require remediation within 7 days. Medium and low vulnerabilities are tracked and remediated on a 30-day and quarterly cadence respectively. The findings are aggregated in a central dashboard (often a vulnerability management platform like Snyk, Wiz, or an in-house system) where each finding has an owner and a due date.

The supply-chain security layer extends beyond vulnerability scanning: dependency license compliance (checking that all transitive dependencies use licenses compatible with the product's distribution model), SBOM (Software Bill of Materials) generation for each release artifact, and provenance attestation (a machine-verifiable record that each artifact was built from specific source at a specific commit). The SBOM and provenance attestations are the foundation of a software supply-chain security program that meets emerging regulatory requirements (EU Cyber Resilience Act, NIST SSDF). Designing this program and integrating it into the CI/CD pipeline is an L6/L7 security engineering contribution.
