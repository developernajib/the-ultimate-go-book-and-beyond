## 102G.12 Common Mistakes

### 1. Not Scanning Base Images Regularly

Scanning container images only at build time leaves running containers exposed when new CVEs are published against their base layers. Tools like the Trivy Operator integrate with Kubernetes to continuously audit every running image and surface vulnerabilities as native `VulnerabilityReport` resources, so stale images can be identified and rotated without waiting for the next deployment cycle.

```bash
# WRONG: scan only on build, never re-scan running images
# CVE discovered 6 months after build → running containers vulnerable for 6 months

# CORRECT: continuous scanning
# Use Trivy operator (Kubernetes): automatically scans running images and reports
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/trivy-operator/main/deploy/helm/Chart.yaml

# Trivy Operator creates VulnerabilityReport CRDs for each running image
kubectl get vulnerabilityreports -n production
```

### 2. Running as Root Because "It's Easier"

Defaulting to the root user inside a container creates a privilege escalation path if a process is compromised, since root inside the container maps to root on the host kernel. Using a distroless nonroot image enforces a non-privileged UID at the image level itself, so no runtime security policy is needed to prevent accidental root execution.

```dockerfile
# WRONG:
FROM golang:1.27.1
# User is root by default
COPY . .
RUN go build -o server .
CMD ["./server"]

# CORRECT: explicit non-root user
FROM gcr.io/distroless/static-debian12:nonroot
# Already runs as 65532 (nonroot)
COPY --from=builder /server /server
ENTRYPOINT ["/server"]
```

### 3. Mounting Sensitive Host Paths

Mounting the Docker socket or the host root filesystem gives a container unrestricted access to the underlying node, effectively enabling a full container escape. Ephemeral workloads should use `emptyDir` volumes with explicit size limits, while persistent data should be backed by a PersistentVolumeClaim scoped to the namespace.

```yaml
# WRONG: mounting Docker socket gives container full Docker access = container escape
volumes:
  - name: docker-sock
    hostPath:
      path: /var/run/docker.sock  # NEVER do this in production

# WRONG: mounting host root
volumes:
  - name: host-root
    hostPath:
      path: /  # complete container escape

# CORRECT: use emptyDir for ephemeral storage, PVC for persistent storage
volumes:
  - name: cache
    emptyDir:
      medium: Memory
      sizeLimit: 100Mi
```

### 4. Secrets in Environment Variables

Environment variables are trivially readable through `docker inspect`, the `/proc` filesystem, and many logging pipelines, making them an unsafe carrier for credentials. Kubernetes `secretKeyRef` injects values at runtime without exposing them in pod specs, and pairing it with an External Secrets Operator keeps the actual secret material in a managed vault entirely outside the cluster.

```dockerfile
# WRONG: secrets visible in process list, docker inspect, pod logs
env:
  - name: DATABASE_URL
    value: "postgres://user:password@host/db"

# CORRECT: mount secret as file or use secretKeyRef
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: password
# Or better: use External Secrets Operator + AWS Secrets Manager
```

### 5. Not Implementing Graceful Deregistration

When a container is killed without deregistering from the service registry, downstream consumers continue receiving its address until the health-check TTL expires, causing failed requests during that window. Catching `SIGTERM` and calling `Deregister` before the HTTP server begins its own graceful shutdown ensures that the registry reflects reality within milliseconds of a pod termination event.

```go
// WRONG: service killed without deregistering from Consul/etcd
// → dead instances remain in registry for TTL duration

// CORRECT: deregister on SIGTERM
func main() {
    registry, _ := consul.NewServiceRegistry("my-service", 8080, logger)
    registry.Register(ctx)

    // Deregister before shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    registry.Deregister()  // remove from service discovery immediately
    // then do HTTP server graceful shutdown
}
```

### 6. Hardcoding Trust Domain in mTLS

Hardcoding a SPIFFE identity string ties the authorization logic to a specific cluster, namespace, and environment name, making multi-cluster deployments and trust-domain migrations painful to execute safely. Externalizing the allowed-callers list as a comma-separated environment variable lets operations teams update access policy at deploy time without touching source code.

```go
// WRONG: hardcoded trust domain prevents multi-cluster or migration
if callerID != "spiffe://myorg.com/ns/prod/sa/payment-service" {
    return errors.New("unauthorized")
}

// CORRECT: configuration-driven allowed callers
allowedCallers := strings.Split(os.Getenv("ALLOWED_CALLERS"), ",")
// spiffe://myorg.com/ns/prod/sa/payment-service,spiffe://myorg.com/ns/staging/sa/payment-service
```

---

### Junior → FAANG: Using the Mistakes List as a Code Review Checklist

These six mistakes are the security code review checklist for any containerized Go service. In your first job, running through this list on every pull request you review is the habit that gets you noticed as a security-conscious engineer.

The highest-impact items to internalize first: mistake 2 (running as root) and mistake 4 (secrets in environment variables) are the two that appear most frequently in junior codebases and are the easiest to catch. If you find a Dockerfile without an explicit non-root user or a pod spec with a plaintext secret value, flag it in review. Every time. Build the habit before the behavior becomes unconscious.

Mistake 5 (graceful deregistration) is the one that most juniors miss because it is not a build-time failure. It manifests as transient 500 errors during deployments that are hard to reproduce and hard to trace without knowing to look at the service registry state. Understanding the connection between SIGTERM handling, registry deregistration, and request failure rates is the operational knowledge that separates engineers who have debugged production incidents from those who have only built features.

Prerequisite gap: mistake 3's comment "NEVER do this in production" for the Docker socket mount needs context. There are legitimate uses (Docker-in-Docker for CI runners) but they require understanding the full security implications. In a shared cluster, the Docker socket gives cluster-admin equivalent access. The rule is: if you do not know exactly why you need it, you do not need it.

### Senior @ FAANG: Mistake Patterns as Organizational Signals

At the staff level, seeing the same mistake repeatedly across multiple services is not a code quality problem. It is a platform problem. The platform is not making the secure path the easy path. Each of these mistakes has a systemic fix that removes the mistake as a decision point for product teams.

Mistake 1 (no continuous scanning) is fixed by deploying the Trivy Operator cluster-wide as a platform component. Product teams do not need to do anything. The platform team operates the scanner, and `VulnerabilityReport` resources are created automatically.

Mistake 2 (running as root) is fixed by the OPA/Gatekeeper constraint that rejects pods without `runAsNonRoot: true`. The constraint enforces the policy at admission time, making it impossible to deploy a root-running container to production namespaces without explicitly overriding the constraint (which requires an exception approval).

Mistake 4 (secrets in environment variables) is fixed by the External Secrets Operator as a platform component, combined with a Gatekeeper constraint that rejects pod specs containing environment variables with names matching a secret pattern (PASSWORD, SECRET, TOKEN, KEY). This makes the wrong approach visibly fail at deploy time.

The pattern: every item on this common mistakes list is either fixable by a platform-level enforcement mechanism (Gatekeeper, platform components) or by a platform-level golden path (pre-configured Helm chart values, golden Dockerfiles). A staff engineer reviewing this list should not think "how do we train engineers to avoid these mistakes" but "how do we make the platform enforce the correct behavior automatically."

The hardcoded trust domain mistake (6) at scale requires a policy management platform, not just environment variables. When you have 200 services each with their own allowed-callers list, the total policy surface is 200 lists to maintain, review, and audit. The platform solution is a centralized policy store (OPA, or a dedicated AuthZ service) where access relationships are declared as data, reviewed as part of a change management process, and audited automatically. A staff engineer proposing this architecture also proposes the tooling that keeps the policy store synchronized with the actual service topology, and alerts when a service calls another service that is not in its declared allowed-callers list.

