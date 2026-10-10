## 102G.1 Container Threat Model

### Attack Surface

Containers shrink but do not eliminate the attack surface of traditional VMs. The threat model for containerized workloads spans four layers: the image (what you ship), the runtime (how it runs), the network (how services communicate), and the host kernel (the shared foundation). Understanding where vulnerabilities live at each layer is the prerequisite for choosing the right defensive control. Image scanning, seccomp profiles, network policies, or RBAC. Rather than applying them uniformly without understanding the actual risk.

```
1. Image vulnerabilities: outdated OS packages, vulnerable app dependencies
   → Mitigation: image scanning (Trivy), minimal base images, regular rebuilds

2. Supply chain attacks: compromised base image, malicious dependency
   → Mitigation: trusted base images, SBOM, image signing (Cosign)

3. Privilege escalation: container running as root, hostPath mounts
   → Mitigation: runAsNonRoot, read-only filesystem, drop capabilities

4. Container escape: exploiting kernel syscall vulnerabilities
   → Mitigation: seccomp (reduce syscall surface), gVisor (user-space kernel)

5. Lateral movement: compromised container reaches other services
   → Mitigation: network policies, mTLS, least-privilege service accounts

6. Secrets exposure: credentials in environment variables, image layers
   → Mitigation: Secrets Manager, never COPY secrets into images

7. Runtime attacks: unexpected process execution, file writes, network connections
   → Mitigation: Falco rules, read-only filesystem, AppArmor
```

---

### Junior → FAANG: Threat Modeling as a Structured Interview Skill

When an interviewer asks "how would you secure this system," they are implicitly asking you to perform a threat model. Walking through the seven threat categories here gives you a repeatable structure: image, supply chain, privilege, escape, lateral movement, secrets, runtime. Cover each layer, name the specific mitigation, and explain why that mitigation addresses that specific threat.

The prerequisite gap most juniors have is conflating "we use Kubernetes" with "we are secure." Kubernetes gives you the primitives (RBAC, network policies, pod security standards) but does not configure them securely by default. An interviewer who asks "what would you add to a default Kubernetes cluster to make it production-ready" is testing whether you know the gap between defaults and a hardened posture.

Entry-point framing: category 6 (secrets exposure) is the most common real-world finding in container security reviews. Juniors frequently check in `.env` files, embed credentials in Docker build args that persist in layer history, or put API keys in environment variables visible to any process in the container. Know these failure modes and their mitigations before any senior-track interview.

First-job habit: when you encounter a new service, grep the Dockerfile and Kubernetes manifests for `ENV`, `ARG`, and `hostPath`. These are the first signals of secrets exposure and privilege escalation risk.

### Senior @ FAANG: Operationalizing the Threat Model Across an Engineering Organization

A threat model written once in a design document is not a threat model. It is a snapshot. At the L6/L7 level, the goal is a living threat model that updates when the system changes and that informs control selection, not just documents it.

The operational pattern that scales is threat modeling as part of the design review process. Every service that handles customer data or has elevated privileges gets a mandatory threat model section in its design doc. The platform security team maintains a library of reusable threat model components (standard microservice threat model, standard database-backed service threat model, standard batch job threat model) that teams adapt rather than building from scratch. This reduces review time and ensures consistent coverage.

For container-specific threats, the most valuable investment at scale is category 4 (container escape) and category 5 (lateral movement), because these are the categories where a single compromised container can affect multiple services or the host. The mitigation stack for container escape requires understanding the kernel attack surface: seccomp reduces the syscall set a container can invoke, gVisor interposes a user-space kernel between the container and the host, and hardware-based isolation (Kata containers) provides the strongest isolation at the highest performance cost. A staff engineer selecting between these must reason about the threat model (what is the realistic adversary capability, what is the cost of a host compromise) and the performance impact (gVisor adds latency, Kata adds cold start time).

Lateral movement mitigation (category 5) is where network policy design and service mesh policy interact. A network policy that restricts pod-to-pod communication to declared service dependencies is most useful because it makes lateral movement require an additional exploit to bypass the policy, not just a compromised credential. The governance question is: who approves network policy changes, and how are changes audited? At FAANG scale, network policy changes go through the same change management process as firewall rule changes in traditional infrastructure, because the blast radius is equivalent.

Bar-raiser signal: candidates who understand that threat models are organizational artifacts (requiring maintenance, ownership, and integration into review processes) rather than technical documents are demonstrating L6 thinking. The technical content of the threat model matters, but the system that keeps it current and actionable is what distinguishes platform engineering from one-off security reviews.
