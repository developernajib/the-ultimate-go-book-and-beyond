## 110.13 Interview Questions

### Question 1: Your team discovered a critical vulnerability in a transitive dependency. Walk me through your response process.

**What FAANG expects:** Triage → patch → verify → retro. First 30 minutes: determine *reachability* (`govulncheck` in Go is reachability-aware, not just dep-tree listing), blast radius, exploitability. Patch or vendor-fix, deploy with canary. Post-incident: SBOM audit, Dependabot/Renovate enabled, SLSA upgrade plan, artifact signing (Sigstore/cosign). Bonus for citing Log4Shell (CVE-2021-44228) as the modern baseline supply-chain incident, and for knowing that Go modules with `GOSUMDB=sum.golang.org` already verify module integrity by default.

**What interviewers are looking for**:
- Incident response methodology
- Understanding of dependency management
- Communication and prioritization skills

**Strong Answer Framework**:

```
"My response would follow a structured incident response process:

1. IMMEDIATE ASSESSMENT (First 30 minutes)
   - Identify which services use the vulnerable dependency
   - Check if the vulnerable code path is actually called
   - Determine exposure window (when was it deployed?)

2. CONTAINMENT (First hour)
   - If actively exploited: consider service isolation
   - Enable additional logging/monitoring on affected services
   - Alert security team and stakeholders

3. INVESTIGATION (First 2 hours)
   - Use govulncheck to confirm vulnerability impact:
     `govulncheck -json ./... | jq 'select(.finding != null)'`
   - Check if vulnerable functions are in call graph
   - Review CVE details and exploitation requirements

4. REMEDIATION (Same day)
   - Update dependency to patched version
   - If no patch exists: consider workarounds or removal
   - Run full test suite to validate fix

5. DEPLOYMENT (Same day if critical)
   - Fast-track deployment through CI/CD
   - Monitor for regressions
   - Verify fix in production

6. POST-INCIDENT
   - Update SBOM and dependency tracking
   - Add automated check for this CVE
   - Document lessons learned

For Go specifically, I'd use this command chain:
"
```

```bash
# Find which services are affected
for dir in ./services/*; do
    (cd "$dir" && govulncheck ./... 2>&1 | grep -q 'GO-2024-XXXX' && echo "$dir: AFFECTED")
done

# Update to fixed version
go get github.com/affected/library@v1.2.3
go mod tidy
go mod verify
```

**Key Points to Mention**:
1. "Use govulncheck to assess actual call graph impact"
2. "Transitive dependencies can be indirect, trace the full chain"
3. "Communication is critical, stakeholders need to know exposure"
4. "Post-incident: add monitoring to prevent recurrence"

---

### Question 2: "How would you design a secure CI/CD pipeline for a Go application?"

**What interviewers are looking for**:
- End-to-end security thinking
- Knowledge of supply chain tools
- Practical implementation skills

**Strong Answer Framework**:

```text
PIPELINE STAGES:

1. SOURCE VERIFICATION
   ├── Signed commits required
   ├── Branch protection rules
   └── PR review requirements

2. DEPENDENCY SECURITY
   ├── govulncheck scan
   ├── License compliance check
   └── Package allowlist verification

3. STATIC ANALYSIS
   ├── gosec for security vulnerabilities
   ├── staticcheck for code quality
   └── go vet for correctness

4. BUILD SECURITY
   ├── Reproducible builds (-trimpath)
   ├── Build provenance generation
   └── SBOM creation

5. ARTIFACT SECURITY
   ├── Image scanning (Trivy)
   ├── Image signing (cosign)
   └── SBOM attachment

6. DEPLOYMENT VERIFICATION
   ├── Signature verification
   ├── Policy enforcement
   └── Runtime scanning
```

```yaml
# Complete secure pipeline implementation
name: Secure CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write
  id-token: write  # For keyless signing

jobs:
  # Stage 1: Source Verification
  verify-commits:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Verify commit signatures
        run: |
          git log --format='%H %G?' origin/main..HEAD | \
          grep -E '\s[^G]$' && exit 1 || echo "All commits signed"

  # Stage 2: Dependency Security
  dependency-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Verify dependencies haven't been tampered
        run: go mod verify

      - name: Run govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck -format json ./... > vulns.json
          if jq -e 'select(.finding != null)' vulns.json > /dev/null; then
            echo "::error::Vulnerabilities found"
            exit 1
          fi

      - name: Check license compliance
        run: |
          go install github.com/google/go-licenses@latest
          go-licenses check ./... --disallowed_types=forbidden

      - name: Verify package allowlist
        run: |
          fail=0
          while read -r pkg; do
            grep -q "^${pkg}$" .allowed-packages.txt || {
              echo "::error::Unapproved package: $pkg"
              fail=1
            }
          done < <(go list -m all | tail -n +2 | cut -d' ' -f1)
          exit "$fail"

  # Stage 3: Static Analysis
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Run gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -fmt sarif -out gosec.sarif ./...

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: gosec.sarif

  # Stage 4: Build with Provenance
  build:
    needs: [dependency-check, security-scan]
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - name: Build reproducible binary
        id: build
        run: |
          CGO_ENABLED=0 go build -trimpath \
            -ldflags="-s -w -X main.version=${{ github.sha }}" \
            -o app ./cmd/server
          echo "digest=$(sha256sum app | cut -d' ' -f1)" >> $GITHUB_OUTPUT

      - name: Generate SBOM
        run: |
          curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh
          ./bin/syft dir:. -o spdx-json > sbom.json

  # Stage 5: Container Security
  container:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build container
        run: docker build -t myapp:${{ github.sha }} .

      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: myapp:${{ github.sha }}
          severity: CRITICAL,HIGH
          exit-code: 1

      - name: Install cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign with cosign (keyless)
        if: github.event_name == 'push'
        run: |
          cosign sign --yes myapp:${{ github.sha }}

      - name: Attach SBOM
        run: |
          cosign attach sbom --sbom sbom.json myapp:${{ github.sha }}
```

**Key Points to Mention**:
1. "Defense in depth: multiple security checks at each stage"
2. "Fail fast: block merges if vulnerabilities found"
3. "Provenance: generate attestation for builds"
4. "SBOM: essential for incident response"
5. "Keyless signing with Sigstore for ease of use"

---

### Question 3: "Explain the difference between dependency confusion and typosquatting attacks. How would you prevent both?"

**What interviewers are looking for**:
- Understanding of attack vectors
- Practical prevention strategies
- Go-specific knowledge

**Strong Answer Framework**:

```
"These are two distinct supply chain attack vectors:

DEPENDENCY CONFUSION:
- Attacker publishes public package with same name as internal package
- Build system prioritizes public registry over private
- Example: Internal package 'yourcompany/utils' gets shadowed by
  public 'github.com/yourcompany/utils'

TYPOSQUATTING:
- Attacker publishes packages with similar names to popular ones
- Relies on developer typos during import
- Example: 'github.com/gogle/oauth2' vs 'golang.org/x/oauth2'

PREVENTION STRATEGIES FOR GO:
```

```bash
# 1. GOPRIVATE to protect internal packages
export GOPRIVATE="github.com/yourcompany/*,*.internal.company.com"

# 2. GOPROXY to control package sources
export GOPROXY="https://internal-proxy.company.com,https://proxy.golang.org,direct"

# 3. GONOSUMDB for private package checksums
export GONOSUMDB="github.com/yourcompany/*"
```

```go
// 4. Implement package allowlist verification in CI
package main

import (
    "bufio"
    "fmt"
    "os"
    "os/exec"
    "strings"
)

func main() {
    // Load approved packages
    approved := loadAllowedPackages(".allowed-packages.txt")

    // Get current dependencies
    deps := getDependencies()

    var violations []string
    for _, dep := range deps {
        if !isApproved(dep, approved) {
            violations = append(violations, dep)
        }
    }

    if len(violations) > 0 {
        fmt.Println("UNAPPROVED DEPENDENCIES:")
        for _, v := range violations {
            fmt.Printf("  - %s\n", v)
        }
        os.Exit(1)
    }

    fmt.Println("All dependencies approved")
}

func loadAllowedPackages(filename string) map[string]bool {
    allowed := make(map[string]bool)
    f, err := os.Open(filename)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
        return allowed
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line != "" && !strings.HasPrefix(line, "#") {
            allowed[line] = true
        }
    }
    return allowed
}

func getDependencies() []string {
    cmd := exec.Command("go", "list", "-m", "-f", "{{.Path}}", "all")
    out, err := cmd.Output()
    if err != nil {
        fmt.Fprintf(os.Stderr, "Error listing deps: %v\n", err)
        return nil
    }
    var deps []string
    for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
        if line != "" {
            deps = append(deps, line)
        }
    }
    return deps
}

func isApproved(dep string, approved map[string]bool) bool {
    // Check exact match
    if approved[dep] {
        return true
    }

    // Check wildcard patterns (e.g., "golang.org/x/*")
    for pattern := range approved {
        if strings.HasSuffix(pattern, "/*") {
            prefix := strings.TrimSuffix(pattern, "/*")
            if strings.HasPrefix(dep, prefix+"/") {
                return true
            }
        }
    }

    return false
}
```

```
5. TYPOSQUATTING DETECTION:
   - Levenshtein distance checks against known packages
   - Block packages created recently with similar names
   - Review all new dependencies in PRs

6. PRIVATE MODULE PROXY:
   - Run internal proxy for private packages
   - Ensure internal packages can't be shadowed
   - Authenticate all module downloads
"
```

**Key Points to Mention**:
1. "GOPRIVATE is the primary defense against dependency confusion"
2. "Typosquatting requires package allowlisting and review"
3. "Internal proxy ensures private packages can't be shadowed"
4. "Both attacks require continuous monitoring"

---

### Question 4: "How would you implement SLSA Level 3 compliance for a Go project?"

**What interviewers are looking for**:
- Understanding of SLSA framework
- Practical implementation knowledge
- Build security concepts

**Strong Answer Framework**:

```
"SLSA Level 3 requires:
1. Non-falsifiable provenance: the build service generates the attestation
2. Isolated builds: prevent cross-build interference
3. Hardened build platform: prevent tampering

Implementation for Go project:

STEP 1: Use trusted build service (GitHub Actions with SLSA generator)
STEP 2: Generate build provenance attestation
STEP 3: Sign provenance with keyless signing
STEP 4: Verify provenance before deployment
```

```yaml
# .github/workflows/slsa-release.yml
name: SLSA Level 3 Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write
  id-token: write  # For signing

jobs:
  # Build the binary and generate hash
  build:
    runs-on: ubuntu-latest
    outputs:
      hashes: ${{ steps.hash.outputs.hashes }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Build binary
        env:
          CGO_ENABLED: 0
        run: |
          go build -trimpath -ldflags="-s -w" -o myapp ./cmd/server

      - name: Generate subject hash
        id: hash
        run: |
          set -euo pipefail
          echo "hashes=$(sha256sum myapp | base64 -w0)" >> "$GITHUB_OUTPUT"

      - uses: actions/upload-artifact@v4
        with:
          name: myapp
          path: myapp
          if-no-files-found: error
          retention-days: 5

  # Generate SLSA provenance using official generator
  provenance:
    needs: [build]
    permissions:
      actions: read
      id-token: write
      contents: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
    with:
      base64-subjects: "${{ needs.build.outputs.hashes }}"
      upload-assets: true

  # Verify and create release
  release:
    needs: [build, provenance]
    runs-on: ubuntu-latest
    steps:
      - name: Download binary
        uses: actions/download-artifact@v4
        with:
          name: myapp

      - name: Download provenance
        uses: actions/download-artifact@v4
        with:
          name: myapp.intoto.jsonl

      - name: Verify provenance
        run: |
          # Install slsa-verifier
          go install github.com/slsa-framework/slsa-verifier/v2/cli/slsa-verifier@latest

          # Verify the artifact
          slsa-verifier verify-artifact myapp \
            --provenance-path myapp.intoto.jsonl \
            --source-uri github.com/${{ github.repository }} \
            --source-tag ${{ github.ref_name }}

      - name: Create release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            myapp
            myapp.intoto.jsonl
```

```bash
# User verification of downloaded artifact
slsa-verifier verify-artifact myapp \
  --provenance-path myapp.intoto.jsonl \
  --source-uri github.com/yourorg/yourrepo \
  --source-tag v1.0.0
```

**Key Points to Mention**:
1. "SLSA 3 requires a trusted build service, you can't self-attest"
2. "Provenance is generated during the build, not after"
3. "Keyless signing (Fulcio/Rekor) eliminates key management"
4. "Verification must happen at deployment time"
5. "The slsa-github-generator handles the complex attestation format"

### Junior → FAANG: Supply Chain Interview Questions Require Process Thinking

Supply chain security interview questions are process questions as much as technical questions. The interviewer wants to know how you think about the problem, how you triage and prioritize, and how you communicate during an incident.

**Gap to close:** For Question 1 (transitive dependency vulnerability), practice the answer until it is reflexive: (1) identify all services affected using SBOM query, (2) use govulncheck to determine if the vulnerability is reachable in each service, (3) prioritize by reachability and service criticality, (4) patch and deploy in priority order, (5) run post-incident review. This five-step process is the L4/L5 answer. The L3 answer stops at "update the dependency."

**Interview signal:** Adding "I would also check whether the vulnerability was exploited before we patched it by reviewing access logs for anomalous patterns" elevates the answer from reactive (fix the vulnerability) to proactive (assess the exposure). This signal matters to security-focused interviewers.

### Senior @ FAANG: Supply Chain Design Questions at L6+

Senior supply chain interviews probe organizational design: "How would you build a supply chain security program for 50 Go services across 10 teams?" This is not a technical question: it is a program design question.

**Program design answer:** Describe the phases: (1) foundations (govulncheck in CI, SBOM generation, base image pinning) that can be rolled out in parallel across all teams using a shared CI template, (2) visibility (SBOM repository, vulnerability feed integration, compliance dashboard) that gives leadership and teams insight into their posture, (3) enforcement (admission control, deployment gates, SLA-based remediation tracking) that converts visibility into accountability. Each phase has a timeline, a rollout plan, and success metrics.

**Trade-off reasoning:** A bar-raiser will probe the trade-offs: "If you require digest pinning for all base images, how do you handle security patches to the base image?" The answer: Dependabot or Renovate automatically updates digest pins when the upstream image receives a security update, creating a PR for review. The review ensures the update is intentional and tested. This demonstrates that you have thought through the operational implications of the security control, not just its technical properties.

---
