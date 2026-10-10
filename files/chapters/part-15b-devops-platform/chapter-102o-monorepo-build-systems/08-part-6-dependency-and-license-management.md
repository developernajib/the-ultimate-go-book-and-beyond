## 102O.6 Dependency and License Management

Dependency management in a monorepo must address two concerns simultaneously: security (known vulnerabilities in transitive dependencies) and legal (license compatibility with your distribution model). The tool below combines `govulncheck` for vulnerability scanning with a license allowlist check that reads each dependency's declared license from its module metadata. Running both checks as a CI gate prevents new dependencies from introducing GPL-licensed code into a proprietary codebase or known CVEs into the production dependency graph without a tracked exception.

```go
// cmd/depcheck/main.go - checks dependencies for licenses and vulnerabilities
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// LicenseChecker validates dependency licenses
type LicenseChecker struct {
	allowed  []string
	denied   []string
}

func NewLicenseChecker() *LicenseChecker {
	return &LicenseChecker{
		allowed: []string{
			"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
			"ISC", "MPL-2.0", "LGPL-2.1",
		},
		denied: []string{
			"GPL-2.0", "GPL-3.0", "AGPL-3.0", "CC-BY-NC", "SSPL",
		},
	}
}

type ModuleInfo struct {
	Path     string `json:"Path"`
	Version  string `json:"Version"`
	License  string `json:"License,omitempty"`
	Indirect bool   `json:"Indirect,omitempty"`
}

// CheckLicenses uses go-licenses to verify all dependencies
func (c *LicenseChecker) CheckLicenses() ([]LicenseViolation, error) {
	// Use google/go-licenses
	out, err := exec.Command("go-licenses", "csv", "./...").Output()
	if err != nil {
		return nil, fmt.Errorf("go-licenses: %w", err)
	}

	var violations []LicenseViolation
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) < 3 {
			continue
		}
		pkg := parts[0]
		licenseURL := parts[1]
		licenseType := parts[2]

		if c.isDenied(licenseType) {
			violations = append(violations, LicenseViolation{
				Package: pkg,
				License: licenseType,
				URL:     licenseURL,
				Reason:  "license is in denied list",
			})
		} else if !c.isAllowed(licenseType) {
			violations = append(violations, LicenseViolation{
				Package: pkg,
				License: licenseType,
				URL:     licenseURL,
				Reason:  "license not in allowed list",
			})
		}
	}

	return violations, nil
}

type LicenseViolation struct {
	Package string
	License string
	URL     string
	Reason  string
}

func (c *LicenseChecker) isAllowed(license string) bool {
	for _, a := range c.allowed {
		if strings.EqualFold(a, license) {
			return true
		}
	}
	return false
}

func (c *LicenseChecker) isDenied(license string) bool {
	for _, d := range c.denied {
		if strings.EqualFold(d, license) {
			return true
		}
	}
	return false
}

// VulnerabilityScanner runs govulncheck
type VulnerabilityScanner struct{}

type Vulnerability struct {
	ID          string   `json:"osv"`
	Modules     []string `json:"modules"`
	Description string   `json:"description"`
	Fixed       string   `json:"fixed"`
}

func (s *VulnerabilityScanner) Scan(dir string) ([]Vulnerability, error) {
	cmd := exec.Command("govulncheck", "-json", "./...")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return nil, fmt.Errorf("govulncheck: %w", err)
	}

	var result struct {
		Vulns []struct {
			OSV struct {
				ID      string `json:"id"`
				Details string `json:"details"`
			} `json:"osv"`
			Modules []struct {
				Path    string `json:"path"`
				Fixed   string `json:"fixed_version"`
			} `json:"modules"`
		} `json:"vulns"`
	}

	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parse vulnerabilities: %w", err)
	}

	var vulns []Vulnerability
	for _, v := range result.Vulns {
		var modules []string
		fixed := ""
		for _, m := range v.Modules {
			modules = append(modules, m.Path)
			if m.Fixed != "" {
				fixed = m.Fixed
			}
		}
		vulns = append(vulns, Vulnerability{
			ID:          v.OSV.ID,
			Modules:     modules,
			Description: v.OSV.Details,
			Fixed:       fixed,
		})
	}

	return vulns, nil
}

func main() {
	checker := NewLicenseChecker()
	scanner := &VulnerabilityScanner{}

	dir, _ := os.Getwd()

	// Check vulnerabilities
	fmt.Println("Checking for vulnerabilities...")
	vulns, err := scanner.Scan(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "vulnerability scan error: %v\n", err)
	} else if len(vulns) > 0 {
		fmt.Printf("⚠️  Found %d vulnerabilities:\n", len(vulns))
		for _, v := range vulns {
			fmt.Printf("  %s: %s\n", v.ID, v.Description[:min(80, len(v.Description))])
			if v.Fixed != "" {
				fmt.Printf("    Fix available: %s\n", v.Fixed)
			}
		}
	} else {
		fmt.Println("✓ No vulnerabilities found")
	}

	// Check licenses
	fmt.Println("\nChecking licenses...")
	violations, err := checker.CheckLicenses()
	if err != nil {
		fmt.Fprintf(os.Stderr, "license check error: %v\n", err)
	} else if len(violations) > 0 {
		fmt.Printf("⚠️  Found %d license violations:\n", len(violations))
		for _, v := range violations {
			fmt.Printf("  %s (%s): %s\n", v.Package, v.License, v.Reason)
		}
		os.Exit(1)
	} else {
		fmt.Println("✓ All licenses approved")
	}
}
```

### Junior → FAANG: Why Dependency Governance Is Not Optional

A monorepo that grows without dependency governance will eventually have a GPL-licensed transitive dependency in a proprietary codebase, or a known CVE in a package that was added two years ago and never updated. Both are discovered at the worst possible time: during a customer security audit or an acquisition due diligence process.

The habit to build early: every time you add a new `require` line to a `go.mod`, run `go-licenses check ./...` and `govulncheck ./...` locally before committing. This takes 30 seconds and prevents the category of "we need to emergency-remove this dependency because of a license issue" that is disproportionately painful in large codebases.

For interviews: if asked about dependency management, mention the difference between direct and transitive dependencies. You control your direct dependencies. Your transitive dependencies are controlled by your direct dependencies' maintainers. A vulnerability scanner that only checks direct dependencies misses the majority of actual exposure.

### Senior @ FAANG: Dependency Governance as an SLO

At FAANG scale, dependency governance is a measurable operational concern, not a one-time audit. The metrics that matter: mean time to patch a known CVE (from publication to merged fix), percentage of dependencies with approved licenses, number of unapproved dependencies blocked by CI versus approved via exception, and number of dependencies past their end-of-life date.

Setting SLOs for these metrics is a staff-level responsibility. A common target: critical CVEs patched within 3 business days, high CVEs within 14 days, moderate CVEs within 90 days. These numbers must be negotiated with the security team and documented as an internal policy. Without documented SLOs, individual teams will prioritize feature work over dependency updates indefinitely.

The exception management process is equally important. Not every unapproved license can be swapped out immediately. The governance system needs a structured exception workflow: a time-bounded approval, a documented justification, a named engineer who accepts responsibility, and an automated reminder when the exception expires. An exception file checked into the repo (read by the license checker to skip specific packages) makes the full set of exceptions auditable in git history. This is the difference between governance that scales and governance that becomes a bottleneck because every exception requires a platform team member to manually update a configuration file.

### Junior → FAANG: Treating Dependencies as a Security Surface

Every dependency you add to a Go monorepo is code that you are trusting to execute in your production environment. Junior engineers often add dependencies casually, checking whether a package does what they need but not thinking about its transitive closure or its vulnerability history. The first habit to build: before adding any dependency, run `govulncheck ./...` after adding it and check the license with `go-licenses csv ./...`. Both commands take under a minute and surface problems before they reach CI.

A second habit: read the `go.sum` diff in every PR that adds a new dependency. The sum file contains checksums for every module version, including transitive dependencies. An unexpected transitive dependency (a library pulling in a large framework you did not intend to include) shows up as a large `go.sum` diff. If the diff is bigger than expected, investigate why.

Interview entry point: explain dependency governance as a two-dimensional problem. Security: ensuring no known CVE is present in the dependency tree, with a defined SLO for patching time. Legal: ensuring license compatibility with the distribution model, with a structured exception process for edge cases.

### Senior @ FAANG: Dependency Governance as an Engineering-Wide SLO

At FAANG scale, dependency security is not a developer responsibility, it is a platform responsibility enforced through policy. The platform team owns the scanning infrastructure, defines the patch SLOs (critical CVE patched within 3 business days, high within 14 days), and provides automated update PRs via Renovate or Dependabot. Individual teams are responsible for reviewing and merging update PRs within the SLO window, and compliance is tracked as a metric reported to engineering leadership.

The license governance system has an additional dimension at companies that ship both open-source and proprietary products: the same dependency may be acceptable for an open-source tool (where GPL code is permissible) and unacceptable for a commercial product (where GPL copyleft obligations create business risk). The allowlist must be per-product, not per-repo. This requires the license checker to know which products each package is compiled into, which is information the build graph has but a simple `go-licenses` scan does not.

The SBOM (Software Bill of Materials) requirement adds a third dimension. SBOM generation in SPDX or CycloneDX format is increasingly a contractual or regulatory requirement for software sold to US federal agencies (following the May 2021 executive order) and for software subject to EU CRA (Cyber Resilience Act). The SBOM must be generated per release artifact, not per repository, because a single repository may produce dozens of artifacts with different dependency subsets. Wiring SBOM generation into the release pipeline and attaching the SBOM to each release artifact is a staff-level infrastructure project that must be planned well ahead of any compliance deadline.

---
