## 102D.16 GitOps Security: Supply Chain & Admission Verification

Security in a GitOps pipeline extends far beyond Kubernetes RBAC. The Git repository itself becomes an attack surface: a compromised commit can deploy malicious workloads across every environment. This section covers the full supply chain from developer commit to production pod.

### Signed Commits with Sigstore / Gitsign

Sigstore's Gitsign replaces GPG for commit signing. It uses ephemeral Fulcio certificates bound to an OIDC identity (GitHub, Google, Microsoft) - no key management required.

```bash
# Install and configure Gitsign
brew install sigstore/tap/gitsign

git config --global gpg.x509.program gitsign
git config --global gpg.format x509
git config --global commit.gpgsign true

# Verify a commit's signature
gitsign verify \
  --certificate-identity=dev@acme.com \
  --certificate-oidc-issuer=https://accounts.google.com \
  HEAD
```

ArgoCD enforces signed commits per project:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  signatureKeys:
    - keyID: "4AEE18F83AFDEB23"
  sourceRepos:
    - "https://github.com/acme/gitops-config.git"
  destinations:
    - namespace: "*"
      server: https://prod.k8s.acme.internal
```

### OPA/Gatekeeper - Approved Image Registry Policy

Gatekeeper intercepts every Kubernetes admission request and evaluates OPA Rego policies before the object is persisted.

```yaml
# constraint-template-approved-registries.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: approvedimageregistry
spec:
  crd:
    spec:
      names:
        kind: ApprovedImageRegistry
      validation:
        openAPIV3Schema:
          type: object
          properties:
            approvedRegistries:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package approvedimageregistry

        violation[{"msg": msg}] {
          container := input.review.object.spec.template.spec.containers[_]
          image := container.image
          not starts_with_approved(image, input.parameters.approvedRegistries)
          msg := sprintf("Image '%v' is not from an approved registry", [image])
        }

        starts_with_approved(image, registries) {
          registry := registries[_]
          startswith(image, registry)
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: ApprovedImageRegistry
metadata:
  name: require-approved-registry
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces: ["production", "staging"]
  parameters:
    approvedRegistries:
      - "ghcr.io/acme/"
      - "public.ecr.aws/acme/"
```

### Go Admission Webhook - Reject Unsigned Images

A validating admission webhook enforces Cosign image signatures before any pod is scheduled.

```go
// cmd/admission-webhook/main.go
package main

import (
	"context"
	"crypto"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/sigstore/cosign/v2/pkg/cosign"
	"github.com/sigstore/cosign/v2/pkg/oci/remote"
	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/validate", validateHandler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Addr: ":8443", Handler: mux}
	logger.Info("admission webhook listening", "addr", ":8443")
	if err := srv.ListenAndServeTLS("/tls/tls.crt", "/tls/tls.key"); err != nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func validateHandler(w http.ResponseWriter, r *http.Request) {
	var review admissionv1.AdmissionReview
	if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
		http.Error(w, "decode error", http.StatusBadRequest)
		return
	}
	resp := &admissionv1.AdmissionResponse{UID: review.Request.UID}

	var pod corev1.Pod
	if err := json.Unmarshal(review.Request.Object.Raw, &pod); err != nil {
		resp.Allowed = false
		resp.Result = &metav1.Status{Message: fmt.Sprintf("unmarshal pod: %v", err)}
		writeReview(w, resp)
		return
	}

	if err := verifyPodImages(r.Context(), pod, os.Getenv("COSIGN_PUBLIC_KEY_PATH")); err != nil {
		logger.Warn("image verification failed", "pod", pod.Name, "err", err)
		resp.Allowed = false
		resp.Result = &metav1.Status{Code: http.StatusForbidden, Message: err.Error()}
	} else {
		resp.Allowed = true
	}
	writeReview(w, resp)
}

// verifyPodImages checks every init and regular container image is cosign-signed.
func verifyPodImages(ctx context.Context, pod corev1.Pod, pubKeyPath string) error {
	keyBytes, err := os.ReadFile(pubKeyPath)
	if err != nil {
		return fmt.Errorf("read public key %s: %w", pubKeyPath, err)
	}
	verifier, err := cosign.NewPublicKeyVerifier(keyBytes, crypto.SHA256)
	if err != nil {
		return fmt.Errorf("build verifier: %w", err)
	}
	checkOpts := &cosign.CheckOpts{
		SigVerifier:        verifier,
		RegistryClientOpts: []remote.Option{remote.WithContext(ctx)},
	}
	allContainers := append(pod.Spec.InitContainers, pod.Spec.Containers...)
	for _, c := range allContainers {
		ref, parseErr := name.ParseReference(c.Image)
		if parseErr != nil {
			return fmt.Errorf("parse image ref %q: %w", c.Image, parseErr)
		}
		if _, _, verifyErr := cosign.VerifyImageSignatures(ctx, ref, checkOpts); verifyErr != nil {
			return fmt.Errorf("image %q has no valid organization signature: %w", c.Image, verifyErr)
		}
		logger.Info("image signature valid", "image", c.Image)
	}
	return nil
}

func writeReview(w http.ResponseWriter, resp *admissionv1.AdmissionResponse) {
	review := admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "admission.k8s.io/v1",
			Kind:       "AdmissionReview",
		},
		Response: resp,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(review)
}
```

### SBOM Generation and SLSA Attestation

Software Bill of Materials (SBOM) documents every dependency in a container image. SLSA (Supply-chain Levels for Software Artifacts) defines four levels of provenance attestation. SLSA 3 is the enterprise baseline.

```yaml
# .github/workflows/sbom-slsa.yaml
name: SBOM and SLSA Attestation
on:
  push:
    branches: [main]

jobs:
  attest:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Build and push image
        id: build
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/acme/shopapp:${{ github.sha }}

      - name: Generate SBOM with Syft
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/acme/shopapp:${{ github.sha }}
          format: spdx-json
          output-file: sbom.spdx.json

      - name: Attest SBOM with Cosign
        run: |
          cosign attest --yes \
            --predicate sbom.spdx.json \
            --type spdxjson \
            ghcr.io/acme/shopapp@${{ steps.build.outputs.digest }}

      - name: Sign image (keyless Sigstore)
        run: |
          cosign sign --yes \
            ghcr.io/acme/shopapp@${{ steps.build.outputs.digest }}

      - name: Generate SLSA Level 3 provenance
        uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v1.9.0
        with:
          image: ghcr.io/acme/shopapp
          digest: ${{ steps.build.outputs.digest }}
          registry-username: ${{ github.actor }}
        secrets:
          registry-password: ${{ secrets.GITHUB_TOKEN }}
```

Verifying attestations at deploy time:

```bash
# Verify image signature
cosign verify \
  --certificate-identity-regexp="https://github.com/acme/shopapp/.github/.*" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/acme/shopapp@sha256:<digest>

# Verify SBOM attestation
cosign verify-attestation \
  --type spdxjson \
  --certificate-identity-regexp="https://github.com/acme/shopapp/.github/.*" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/acme/shopapp@sha256:<digest>
```

### Audit Trail - ArgoCD Notification Webhook

Every sync event (success or failure) is forwarded to the organization's audit service for long-term retention and SIEM correlation.

```yaml
# argocd-notifications-cm patch
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-notifications-cm
  namespace: argocd
data:
  service.webhook.audit-log: |
    url: https://audit.acme.internal/api/v1/events
    headers:
      - name: Authorization
        value: $audit-log-token
      - name: Content-Type
        value: application/json
  template.audit-sync-event: |
    webhook:
      audit-log:
        method: POST
        body: |
          {
            "event": "{{.app.status.operationState.phase}}",
            "application": "{{.app.metadata.name}}",
            "environment": "{{.app.metadata.labels.environment}}",
            "revision": "{{.app.status.operationState.syncResult.revision}}",
            "syncedAt": "{{.app.status.operationState.finishedAt}}",
            "triggeredBy": "{{.app.status.operationState.operation.initiatedBy.username}}"
          }
  trigger.on-sync-succeeded: |
    - when: app.status.operationState.phase in ['Succeeded']
      send: [audit-sync-event]
  trigger.on-sync-failed: |
    - when: app.status.operationState.phase in ['Failed', 'Error']
      send: [audit-sync-event]
```

The audit record links: Git commit SHA (who wrote what code), merge PR number (who approved), ArgoCD sync event (who triggered deploy, when), and pod start time (when it reached production). This chain satisfies SOC 2 Type II and PCI-DSS 4.0 change management requirements without any additional tooling.

### Junior → FAANG: Why Supply Chain Security Matters Now

Supply chain security moved from a theoretical concern to a production requirement after the SolarWinds breach in 2020 and the Log4Shell vulnerability in 2021. Both demonstrated that attackers target the build and delivery pipeline, not just the running application. Understanding why signed commits and image signatures exist is now part of basic platform literacy.

The chain of custody that this section builds: the developer identity is verified at commit time by Gitsign (using their OIDC token from GitHub), the built image is signed by the CI pipeline (using the GitHub Actions OIDC token, verifiable against Fulcio), and the admission webhook verifies the image signature before any pod is scheduled. Breaking any link in this chain triggers a rejection: an unsigned commit cannot be merged if branch protection requires verified signatures, and an unsigned image cannot be scheduled if the admission webhook is running. This is defense in depth applied to the deployment pipeline.

For a first implementation, start with OPA/Gatekeeper policies before tackling Cosign image signing. The Gatekeeper constraint for approved image registries prevents the most common supply chain risk (pulling untrusted images) with minimal operational complexity. Add image signing after the registry policy is in place and enforced.

### Senior @ FAANG: Supply Chain Security as a Regulatory Requirement Landscape

At L6, supply chain security is an organizational compliance concern with specific regulatory mapping. NIST SP 800-218 (SSDF), Executive Order 14028 (US federal contractors), and the EU Cyber Resilience Act all have provisions that map to the technical controls in this section. The ability to trace a running container back to a specific developer commit with a verified identity satisfies the provenance requirements of SLSA Level 3 and several NIST controls.

The SLSA attestation workflow is the most forward-looking element in this section. SLSA (Supply-chain Levels for Software Artifacts) defines four levels, with Level 3 requiring: the build process is isolated from other builds (GitHub Actions ephemeral runners), the build provenance includes the exact source commit and build parameters (captured by the SLSA GitHub generator action), and the provenance is signed by the build platform's identity (GitHub Actions OIDC token). Level 4, which requires hermetic, reproducible builds, is not yet widely achieved in practice and requires investment in reproducible build tooling.

The OPA Gatekeeper policy for approved image registries is a mutation-prevention control. It is most effective when combined with immutable image tags: enforcing that production images are referenced by digest (`@sha256:...`) rather than by mutable tag prevents the scenario where an attacker who has write access to the registry pushes a malicious image with the same tag that a legitimate image previously used. Digest pinning, enforced at the admission layer, eliminates this attack vector entirely. Platform teams should consider adding a Gatekeeper mutation webhook that automatically resolves image tags to digests at admission time, making digest pinning transparent to application teams.

The ArgoCD AppProject `signatureKeys` field for enforcing signed commits is underused in practice. Most organizations stop at branch protection with required reviewers, which prevents unsigned commits from merging via the GitHub UI but does not prevent commits pushed with `--force` by anyone with push access. The `signatureKeys` enforcement in ArgoCD adds a second verification layer: even if a commit makes it into the main branch somehow, ArgoCD will refuse to sync it if it is not signed by a recognized key. This is the defense-in-depth principle applied to the GitOps control plane.

---
