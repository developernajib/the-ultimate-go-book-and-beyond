## 90I.1 SolarWinds SUNBURST - The Build Pipeline That Betrayed 18,000 Organizations (2020)

### The Attack Timeline

The SolarWinds SUNBURST attack stands as the most sophisticated supply chain compromise in the history of software
engineering. It was not a smash-and-grab data theft or an opportunistic exploitation of a known vulnerability. It
was a meticulously planned, flawlessly executed operation by Russia's SVR intelligence service (APT29, also known as
Cozy Bear) that turned a trusted IT management platform into a weapon aimed at the heart of the United States
government and Fortune 500 corporations.

**Phase 1: Initial Access (October 2019)**

The attackers gained access to SolarWinds' internal network through means that have never been fully disclosed
publicly. Intelligence community assessments suggest a combination of credential theft and exploitation of
internet-facing systems. Once inside SolarWinds' corporate network, the attackers did not rush. They spent weeks
mapping the internal network, understanding the development infrastructure, and identifying their ultimate target:
the build system for SolarWinds' Orion platform.

**Phase 2: Build Pipeline Reconnaissance (November 2019 - February 2020)**

The attackers studied SolarWinds' software development lifecycle in extraordinary detail. They needed to understand
exactly how Orion was compiled, tested, signed, and distributed. This reconnaissance phase lasted months. They
identified the TeamCity build servers, understood the signing process, and mapped the code review workflow. They
also deployed a test implant called SUNSPOT - a piece of malware designed specifically to monitor the build process
and inject malicious code at compile time without modifying the source code repository.

**Phase 3: SUNSPOT Deployment (February 2020)**

SUNSPOT was an ingenious piece of engineering. It ran as a background process on the build server, monitoring for
the `MsBuild.exe` process. When it detected that an Orion build was in progress, it identified the specific source
file (`InventoryManager.cs`) being compiled, replaced it in memory with a modified version containing the SUNBURST
backdoor, and then restored the original file after compilation completed. This meant:

- The source code repository was never modified
- Code reviews would not detect the change
- The compiled binary contained the backdoor
- The binary was legitimately signed with SolarWinds' code signing certificate
- File integrity checks against the source repository would pass

**Phase 4: SUNBURST Distribution (March - June 2020)**

The poisoned Orion update (versions 2019.4 HF 5 through 2020.2.1) was distributed to approximately 18,000
organizations through SolarWinds' normal update mechanism. Because the update was digitally signed by SolarWinds'
legitimate certificate, every organization's security tools accepted it as trusted software. The backdoor lay
dormant for approximately two weeks after installation before activating - a technique designed to evade sandbox
analysis tools that typically monitor new software for only a few days.

**Phase 5: Command and Control (March - December 2020)**

Once activated, SUNBURST used an ingenious domain generation algorithm (DGA) that encoded information about the
victim's environment into DNS queries to `avsvmcloud.com`. The C2 communication was disguised as legitimate
SolarWinds API traffic, using HTTP requests that mimicked the Orion Improvement Program telemetry. The attackers
then selectively deployed a secondary payload called TEARDROP on high-value targets - approximately 100
organizations out of the 18,000 that received the backdoor.

**Phase 6: Lateral Movement and Data Exfiltration (March - December 2020)**

The confirmed high-value victims included:
- US Department of the Treasury
- US Department of Homeland Security (including CISA, the cybersecurity agency)
- US Department of Commerce (NTIA)
- US Department of State
- US Department of Energy (including the National Nuclear Security Administration)
- Microsoft
- FireEye (the cybersecurity firm that ultimately discovered the breach)
- Intel, Cisco, Deloitte, and numerous Fortune 500 companies

The attackers used the SUNBURST backdoor to gain initial access, then pivoted using stolen SAML signing certificates
to forge authentication tokens - a technique known as "Golden SAML." This allowed them to access cloud resources
(email, SharePoint, Azure AD) without triggering the compromised on-premises systems' security alerts.

### How It Was Discovered

FireEye, one of the world's leading cybersecurity firms, discovered the breach on December 8, 2020, when their own
red team tools were stolen. A FireEye analyst noticed an anomalous MFA registration event - a new device was
registered to an employee's account from an IP address that did not match the employee's known locations. This
triggered an investigation that traced the compromise back to the SolarWinds Orion update.

The delay between initial compromise (March 2020) and discovery (December 2020) - nine months of undetected access
 -  illustrates the sophistication of the operation and the fundamental inadequacy of perimeter-based security models
against supply chain attacks.

### Technical Root Cause Analysis

The SUNBURST attack exploited several interconnected failures:

1. **Build pipeline integrity**: SolarWinds' build servers lacked integrity monitoring. The SUNSPOT implant ran
   undetected for months because there was no attestation of the build environment's state.

2. **No reproducible builds**: There was no mechanism to verify that the compiled binary corresponded to the source
   code in the repository. Reproducible builds would have detected the discrepancy immediately.

3. **Code signing as single trust anchor**: The code signing certificate was treated as the ultimate proof of
   software integrity, but the signing happened on the compromised build server, after the malicious code was
   injected.

4. **No software bill of materials (SBOM)**: Organizations consuming SolarWinds updates had no way to verify what
   was actually in the binary they were installing.

5. **Excessive trust in vendor software**: Orion was typically deployed with elevated network privileges because it
   needed to monitor infrastructure, making it an ideal vector for lateral movement.

### SolarWinds' Response

SolarWinds issued an emergency advisory on December 13, 2020, and released a clean update (2020.2.1 HF 2) on
December 15, 2020. The company engaged CrowdStrike for incident response and worked with CISA, the FBI, and the
NSA on the government-wide response. In the aftermath, SolarWinds overhauled their build pipeline, implementing
a modernized build system with integrity verification at every stage.

### Go Code: SLSA Provenance Verification

The Software Supply Chain Levels for Software Artifacts (SLSA, pronounced "salsa") framework was developed directly
in response to attacks like SUNBURST. It defines levels of build integrity assurance. Here is a production-grade
implementation of SLSA provenance generation and verification in Go:

```go
package slsa

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"
)

// SLSALevel represents the SLSA compliance level of a build.
type SLSALevel int

const (
	// SLSALevel0 indicates no provenance guarantees.
	SLSALevel0 SLSALevel = iota
	// SLSALevel1 indicates provenance exists and is documented.
	SLSALevel1
	// SLSALevel2 indicates a hosted, authenticated build service generated provenance.
	SLSALevel2
	// SLSALevel3 indicates hardened build platform with non-falsifiable provenance.
	SLSALevel3
	// SLSALevel4 indicates hermetic, reproducible builds with two-party review.
	SLSALevel4
)

// ProvenanceStatement represents a SLSA provenance attestation following the
// in-toto attestation framework specification.
type ProvenanceStatement struct {
	Type          string             `json:"_type"`
	Subject       []ResourceDescriptor `json:"subject"`
	PredicateType string             `json:"predicateType"`
	Predicate     ProvenancePredicate `json:"predicate"`
}

// ResourceDescriptor identifies a build artifact by name and cryptographic digest.
type ResourceDescriptor struct {
	Name   string            `json:"name"`
	Digest map[string]string `json:"digest"`
}

// ProvenancePredicate contains the build metadata and parameters.
type ProvenancePredicate struct {
	BuildDefinition BuildDefinition `json:"buildDefinition"`
	RunDetails      RunDetails      `json:"runDetails"`
}

// BuildDefinition describes what was built and from what sources.
type BuildDefinition struct {
	BuildType            string               `json:"buildType"`
	ExternalParameters   ExternalParameters   `json:"externalParameters"`
	InternalParameters   InternalParameters   `json:"internalParameters"`
	ResolvedDependencies []ResourceDescriptor `json:"resolvedDependencies"`
}

// ExternalParameters represents user-controlled build inputs.
type ExternalParameters struct {
	Repository string `json:"repository"`
	Ref        string `json:"ref"`
	CommitSHA  string `json:"commitSHA"`
}

// InternalParameters represents builder-controlled build configuration.
type InternalParameters struct {
	GoVersion    string `json:"goVersion"`
	GOOS         string `json:"goos"`
	GOARCH       string `json:"goarch"`
	CGOEnabled   bool   `json:"cgoEnabled"`
	BuildFlags   string `json:"buildFlags"`
	Reproducible bool   `json:"reproducible"`
}

// RunDetails describes the build execution environment.
type RunDetails struct {
	Builder   BuilderInfo `json:"builder"`
	Metadata  BuildMeta   `json:"metadata"`
}

// BuilderInfo identifies the build platform.
type BuilderInfo struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

// BuildMeta contains timestamps and invocation identifiers.
type BuildMeta struct {
	InvocationID string    `json:"invocationId"`
	StartedOn    time.Time `json:"startedOn"`
	FinishedOn   time.Time `json:"finishedOn"`
}

// SignedProvenance wraps a provenance statement with a cryptographic signature.
type SignedProvenance struct {
	Statement ProvenanceStatement `json:"statement"`
	Signature []byte              `json:"signature"`
	PublicKey []byte              `json:"publicKey"`
}

// ProvenanceGenerator creates SLSA provenance attestations for build artifacts.
type ProvenanceGenerator struct {
	builderID  string
	signingKey *ecdsa.PrivateKey
}

// NewProvenanceGenerator creates a generator with the given builder identity
// and ECDSA signing key for attestation signatures.
func NewProvenanceGenerator(builderID string, key *ecdsa.PrivateKey) *ProvenanceGenerator {
	return &ProvenanceGenerator{
		builderID:  builderID,
		signingKey: key,
	}
}

// GenerateKeyPair creates a new ECDSA P-256 key pair for signing provenance
// attestations. The private key should be stored in a hardware security module
// or secrets manager in production environments.
func GenerateKeyPair() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// HashFile computes the SHA-256 digest of a file, returning it as a hex string.
func HashFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading file for hash: %w", err)
	}
	hash := sha256.Sum256(data)
	return fmt.Sprintf("%x", hash), nil
}

// Generate creates a signed SLSA provenance attestation for the given artifact.
func (g *ProvenanceGenerator) Generate(
	artifactPath string,
	artifactHash string,
	params ExternalParameters,
	internal InternalParameters,
	deps []ResourceDescriptor,
	startTime time.Time,
) (*SignedProvenance, error) {
	statement := ProvenanceStatement{
		Type: "https://in-toto.io/Statement/v1",
		Subject: []ResourceDescriptor{
			{
				Name:   artifactPath,
				Digest: map[string]string{"sha256": artifactHash},
			},
		},
		PredicateType: "https://slsa.dev/provenance/v1",
		Predicate: ProvenancePredicate{
			BuildDefinition: BuildDefinition{
				BuildType:            "https://github.com/slsa-framework/slsa-github-generator/go@v1",
				ExternalParameters:   params,
				InternalParameters:   internal,
				ResolvedDependencies: deps,
			},
			RunDetails: RunDetails{
				Builder: BuilderInfo{
					ID:      g.builderID,
					Version: "1.0.0",
				},
				Metadata: BuildMeta{
					InvocationID: fmt.Sprintf("build-%d", time.Now().UnixNano()),
					StartedOn:    startTime,
					FinishedOn:   time.Now(),
				},
			},
		},
	}

	statementBytes, err := json.Marshal(statement)
	if err != nil {
		return nil, fmt.Errorf("marshaling statement: %w", err)
	}

	hash := sha256.Sum256(statementBytes)
	sig, err := ecdsa.SignASN1(rand.Reader, g.signingKey, hash[:])
	if err != nil {
		return nil, fmt.Errorf("signing provenance: %w", err)
	}

	pubKeyBytes, err := x509.MarshalPKIXPublicKey(&g.signingKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("marshaling public key: %w", err)
	}

	pubKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubKeyBytes,
	})

	return &SignedProvenance{
		Statement: statement,
		Signature: sig,
		PublicKey: pubKeyPEM,
	}, nil
}

// VerifyProvenance checks the cryptographic signature on a provenance attestation
// and validates its contents against expected values.
func VerifyProvenance(
	sp *SignedProvenance,
	expectedArtifactHash string,
	expectedBuilderID string,
	trustedKeys []*ecdsa.PublicKey,
) error {
	// Step 1: Verify the artifact hash matches the provenance subject.
	if len(sp.Statement.Subject) == 0 {
		return errors.New("provenance has no subjects")
	}
	actualHash, ok := sp.Statement.Subject[0].Digest["sha256"]
	if !ok {
		return errors.New("provenance subject missing sha256 digest")
	}
	if actualHash != expectedArtifactHash {
		return fmt.Errorf(
			"artifact hash mismatch: provenance says %s, actual is %s",
			actualHash, expectedArtifactHash,
		)
	}

	// Step 2: Verify the builder identity.
	if sp.Statement.Predicate.RunDetails.Builder.ID != expectedBuilderID {
		return fmt.Errorf(
			"untrusted builder: %s (expected %s)",
			sp.Statement.Predicate.RunDetails.Builder.ID, expectedBuilderID,
		)
	}

	// Step 3: Verify the cryptographic signature against trusted keys.
	statementBytes, err := json.Marshal(sp.Statement)
	if err != nil {
		return fmt.Errorf("marshaling statement for verification: %w", err)
	}
	hash := sha256.Sum256(statementBytes)

	for _, key := range trustedKeys {
		if ecdsa.VerifyASN1(key, hash[:], sp.Signature) {
			return nil // Signature valid against a trusted key.
		}
	}

	return errors.New("provenance signature does not match any trusted key")
}
```

### Engineering Lessons

1. **Build pipelines are a critical security boundary.** They deserve the same level of hardening as production
   servers. Implement build provenance (SLSA Level 3+), reproducible builds, and real-time integrity monitoring of
   build infrastructure.

2. **Code signing alone is insufficient.** A legitimate signature only proves the software was signed by the
   key holder - it says nothing about what was actually compiled. Provenance attestation links the binary to specific
   source code, build parameters, and dependencies.

3. **Trust must be verified continuously, not granted once.** The zero-trust principle applies to software supply
   chains. Every artifact should carry cryptographically verifiable provenance that consumers can validate before
   deployment.

4. **Dwell time is the attacker's greatest advantage.** Nine months of undetected access allowed the attackers to
   target the most sensitive organizations. Assume breach and invest in detection, not just prevention.

---

### Junior → FAANG: Build Pipeline Security as a System Design Topic

SolarWinds is the interview answer to "what is a supply chain attack and how do you defend against it?" The attack compromised the build pipeline that produced SolarWinds Orion updates, injecting malicious code into the binary before it was signed and distributed. 18,000 organizations installed the tampered update because the binary bore a legitimate SolarWinds signature. For FAANG interviews, the defense has three parts. First, SLSA provenance: every production artifact should carry a signed attestation that links the binary to a specific source commit, build environment, and dependency set. Second, reproducible builds: given the same source and build environment, the output binary should be bit-for-bit identical, so any tampering with the build environment changes the output. Third, assume breach: invest in behavioral detection for insider-level access, not just perimeter prevention. The `ProvenanceGenerator` and `VerifyProvenance` functions in this section demonstrate the SLSA attestation pattern in Go.

### Senior @ FAANG: Build Pipeline as a Security Boundary and SLSA as a Platform Standard

At L6, the SolarWinds incident reframes the build pipeline as a security boundary that must be hardened at the same level as the production environment. Most organizations treat CI/CD as a productivity tool: the security controls are often weaker than production (fewer access controls, more permissive permissions, shared infrastructure). SolarWinds demonstrates that a compromised build pipeline can inject code into every binary the organization ships, with no indication to consumers that the binary has been tampered with. The staff-level response is to define explicit security requirements for the build pipeline: isolated build environments that cannot access production credentials, build agents that authenticate to the artifact registry using short-lived tokens rather than long-lived credentials, and artifact signing with hardware-backed keys stored in an HSM. SLSA Level 2 (provenance generated and signed by the CI system) is the minimum for any software distributed externally. SLSA Level 3 (provenance generated and signed by a hardened build platform) is the target for any software in the critical path. Building the SLSA platform tooling and establishing the org-wide provenance verification policy is a staff engineer's platform investment that benefits every team in the organization.

