## 110.2 Dependency Scanning with govulncheck

### Installing govulncheck

`govulncheck` installs as a standalone binary and needs no configuration to start finding reachable vulnerabilities in your module.
```bash
# Install the official Go vulnerability scanner
go install golang.org/x/vuln/cmd/govulncheck@latest

# Verify installation
govulncheck -h
```

### Basic Usage

`govulncheck` analyzes a Go module's call graph against the Go vulnerability database and reports only vulnerabilities whose affected symbols are reachable from the program, minimizing false positives compared to module-level dependency scanning. The following examples show the standard invocation forms for source and binary analysis.

```bash
# Scan your module for vulnerabilities
govulncheck ./...

# Scan with JSON output
govulncheck -json ./...

# Scan specific packages
govulncheck ./cmd/server
```

### Example Output

Interpreting `govulncheck` output correctly requires understanding which reported symbols are in the direct call graph versus transitively reachable, and which CVEs require immediate remediation versus can be deferred. The following annotated output demonstrates how to read the tool's findings and prioritize remediation.

```
Scanning your code and 147 packages across 23 dependent modules for known vulnerabilities...

Vulnerability #1: GO-2023-1840
    Improper sanitization of CSS values in github.com/microcosm-cc/bluemonday

    More info: https://pkg.go.dev/vuln/GO-2023-1840

    Module: github.com/microcosm-cc/bluemonday
    Found in: github.com/microcosm-cc/bluemonday@v1.0.23
    Fixed in: github.com/microcosm-cc/bluemonday@v1.0.24

    Call stacks in your code:
      main.go:45:20: yourpkg.SanitizeHTML calls bluemonday.UGCPolicy.Sanitize
```

### Automated Scanning Script

Wrapping `govulncheck` in a small Go tool gives CI a single deterministic gate: the tool runs the scanner, parses its streaming JSON output, prints a readable report, and exits non-zero when blocking findings are present.

```go
// tools/vulnscan/main.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Vulnerability represents a single vulnerability finding
type Vulnerability struct {
	ID          string   `json:"id"`
	Details     string   `json:"details"`
	Module      string   `json:"module"`
	Found       string   `json:"found"`
	Fixed       string   `json:"fixed"`
	AffectedPkg string   `json:"affected_pkg"`
	Severity    string   `json:"severity"`
	References  []string `json:"references"`
}

// ScanResult holds the complete scan output
type ScanResult struct {
	Vulnerabilities []Vulnerability `json:"vulnerabilities"`
	Summary         ScanSummary     `json:"summary"`
}

type ScanSummary struct {
	Total    int `json:"total"`
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
}

func main() {
	if err := runScan(); err != nil {
		fmt.Fprintf(os.Stderr, "Scan failed: %v\n", err)
		os.Exit(1)
	}
}

func runScan() error {
	// Run govulncheck with JSON output
	cmd := exec.Command("govulncheck", "-json", "./...")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// govulncheck returns non-zero if vulnerabilities found
		if len(output) == 0 {
			return fmt.Errorf("govulncheck failed: %w", err)
		}
	}

	// Parse JSON output
	vulns, err := parseVulnerabilities(output)
	if err != nil {
		return fmt.Errorf("failed to parse results: %w", err)
	}

	// Generate report
	if err := generateReport(vulns); err != nil {
		return fmt.Errorf("failed to generate report: %w", err)
	}

	// Fail if critical vulnerabilities found
	if hasBlockingVulnerabilities(vulns) {
		return fmt.Errorf("blocking vulnerabilities detected")
	}

	return nil
}

func parseVulnerabilities(data []byte) ([]Vulnerability, error) {
	var vulns []Vulnerability

	// govulncheck outputs one JSON object per line
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}

		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		// Extract vulnerability information
		if entry["finding"] != nil {
			vuln := extractVulnerability(entry)
			vulns = append(vulns, vuln)
		}
	}

	return vulns, nil
}

func extractVulnerability(entry map[string]any) Vulnerability {
	// Simplified extraction: a real implementation walks the nested
	// "finding" object and maps OSV severity data so that
	// hasBlockingVulnerabilities can act on it
	return Vulnerability{
		ID:      getString(entry, "osv"),
		Details: getString(entry, "description"),
		Module:  getString(entry, "module"),
	}
}

func getString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func generateReport(vulns []Vulnerability) error {
	fmt.Printf("\n=== Vulnerability Scan Report ===\n\n")
	fmt.Printf("Total vulnerabilities found: %d\n\n", len(vulns))

	for i, vuln := range vulns {
		fmt.Printf("%d. %s\n", i+1, vuln.ID)
		fmt.Printf("   Module: %s\n", vuln.Module)
		fmt.Printf("   Details: %s\n", vuln.Details)
		if vuln.Fixed != "" {
			fmt.Printf("   Fix: Upgrade to %s\n", vuln.Fixed)
		}
		fmt.Println()
	}

	return nil
}

func hasBlockingVulnerabilities(vulns []Vulnerability) bool {
	for _, v := range vulns {
		if v.Severity == "CRITICAL" || v.Severity == "HIGH" {
			return true
		}
	}
	return false
}
```

### CI/CD Integration

The workflow below runs `govulncheck` on every pull request, on pushes to main, and on a daily schedule, so newly disclosed vulnerabilities are caught even when no code changes.

```yaml
# .github/workflows/security.yml
name: Security Scan

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight

jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest

      - name: Scan for vulnerabilities
        run: |
          set -o pipefail
          govulncheck -json ./... | tee vuln-report.json

      - name: Upload results
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: vulnerability-report
          path: vuln-report.json
```

### Junior → FAANG: Using govulncheck Correctly

`govulncheck` is Go's official vulnerability scanner. Unlike generic SCA tools, it analyzes your call graph to report only vulnerabilities in functions your code actually calls, dramatically reducing false positives.

**Gap to close:** Run `govulncheck ./...` against your current project right now. If you have never done this, you may find vulnerabilities you did not know about. More importantly, understand what the output means: each finding includes the CVE identifier, the affected package and function, and whether your code actually calls the vulnerable function. A finding where your code does not call the vulnerable function is informational but not urgent. A finding where your code does call it is a prioritized fix.

**First-job habit:** Add `govulncheck ./...` to your CI pipeline with a non-zero exit code on findings. This prevents shipping new code that introduces known vulnerabilities. For findings in existing code, create tickets and track remediation.

**Interview framing:** When asked about Go vulnerability management, explain that `govulncheck` uses call graph analysis: it understands which functions your code calls, traces through to the vulnerable function, and only reports the vulnerability if there is a reachable call path. This makes its results more actionable than tools that report all vulnerabilities in imported packages regardless of whether the vulnerable code is reachable.

### Senior @ FAANG: Vulnerability Management Program Design

At senior level, `govulncheck` is one tool in a vulnerability management program. The program includes triage, prioritization, SLA-based remediation, and tracking.

**Vulnerability SLA policy:** Define remediation SLAs by severity: critical (CVSS 9.0+) within 24 hours, high (CVSS 7.0-8.9) within 7 days, medium (CVSS 4.0-6.9) within 30 days, low (CVSS < 4.0) at next planned update. These SLAs are organizationally committed and tracked. When SLA breaches occur, they are escalated and root-caused (was the dependency update unavailable? was testing blocking the fix? was prioritization wrong?).

**False positive management:** `govulncheck` call graph analysis reduces but does not eliminate situations where a finding is not practically exploitable given your deployment context. Define a process for documenting and tracking false positives: a structured comment in the code or a central exception register that captures the CVE, the reason it is not exploitable, the review date, and the engineer who made the determination. Exceptions are reviewed quarterly and revoked if the context changes.

**Dependency update automation:** Use Dependabot or Renovate to automate dependency version bumps. Configure them to: auto-merge patch updates with passing tests (low risk), require human review for minor updates (moderate risk), and require security engineer review for any update flagged by `govulncheck` (high risk). This automation reduces the operational burden of dependency currency without sacrificing human judgment on risk.

---
