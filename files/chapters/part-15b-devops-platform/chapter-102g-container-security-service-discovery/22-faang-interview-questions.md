## 102G.20 FAANG Interview Questions: Container Security & Service Discovery

### Q1 (Amazon, L6): Design a supply-chain security program for container images.

SLSA level 3 target. Build on ephemeral runners, sign with Sigstore Cosign keyed to OIDC identity, attest SBOM via in-toto, scan with Trivy or Grype at push and on a daily rescan of the registry. Admission controller verifies signature and SBOM before the pod starts. Block base images older than 30 days.

### Q2 (Google, L5): Runtime threat detection in Kubernetes. What do you use and why?

Falco for syscall-level rules, backed by eBPF for low-overhead capture. Tetragon for fine-grained policy enforcement when you need in-kernel blocking, not just alerting. Forward events to a SIEM. alone they are noise. The real win is mapping rules to MITRE ATT&CK so detections have investigative context.

### Q3 (Meta, E6): Client-side vs server-side service discovery. Choose for a 10k-service mesh.

Server-side via mesh sidecars or ambient mode. Client-side libraries fragment across languages, hide failure modes, and couple application releases to discovery changes. A mesh gives consistent mTLS, retries, and telemetry without per-language effort. The tradeoff is operational complexity, which a platform team absorbs.

### Q4 (Netflix, Senior): mTLS rollout across legacy services without downtime.

Permissive mode first (accept mTLS and plaintext), measure coverage, then flip to strict per namespace. Automate certificate rotation via SPIFFE/SPIRE or the mesh CA. Keep an out-of-band break-glass path. Never do a big-bang cutover. Stage by blast radius.

### Q5 (Apple, ICT5): Distroless vs Alpine vs scratch for Go binaries.

Scratch for static binaries when you do not need TLS root certs or timezone data. Distroless when you need those without a shell. Alpine only if you truly need a package manager at runtime, which you usually do not. Smaller image equals smaller CVE surface and faster pull, both measurable wins.

---

### Junior → FAANG: Using These Questions to Calibrate Your Preparation

These five questions are real-world signals of what L5/L6 bars look like at specific companies. The answers are intentionally terse because the interviewer is testing whether you can produce that level of structured, precise thinking, not whether you can recite a longer essay.

Q1 (Amazon L6): the answer names specific levels, tools, and timelines. "SLSA 3, Cosign, in-toto, Trivy, 30-day base image age limit" is the structure. If your answer to a supply-chain question is "we use security scanning," you are at L4. If it is "SLSA 2, Cosign keyless signing, Trivy with daily rescan, admission controller enforcement," you are at L5. If it adds SBOM attestation, MITRE ATT&CK mapping, and specific thresholds, you are at L6.

Q5 (Apple ICT5): the decision tree here is the interview answer structure. Start with the most restrictive option (scratch), name the specific conditions that prevent it (no TLS certs, no timezone data), name the fallback (distroless), and name the condition for the least restrictive option (Alpine: only if package manager needed at runtime). This decision-tree structure, knowing when each option is appropriate and when it is not, is what distinguishes a design answer from a preference answer.

First-job preparation: before your interview, be able to answer Q4 (mTLS rollout without downtime) with a concrete phase list. "Permissive mode, measure coverage, flip to strict per namespace, keep break-glass path, never big-bang cutover" is the structure. Memorize the phases. The ability to name a migration strategy without hesitation signals operational experience.

### Senior @ FAANG: What the Interviewers Are Listening For Behind These Answers

For Q1 (Amazon L6 supply chain design), the bar-raiser follow-ups probe three dimensions: governance (who approves exceptions to the 30-day base image age limit), failure modes (what happens when Sigstore's Rekor transparency log is unavailable and the admission controller cannot verify the signature), and organizational scaling (how does this program work for 500 services across 50 teams, not 5 services on one team). A candidate who gives the technical answer without the governance and failure mode dimensions is at L5. An L6 candidate addresses all three without being asked.

For Q2 (Google L5 runtime detection), the MITRE ATT&CK mapping comment is the detail that signals operational maturity. Rules without ATT&CK mapping produce alerts that responders do not know how to investigate. "Shell spawned in container" without ATT&CK context could be T1059 (Command and Scripting Interpreter) or T1609 (Container Administration Command) depending on how it was triggered. The mapping tells the responder which technique to look for in the broader incident context. Knowing this signals that you have written detection rules that people actually used to investigate incidents, not just rules that generated noise.

For Q3 (Meta E6 service mesh), the answer "a platform team absorbs the operational complexity" is the L6/L7 framing. It signals that you think at the organizational level (who owns this, how do product teams interact with it) rather than just the technical level (how does the sidecar proxy work). At E6/L7, every architectural choice includes an implicit answer to "who owns this in production" and "how do 50 product teams use this without needing to understand its internals."

For Q4 (Netflix Senior mTLS rollout), "stage by blast radius" is the key phrase. Blast radius staging means: start with namespaces where a rollout failure affects the fewest users and the least revenue. A batch processing namespace has lower blast radius than the payment processing namespace. Rollout order is determined by blast radius, not by technical readiness. This operational judgment, weighing technical feasibility against business risk, is what senior engineers demonstrate that junior engineers do not.

