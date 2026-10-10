## Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Not setting `UidMappings` in user namespace | Root inside = root outside (dangerous) | Always map container root to non-root host UID |
| Mounting /proc outside PID namespace | Leaks host process info | Mount /proc after entering PID namespace |
| Not using `CLONE_NEWPID` | Container processes visible in host | Always use PID namespace |
| Forgetting work dir for overlay | overlayfs mount fails | workdir and upperdir must be on same filesystem |
| Not deleting cgroup after exit | Cgroup leaks | Defer `cgroup.Delete()` after container exits |
| Writing to lowerdir in overlay | Corrupts image layer | Upper dir is always writable, lower is read-only |
| No seccomp profile | Container can use any syscall | Apply default seccomp profile before exec |
| Keeping CAP_SYS_ADMIN | Full container escape possible | Drop all caps except minimal required set |

### Junior → FAANG: Internalizing Container Mistakes Through Deliberate Practice

The common mistakes table is a compressed incident history: each row represents a class of production failures that engineers have caused, diagnosed, and learned from. The most impactful habit is to reproduce each mistake in a controlled environment before encountering it in production. Create a container with `CAP_SYS_ADMIN`, try a container escape proof-of-concept (the infamous `cdk` tool has examples), and understand what the escape looks like. Then re-run with capabilities dropped and verify the escape fails. This deliberate practice converts abstract security knowledge into concrete, memorable experience.

The cgroups-without-limits mistake is subtle because containers run correctly at low load and only fail when resource pressure appears. Develop the habit of always setting `requests` and `limits` in Kubernetes pod specs, and verify with `kubectl get pod -o json | jq '.spec.containers[].resources'` that both are set for all containers in all pods in your services. A container without limits can consume unbounded memory and cause OOM kills in other pods on the same node, which is a noisy neighbor incident that is hard to attribute to its cause.

The PID namespace sharing mistake (running with `hostPID: true` when not needed) is a common misconfiguration in debugging runbooks that get committed to deployment manifests. Use admission controllers to detect and alert on pods that use host-level settings (`hostPID`, `hostNetwork`, `hostIPC`) without an approved annotation. Make the approval process explicit: engineers must add a specific annotation with a justification, and the admission controller validates that the annotation is present and that the requesting team has the appropriate permission.

### Senior @ FAANG: Systematic Prevention of Container Security Mistakes

The common mistakes table defines the scope of what admission controllers must prevent. At FAANG, no production pod reaches a cluster node without passing through an admission webhook that validates: no containers running as root (unless explicitly approved), no dangerous capabilities, seccomp profile present, no host namespace sharing (unless approved), resource requests and limits set, and read-only root filesystem (unless a writable path is explicitly declared as a volume). This policy as code is maintained in a `kyverno` or OPA Gatekeeper policy repository with the same rigor as application code: reviewed, tested, and versioned.

The "container is not a VM" mistake has an organizational dimension beyond the technical one. Engineers who treat containers as VMs build images with multiple processes, init systems, and SSH daemons. These images are harder to scan for CVEs, harder to restart correctly (PID 1 is init, not the application, so application crashes are masked), and larger than necessary (carrying init system dependencies). The platform team addresses this through onboarding documentation, build system lint rules that warn on common anti-patterns (detecting `FROM ubuntu` with subsequent `RUN apt-get install ssh`), and image review guidelines for teams that are new to container-native architectures.

The capability retention mistake (`CAP_SYS_ADMIN` in particular) is often a historical accident: an engineer granted the capability to debug an issue three years ago and never removed it. Platform teams run quarterly capability audits: for every production workload, query the running pod specs, extract capability lists, and compare against the documented justification in the team's runbook. Workloads with undocumented capabilities receive a remediation request. Automating this audit with a Kubernetes controller that watches for pods with undocumented capabilities and creates Jira tickets is L6-level platform work that converts a quarterly manual process into a continuous automated one.

---

---
