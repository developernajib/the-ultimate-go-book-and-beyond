## 102G.2 Image Scanning with Trivy

### CI Integration

Trivy is an open-source vulnerability scanner that checks container images, filesystems, and Git repositories for known CVEs in OS packages and language-specific dependencies. Integrating Trivy into CI ensures that every image is scanned before it reaches any registry, and the `--exit-code 1 --severity CRITICAL` flags make the pipeline fail immediately if critical vulnerabilities are found. Piping results to SARIF format and uploading to GitHub Advanced Security puts vulnerability findings directly in the pull request review interface, where developers can act on them without switching context.

```yaml
# .github/workflows/security.yaml
name: Security Scan
on:
  push:
    branches: [main]
  pull_request:

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: docker build -t myapp:${{ github.sha }} .

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: myapp:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          exit-code: 1  # fail CI if CRITICAL or HIGH found
          ignore-unfixed: true  # ignore vulns with no fix available

      - name: Upload results to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
        if: always()

      - name: Scan filesystem (dependencies)
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: fs
          scan-ref: .
          format: table
          severity: CRITICAL,HIGH
          exit-code: 1
```

### Go Integration - Scan Before Push

Wrapping Trivy in a Go function lets you embed pre-push scanning directly into release tooling, custom CI runners, or internal developer portals without requiring every developer to remember the correct CLI flags. The `ScanImage` function shells out to `trivy` with `--format json` so results are machine-readable, while `CheckPolicy` decouples the severity threshold from the scan itself. Callers can block on `CRITICAL` in production pipelines while only warning on `HIGH` in development environments. Because Trivy exits with code `1` when it finds vulnerabilities (not on scan failure), the error-handling logic must distinguish between a scan error and a policy violation before deciding whether to abort.

```go
package security

import (
    "context"
    "encoding/json"
    "fmt"
    "os/exec"
    "strings"
)

// TrivyScanResult represents Trivy JSON output
type TrivyScanResult struct {
    Results []TrivyResult `json:"Results"`
}

type TrivyResult struct {
    Target          string            `json:"Target"`
    Vulnerabilities []TrivyVulnerability `json:"Vulnerabilities"`
}

type TrivyVulnerability struct {
    VulnerabilityID  string `json:"VulnerabilityID"`
    PkgName          string `json:"PkgName"`
    InstalledVersion string `json:"InstalledVersion"`
    FixedVersion     string `json:"FixedVersion"`
    Severity         string `json:"Severity"`
    Title            string `json:"Title"`
}

// ScanImage runs Trivy against a container image and returns vulnerabilities
func ScanImage(ctx context.Context, imageRef string) (*TrivyScanResult, error) {
    cmd := exec.CommandContext(ctx,
        "trivy", "image",
        "--format", "json",
        "--no-progress",
        "--ignore-unfixed",
        imageRef,
    )

    out, err := cmd.Output()
    if err != nil {
        // Trivy exits non-zero when vulnerabilities found - check if it's just vulns
        if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
            // Exit code 1 = vulnerabilities found, still parse output
        } else {
            return nil, fmt.Errorf("trivy scan failed: %w", err)
        }
    }

    var result TrivyScanResult
    if err := json.Unmarshal(out, &result); err != nil {
        return nil, fmt.Errorf("parse trivy output: %w", err)
    }

    return &result, nil
}

// CheckPolicy returns an error if critical vulnerabilities are found
func CheckPolicy(result *TrivyScanResult, blockSeverities []string) error {
    blocked := make(map[string]bool)
    for _, s := range blockSeverities {
        blocked[strings.ToUpper(s)] = true
    }

    var violations []string
    for _, r := range result.Results {
        for _, v := range r.Vulnerabilities {
            if blocked[v.Severity] {
                violations = append(violations, fmt.Sprintf(
                    "%s (%s) in %s@%s → fix: %s",
                    v.VulnerabilityID, v.Severity, v.PkgName,
                    v.InstalledVersion, v.FixedVersion,
                ))
            }
        }
    }

    if len(violations) > 0 {
        return fmt.Errorf("found %d blocked vulnerabilities:\n%s",
            len(violations), strings.Join(violations, "\n"))
    }
    return nil
}
```

---

### Junior → FAANG: Understanding the CVE Triage Workflow

Juniors frequently encounter Trivy results for the first time and panic at a list of 50 HIGH CVEs with no clear path forward. The skill is triage: knowing which findings require immediate action and which are acceptable risk.

The most important flag in the CI config above is `--ignore-unfixed`. A CVE with no fix available is not something a developer can act on today. Blocking CI on unfixed CVEs creates pressure without providing agency, which leads teams to suppress scanning entirely. The right policy is: block on CRITICAL with a fix available, warn on HIGH, and log unfixed CVEs separately for a scheduled review process.

Prerequisite gap: many juniors do not know how CVEs are scored (CVSS base score vs. environmental score) or what "exploitability" means in context. A CRITICAL CVE in a library you use only for parsing log output in a read-only internal tool has a very different risk profile than the same CVE in a service that parses untrusted network input. Context matters in triage.

First-job interview framing: if asked "how do you handle vulnerable dependencies," the answer that impresses is: scan in CI, triage by exploitability, block on fixable CRITICAL, automate dependency updates with Dependabot or Renovate, and review unfixed HIGH on a weekly cadence. That answer shows a complete workflow, not just "we run Trivy."

### Senior @ FAANG: Building a Vulnerability Management Program, Not Just a Scanner

At the staff level, Trivy is a data source, not a program. A vulnerability management program defines: who receives findings, what the SLA is for remediation by severity, how exceptions are approved, how SLA compliance is measured and reported, and what happens when a team misses their SLA.

The SLA policy is where most organizations underinvest. A typical FAANG baseline: CRITICAL fixable CVEs remediated within 7 days, HIGH within 30 days, MEDIUM within 90 days. The policy needs to be codified in a document signed off by security leadership, with a defined escalation path (SLA breach triggers an automated ticket to the team's engineering manager).

The Go integration pattern here (wrapping Trivy in a Go function) is the right foundation for building an internal vulnerability management service. That service calls Trivy, stores results in a database with timestamps, tracks SLA status per vulnerability per service, and exposes an API that security dashboards query. Building that service as a platform product means product teams get vulnerability tracking for free by opting into the platform.

At scale, the challenge is false positive management. Trivy may flag a CVE in a library where the vulnerable code path is never executed in your application. The platform needs a mechanism for teams to document that justification, get it reviewed by a security engineer, and have the exception recorded with an expiry date. When the library version changes or a new exploit is published, the exception must be re-evaluated automatically. Building that lifecycle is the engineering work that distinguishes a mature vulnerability management program from a scanner that produces a report nobody reads.

Bar-raiser ADR question: should you scan images at build time, at push to registry, at deploy time, or continuously for running workloads? The correct answer is all four, because each catches a different failure mode: build-time catches new vulnerabilities introduced in the current change, push-time catches vulnerabilities in base images that changed since last build, deploy-time enforces a policy gate, and continuous scanning catches CVEs published after a previously-clean image was deployed. A candidate who can articulate why each scan point adds distinct value demonstrates L6 depth.
