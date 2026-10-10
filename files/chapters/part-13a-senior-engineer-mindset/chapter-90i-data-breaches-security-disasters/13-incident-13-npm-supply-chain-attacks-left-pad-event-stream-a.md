## 90I.13 npm Supply Chain Attacks - left-pad, event-stream, and colors.js

### The Attack Timeline

The npm ecosystem has suffered three landmark supply chain attacks that collectively demonstrate every dimension
of open-source dependency risk: removal, hijacking, and sabotage.

**left-pad (March 2016): The Deletion That Broke the Internet**

On March 22, 2016, developer Azer Koçulu unpublished all 273 of his npm packages, including `left-pad` - an
11-line package that padded strings with spaces. The package had over 2.5 million downloads per month and was
a transitive dependency of thousands of projects including Babel, React, and Node.js itself. When `left-pad`
disappeared from npm, build systems worldwide broke simultaneously. CI/CD pipelines failed, deployments stalled,
and developers scrambled to understand why their projects suddenly could not install dependencies.

npm's response was unprecedented: they "un-unpublished" the package - the first time npm had ever restored a
package against the author's wishes. This incident led to npm implementing a policy that packages with more
than a threshold of dependents cannot be unpublished.

**event-stream (November 2018): The Social Engineering Takeover**

The `event-stream` package was a popular Node.js streaming library maintained by Dominic Tarr. In September 2018,
a new contributor named "right9ctrl" offered to take over maintenance. Tarr, who had moved on from the project,
transferred ownership. Right9ctrl then added a dependency on a new package called `flatmap-stream`, which
contained obfuscated malicious code targeting the Copay Bitcoin wallet. The malicious code:

1. Detected if it was running inside the Copay wallet application
2. Stole Bitcoin wallet private keys
3. Sent the keys to a remote server

The attack was discovered by a community member who noticed the suspicious `flatmap-stream` dependency and
deobfuscated its code. The attack had been live for approximately two months before detection.

**colors.js (January 2022): The Maintainer's Protest**

On January 8, 2022, Marak Squires - the maintainer of `colors.js` (20 million weekly downloads) and `faker.js`
(2.8 million weekly downloads) - deliberately sabotaged his own packages. He published new versions containing
infinite loops that printed the American flag and garbage text, breaking thousands of applications. Squires had
previously expressed frustration that large corporations were using his open-source work without compensation.

### Technical Root Cause Analysis

These three incidents represent three distinct failure modes:
1. **left-pad**: Dependency on trivial packages creates fragility. A single author's action can break the ecosystem.
2. **event-stream**: Maintainer succession without verification enables social engineering takeover.
3. **colors.js**: A single disgruntled maintainer can weaponize widely-used packages.

Common to all three: the npm ecosystem lacks cryptographic integrity verification of the kind Go provides.

### Go Code: go.sum Verification and Dependency Hygiene

Go's module system was designed with explicit awareness of these npm-style attacks. The `go.sum` file provides
cryptographic verification that dependency contents have not changed, and the Go module proxy/checksum database
provides a transparency log:

```go
package dephygiene

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
    "sort"
	"strings"
)

// DependencyReport contains the analysis of a Go module's dependencies.
type DependencyReport struct {
	DirectDeps     int                 `json:"directDeps"`
	TransitiveDeps int                 `json:"transitiveDeps"`
	TotalDeps      int                 `json:"totalDeps"`
	Vulnerabilities int                `json:"vulnerabilities"`
	Modules        []ModuleInfo        `json:"modules"`
	Risks          []DependencyRisk    `json:"risks"`
}

// ModuleInfo describes a single dependency module.
type ModuleInfo struct {
	Path     string `json:"path"`
	Version  string `json:"version"`
	Indirect bool   `json:"indirect"`
	HasSum   bool   `json:"hasSum"`
}

// DependencyRisk describes a potential risk in the dependency tree.
type DependencyRisk struct {
	Severity    string `json:"severity"`
	Module      string `json:"module"`
	Description string `json:"description"`
}

// AnalyzeDependencies performs a comprehensive analysis of a Go module's
// dependency health, checking for common supply chain risk indicators.
func AnalyzeDependencies(moduleDir string) (*DependencyReport, error) {
	report := &DependencyReport{}

	// Step 1: Parse go.mod for direct dependencies.
	modules, err := parseGoMod(moduleDir)
	if err != nil {
		return nil, fmt.Errorf("parsing go.mod: %w", err)
	}

	// Step 2: Parse go.sum for integrity hashes.
	sums, err := parseGoSum(moduleDir)
	if err != nil {
		return nil, fmt.Errorf("parsing go.sum: %w", err)
	}

	for i := range modules {
		key := modules[i].Path + " " + modules[i].Version
		modules[i].HasSum = sums[key]
		if modules[i].Indirect {
			report.TransitiveDeps++
		} else {
			report.DirectDeps++
		}
	}
	report.TotalDeps = len(modules)
	report.Modules = modules

	// Step 3: Check for risk indicators.
	report.Risks = assessRisks(modules, sums)

	// Step 4: Run go mod verify to check local cache integrity.
	if err := runGoModVerify(moduleDir); err != nil {
		report.Risks = append(report.Risks, DependencyRisk{
			Severity:    "CRITICAL",
			Module:      "*",
			Description: fmt.Sprintf("go mod verify failed: %v", err),
		})
	}

	return report, nil
}

func parseGoMod(moduleDir string) ([]ModuleInfo, error) {
	cmd := exec.Command("go", "list", "-m", "-json", "all")
	cmd.Dir = moduleDir
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var modules []ModuleInfo
	decoder := json.NewDecoder(strings.NewReader(string(output)))
	for decoder.More() {
		var m struct {
			Path     string `json:"Path"`
			Version  string `json:"Version"`
			Indirect bool   `json:"Indirect"`
			Main     bool   `json:"Main"`
		}
		if err := decoder.Decode(&m); err != nil {
			continue
		}
		if m.Main {
			continue
		}
		modules = append(modules, ModuleInfo{
			Path:     m.Path,
			Version:  m.Version,
			Indirect: m.Indirect,
		})
	}
	return modules, nil
}

func parseGoSum(moduleDir string) (map[string]bool, error) {
	goSumPath := moduleDir + "/go.sum"
	file, err := os.Open(goSumPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	sums := make(map[string]bool)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) >= 2 {
			// Strip /go.mod suffix from version if present.
			version := strings.TrimSuffix(parts[1], "/go.mod")
			sums[parts[0]+" "+version] = true
		}
	}
	return sums, scanner.Err()
}

func assessRisks(modules []ModuleInfo, sums map[string]bool) []DependencyRisk {
	var risks []DependencyRisk

	// Risk: modules without go.sum entries.
	for _, m := range modules {
		if !m.HasSum {
			risks = append(risks, DependencyRisk{
				Severity:    "HIGH",
				Module:      m.Path,
				Description: "Module has no go.sum entry - integrity not verified",
			})
		}
	}

	// Risk: high dependency count increases attack surface.
	if len(modules) > 100 {
		risks = append(risks, DependencyRisk{
			Severity: "MEDIUM",
			Module:   "*",
			Description: fmt.Sprintf(
				"High dependency count (%d modules). Each dependency is a potential attack vector",
				len(modules),
			),
		})
	}

	// Risk: dependencies from personal/non-organizational repositories.
	for _, m := range modules {
		parts := strings.Split(m.Path, "/")
		if len(parts) >= 3 && parts[0] == "github.com" {
			// Check if it looks like a personal repo (heuristic).
			org := parts[1]
			if len(org) < 4 && !m.Indirect {
				risks = append(risks, DependencyRisk{
					Severity: "LOW",
					Module:   m.Path,
					Description: fmt.Sprintf(
						"Direct dependency on potentially personal repository (org: %s)",
						org,
					),
				})
			}
		}
	}

	return risks
}

func runGoModVerify(moduleDir string) error {
	cmd := exec.Command("go", "mod", "verify")
	cmd.Dir = moduleDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", output)
	}
	return nil
}

// GenerateSBOM creates a Software Bill of Materials for the current module,
// listing all dependencies with their versions and hashes.
func GenerateSBOM(moduleDir string) (string, error) {
	report, err := AnalyzeDependencies(moduleDir)
	if err != nil {
		return "", err
	}

	var sb strings.Builder
	sb.WriteString("# Software Bill of Materials (SBOM)\n\n")
	sb.WriteString(fmt.Sprintf("Total dependencies: %d (direct: %d, transitive: %d)\n\n",
		report.TotalDeps, report.DirectDeps, report.TransitiveDeps))

	// Sort by path for deterministic output.
	sort.Slice(report.Modules, func(i, j int) bool {
		return report.Modules[i].Path < report.Modules[j].Path
	})

	sb.WriteString("## Direct Dependencies\n\n")
	for _, m := range report.Modules {
		if !m.Indirect {
			verified := "VERIFIED"
			if !m.HasSum {
				verified = "UNVERIFIED"
			}
			sb.WriteString(fmt.Sprintf("- %s@%s [%s]\n", m.Path, m.Version, verified))
		}
	}

	sb.WriteString("\n## Transitive Dependencies\n\n")
	for _, m := range report.Modules {
		if m.Indirect {
			verified := "VERIFIED"
			if !m.HasSum {
				verified = "UNVERIFIED"
			}
			sb.WriteString(fmt.Sprintf("- %s@%s [%s]\n", m.Path, m.Version, verified))
		}
	}

	if len(report.Risks) > 0 {
		sb.WriteString("\n## Risk Assessment\n\n")
		for _, r := range report.Risks {
			sb.WriteString(fmt.Sprintf("- [%s] %s: %s\n", r.Severity, r.Module, r.Description))
		}
	}

	return sb.String(), nil
}

// PolicyCheck verifies that all dependencies comply with organizational
// security policies. Returns violations found.
func PolicyCheck(moduleDir string, allowedPrefixes []string, maxDeps int) ([]string, error) {
	report, err := AnalyzeDependencies(moduleDir)
	if err != nil {
		return nil, err
	}

	var violations []string

	// Check maximum dependency count.
	if maxDeps > 0 && report.TotalDeps > maxDeps {
		violations = append(violations, fmt.Sprintf(
			"dependency count %d exceeds maximum %d", report.TotalDeps, maxDeps,
		))
	}

	// Check allowed prefixes (organizational dependency policy).
	if len(allowedPrefixes) > 0 {
		for _, m := range report.Modules {
			allowed := false
			for _, prefix := range allowedPrefixes {
				if strings.HasPrefix(m.Path, prefix) {
					allowed = true
					break
				}
			}
			if !allowed && !m.Indirect {
				violations = append(violations, fmt.Sprintf(
					"direct dependency %s not in allowed list", m.Path,
				))
			}
		}
	}

	return violations, nil
}
```

### Engineering Lessons

1. **Go's module system provides cryptographic supply chain integrity.** The `go.sum` file contains SHA-256
   hashes of every dependency, verified against the Go checksum database (`sum.golang.org`). If a package's
   contents change for a given version, the build fails. This prevents the event-stream style attack where
   malicious code is injected into an existing version.

2. **The Go module proxy prevents the left-pad problem.** The Go module proxy (`proxy.golang.org`) caches
   module versions permanently. Even if an author deletes their repository, the cached version remains
   available. This is architecturally immune to the left-pad deletion attack.

3. **Minimize dependencies.** Go's standard library is broad enough that many applications need very
   few external dependencies. Each dependency you add is a trust relationship you must maintain. The Go
   community's preference for "a little copying is better than a little dependency" directly reduces supply
   chain risk.

4. **Vendoring provides defense in depth.** `go mod vendor` copies all dependencies into your repository,
   creating a complete, verifiable snapshot that does not depend on external registries at build time.

---

### Junior → FAANG: Go Module Security vs npm Supply Chain Risks

The npm supply chain attacks answer "how does Go's module system defend against supply chain attacks better than npm?" Three Go mechanisms are directly relevant. First, `go.sum` cryptographically locks every dependency version: if a maintainer replaces a version with malicious code, `go mod verify` detects the hash mismatch. npm had no equivalent until lockfiles were added, and even then they were often not checked into version control. Second, the Go module proxy caches versions permanently, preventing the left-pad deletion attack. Third, Go's standard library is broad enough to replace most small utility packages, reducing the number of external dependencies that represent supply chain attack surface. For FAANG interviews, the principle is: minimize dependencies, lock all dependency hashes cryptographically, and use vendoring for production builds to create an immutable build-time snapshot.

### Senior @ FAANG: Dependency Minimization as a Security Policy and Allowlist-Based Dependency Governance

At L6, the npm supply chain incidents are an argument for dependency minimization as an explicit security policy. Every external dependency added to your codebase is a trust relationship: you are trusting the maintainer not to inject malicious code, the registry not to allow a malicious replacement, and the build system to verify the hash before using the package. Most organizations have no process for governing these trust relationships. At staff level, you establish an allowlist-based dependency policy: a curated list of approved external packages that have been reviewed for maintainer trust, activity level, and security posture. Adding a new package outside the allowlist requires an exception request with security review. Packages on the allowlist are monitored for new releases and checked against the Go vulnerability database automatically. The allowlist is maintained by the platform security team and updated quarterly. This converts dependency governance from a reactive practice (respond to CVEs after they are published) to a proactive one (prevent vulnerable or malicious packages from entering the codebase in the first place).

