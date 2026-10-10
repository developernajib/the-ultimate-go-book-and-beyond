## 97.5 Security Best Practices

### Non-Root User

By default, processes inside a Docker container run as the root user (UID 0), which means that if an attacker exploits a vulnerability in your application, they gain root-level access inside the container. Running as a non-root user is one of the simplest and most effective security hardening steps you can take. The `USER` instruction in a Dockerfile tells Docker to run all subsequent commands as the specified user instead of root.

```dockerfile
# Option 1: Using scratch with numeric user
FROM scratch
USER 65534:65534  # nobody user
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]

# Option 2: Using alpine with created user
FROM alpine:3.19
RUN addgroup -g 1000 appgroup && \
    adduser -u 1000 -G appgroup -D appuser
USER appuser:appgroup
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

### Security Scanning

Container images can contain known vulnerabilities inherited from their base images or installed packages. Security scanning tools like Docker Scout and Trivy analyze your image layers and report any known CVEs (Common Vulnerabilities and Exposures). You should also use a `.dockerignore` file to prevent sensitive files like private keys, environment files, and git history from being included in the build context, where they could accidentally end up baked into your image.

```dockerfile
# .dockerignore - Exclude sensitive files
.git
.env
*.pem
*.key
secrets/
credentials/
```

```bash
# Scan image for vulnerabilities
docker scout cves myapp:latest

# Or use trivy
trivy image myapp:latest
```

### Read-Only Filesystem

A read-only filesystem prevents any process inside the container from writing to the container's filesystem. This blocks many types of attacks where an attacker tries to drop malicious files, modify configuration, or install backdoors. If your application needs to write temporary files, you can mount a `tmpfs` volume (stored only in memory) at `/tmp` while keeping the rest of the filesystem locked down.

```yaml
# docker-compose.yml
services:
  app:
    image: myapp:latest
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
```

---

### Junior → FAANG: Security Controls Every Go Developer Must Apply

The non-root user rule is the most commonly skipped and most important control in a Dockerfile. Containers run as root by default, which means a process escape gives the attacker root on the container filesystem and potentially on the host. Adding `USER nonroot:nonroot` (or a numeric UID like `65532` used by distroless images) is a one-line change that significantly reduces blast radius.

The other gap newcomers miss is the read-only root filesystem. Most Go binaries do not need to write to the filesystem at runtime. Adding `--read-only` to `docker run` or `readOnlyRootFilesystem: true` in a Kubernetes pod spec means that if an attacker achieves code execution, they cannot write payloads or persist changes. If your application genuinely needs to write temporary files, mount a specific `tmpfs` volume for that directory only.

First-job habit: run a container security scanner on your image before every push. `trivy image <name>` or `docker scout cves <name>` will report known CVEs in the base image and installed packages. Being able to categorize findings (critical/high versus informational) and explain why a given CVE is or is not exploitable in your specific configuration is a basic security literacy requirement.

### Senior @ FAANG: Container Security Posture as a Platform Contract

At staff level, container security is not a checklist for individual teams. It is a platform contract enforced through admission control and continuous compliance scanning. The three enforcement layers are: image build policy (enforced in CI via conftest or custom linters), registry admission (only signed images from approved registries are accepted), and runtime enforcement (admission controller blocks pods that violate security policies).

The specific controls that should be enforced at the platform layer rather than left to teams: non-root UID, read-only root filesystem, no privileged containers, no host network/pid/ipc namespaces, capability dropping (drop ALL, add back only what is explicitly needed), and seccomp profile (use the default Docker/Kubernetes profile or a stricter custom profile for sensitive workloads).

Vulnerability management at scale requires a process, not just a scanner. A scanner that finds 400 CVEs and has no process to triage, assign, and track remediation is noise. The platform team responsibility is to define severity thresholds (block on critical, warn on high), own the base image update pipeline (automated PRs when a new base image with fewer CVEs is available), and track mean-time-to-remediation as an organizational metric. At FAANG, this often involves integrating with a centralized security platform (internal or commercial) that aggregates findings across all images in all registries. The staff engineer role is to design the integration and own the process, not to triage every CVE individually.
