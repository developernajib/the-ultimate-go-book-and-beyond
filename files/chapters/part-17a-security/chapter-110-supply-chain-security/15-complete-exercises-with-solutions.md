## 110.14 Complete Exercises with Solutions

### Exercise 1: Dependency Vulnerability Scanner

**Problem**: Build a full dependency vulnerability scanner that integrates with CI/CD and provides actionable reports.

**Solution**:

```go
// cmd/vulnscan/main.go
package main

import (
    "bufio"
    "cmp"
    "encoding/json"
    "flag"
    "fmt"
    "os"
    "os/exec"
    "slices"
    "strings"
    "time"
)

type Vulnerability struct {
    ID          string   `json:"id"`
    Aliases     []string `json:"aliases,omitempty"`
    Summary     string   `json:"summary"`
    Details     string   `json:"details"`
    Affected    []string `json:"affected"`
    Fixed       string   `json:"fixed"`
    Severity    string   `json:"severity"`
    CVSS        float64  `json:"cvss,omitempty"`
    References  []string `json:"references,omitempty"`
    CallStacks  []string `json:"call_stacks,omitempty"`
}

type ScanResult struct {
    Timestamp       time.Time       `json:"timestamp"`
    Repository      string          `json:"repository"`
    Commit          string          `json:"commit"`
    Branch          string          `json:"branch"`
    TotalDeps       int             `json:"total_deps"`
    Vulnerabilities []Vulnerability `json:"vulnerabilities"`
    Summary         ScanSummary     `json:"summary"`
}

type ScanSummary struct {
    Total     int `json:"total"`
    Critical  int `json:"critical"`
    High      int `json:"high"`
    Medium    int `json:"medium"`
    Low       int `json:"low"`
    Unfixed   int `json:"unfixed"`
    HasFix    int `json:"has_fix"`
}

func main() {
    outputFormat := flag.String("format", "text", "Output format: text, json, sarif")
    failOn := flag.String("fail-on", "high", "Fail on severity: critical, high, medium, low")
    ignoreFile := flag.String("ignore", "", "File containing vulnerabilities to ignore")
    flag.Parse()

    scanner := &VulnScanner{
        FailOnSeverity: *failOn,
        IgnoreFile:     *ignoreFile,
    }

    result, err := scanner.Scan()
    if err != nil {
        fmt.Fprintf(os.Stderr, "Scan failed: %v\n", err)
        os.Exit(1)
    }

    switch *outputFormat {
    case "json":
        outputJSON(result)
    case "sarif":
        outputSARIF(result)
    default:
        outputText(result)
    }

    if scanner.ShouldFail(result) {
        os.Exit(1)
    }
}

type VulnScanner struct {
    FailOnSeverity string
    IgnoreFile     string
    ignoredVulns   map[string]bool
}

func (s *VulnScanner) Scan() (*ScanResult, error) {
    // Load ignored vulnerabilities
    if s.IgnoreFile != "" {
        s.loadIgnoreList()
    }

    // Run govulncheck
    cmd := exec.Command("govulncheck", "-json", "./...")
    output, _ := cmd.CombinedOutput()

    // Parse results
    vulns, err := s.parseGovulncheckOutput(output)
    if err != nil {
        return nil, err
    }

    // Filter ignored
    vulns = s.filterIgnored(vulns)

    // Get metadata
    result := &ScanResult{
        Timestamp:       time.Now(),
        Repository:      getGitRemote(),
        Commit:          getGitCommit(),
        Branch:          getGitBranch(),
        TotalDeps:       countDependencies(),
        Vulnerabilities: vulns,
    }

    // Calculate summary
    result.Summary = calculateSummary(vulns)

    return result, nil
}

func (s *VulnScanner) parseGovulncheckOutput(data []byte) ([]Vulnerability, error) {
    var vulns []Vulnerability
    vulnMap := make(map[string]*Vulnerability)

    lines := strings.Split(string(data), "\n")
    for _, line := range lines {
        if line == "" {
            continue
        }

        var entry map[string]any
        if err := json.Unmarshal([]byte(line), &entry); err != nil {
            continue
        }

        // Process OSV entries
        if osv, ok := entry["osv"].(map[string]any); ok {
            id := osv["id"].(string)
            if vulnMap[id] == nil {
                vuln := &Vulnerability{
                    ID:      id,
                    Summary: getString(osv, "summary"),
                    Details: getString(osv, "details"),
                }

                // Extract severity from database_specific
                if dbSpec, ok := osv["database_specific"].(map[string]any); ok {
                    vuln.Severity = getString(dbSpec, "severity")
                }

                // Extract aliases (CVE IDs)
                if aliases, ok := osv["aliases"].([]any); ok {
                    for _, a := range aliases {
                        vuln.Aliases = append(vuln.Aliases, a.(string))
                    }
                }

                vulnMap[id] = vuln
            }
        }

        // Process findings (call stacks)
        if finding, ok := entry["finding"].(map[string]any); ok {
            if osv := getString(finding, "osv"); osv != "" {
                if vuln := vulnMap[osv]; vuln != nil {
                    // Extract call stack info
                    if trace, ok := finding["trace"].([]any); ok && len(trace) > 0 {
                        callStack := extractCallStack(trace)
                        vuln.CallStacks = append(vuln.CallStacks, callStack)
                    }
                }
            }
        }
    }

    for _, v := range vulnMap {
        vulns = append(vulns, *v)
    }

    // Sort by severity
    slices.SortFunc(vulns, func(a, b Vulnerability) int {
        return cmp.Compare(severityOrder(a.Severity), severityOrder(b.Severity))
    })

    return vulns, nil
}

func extractCallStack(trace []any) string {
    var parts []string
    for _, t := range trace {
        if tm, ok := t.(map[string]any); ok {
            if fn := getString(tm, "function"); fn != "" {
                parts = append(parts, fn)
            }
        }
    }
    return strings.Join(parts, " -> ")
}

func (s *VulnScanner) loadIgnoreList() {
    s.ignoredVulns = make(map[string]bool)
    f, err := os.Open(s.IgnoreFile)
    if err != nil {
        return
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line != "" && !strings.HasPrefix(line, "#") {
            s.ignoredVulns[line] = true
        }
    }
}

func (s *VulnScanner) filterIgnored(vulns []Vulnerability) []Vulnerability {
    if len(s.ignoredVulns) == 0 {
        return vulns
    }

    var filtered []Vulnerability
    for _, v := range vulns {
        if !s.ignoredVulns[v.ID] {
            filtered = append(filtered, v)
        }
    }
    return filtered
}

func (s *VulnScanner) ShouldFail(result *ScanResult) bool {
    threshold := severityOrder(s.FailOnSeverity)
    for _, v := range result.Vulnerabilities {
        if severityOrder(v.Severity) <= threshold {
            return true
        }
    }
    return false
}

func calculateSummary(vulns []Vulnerability) ScanSummary {
    summary := ScanSummary{Total: len(vulns)}
    for _, v := range vulns {
        switch strings.ToUpper(v.Severity) {
        case "CRITICAL":
            summary.Critical++
        case "HIGH":
            summary.High++
        case "MEDIUM":
            summary.Medium++
        case "LOW":
            summary.Low++
        }
        if v.Fixed != "" {
            summary.HasFix++
        } else {
            summary.Unfixed++
        }
    }
    return summary
}

func severityOrder(s string) int {
    switch strings.ToUpper(s) {
    case "CRITICAL":
        return 0
    case "HIGH":
        return 1
    case "MEDIUM":
        return 2
    case "LOW":
        return 3
    default:
        return 4
    }
}

func outputText(result *ScanResult) {
    fmt.Printf("\n╔══════════════════════════════════════════════════════════════╗\n")
    fmt.Printf("║            VULNERABILITY SCAN REPORT                          ║\n")
    fmt.Printf("╚══════════════════════════════════════════════════════════════╝\n\n")

    fmt.Printf("Repository: %s\n", result.Repository)
    fmt.Printf("Commit:     %s\n", result.Commit)
    fmt.Printf("Branch:     %s\n", result.Branch)
    fmt.Printf("Timestamp:  %s\n", result.Timestamp.Format(time.RFC3339))
    fmt.Printf("Dependencies Scanned: %d\n\n", result.TotalDeps)

    fmt.Printf("SUMMARY:\n")
    fmt.Printf("  Total:    %d vulnerabilities\n", result.Summary.Total)
    fmt.Printf("  Critical: %d\n", result.Summary.Critical)
    fmt.Printf("  High:     %d\n", result.Summary.High)
    fmt.Printf("  Medium:   %d\n", result.Summary.Medium)
    fmt.Printf("  Low:      %d\n", result.Summary.Low)
    fmt.Printf("  Fixable:  %d\n\n", result.Summary.HasFix)

    if len(result.Vulnerabilities) > 0 {
        fmt.Printf("VULNERABILITIES:\n")
        fmt.Printf("────────────────────────────────────────────────────────────────\n")
        for i, v := range result.Vulnerabilities {
            icon := severityIcon(v.Severity)
            fmt.Printf("\n%d. %s [%s] %s\n", i+1, icon, v.Severity, v.ID)
            if len(v.Aliases) > 0 {
                fmt.Printf("   CVE: %s\n", strings.Join(v.Aliases, ", "))
            }
            fmt.Printf("   Summary: %s\n", v.Summary)
            if v.Fixed != "" {
                fmt.Printf("   Fixed in: %s\n", v.Fixed)
            }
            if len(v.CallStacks) > 0 {
                fmt.Printf("   Call path: %s\n", v.CallStacks[0])
            }
        }
    } else {
        fmt.Printf("✅ No vulnerabilities found!\n")
    }
}

func outputJSON(result *ScanResult) {
    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(result)
}

func outputSARIF(result *ScanResult) {
    sarif := map[string]any{
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": []map[string]any{
            {
                "tool": map[string]any{
                    "driver": map[string]any{
                        "name":    "vulnscan",
                        "version": "1.0.0",
                    },
                },
                "results": convertToSARIFResults(result.Vulnerabilities),
            },
        },
    }

    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(sarif)
}

func convertToSARIFResults(vulns []Vulnerability) []map[string]any {
    var results []map[string]any
    for _, v := range vulns {
        results = append(results, map[string]any{
            "ruleId":  v.ID,
            "level":   sarifLevel(v.Severity),
            "message": map[string]string{"text": v.Summary},
        })
    }
    return results
}

func sarifLevel(severity string) string {
    switch strings.ToUpper(severity) {
    case "CRITICAL", "HIGH":
        return "error"
    case "MEDIUM":
        return "warning"
    default:
        return "note"
    }
}

func severityIcon(s string) string {
    switch strings.ToUpper(s) {
    case "CRITICAL":
        return "🔴"
    case "HIGH":
        return "🟠"
    case "MEDIUM":
        return "🟡"
    default:
        return "🔵"
    }
}

func getString(m map[string]any, key string) string {
    if v, ok := m[key].(string); ok {
        return v
    }
    return ""
}

func getGitRemote() string {
    out, _ := exec.Command("git", "remote", "get-url", "origin").Output()
    return strings.TrimSpace(string(out))
}

func getGitCommit() string {
    out, _ := exec.Command("git", "rev-parse", "HEAD").Output()
    return strings.TrimSpace(string(out))
}

func getGitBranch() string {
    out, _ := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD").Output()
    return strings.TrimSpace(string(out))
}

func countDependencies() int {
    out, _ := exec.Command("go", "list", "-m", "all").Output()
    return len(strings.Split(strings.TrimSpace(string(out)), "\n")) - 1
}
```

**Key Implementation Points**:
- Parses govulncheck JSON output for detailed info
- Supports ignore list for known/accepted vulnerabilities
- Multiple output formats (text, JSON, SARIF)
- Configurable failure threshold
- Call stack extraction to show vulnerable code paths

---

### Exercise 2: SBOM Generator and Analyzer

**Problem**: Build an SBOM generator that creates both SPDX and CycloneDX formats, with vulnerability analysis capabilities.

**Solution**:

```go
// cmd/sbom/main.go
package main

import (
    "encoding/json"
    "flag"
    "fmt"
    "io"
    "os"
    "os/exec"
    "strings"
    "time"

    "github.com/google/uuid"
)

// SPDX format
type SPDXDocument struct {
    SPDXVersion       string        `json:"spdxVersion"`
    DataLicense       string        `json:"dataLicense"`
    SPDXID            string        `json:"SPDXID"`
    Name              string        `json:"name"`
    DocumentNamespace string        `json:"documentNamespace"`
    CreationInfo      CreationInfo  `json:"creationInfo"`
    Packages          []SPDXPackage `json:"packages"`
    Relationships     []Relationship `json:"relationships"`
}

type CreationInfo struct {
    Created  string   `json:"created"`
    Creators []string `json:"creators"`
}

type SPDXPackage struct {
    SPDXID           string            `json:"SPDXID"`
    Name             string            `json:"name"`
    VersionInfo      string            `json:"versionInfo"`
    PackageFileName  string            `json:"packageFileName,omitempty"`
    DownloadLocation string            `json:"downloadLocation"`
    FilesAnalyzed    bool              `json:"filesAnalyzed"`
    Checksums        []PackageChecksum `json:"checksums,omitempty"`
    ExternalRefs     []ExternalRef     `json:"externalRefs,omitempty"`
}

type PackageChecksum struct {
    Algorithm string `json:"algorithm"`
    Value     string `json:"checksumValue"`
}

type ExternalRef struct {
    Category string `json:"referenceCategory"`
    Type     string `json:"referenceType"`
    Locator  string `json:"referenceLocator"`
}

type Relationship struct {
    Element string `json:"spdxElementId"`
    Related string `json:"relatedSpdxElement"`
    Type    string `json:"relationshipType"`
}

// CycloneDX format
type CycloneDXBOM struct {
    BOMFormat    string          `json:"bomFormat"`
    SpecVersion  string          `json:"specVersion"`
    SerialNumber string          `json:"serialNumber"`
    Version      int             `json:"version"`
    Metadata     CDXMetadata     `json:"metadata"`
    Components   []CDXComponent  `json:"components"`
    Dependencies []CDXDependency `json:"dependencies,omitempty"`
}

type CDXMetadata struct {
    Timestamp string       `json:"timestamp"`
    Tools     []CDXTool    `json:"tools"`
    Component *CDXComponent `json:"component,omitempty"`
}

type CDXTool struct {
    Vendor  string `json:"vendor"`
    Name    string `json:"name"`
    Version string `json:"version"`
}

type CDXComponent struct {
    Type       string   `json:"type"`
    BOMRef     string   `json:"bom-ref"`
    Name       string   `json:"name"`
    Version    string   `json:"version"`
    PURL       string   `json:"purl,omitempty"`
    Hashes     []CDXHash `json:"hashes,omitempty"`
}

type CDXHash struct {
    Algorithm string `json:"alg"`
    Content   string `json:"content"`
}

type CDXDependency struct {
    Ref       string   `json:"ref"`
    DependsOn []string `json:"dependsOn,omitempty"`
}

func main() {
    format := flag.String("format", "spdx", "Output format: spdx, cyclonedx")
    output := flag.String("output", "", "Output file (default: stdout)")
    analyze := flag.Bool("analyze", false, "Run vulnerability analysis on SBOM")
    flag.Parse()

    generator := &SBOMGenerator{}

    var sbom any
    var err error

    switch *format {
    case "cyclonedx":
        sbom, err = generator.GenerateCycloneDX()
    default:
        sbom, err = generator.GenerateSPDX()
    }

    if err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }

    // Output
    var out io.Writer = os.Stdout
    if *output != "" {
        f, err := os.Create(*output)
        if err != nil {
            fmt.Fprintf(os.Stderr, "Error creating output file: %v\n", err)
            os.Exit(1)
        }
        defer f.Close()
        out = f
    }

    enc := json.NewEncoder(out)
    enc.SetIndent("", "  ")
    if err := enc.Encode(sbom); err != nil {
        fmt.Fprintf(os.Stderr, "Error encoding: %v\n", err)
        os.Exit(1)
    }

    if *analyze && *output != "" {
        analyzeVulnerabilities(*output)
    }
}

type SBOMGenerator struct{}

type GoModule struct {
    Path     string `json:"Path"`
    Version  string `json:"Version"`
    Main     bool   `json:"Main"`
    Indirect bool   `json:"Indirect"`
    Dir      string `json:"Dir"`
    Sum      string `json:"Sum"`
}

func (g *SBOMGenerator) getModules() ([]GoModule, error) {
    cmd := exec.Command("go", "list", "-m", "-json", "all")
    output, err := cmd.Output()
    if err != nil {
        return nil, err
    }

    var modules []GoModule
    decoder := json.NewDecoder(strings.NewReader(string(output)))
    for decoder.More() {
        var mod GoModule
        if err := decoder.Decode(&mod); err != nil {
            return nil, err
        }
        modules = append(modules, mod)
    }

    return modules, nil
}

func (g *SBOMGenerator) GenerateSPDX() (*SPDXDocument, error) {
    modules, err := g.getModules()
    if err != nil {
        return nil, err
    }

    var mainMod GoModule
    for _, m := range modules {
        if m.Main {
            mainMod = m
            break
        }
    }

    doc := &SPDXDocument{
        SPDXVersion: "SPDX-2.3",
        DataLicense: "CC0-1.0",
        SPDXID:      "SPDXRef-DOCUMENT",
        Name:        mainMod.Path,
        DocumentNamespace: fmt.Sprintf("https://spdx.org/spdxdocs/%s-%s-%s",
            sanitizeID(mainMod.Path), mainMod.Version, uuid.New().String()),
        CreationInfo: CreationInfo{
            Created:  time.Now().UTC().Format(time.RFC3339),
            Creators: []string{"Tool: go-sbom-generator-1.0.0"},
        },
    }

    // Add main package
    mainPkg := SPDXPackage{
        SPDXID:           "SPDXRef-Package-" + sanitizeID(mainMod.Path),
        Name:             mainMod.Path,
        VersionInfo:      mainMod.Version,
        DownloadLocation: "NOASSERTION",
        FilesAnalyzed:    false,
        ExternalRefs: []ExternalRef{
            {
                Category: "PACKAGE-MANAGER",
                Type:     "purl",
                Locator:  fmt.Sprintf("pkg:golang/%s@%s", mainMod.Path, mainMod.Version),
            },
        },
    }
    doc.Packages = append(doc.Packages, mainPkg)

    // Add dependencies
    for _, mod := range modules {
        if mod.Main {
            continue
        }

        pkg := SPDXPackage{
            SPDXID:           "SPDXRef-Package-" + sanitizeID(mod.Path),
            Name:             mod.Path,
            VersionInfo:      mod.Version,
            DownloadLocation: fmt.Sprintf("https://proxy.golang.org/%s/@v/%s.zip",
                mod.Path, mod.Version),
            FilesAnalyzed: false,
            ExternalRefs: []ExternalRef{
                {
                    Category: "PACKAGE-MANAGER",
                    Type:     "purl",
                    Locator:  fmt.Sprintf("pkg:golang/%s@%s", mod.Path, mod.Version),
                },
            },
        }

        // Record Go's module hash if available. Note: the h1: value is
        // Go's base64 dirhash, not the module zip's raw SHA-256 hex digest.
        if mod.Sum != "" {
            pkg.Checksums = append(pkg.Checksums, PackageChecksum{
                Algorithm: "SHA256",
                Value:     strings.TrimPrefix(mod.Sum, "h1:"),
            })
        }

        doc.Packages = append(doc.Packages, pkg)

        // Add relationship
        relType := "DEPENDS_ON"
        if mod.Indirect {
            relType = "HAS_PREREQUISITE"
        }
        doc.Relationships = append(doc.Relationships, Relationship{
            Element: "SPDXRef-Package-" + sanitizeID(mainMod.Path),
            Related: "SPDXRef-Package-" + sanitizeID(mod.Path),
            Type:    relType,
        })
    }

    return doc, nil
}

func (g *SBOMGenerator) GenerateCycloneDX() (*CycloneDXBOM, error) {
    modules, err := g.getModules()
    if err != nil {
        return nil, err
    }

    var mainMod GoModule
    for _, m := range modules {
        if m.Main {
            mainMod = m
            break
        }
    }

    bom := &CycloneDXBOM{
        BOMFormat:    "CycloneDX",
        SpecVersion:  "1.5",
        SerialNumber: "urn:uuid:" + uuid.New().String(),
        Version:      1,
        Metadata: CDXMetadata{
            Timestamp: time.Now().UTC().Format(time.RFC3339),
            Tools: []CDXTool{
                {
                    Vendor:  "custom",
                    Name:    "go-sbom-generator",
                    Version: "1.0.0",
                },
            },
            Component: &CDXComponent{
                Type:    "application",
                BOMRef:  mainMod.Path,
                Name:    mainMod.Path,
                Version: mainMod.Version,
                PURL:    fmt.Sprintf("pkg:golang/%s@%s", mainMod.Path, mainMod.Version),
            },
        },
    }

    // Add dependencies
    var mainDeps []string
    for _, mod := range modules {
        if mod.Main {
            continue
        }

        component := CDXComponent{
            Type:    "library",
            BOMRef:  mod.Path + "@" + mod.Version,
            Name:    mod.Path,
            Version: mod.Version,
            PURL:    fmt.Sprintf("pkg:golang/%s@%s", mod.Path, mod.Version),
        }

        if mod.Sum != "" {
            component.Hashes = append(component.Hashes, CDXHash{
                Algorithm: "SHA-256",
                Content:   strings.TrimPrefix(mod.Sum, "h1:"),
            })
        }

        bom.Components = append(bom.Components, component)

        if !mod.Indirect {
            mainDeps = append(mainDeps, mod.Path+"@"+mod.Version)
        }
    }

    // Add dependency graph
    bom.Dependencies = append(bom.Dependencies, CDXDependency{
        Ref:       mainMod.Path,
        DependsOn: mainDeps,
    })

    return bom, nil
}

func analyzeVulnerabilities(sbomFile string) {
    fmt.Printf("\n🔍 Analyzing SBOM for vulnerabilities...\n")

    // Use grype to scan SBOM
    cmd := exec.Command("grype", "sbom:"+sbomFile)
    output, _ := cmd.CombinedOutput()
    fmt.Println(string(output))
}

func sanitizeID(s string) string {
    s = strings.ReplaceAll(s, "/", "-")
    s = strings.ReplaceAll(s, "@", "-")
    s = strings.ReplaceAll(s, ".", "-")
    return s
}
```

**Key Implementation Points**:
- Generates both SPDX 2.3 and CycloneDX 1.5 formats
- Includes checksums from go.sum
- Adds PURL (Package URL) for each component
- Distinguishes direct vs indirect dependencies
- Integrates with grype for vulnerability analysis

---

### Exercise 3: Container Image Security Pipeline

**Problem**: Build a complete container security pipeline that scans, signs, and verifies container images.

**Solution**:

```go
// cmd/imagesec/main.go
package main

import (
    "encoding/json"
    "flag"
    "fmt"
    "os"
    "os/exec"
    "strings"
    "time"
)

type ScanResult struct {
    Image           string          `json:"image"`
    Timestamp       time.Time       `json:"timestamp"`
    Vulnerabilities []Vulnerability `json:"vulnerabilities"`
    Summary         VulnSummary     `json:"summary"`
    Passed          bool            `json:"passed"`
    SignatureStatus string          `json:"signature_status"`
}

type Vulnerability struct {
    ID          string `json:"id"`
    Severity    string `json:"severity"`
    Package     string `json:"package"`
    Version     string `json:"version"`
    FixedIn     string `json:"fixed_in"`
    Description string `json:"description"`
}

type VulnSummary struct {
    Critical int `json:"critical"`
    High     int `json:"high"`
    Medium   int `json:"medium"`
    Low      int `json:"low"`
    Total    int `json:"total"`
}

func main() {
    action := flag.String("action", "scan", "Action: scan, sign, verify, full")
    image := flag.String("image", "", "Container image to process")
    keyFile := flag.String("key", "", "Cosign private key file (for signing)")
    pubKeyFile := flag.String("pub", "", "Cosign public key file (for verification)")
    failOn := flag.String("fail-on", "critical", "Fail on severity: critical, high, medium")
    sbomFile := flag.String("sbom", "", "SBOM file to attach")
    flag.Parse()

    if *image == "" {
        fmt.Fprintln(os.Stderr, "Error: --image is required")
        os.Exit(1)
    }

    pipeline := &ImageSecurityPipeline{
        Image:      *image,
        KeyFile:    *keyFile,
        PubKeyFile: *pubKeyFile,
        FailOn:     *failOn,
        SBOMFile:   *sbomFile,
    }

    var err error
    switch *action {
    case "scan":
        err = pipeline.Scan()
    case "sign":
        err = pipeline.Sign()
    case "verify":
        err = pipeline.Verify()
    case "full":
        err = pipeline.FullPipeline()
    default:
        err = fmt.Errorf("unknown action: %s", *action)
    }

    if err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(1)
    }
}

type ImageSecurityPipeline struct {
    Image      string
    KeyFile    string
    PubKeyFile string
    FailOn     string
    SBOMFile   string
}

func (p *ImageSecurityPipeline) Scan() error {
    fmt.Printf("🔍 Scanning image: %s\n\n", p.Image)

    // Run Trivy scan
    cmd := exec.Command("trivy", "image", "--format", "json", p.Image)
    output, err := cmd.Output()
    if err != nil {
        // Trivy returns non-zero on vulnerabilities
        if len(output) == 0 {
            return fmt.Errorf("trivy scan failed: %w", err)
        }
    }

    result, err := p.parseTrivyOutput(output)
    if err != nil {
        return err
    }

    p.printScanResult(result)

    if p.shouldFail(result) {
        return fmt.Errorf("vulnerabilities exceed threshold")
    }

    return nil
}

func (p *ImageSecurityPipeline) parseTrivyOutput(data []byte) (*ScanResult, error) {
    var trivyResult struct {
        Results []struct {
            Target          string `json:"Target"`
            Vulnerabilities []struct {
                VulnerabilityID  string `json:"VulnerabilityID"`
                PkgName          string `json:"PkgName"`
                InstalledVersion string `json:"InstalledVersion"`
                FixedVersion     string `json:"FixedVersion"`
                Severity         string `json:"Severity"`
                Description      string `json:"Description"`
            } `json:"Vulnerabilities"`
        } `json:"Results"`
    }

    if err := json.Unmarshal(data, &trivyResult); err != nil {
        return nil, err
    }

    result := &ScanResult{
        Image:     p.Image,
        Timestamp: time.Now(),
        Passed:    true,
    }

    for _, r := range trivyResult.Results {
        for _, v := range r.Vulnerabilities {
            vuln := Vulnerability{
                ID:          v.VulnerabilityID,
                Severity:    v.Severity,
                Package:     v.PkgName,
                Version:     v.InstalledVersion,
                FixedIn:     v.FixedVersion,
                Description: truncate(v.Description, 100),
            }
            result.Vulnerabilities = append(result.Vulnerabilities, vuln)

            switch strings.ToUpper(v.Severity) {
            case "CRITICAL":
                result.Summary.Critical++
            case "HIGH":
                result.Summary.High++
            case "MEDIUM":
                result.Summary.Medium++
            case "LOW":
                result.Summary.Low++
            }
        }
    }

    result.Summary.Total = len(result.Vulnerabilities)
    return result, nil
}

func (p *ImageSecurityPipeline) printScanResult(result *ScanResult) {
    fmt.Printf("╔══════════════════════════════════════════════════════════════╗\n")
    fmt.Printf("║                 IMAGE SECURITY SCAN REPORT                   ║\n")
    fmt.Printf("╚══════════════════════════════════════════════════════════════╝\n\n")

    fmt.Printf("Image: %s\n", result.Image)
    fmt.Printf("Time:  %s\n\n", result.Timestamp.Format(time.RFC3339))

    fmt.Printf("VULNERABILITY SUMMARY:\n")
    fmt.Printf("  🔴 Critical: %d\n", result.Summary.Critical)
    fmt.Printf("  🟠 High:     %d\n", result.Summary.High)
    fmt.Printf("  🟡 Medium:   %d\n", result.Summary.Medium)
    fmt.Printf("  🔵 Low:      %d\n", result.Summary.Low)
    fmt.Printf("  ━━━━━━━━━━━━━━━━\n")
    fmt.Printf("  📊 Total:    %d\n\n", result.Summary.Total)

    if result.Summary.Critical > 0 || result.Summary.High > 0 {
        fmt.Printf("CRITICAL/HIGH VULNERABILITIES:\n")
        fmt.Printf("────────────────────────────────────────────────────────────────\n")
        for _, v := range result.Vulnerabilities {
            if v.Severity == "CRITICAL" || v.Severity == "HIGH" {
                icon := "🔴"
                if v.Severity == "HIGH" {
                    icon = "🟠"
                }
                fmt.Printf("%s %s: %s (%s)\n", icon, v.ID, v.Package, v.Version)
                if v.FixedIn != "" {
                    fmt.Printf("   Fixed in: %s\n", v.FixedIn)
                }
            }
        }
    }
}

func (p *ImageSecurityPipeline) shouldFail(result *ScanResult) bool {
    switch p.FailOn {
    case "critical":
        return result.Summary.Critical > 0
    case "high":
        return result.Summary.Critical > 0 || result.Summary.High > 0
    case "medium":
        return result.Summary.Critical > 0 || result.Summary.High > 0 || result.Summary.Medium > 0
    default:
        return result.Summary.Critical > 0
    }
}

func (p *ImageSecurityPipeline) Sign() error {
    fmt.Printf("✍️  Signing image: %s\n", p.Image)

    args := []string{"sign"}
    if p.KeyFile != "" {
        args = append(args, "--key", p.KeyFile)
    } else {
        // Keyless signing with OIDC
        args = append(args, "--yes")
    }
    args = append(args, p.Image)

    cmd := exec.Command("cosign", args...)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Stdin = os.Stdin

    if err := cmd.Run(); err != nil {
        return fmt.Errorf("signing failed: %w", err)
    }

    fmt.Printf("✅ Image signed successfully\n")

    // Attach SBOM if provided
    if p.SBOMFile != "" {
        fmt.Printf("📋 Attaching SBOM: %s\n", p.SBOMFile)
        cmd := exec.Command("cosign", "attach", "sbom", "--sbom", p.SBOMFile, p.Image)
        if err := cmd.Run(); err != nil {
            return fmt.Errorf("failed to attach SBOM: %w", err)
        }
        fmt.Printf("✅ SBOM attached successfully\n")
    }

    return nil
}

func (p *ImageSecurityPipeline) Verify() error {
    fmt.Printf("🔐 Verifying image signature: %s\n", p.Image)

    args := []string{"verify"}
    if p.PubKeyFile != "" {
        args = append(args, "--key", p.PubKeyFile)
    }
    args = append(args, p.Image)

    cmd := exec.Command("cosign", args...)
    output, err := cmd.CombinedOutput()
    if err != nil {
        fmt.Printf("❌ Signature verification FAILED\n")
        fmt.Println(string(output))
        return fmt.Errorf("verification failed")
    }

    fmt.Printf("✅ Signature verified successfully\n")

    // Parse and display signature info
    var verifyResult []map[string]any
    if err := json.Unmarshal(output, &verifyResult); err == nil && len(verifyResult) > 0 {
        fmt.Printf("\nSignature Details:\n")
        for _, sig := range verifyResult {
            if payload, ok := sig["optional"].(map[string]any); ok {
                if issuer, ok := payload["Issuer"]; ok {
                    fmt.Printf("  Issuer: %v\n", issuer)
                }
                if subject, ok := payload["Subject"]; ok {
                    fmt.Printf("  Subject: %v\n", subject)
                }
            }
        }
    }

    return nil
}

func (p *ImageSecurityPipeline) FullPipeline() error {
    fmt.Printf("🚀 Running full security pipeline for: %s\n\n", p.Image)

    // Step 1: Scan
    fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    fmt.Println("STEP 1: VULNERABILITY SCAN")
    fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if err := p.Scan(); err != nil {
        return fmt.Errorf("scan failed: %w", err)
    }

    // Step 2: Sign
    fmt.Println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    fmt.Println("STEP 2: SIGN IMAGE")
    fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if err := p.Sign(); err != nil {
        return fmt.Errorf("sign failed: %w", err)
    }

    // Step 3: Verify
    fmt.Println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    fmt.Println("STEP 3: VERIFY SIGNATURE")
    fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if err := p.Verify(); err != nil {
        return fmt.Errorf("verify failed: %w", err)
    }

    fmt.Println("\n╔══════════════════════════════════════════════════════════════╗")
    fmt.Println("║          ✅ SECURITY PIPELINE COMPLETED SUCCESSFULLY          ║")
    fmt.Println("╚══════════════════════════════════════════════════════════════╝")

    return nil
}

func truncate(s string, max int) string {
    if len(s) <= max {
        return s
    }
    return s[:max] + "..."
}
```

**Key Implementation Points**:
- Integrates with Trivy for vulnerability scanning
- Supports both keyed and keyless (OIDC) signing with cosign
- Attaches SBOM to signed images
- Configurable failure thresholds
- Full pipeline mode for complete security workflow

### Junior → FAANG: Building the SBOM Scanner Exercise

The SBOM scanner exercise is a production-fidelity implementation that demonstrates SBOM tooling, API integration, and vulnerability correlation in a single program. Completing it correctly produces a tool you can actually use.

**Gap to close:** The OSV (Open Source Vulnerability) API is the vulnerability data source for `govulncheck` and is the most comprehensive Go vulnerability database available. Understanding how to query it programmatically is a career-long skill: every SBOM analysis tool ultimately queries a vulnerability database, and OSV is the most accessible.

**Testing the exercise:** Write integration tests that use a known-vulnerable module version (any module that appears in the Go vulnerability database) and verify that your tool correctly identifies the CVE. Write unit tests with a mock OSV API that test your parsing and reporting logic without network access.

### Senior @ FAANG: Using These Exercises in Team Development

The supply chain security exercises in this section are suitable for team security sprints: structured sessions where the team implements a security tool together, then discusses what they learned.

**Team exercise format:** Run Exercise 1 as a pair programming session with a junior and a senior engineer. The junior drives the implementation. The senior asks probing questions at each decision point: "Why are you using syft rather than cyclonedx-gomod?" "What happens when the OSV API is unavailable?" "How would you extend this to support multiple SBOM formats?" This format accelerates junior learning while building the senior's coaching skills.

**Portfolio value:** A working SBOM scanner that queries OSV and produces actionable vulnerability reports is a genuine open-source contribution. Publish it as a Go tool with good documentation. It demonstrates supply chain security expertise, OSV API knowledge, and production-quality Go development. FAANG hiring managers who look at a candidate's GitHub and find a well-implemented security tool are impressed in a way that a resume line cannot replicate.

---
