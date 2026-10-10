## 110.3 SBOM (Software Bill of Materials)

### What is an SBOM?

An SBOM is a complete inventory of all components in your software:

```
Application v1.2.3
├── golang.org/x/crypto v0.14.0
├── github.com/gin-gonic/gin v1.9.1
│   ├── github.com/bytedance/sonic v1.9.1
│   ├── github.com/go-playground/validator/v10 v10.14.0
│   └── ...
├── github.com/lib/pq v1.10.9
└── ...
```

### SBOM Formats

**SPDX (Software Package Data Exchange)**
- Linux Foundation standard
- ISO/IEC 5962:2021 international standard

**CycloneDX**
- OWASP project
- Focus on security use cases

### Generating SBOM with syft

`syft` is the most widely used open source SBOM generator. It scans a source directory or a container image and emits SPDX or CycloneDX documents ready to attach to release artifacts.

```bash
# Install syft (Anchore's SBOM generator)
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

# Generate SBOM in SPDX format
syft scan . -o spdx-json > sbom.spdx.json

# Generate SBOM in CycloneDX format
syft scan . -o cyclonedx-json > sbom.cyclonedx.json

# Generate from container image
syft scan myapp:latest -o spdx-json > sbom.spdx.json
```

### Custom SBOM Generator

Building a minimal generator yourself demystifies the format. The tool below shells out to `go list -m -json all` for the dependency graph and emits a valid SPDX 2.3 document with one package entry and one `DEPENDS_ON` relationship per module.

```go
// tools/sbom/generator.go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// SPDXDocument represents a minimal SPDX 2.3 document
type SPDXDocument struct {
	SPDXVersion       string            `json:"spdxVersion"`
	DataLicense       string            `json:"dataLicense"`
	SPDXID            string            `json:"SPDXID"`
	Name              string            `json:"name"`
	DocumentNamespace string            `json:"documentNamespace"`
	CreationInfo      CreationInfo      `json:"creationInfo"`
	Packages          []Package         `json:"packages"`
	Relationships     []Relationship    `json:"relationships"`
}

type CreationInfo struct {
	Created            string   `json:"created"`
	Creators           []string `json:"creators"`
	LicenseListVersion string   `json:"licenseListVersion"`
}

type Package struct {
	SPDXID           string `json:"SPDXID"`
	Name             string `json:"name"`
	VersionInfo      string `json:"versionInfo"`
	DownloadLocation string `json:"downloadLocation"`
	FilesAnalyzed    bool   `json:"filesAnalyzed"`
	LicenseConcluded string `json:"licenseConcluded"`
	LicenseDeclared  string `json:"licenseDeclared"`
	CopyrightText    string `json:"copyrightText"`
}

type Relationship struct {
	SPDXID      string `json:"spdxElementId"`
	RelatedID   string `json:"relatedSpdxElement"`
	Relationship string `json:"relationshipType"`
}

func main() {
	sbom, err := generateSBOM()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Output as JSON
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(sbom); err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding: %v\n", err)
		os.Exit(1)
	}
}

func generateSBOM() (*SPDXDocument, error) {
	// Get module information
	modules, err := getModules()
	if err != nil {
		return nil, err
	}

	// Get module name and version
	modName, modVersion, err := getModuleInfo()
	if err != nil {
		return nil, err
	}

	doc := &SPDXDocument{
		SPDXVersion: "SPDX-2.3",
		DataLicense: "CC0-1.0",
		SPDXID:      "SPDXRef-DOCUMENT",
		Name:        modName,
		DocumentNamespace: fmt.Sprintf("https://sbom.example.com/%s-%s-%s",
			modName, modVersion, time.Now().Format("2006-01-02")),
		CreationInfo: CreationInfo{
			Created:            time.Now().UTC().Format(time.RFC3339),
			Creators:           []string{"Tool: custom-sbom-generator"},
			LicenseListVersion: "3.21",
		},
	}

	// Add main package
	doc.Packages = append(doc.Packages, Package{
		SPDXID:           "SPDXRef-Package-" + sanitizeID(modName),
		Name:             modName,
		VersionInfo:      modVersion,
		DownloadLocation: "NOASSERTION",
		FilesAnalyzed:    false,
		LicenseConcluded: "NOASSERTION",
		LicenseDeclared:  "NOASSERTION",
		CopyrightText:    "NOASSERTION",
	})

	// Add dependencies
	for _, mod := range modules {
		pkg := Package{
			SPDXID:           "SPDXRef-Package-" + sanitizeID(mod.Path),
			Name:             mod.Path,
			VersionInfo:      mod.Version,
			DownloadLocation: fmt.Sprintf("https://%s@%s", mod.Path, mod.Version),
			FilesAnalyzed:    false,
			LicenseConcluded: "NOASSERTION",
			LicenseDeclared:  "NOASSERTION",
			CopyrightText:    "NOASSERTION",
		}
		doc.Packages = append(doc.Packages, pkg)

		// Add relationship
		doc.Relationships = append(doc.Relationships, Relationship{
			SPDXID:       "SPDXRef-Package-" + sanitizeID(modName),
			RelatedID:    "SPDXRef-Package-" + sanitizeID(mod.Path),
			Relationship: "DEPENDS_ON",
		})
	}

	return doc, nil
}

type Module struct {
	Path    string
	Version string
}

func getModules() ([]Module, error) {
	cmd := exec.Command("go", "list", "-m", "-json", "all")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var modules []Module
	decoder := json.NewDecoder(strings.NewReader(string(output)))

	for decoder.More() {
		var mod struct {
			Path    string `json:"Path"`
			Version string `json:"Version"`
			Main    bool   `json:"Main"`
		}
		if err := decoder.Decode(&mod); err != nil {
			return nil, err
		}

		// Skip main module
		if mod.Main {
			continue
		}

		modules = append(modules, Module{
			Path:    mod.Path,
			Version: mod.Version,
		})
	}

	return modules, nil
}

func getModuleInfo() (string, string, error) {
	cmd := exec.Command("go", "list", "-m", "-json")
	output, err := cmd.Output()
	if err != nil {
		return "", "", err
	}

	var mod struct {
		Path    string `json:"Path"`
		Version string `json:"Version"`
	}
	if err := json.Unmarshal(output, &mod); err != nil {
		return "", "", err
	}

	version := mod.Version
	if version == "" {
		version = "v0.0.0-dev"
	}

	return mod.Path, version, nil
}

func sanitizeID(s string) string {
	// SPDX IDs must be alphanumeric, ., or -
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, "@", "-")
	return s
}
```

### Junior → FAANG: Why SBOMs Matter for Engineers

SBOMs (Software Bills of Materials) sound like a compliance paperwork exercise but are a powerful engineering tool for incident response and dependency governance.

**Gap to close:** Understand what an SBOM contains: every software component in your application, its version, its license, and its origin. When Log4Shell was disclosed in December 2021, organizations with SBOMs identified all affected services in hours. Organizations without SBOMs spent days discovering which services used Log4j. The SBOM is the index that makes vulnerability response fast.

**First-job habit:** Generate an SBOM for your Go service using `syft` or `cyclonedx-gomod`. Attach it to your release artifacts. Even if no one looks at it today, it will be invaluable when the next major vulnerability is disclosed and you need to know immediately whether your service is affected.

**Interview framing:** When asked about SBOM, describe it as a manifest of all components in your software. Explain how it enables rapid response to newly disclosed vulnerabilities: you search the SBOM for the affected package name, and you immediately know whether your service is at risk. This practical, incident-response framing is more compelling than the compliance framing.

### Senior @ FAANG: SBOM as Organizational Infrastructure

At senior level, SBOMs are generated automatically for every release, stored alongside every artifact, and queried programmatically in response to new vulnerability disclosures.

**SBOM automation in CI:** Configure every build pipeline to generate an SBOM as part of the build process, sign it with cosign, and attach it to the container image or release artifact. The SBOM is not a manual artifact: it is generated from the exact state of the build, not from a snapshot of `go.mod`. Use `syft` or `trivy` integrated into the build step to produce CycloneDX or SPDX format SBOMs.

**Vulnerability lookup at scale:** Build or adopt a tool that accepts an SBOM and a CVE identifier and reports whether the CVE affects any component in the SBOM. Integrate this tool with your vulnerability feed (NVD, GitHub Advisory Database, Go vulnerability database). When a new CVE is published, the tool automatically queries all SBOMs in your artifact repository and generates a list of affected services with owners. This converts a potentially days-long discovery process into an automated, minutes-long operation.

**SBOM governance and customer requirements:** Some customers (US federal agencies, defense contractors) now require SBOMs as a condition of purchase. Staff engineers anticipate these requirements and build SBOM generation into the release process before customers ask. Retrofitting SBOM generation after a customer contract requires it is expensive and politically awkward. Building it in advance demonstrates supply chain security maturity and can be a competitive differentiator.

---
