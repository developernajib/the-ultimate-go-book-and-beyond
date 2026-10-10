## 102G.19 Advanced Interview Questions

---

**Q16: What is the principle of least privilege and how do you apply it to containers?**

Least privilege means a process is granted only the permissions it needs to perform its function - nothing more. For containers this translates to: (1) **User**: run as a non-root user (`runAsNonRoot: true`, `runAsUser: 1000`). (2) **Capabilities**: drop all Linux capabilities (`drop: [ALL]`) and add back only what is strictly needed - a web server needs nothing. (3) **Filesystem**: use `readOnlyRootFilesystem: true` and only mount specific writable `emptyDir` volumes for temp files. (4) **Network**: default-deny NetworkPolicy, allow only required egress destinations. (5) **Secrets**: use projected service account tokens with audience scoping, not broad cluster-admin credentials. (6) **Service account**: bind a dedicated ServiceAccount with only the RBAC roles it needs - not `default` which may have inherited permissions. Audit with `kubectl auth can-i --list --as=system:serviceaccount:mynamespace:myservice`.

---

**Q17: How do you prevent container escape attacks?**

Container escape exploits host kernel vulnerabilities to break out of the container namespace. Defenses: (1) **seccomp**: block dangerous syscalls (`ptrace`, `mount`, `unshare`, `clone` with namespace flags). Use `RuntimeDefault` or a custom seccomp profile. (2) **AppArmor/SELinux**: mandatory access control that restricts what the process can access on the host. (3) **No privileged mode**: never use `privileged: true` - it grants full host access. (4) **No hostPID/hostNetwork/hostIPC**: these share host namespaces and are almost always unnecessary. (5) **No write to sensitive host mounts**: never mount `/`, `/proc`, `/sys`, `/dev` with write access. (6) **Use gVisor or Kata Containers**: provide a strong isolation boundary by running containers in a VM or a user-space kernel. For workloads running untrusted code (multi-tenant SaaS, CI runners), `gVisor` (`runtimeClassName: gvisor`) adds a user-space kernel that intercepts all syscalls before they reach the host kernel.

---

**Q18: What is a software supply chain attack and how do you prevent it?**

A supply chain attack compromises software before it reaches the end user - by injecting malicious code into a dependency, the build system, or the distribution channel, rather than attacking the deployed application directly. Examples: SolarWinds (2020) modified the build process to insert a backdoor into a software update. XZ Utils (2024) backdoored a compression library via a compromised open-source contributor. Codecov (2021) a CI/CD tool had its installer script modified. Prevention layers: (1) **Pin dependencies**: use `go.sum` (Go's built-in) and `GONOSUMCHECK` never bypassed. (2) **SLSA provenance**: require SLSA 2+ for all builds - cryptographically verify artifacts came from a known build system. (3) **Image signing**: Cosign + Sigstore. Reject any image without a verified signature at the admission webhook. (4) **SBOM + continuous scanning**: generate SBOMs at build time, scan against CVE databases daily - know when a newly published CVE affects you. (5) **Minimal dependencies**: fewer dependencies = smaller attack surface. (6) **Private module proxy**: `GOPROXY=https://your-proxy` caches and mirrors dependencies, preventing dependency confusion attacks.

---

**Q19: How does Kubernetes NetworkPolicy work internally?**

NetworkPolicy is a Kubernetes API object that defines allowed traffic flows between pods. The API itself does nothing - it is purely declarative. The actual enforcement is implemented by the CNI (Container Network Interface) plugin: Calico, Cilium, Weave Net, etc. Without a CNI that supports NetworkPolicy, the rules are stored in etcd but silently ignored. How Cilium implements it: (1) Cilium assigns each pod an eBPF map entry. (2) When a pod tries to send a packet, the eBPF program on the sending node evaluates the egress NetworkPolicy. (3) When the packet arrives at the destination node, the eBPF program evaluates ingress policy. (4) Both checks must pass. Cilium also supports L7 policies (HTTP method/path, gRPC method) and identity-based policies using SPIFFE IDs rather than IP addresses - more resilient because pod IPs change. Default-deny pattern: apply `policyTypes: [Ingress, Egress]` with empty rules to every namespace, then explicitly allow only what's needed.

---

**Q20: What is SLSA and why does it matter for supply chain security?**

SLSA (Supply-chain Levels for Software Artifacts, pronounced "salsa") is a security framework from Google for evaluating and improving the integrity of software build pipelines. It defines four levels of build integrity: Level 1 requires a documented build process. Level 2 requires that a build service generates signed provenance (a record of what was built, from what source, on what builder). Level 3 requires a hardened build environment - the build worker is ephemeral, has no persistent state, and cannot be modified during the build. Level 4 requires two-party review of all changes and reproducible builds. Why it matters: provenance lets you answer "was this artifact built from the source code I reviewed?" Attackers who compromise a build server can inject code without touching source control. SLSA 2+ provenance proves the artifact was produced by a specific CI job from a specific commit - not modified afterward. In practice: GitHub Actions generates SLSA provenance natively for releases. Cosign attests provenance to the image. Admission webhooks verify the attestation before scheduling.

---

**Q21: How would you secure secrets in a Kubernetes cluster?**

Kubernetes Secrets are base64-encoded (not encrypted) by default and stored in etcd. The layered approach: (1) **Encrypt etcd at rest**: configure `EncryptionConfiguration` with AES-GCM or KMS provider. (2) **External secrets management**: use HashiCorp Vault, AWS Secrets Manager, or GCP Secret Manager as the source of truth. Sync secrets into Kubernetes via External Secrets Operator - the secret value is never committed to Git. (3) **RBAC**: restrict who can `get`/`list` Secrets. Pods should only access Secrets explicitly referenced in their spec. (4) **Never mount secrets as environment variables**: environment variables are visible to all processes, logged by many tools, and dumped by `kubectl describe pod`. Instead, mount secrets as files in a `tmpfs` volume (`medium: Memory`). (5) **Short-lived credentials**: prefer IRSA (IAM Roles for Service Accounts) on AWS or Workload Identity on GCP - the pod gets temporary cloud credentials via OIDC, no long-lived secrets at all. (6) **Audit logging**: enable Kubernetes audit logs filtered to `Secret` resource access - detect any unexpected reads. (7) **Secret rotation**: automate rotation. External Secrets Operator can be configured to poll the secret source on a schedule and update the Kubernetes Secret automatically.

---

**Q22: What is the difference between image scanning and runtime security?**

Image scanning (Trivy, Grype, Snyk) is a static analysis technique performed before or at deployment time. It examines the filesystem layers of a container image, identifies installed packages, and matches them against known CVE databases. It answers: "does this image contain components with known vulnerabilities?" It cannot detect: runtime exploitation, logic vulnerabilities, misconfigurations only visible at runtime, or attacks that inject code after the image is built. Runtime security (Falco, Tetragon, Aqua) monitors what containers actually do while they are running - what processes they spawn, what files they access, what network connections they make. It answers: "is this container behaving as expected?" It catches: zero-day exploits, RCE via application vulnerabilities, insider threats, and container escape attempts - even in fully patched images. The analogy: image scanning is a pre-employment background check. Runtime security is continuous behavioral monitoring once hired. Production requires both: static scanning to maintain baseline hygiene, runtime detection to catch what scanning misses.

---

### Junior → FAANG: Patterns in These Questions and How to Study Them

Questions 16-22 cluster around three themes: least privilege (Q16, Q17), supply chain integrity (Q18, Q20), and secrets management (Q21). Recognizing these themes helps you study efficiently: if you can articulate the principle behind each theme, you can answer variations of these questions that use different wording or different tool names.

For Q16 (least privilege), the practice question to answer out loud before an interview: "show me what a maximally restricted Kubernetes pod spec looks like." Walk through `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, a dedicated ServiceAccount with minimal RBAC, and a default-deny NetworkPolicy. Being able to write this from memory without looking it up is the standard for a senior-track interview.

For Q21 (secrets in Kubernetes), the common interview mistake is stopping at "use Kubernetes Secrets." A senior-track answer must address encryption at rest (EncryptionConfiguration), RBAC on Secret access, External Secrets Operator for vault integration, and short-lived credentials via IRSA. Each of those is a separate layer, and an interviewer asking follow-up questions will probe each layer.

First-job preparation: Q19 (NetworkPolicy internals) is the question that most juniors get partially right but not completely. "NetworkPolicy is enforced by the CNI plugin" is the key fact that is often missing. Know that without a CNI that supports NetworkPolicy (Calico, Cilium, Antrea), your NetworkPolicy resources are stored but silently ignored. Verify your cluster's CNI plugin supports NetworkPolicy before relying on it.

### Senior @ FAANG: Bar-Raiser Extensions on These Questions

After Q17 (container escape prevention), a bar-raiser asks: "your organization runs a multi-tenant Kubernetes cluster where untrusted third-party code runs as containers. What additional isolation do you need beyond standard pod security standards?" The expected answer names gVisor (`runtimeClassName: gvisor`) or Kata Containers (`runtimeClassName: kata-containers`) and explains why seccomp is insufficient for truly untrusted code (seccomp reduces the syscall surface but does not eliminate all kernel attack vectors, gVisor interposes a user-space kernel that eliminates most of them at the cost of performance, Kata containers run each pod in a separate VM for the strongest isolation).

After Q19 (NetworkPolicy internals), a bar-raiser asks: "what is the default behavior of a cluster with no NetworkPolicies, and how do you transition to a default-deny posture without breaking existing services?" The expected answer: no NetworkPolicies means all pod-to-pod traffic is allowed by default. Transitioning to default-deny requires first auditing existing traffic flows (using Cilium Hubble, Istio telemetry, or eBPF-based flow logging), generating NetworkPolicy from observed flows, applying policies in audit mode (if supported by the CNI), verifying no legitimate traffic is blocked, and then enforcing. The migration must be namespace-by-namespace to limit blast radius, starting with new namespaces that have no existing traffic flows.

After Q21 (secrets in Kubernetes), a bar-raiser asks: "how do you handle secret rotation for a high-availability service that has 50 replicas and a zero-downtime requirement?" The expected answer covers: the External Secrets Operator's reconciliation loop updates the Kubernetes Secret when the vault secret changes, pods that read the secret as an environment variable at startup see the old value until restarted, pods that mount the secret as a file and read it at request time can be configured to hot-reload without restart (watch the file path and update the in-memory credential on change), and the rotation procedure includes validation that the new credential is accepted by the external service before the old credential is revoked. The operational failure mode (new credential deployed, old credential revoked, but some pods still have the old credential in memory) is the detail that bar-raisers probe.

