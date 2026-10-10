## 102D.21 Enterprise GitOps Governance, RBAC & Audit Trails

Security in GitOps is multi-layered: securing the Git repository itself (signed commits, branch protection), securing what gets deployed (policy-as-code), securing secret delivery (External Secrets Operator), and maintaining an immutable audit trail.

### Signed Commits with Gitsign

Gitsign uses Sigstore's keyless signing - no GPG key management required. Identity is derived from OIDC tokens (GitHub Actions, Google Workload Identity, etc.). Every commit to the manifests repository must be cryptographically signed.

```bash
# Install gitsign
brew install sigstore/tap/gitsign

# Configure git to use gitsign
git config --global gpg.x509.program gitsign
git config --global gpg.format x509
git config --global commit.gpgsign true
```

```yaml
# .github/workflows/verify-signatures.yaml
name: Verify Commit Signatures
on:
  push:
    branches: [main]
    paths: ["applications/**", "clusters/**"]

permissions:
  id-token: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 20

      - name: Install gitsign
        run: |
          curl -sSfL \
            https://github.com/sigstore/gitsign/releases/latest/download/gitsign_linux_amd64 \
            -o /usr/local/bin/gitsign && chmod +x /usr/local/bin/gitsign

      - name: Verify recent commits are signed
        run: |
          git log --format="%H" -10 | while read sha; do
            gitsign verify \
              --certificate-identity-regexp=".*@github.com" \
              --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
              "$sha" || { echo "UNSIGNED COMMIT: $sha"; exit 1; }
          done
```

### Policy-as-Code with OPA/Conftest

Conftest runs OPA policies against Kubernetes manifests in CI, blocking non-compliant deployments before they ever reach ArgoCD.

```rego
# policy/kubernetes/security.rego
package kubernetes.security

import future.keywords.if
import future.keywords.in

# All Deployments must have required labels for observability and cost attribution
deny[msg] if {
    input.kind == "Deployment"
    required := {"app", "team", "environment", "version"}
    provided := {k | input.metadata.labels[k]}
    missing := required - provided
    count(missing) > 0
    msg := sprintf(
        "Deployment '%s' is missing required labels: %v",
        [input.metadata.name, missing]
    )
}

# Containers must not run as root
deny[msg] if {
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[_]
    container.securityContext.runAsUser == 0
    msg := sprintf(
        "Container '%s' in Deployment '%s' must not run as root",
        [container.name, input.metadata.name]
    )
}

# Memory limits are mandatory - prevent noisy-neighbor OOM scenarios
deny[msg] if {
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[_]
    not container.resources.limits.memory
    msg := sprintf(
        "Container '%s' in Deployment '%s' must have memory limits",
        [container.name, input.metadata.name]
    )
}

# CPU limits are mandatory
deny[msg] if {
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[_]
    not container.resources.limits.cpu
    msg := sprintf(
        "Container '%s' in Deployment '%s' must have CPU limits",
        [container.name, input.metadata.name]
    )
}

# Readiness probes are mandatory - without them, failing pods receive traffic
deny[msg] if {
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[_]
    not container.readinessProbe
    msg := sprintf(
        "Container '%s' in Deployment '%s' must define a readinessProbe",
        [container.name, input.metadata.name]
    )
}
```

```rego
# policy/kubernetes/images.rego
package kubernetes.images

import future.keywords.if

approved_registries := {
    "registry.example.com",
    "gcr.io/example-project",
    "public.ecr.aws/example"
}

# Images must come from approved registries only
deny[msg] if {
    input.kind == "Deployment"
    container := input.spec.template.spec.containers[_]
    parts := split(container.image, "/")
    registry := parts[0]
    not approved_registries[registry]
    msg := sprintf(
        "Container '%s' uses unapproved registry '%s'",
        [container.name, registry]
    )
}

# The 'latest' tag is forbidden in production - use immutable tags
deny[msg] if {
    input.kind == "Deployment"
    input.metadata.labels.environment == "production"
    container := input.spec.template.spec.containers[_]
    endswith(container.image, ":latest")
    msg := sprintf(
        "Container '%s' uses ':latest' tag - forbidden in production",
        [container.name]
    )
}

# Production images should be pinned to digests for true immutability
warn[msg] if {
    input.kind == "Deployment"
    input.metadata.labels.environment == "production"
    container := input.spec.template.spec.containers[_]
    not contains(container.image, "@sha256:")
    msg := sprintf(
        "Container '%s' should use digest pinning (@sha256:...) in production",
        [container.name]
    )
}
```

```yaml
# .github/workflows/policy-check.yaml
name: Policy Validation
on:
  pull_request:
    paths: ["applications/**"]

jobs:
  conftest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install conftest
        run: |
          curl -sSfL \
            https://github.com/open-policy-agent/conftest/releases/latest/download/conftest_linux_amd64.tar.gz \
            | tar -xz -C /usr/local/bin conftest

      - name: Install kustomize
        run: |
          curl -sSfL \
            https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh \
            | bash && mv kustomize /usr/local/bin/

      - name: Render all overlays and validate against policies
        run: |
          FAILED=""
          find applications -name "kustomization.yaml" | while read kfile; do
            dir=$(dirname "$kfile")
            echo "=== Validating: $dir ==="
            kustomize build "$dir" | conftest test - \
              --policy policy/kubernetes \
              --all-namespaces \
              || FAILED=1
          done
          [ -z "$FAILED" ] || exit 1
```

### RBAC for GitOps Repositories

ArgoCD `AppProject` resources provide the RBAC boundary for GitOps access control, restricting which Git repositories, destination clusters, and namespaces each project can target. Roles within a project are expressed as Casbin policy strings and mapped to SSO groups, so permission changes are themselves tracked in Git and subject to the same review process as application manifests. The `syncWindows` field enforces deployment freeze windows at the platform level, preventing any automated or manual sync outside approved change windows.

```yaml
# argocd/projects.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: platform-production
  namespace: argocd
spec:
  description: "Production infrastructure - restricted access"
  sourceRepos:
    - "https://github.com/org/fleet-config"
  destinations:
    - server: "https://k8s.us-east-1.prod.example.com"
      namespace: "*"
    - server: "https://k8s.us-west-2.prod.example.com"
      namespace: "*"
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
    - group: "rbac.authorization.k8s.io"
      kind: ClusterRole
    - group: "rbac.authorization.k8s.io"
      kind: ClusterRoleBinding
  namespaceResourceBlacklist:
    - group: ""
      kind: ResourceQuota
  roles:
    - name: developer-readonly
      description: "Developers can view but not modify production"
      policies:
        - "p, proj:platform-production:developer-readonly, applications, get, platform-production/*, allow"
        - "p, proj:platform-production:developer-readonly, applications, list, platform-production/*, allow"
      groups:
        - org:developers
    - name: sre-deployer
      description: "SREs can sync but not delete applications"
      policies:
        - "p, proj:platform-production:sre-deployer, applications, *, platform-production/*, allow"
        - "p, proj:platform-production:sre-deployer, applications, delete, platform-production/*, deny"
      groups:
        - org:sre-team
    - name: ci-deployer
      description: "CI pipeline automation - full application access"
      policies:
        - "p, proj:platform-production:ci-deployer, applications, *, platform-production/*, allow"
      groups:
        - org:ci-bots
  # No deployments on Friday afternoons (UTC)
  syncWindows:
    - kind: deny
      schedule: "0 16 * * 5"
      duration: 16h
      applications: ["*"]
      manualSync: false
```

### Secrets Management with External Secrets Operator

External Secrets Operator bridges external secret stores with Kubernetes Secrets. The secret value never touches Git - only a path reference does.

```yaml
# external-secrets/cluster-secret-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

```yaml
# applications/shopapp/base/external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: shopapp-secrets
  namespace: shopapp
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: shopapp-secrets      # creates/updates this Kubernetes Secret
    creationPolicy: Owner
    deletionPolicy: Retain
    template:
      engineVersion: v2
      metadata:
        annotations:
          reloader.stakater.com/match: "true"   # auto-restart pods on rotation
      data:
        DATABASE_URL: "{{ .db_host }}:5432/{{ .db_name }}?sslmode=require"
        DATABASE_PASSWORD: "{{ .db_password }}"
        STRIPE_SECRET_KEY: "{{ .stripe_key }}"
        JWT_SIGNING_KEY: "{{ .jwt_key }}"
  data:
    - secretKey: db_host
      remoteRef:
        key: "production/shopapp/database"
        property: host
    - secretKey: db_name
      remoteRef:
        key: "production/shopapp/database"
        property: name
    - secretKey: db_password
      remoteRef:
        key: "production/shopapp/database"
        property: password
    - secretKey: stripe_key
      remoteRef:
        key: "production/shopapp/stripe"
        property: secret_key
    - secretKey: jwt_key
      remoteRef:
        key: "production/shopapp/jwt"
        property: signing_key
```

### Audit Trail for All Deployments

Every deployment event must be recorded in a tamper-evident audit log. The following Go service receives ArgoCD notification webhooks and persists structured, HMAC-verified records.

```go
// audit/argocd_webhook.go
package audit

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"

    "go.uber.org/zap"
)

// SyncEvent represents an ArgoCD application sync notification payload.
type SyncEvent struct {
    Application  string    `json:"application"`
    Namespace    string    `json:"namespace"`
    Environment  string    `json:"environment"`
    Cluster      string    `json:"cluster"`
    Revision     string    `json:"revision"`
    SyncStatus   string    `json:"syncStatus"`
    HealthStatus string    `json:"healthStatus"`
    TriggeredBy  string    `json:"triggeredBy"` // "automated" or a username
    SyncedAt     time.Time `json:"syncedAt"`
    Images       []string  `json:"images"`
    Message      string    `json:"message"`
}

// AuditRecord is the immutable log entry written to the audit store.
type AuditRecord struct {
    ID         string            `json:"id"`
    EventType  string            `json:"eventType"`
    SyncEvent  SyncEvent         `json:"syncEvent"`
    RecordedAt time.Time         `json:"recordedAt"`
    Checksum   string            `json:"checksum"` // HMAC-SHA256 for tamper detection
    Metadata   map[string]string `json:"metadata"`
}

// AuditStore defines persistence for audit records.
type AuditStore interface {
    Write(ctx context.Context, record AuditRecord) error
    Query(ctx context.Context, filter AuditFilter) ([]AuditRecord, error)
}

// AuditFilter specifies query criteria.
type AuditFilter struct {
    Application string
    Environment string
    Cluster     string
    Since       time.Time
    Until       time.Time
    Limit       int
}

// WebhookHandler handles ArgoCD notification webhooks and writes audit records.
type WebhookHandler struct {
    store      AuditStore
    logger     *zap.Logger
    hmacSecret []byte
}

// NewWebhookHandler creates a new WebhookHandler.
func NewWebhookHandler(store AuditStore, logger *zap.Logger, hmacSecret []byte) *WebhookHandler {
    return &WebhookHandler{store: store, logger: logger, hmacSecret: hmacSecret}
}

// ServeHTTP handles incoming ArgoCD sync notifications.
func (h *WebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
    if err != nil {
        h.logger.Error("failed to read webhook body", zap.Error(err))
        http.Error(w, "failed to read body", http.StatusBadRequest)
        return
    }
    defer r.Body.Close()

    // Verify HMAC signature - reject unsigned or tampered payloads
    if !h.verifySignature(body, r.Header.Get("X-Argo-Signature")) {
        h.logger.Warn("webhook signature verification failed",
            zap.String("remote_addr", r.RemoteAddr))
        http.Error(w, "invalid signature", http.StatusUnauthorized)
        return
    }

    var event SyncEvent
    if err := json.Unmarshal(body, &event); err != nil {
        h.logger.Error("failed to parse sync event", zap.Error(err))
        http.Error(w, "invalid event payload", http.StatusBadRequest)
        return
    }

    record := h.buildAuditRecord(event)

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    if err := h.store.Write(ctx, record); err != nil {
        h.logger.Error("failed to write audit record",
            zap.String("application", event.Application),
            zap.Error(err))
        http.Error(w, "audit write failed", http.StatusInternalServerError)
        return
    }

    h.logger.Info("deployment audited",
        zap.String("id", record.ID),
        zap.String("application", event.Application),
        zap.String("environment", event.Environment),
        zap.String("revision", event.Revision),
        zap.String("status", event.SyncStatus),
        zap.String("triggered_by", event.TriggeredBy),
    )

    w.WriteHeader(http.StatusAccepted)
}

func (h *WebhookHandler) buildAuditRecord(event SyncEvent) AuditRecord {
    now := time.Now().UTC()
    record := AuditRecord{
        ID:         fmt.Sprintf("%s-%d", event.Application, now.UnixNano()),
        EventType:  "deployment.sync",
        SyncEvent:  event,
        RecordedAt: now,
        Metadata:   map[string]string{"schema_version": "1.0"},
    }
    // Compute tamper-evident checksum over the full record
    data, _ := json.Marshal(record)
    record.Checksum = h.computeHMAC(data)
    return record
}

func (h *WebhookHandler) verifySignature(body []byte, sig string) bool {
    return hmac.Equal([]byte(h.computeHMAC(body)), []byte(sig))
}

func (h *WebhookHandler) computeHMAC(data []byte) string {
    mac := hmac.New(sha256.New, h.hmacSecret)
    mac.Write(data)
    return hex.EncodeToString(mac.Sum(nil))
}
```

### Junior → FAANG: Building a Security Instinct for GitOps

The most important security concept to internalize early is that Git history is permanent. A plaintext secret committed and immediately reverted is still present in every `git clone` and in GitHub's reflog. This is not recoverable by deleting the file. The organizational response is to rotate the secret, audit every clone for exposure, and add a pre-commit hook running `gitleaks` so the mistake cannot happen again. At entry level, the habit to build is treating every credential as compromised the moment it touches version control, without exception.

The Conftest policy layer is where many juniors underinvest. Writing a policy that denies `runAsUser: 0` is straightforward, but the valuable habit is understanding why: a container running as root inside a pod can potentially escape the container runtime in certain kernel vulnerability scenarios, and it definitely has broader access to mounted volumes and host path mounts than a non-root process. Knowing the motivation behind a policy makes you a better reviewer and helps you write the next policy without guidance.

Entry-level interview framing: when asked about GitOps security, structure your answer in layers. First, who can commit to the manifests repository (branch protection, signed commits). Second, what can be committed (policy-as-code CI gates). Third, what ArgoCD is allowed to deploy (AppProject RBAC and sync windows). Fourth, how secrets reach the cluster (External Secrets Operator). Interviewers reward structured thinking over recall.

### Senior @ FAANG: Security as a Platform Property, Not a Team Responsibility

At staff and principal level, the insight is that security controls in a GitOps environment must be structural rather than procedural. Procedural security means telling teams "never commit secrets" and trusting them to comply. Structural security means making secret commits technically impossible: a required CI check running `gitleaks` that blocks merges, combined with branch protection that prevents force-pushes to bypass the check, combined with CODEOWNERS requiring a platform team review for any change to security-relevant manifests. When the correct behavior is the only behavior available, compliance is guaranteed without enforcement overhead.

The AppProject design is a governance primitive that deserves the same rigor as IAM role design. Each AppProject defines a bounded deployment capability: specific source repositories, specific destination clusters and namespaces, specific resource kinds. A team whose AppProject permits only `Deployment`, `Service`, and `ConfigMap` in their namespaces cannot accidentally or maliciously create a `ClusterRole` or modify a `NetworkPolicy` belonging to a neighboring team. Designing AppProjects with minimum necessary permissions, reviewed annually as team ownership changes, is a staff-level platform responsibility.

The audit webhook pattern in this chapter is the technical foundation for a compliance control, but the governance model around it matters as much as the implementation. Audit records are only valuable if they are queryable, retained for the required period (typically one to seven years depending on the regulatory framework), protected from modification by the teams being audited, and integrated into an incident response process. At L6, the question to answer is not "are we logging deployments?" but "can our security team reconstruct the exact cluster state at any point in the past, identify who authorized each change, and prove no unauthorized changes occurred between audits?" The HMAC checksum in the webhook implementation is one piece of a tamper-evident chain that also requires immutable log storage (S3 with Object Lock, CloudWatch Logs with no-delete policy, or a WORM-compliant SIEM).

Sync windows are the deployment freeze mechanism, but their design reveals organizational maturity. A blanket Friday-to-Monday deny window is a blunt instrument that prevents legitimate emergency deployments during an incident. The mature model layers sync windows: a broad automated-sync deny during non-business hours, combined with an allow window for emergency manual syncs that requires a named approver in the annotation and generates a high-priority audit event. This preserves the deployment freeze guarantee while creating a structured break-glass path that is itself auditable. Designing this model for a regulated environment, documenting the exception process, and getting it approved by the compliance team is a concrete L6 platform engineering deliverable.

---
