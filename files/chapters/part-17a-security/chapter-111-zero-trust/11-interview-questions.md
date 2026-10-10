## 111.10 Interview Questions

These five questions reflect zero-trust topics that appear in FAANG senior and staff engineer loops (Google, Amazon, Meta, Apple, Netflix). Answers target Go 1.27 production systems as of 2026.

### Q1: Design a zero-trust service mesh for 10,000 microservices. How do you bootstrap identity?

**A:** Use SPIFFE/SPIRE with node attestation as the root of trust. Each node proves identity via platform attestation (AWS IID, GCP instance metadata, or Kubernetes PSAT), receives a node SVID, and then issues workload SVIDs to pods through the Workload API over a Unix domain socket. Rotate SVIDs every hour with automatic renewal. Distribute trust bundles via the SPIRE federation API across regions. No long-lived credentials are ever stored in pods or config maps. mTLS is enforced at the sidecar layer (Envoy or native Go gRPC with `tls.Config.GetClientCertificate`).

### Q2: A service receives a valid JWT but you still reject it under zero trust. Why?

**A:** Valid signature is necessary, not sufficient. Zero trust demands: (1) audience matches this service, (2) issuer is in the allow-list for the caller's trust domain, (3) token is not revoked (check CRL or short TTL), (4) the calling workload's SPIFFE ID matches an authorized policy, (5) the request context (path, method, resource) satisfies OPA/Cedar policy evaluation, (6) the caller's mTLS peer certificate chains to the expected SPIRE trust bundle. Any failure rejects the request. Identity is continuously verified, not cached from session start.

### Q3: How would you implement least-privilege for an S3-reading Go service on EKS?

**A:** Use IRSA (IAM Roles for Service Accounts). Create an OIDC provider for the EKS cluster, a Kubernetes service account annotated with an IAM role ARN, and an IAM policy scoped to the specific bucket, prefix, and `s3:GetObject` action only. The AWS SDK v2 auto-discovers the projected service account token at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` and exchanges it via STS `AssumeRoleWithWebIdentity`. No access keys. Add condition keys on `aws:SourceVpce` to prevent token exfiltration.

### Q4: Compare OPA, Cedar, and custom Go policy engines for authorization.

**A:** OPA with Rego is the industry standard, hot-reloadable bundles, rich ecosystem, but Rego has a learning curve and evaluation can be slow at p99. Cedar (AWS) is faster, formally verified, and has simpler syntax, but smaller ecosystem. Custom Go engines win when policies are simple and latency-critical (sub-millisecond), using compiled predicates. Recommendation: OPA for breadth, Cedar for verified correctness, custom Go only when benchmarks prove the tradeoff. Always centralize policy distribution and audit evaluations.

### Q5: How do you detect a compromised workload in a zero-trust mesh?

**A:** Layered detection: (1) SPIRE agent logs anomalous SVID issuance rates, (2) mTLS handshake failures spike when an attacker presents a stolen cert from a wrong node, (3) OPA decision logs flagged when a workload requests resources outside its historical baseline, (4) eBPF-based runtime security (Falco, Tetragon) detects syscall anomalies, (5) network telemetry via Cilium identity-aware flow logs shows unexpected SPIFFE-ID-to-SPIFFE-ID traffic. Response: revoke the SVID via SPIRE registration API, rotate the trust bundle segment, and isolate the node. All actions are automated through a SOAR pipeline.

### Junior → FAANG: Preparing for Zero Trust Interview Questions

These five questions are calibrated to L5/L6 FAANG interviews. For a junior targeting L3/L4, focus on the first two questions (SPIFFE/SPIRE basics, mTLS configuration) and understand the others at a conceptual level.

**Gap to close:** Q5 (detecting a compromised workload) requires knowing the detection mechanisms in a zero-trust mesh. For a junior, the key points are: authentication failures are observable (mTLS handshake failures appear in metrics), authorization decisions are logged (OPA logs can be queried), and runtime anomalies are detectable (Falco or similar tools). You do not need to know the SOAR automation pipeline at L3, but you should be able to describe the detection mechanisms.

**Interview practice:** For each question, draft an answer in writing before the interview. Zero-trust questions require structured, multi-part answers. Writing the answer first forces you to organize your thinking. Then practice delivering it verbally in under 5 minutes. Structured, time-bounded verbal answers are the form FAANG interviewers expect.

### Senior @ FAANG: Using These Questions as Interview Design Templates

These five questions are well-designed interview questions for L5/L6 zero-trust topics. Use them as templates for designing interview questions for your own hiring loops.

**Bar-raising adaptations:** Adapt Q4 (policy engine selection and enforcement) to your specific tech stack: "Given our Go gRPC service and our OPA policies stored in this repository, how would you implement policy enforcement without adding 50ms of latency?" This adaptation tests the same concepts but in a context-specific way that reduces the ability to answer from memorized generic answers.

**Scoring guidance:** For each question, define what a Level 3, Level 5, and Level 7 answer looks like. Level 3: correct but surface-level (describes mTLS as "both sides present certificates"). Level 5: correct and complete (describes the full mTLS configuration in Go `tls.Config`, discusses certificate rotation). Level 7: correct, complete, and organizational (describes how to roll out mTLS across 200 services with minimal disruption, including monitoring and rollback procedures). Having explicit scoring guidance makes interview calibration consistent across interviewers.

---
