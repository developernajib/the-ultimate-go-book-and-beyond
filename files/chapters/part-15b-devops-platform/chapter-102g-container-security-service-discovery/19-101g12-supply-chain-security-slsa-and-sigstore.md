## 102G.17 Supply Chain Security (SLSA and Sigstore)

Supply chain attacks target the build pipeline itself - not the running application. The SolarWinds attack (2020) and XZ Utils backdoor (2024) demonstrated that attackers who compromise a build system can distribute malicious code to thousands of organizations. SLSA and Sigstore are the industry's answer.

### SLSA Framework Levels

SLSA (Supply-chain Levels for Software Artifacts) defines four levels of build integrity:

| Level | Requirement | What it prevents |
|-------|-------------|-----------------|
| SLSA 0 | None | Nothing |
| SLSA 1 | Build process documented and scripted | Accidental errors, basic audit |
| SLSA 2 | Build service generates provenance | Tampering after build |
| SLSA 3 | Build environment is hardened and isolated | Compromised build worker |
| SLSA 4 | Two-party review, hermetic/reproducible builds | Insider threats, backdoors |

For most organizations, SLSA 2-3 is the practical target. SLSA 4 requires reproducible builds - the same source always produces bit-for-bit identical output - which is difficult with most build tools.

### Signing Container Images with Cosign and Sigstore

Cosign (part of the Sigstore project) signs OCI images and stores signatures in the same registry as the image, as a separate manifest. No separate key server needed.

```bash
# Install cosign
brew install cosign   # or download from releases.sigstore.dev

# --- Key-pair based signing (traditional) ---
cosign generate-key-pair   # creates cosign.key and cosign.pub

# Sign an image after push
cosign sign --key cosign.key myregistry.io/services/api:v1.2.3

# Verify signature
cosign verify --key cosign.pub myregistry.io/services/api:v1.2.3

# --- Keyless signing with OIDC (recommended for CI/CD) ---
# In GitHub Actions, Cosign uses OIDC token from the runner identity
# No long-lived keys to manage - Fulcio issues ephemeral signing certs
cosign sign --yes myregistry.io/services/api:v1.2.3
# Sigstore Rekor transparency log receives the signature - tamper-evident log
```

### Keyless Signing in GitHub Actions

```yaml
# .github/workflows/build-sign.yml
name: Build, Scan, Sign

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write
  id-token: write   # Required for keyless OIDC signing

jobs:
  build-sign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Build and push image
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign image (keyless)
        run: |
          cosign sign --yes \
            ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}

      - name: Install Syft (SBOM generator)
        uses: anchore/sbom-action/download-syft@v0

      - name: Generate SBOM
        run: |
          syft ghcr.io/${{ github.repository }}:${{ github.sha }} \
            -o spdx-json > sbom.spdx.json

      - name: Attest SBOM to image
        run: |
          cosign attest --yes \
            --predicate sbom.spdx.json \
            --type spdxjson \
            ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}

      - name: Scan SBOM for vulnerabilities with Grype
        uses: anchore/scan-action@v4
        with:
          sbom: sbom.spdx.json
          fail-build: true
          severity-cutoff: high
```

### Verifying Image Signatures in a Kubernetes Admission Webhook (Go)

This validating admission webhook rejects any pod whose image is not signed by the expected Cosign key or Fulcio OIDC identity:

```go
// cmd/admission-webhook/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "time"

    "github.com/sigstore/cosign/v2/pkg/cosign"
    "github.com/sigstore/cosign/v2/pkg/oci/remote"
    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SignaturePolicy defines what valid signatures look like.
type SignaturePolicy struct {
    // KeylessIssuer is the OIDC issuer expected in keyless certs.
    KeylessIssuer string
    // KeylessIdentity is the subject (e.g., GitHub Actions workflow URL).
    KeylessIdentity string
    // AllowedRegistries are the only registries we trust.
    AllowedRegistries []string
}

type WebhookServer struct {
    policy SignaturePolicy
    logger *slog.Logger
}

func (s *WebhookServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    var review admissionv1.AdmissionReview
    if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
        http.Error(w, "decode error", http.StatusBadRequest)
        return
    }

    response := s.validate(r.Context(), review.Request)
    review.Response = response
    review.Response.UID = review.Request.UID

    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(review); err != nil {
        s.logger.Error("encode response", slog.String("error", err.Error()))
    }
}

func (s *WebhookServer) validate(ctx context.Context, req *admissionv1.AdmissionRequest) *admissionv1.AdmissionResponse {
    var pod corev1.Pod
    if err := json.Unmarshal(req.Object.Raw, &pod); err != nil {
        return deny("failed to parse pod: " + err.Error())
    }

    // Check all containers including init containers
    allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)

    for _, container := range allContainers {
        if err := s.verifyImageSignature(ctx, container.Image); err != nil {
            s.logger.Warn("signature verification failed",
                slog.String("image", container.Image),
                slog.String("error", err.Error()),
                slog.String("pod", pod.Name),
            )
            return deny(fmt.Sprintf("image %q failed signature verification: %v",
                container.Image, err))
        }
        s.logger.Info("image signature verified",
            slog.String("image", container.Image),
        )
    }

    return allow()
}

func (s *WebhookServer) verifyImageSignature(ctx context.Context, image string) error {
    ref, err := parseImageRef(image)
    if err != nil {
        return fmt.Errorf("parse image ref: %w", err)
    }

    checkOpts := &cosign.CheckOpts{
        // Keyless verification: validate against Sigstore's Fulcio CA
        CertIdentity:   s.policy.KeylessIdentity,
        CertOidcIssuer: s.policy.KeylessIssuer,
    }

    // VerifyImageSignatures checks the signature stored in the registry
    // against the Sigstore Rekor transparency log.
    _, _, err = cosign.VerifyImageSignatures(ctx, ref, checkOpts)
    if err != nil {
        return fmt.Errorf("cosign verify: %w", err)
    }

    return nil
}

func parseImageRef(image string) (any, error) {
    return remote.ParseReference(image)
}

func deny(msg string) *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{
        Allowed: false,
        Result: &metav1.Status{
            Message: msg,
            Code:    http.StatusForbidden,
        },
    }
}

func allow() *admissionv1.AdmissionResponse {
    return &admissionv1.AdmissionResponse{Allowed: true}
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    policy := SignaturePolicy{
        KeylessIssuer:   "https://token.actions.githubusercontent.com",
        KeylessIdentity: os.Getenv("GITHUB_WORKFLOW_IDENTITY"), // e.g., "https://github.com/myorg/myrepo/.github/workflows/build.yml@refs/heads/main"
        AllowedRegistries: []string{
            "ghcr.io/myorg/",
            "myregistry.io/services/",
        },
    }

    server := &WebhookServer{policy: policy, logger: logger}

    mux := http.NewServeMux()
    mux.Handle("/validate", server)
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:         ":8443",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    logger.Info("admission webhook listening", slog.String("addr", ":8443"))
    // In production: use TLS with cert-manager-issued certificates
    if err := srv.ListenAndServeTLS(
        os.Getenv("TLS_CERT_FILE"),
        os.Getenv("TLS_KEY_FILE"),
    ); err != nil {
        logger.Error("server error", slog.String("error", err.Error()))
        os.Exit(1)
    }
}
```

Register the webhook with Kubernetes:

```yaml
# validating-webhook-config.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: image-signature-validator
  annotations:
    cert-manager.io/inject-ca-from: security/admission-webhook-cert
webhooks:
  - name: image-signature.security.io
    admissionReviewVersions: ["v1"]
    clientConfig:
      service:
        name: admission-webhook
        namespace: security
        path: /validate
    rules:
      - apiGroups:   [""]
        apiVersions: ["v1"]
        operations:  ["CREATE", "UPDATE"]
        resources:   ["pods"]
    namespaceSelector:
      matchLabels:
        signature-enforcement: enabled   # opt-in per namespace
    failurePolicy: Fail   # Reject pods if webhook is unreachable
    sideEffects: None
    timeoutSeconds: 10
```

### SBOM Vulnerability Scanning with Grype

An SBOM (Software Bill of Materials) is a machine-readable manifest of every library baked into a container image, including transitive dependencies that `go.sum` tracks but `docker inspect` hides. Grype cross-references this list against multiple CVE databases (NVD, GitHub Advisory, OSV) and returns structured JSON findings. The `PolicyGate` function below acts as a build-time quality gate: it maps severity strings to an integer order so that a `"High"` threshold blocks `Critical` and `High` findings while letting `Medium` and below pass.

```go
// internal/security/sbom_scanner.go
package security

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "os/exec"
    "time"
)

// GrypeFinding represents a single vulnerability found by Grype.
type GrypeFinding struct {
    Vulnerability struct {
        ID          string   `json:"id"`
        Severity    string   `json:"severity"`
        Description string   `json:"description"`
        Fix         struct {
            Versions []string `json:"versions"`
            State    string   `json:"state"`
        } `json:"fix"`
    } `json:"vulnerability"`
    Artifact struct {
        Name    string `json:"name"`
        Version string `json:"version"`
        Type    string `json:"type"`
    } `json:"artifact"`
}

// GrypeScanResult is the top-level output from grype --output json.
type GrypeScanResult struct {
    Matches []GrypeFinding `json:"matches"`
}

// ScanSBOM runs Grype against the given SBOM file path and returns findings.
func ScanSBOM(ctx context.Context, sbomPath string) (*GrypeScanResult, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
    defer cancel()

    cmd := exec.CommandContext(ctx, "grype",
        fmt.Sprintf("sbom:%s", sbomPath),
        "--output", "json",
        "--quiet",
    )

    var stdout, stderr bytes.Buffer
    cmd.Stdout = &stdout
    cmd.Stderr = &stderr

    if err := cmd.Run(); err != nil {
        // Exit code 1 means vulnerabilities found - not an error for us
        if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
            // Parse the output anyway
        } else {
            return nil, fmt.Errorf("grype failed: %w, stderr: %s", err, stderr.String())
        }
    }

    var result GrypeScanResult
    if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
        return nil, fmt.Errorf("parse grype output: %w", err)
    }

    return &result, nil
}

// PolicyGate returns an error if the scan result contains violations
// above the specified severity threshold.
func PolicyGate(result *GrypeScanResult, maxSeverity string) error {
    severityOrder := map[string]int{
        "Negligible": 0, "Low": 1, "Medium": 2, "High": 3, "Critical": 4,
    }

    threshold, ok := severityOrder[maxSeverity]
    if !ok {
        return fmt.Errorf("unknown severity level: %s", maxSeverity)
    }

    var violations []GrypeFinding
    for _, finding := range result.Matches {
        level, exists := severityOrder[finding.Vulnerability.Severity]
        if exists && level >= threshold {
            violations = append(violations, finding)
        }
    }

    if len(violations) > 0 {
        return fmt.Errorf("policy gate failed: %d vulnerabilities at or above %s",
            len(violations), maxSeverity)
    }

    return nil
}
```

---

### Junior → FAANG: Why Supply Chain Security Is the 2024-Era Interview Topic

The SolarWinds and XZ Utils attacks are the canonical examples interviewers reference when asking about supply chain security. If you cannot explain what a supply chain attack is (compromising the build or packaging process to distribute malicious code to downstream consumers, rather than attacking the running application directly), you will struggle with this interview category.

The SLSA levels are a useful framework for answering "how mature is your supply chain security?" SLSA 1 is "we have a CI script." SLSA 2 is "CI generates signed provenance attestations." SLSA 3 is "the build environment is hardened and isolated so even a compromised build worker cannot tamper with the output." Most organizations are at SLSA 1 or 2. Being able to describe what SLSA 3 requires (hermetic builds, two-party review of build configuration) and why it is difficult is the depth that separates a candidate who has read the spec from one who has tried to implement it.

The keyless signing workflow (OIDC token from GitHub Actions, ephemeral certificate from Fulcio, transparency log entry in Rekor) is the modern answer to "how do you manage signing keys in CI?" The old answer (long-lived signing key stored as a CI secret) has key rotation problems and access control problems. The keyless answer eliminates both: there is no key to rotate or protect, and the signature is bound to the specific CI job that ran the build.

First-job habit: add Cosign signing and SBOM generation to every build pipeline you set up. The GitHub Actions workflow in this section is a template you can use directly. It takes 10 minutes to add and provides supply chain attestation that most organizations do not have.

### Senior @ FAANG: Supply Chain Governance at Organizational Scale

The admission webhook that verifies Cosign signatures is the enforcement mechanism that gives supply chain signing meaning. Without enforcement, signing is a voluntary practice that individual teams can skip. The webhook makes unsigned images undeployable in signature-enforcement namespaces, which is the correct design: new namespaces are labeled for enforcement at creation time, and teams that need an exception must go through a formal approval process.

The `failurePolicy: Fail` on the ValidatingWebhookConfiguration is the correct security choice but creates an operational dependency: if the webhook service is unavailable, no pods can be scheduled in enforced namespaces. The webhook service must therefore be treated as a critical infrastructure component with the same HA requirements as CoreDNS. A staff engineer deploying this webhook must define: the minimum number of healthy replicas required, the pod disruption budget, the resource limits to prevent memory exhaustion, and the runbook for when the webhook is degraded.

The SLSA 3 requirement for hermetic builds (the same source always produces bit-for-bit identical output) is particularly challenging for Go because Go embeds timestamps and build environment information into binaries by default. The `-trimpath` flag removes source paths, and `-ldflags="-w -s"` strips debug information, but embedded build timestamps remain unless explicitly replaced. Reproducible Go builds require `SOURCE_DATE_EPOCH` to be set and the build environment to be pinned precisely. A staff engineer responsible for achieving SLSA 3 must define the toolchain pinning strategy and the verification process for reproducibility (building from the same source on two independent systems and comparing digests).

The SBOM governance model at scale: each image has an SBOM, SBOMs are stored as Cosign attestations in the registry, and a centralized SBOM database aggregates all SBOMs across all images in production. When a new CVE is published (for example, against a specific version of a Go package), the SBOM database query answers "which of our 500 running images contain this package at this version" in seconds. Without centralized SBOM storage, answering that question requires re-scanning every running image, which takes hours. Building and operating the SBOM database is the staff-level infrastructure work that enables fast CVE response at scale.

The `KeylessIdentity` field in the webhook policy (the GitHub Actions workflow URL) is a powerful but brittle signal. It is powerful because it pins the acceptable signing identity to a specific workflow in a specific repository, not just to any identity in the trust domain. It is brittle because renaming the workflow file or moving the repository changes the identity and breaks verification. The ADR for this policy needs to address: how identity changes are managed (a planned migration with a brief overlap period where both old and new identities are accepted), and how the policy is tested before enforcement to avoid blocking deployments during a rename.

