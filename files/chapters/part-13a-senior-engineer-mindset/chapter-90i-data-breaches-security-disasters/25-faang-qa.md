## FAANG Interview Q&A: Data Breaches and Security Disasters

These questions come up in security-engineering and Staff IC loops where candidates are expected to translate historical breaches into concrete defensive engineering.

### 1. The SolarWinds SUNBURST attack compromised the build pipeline itself. How would you defend a Go build pipeline against this class of attack?

Cover: reproducible builds with cryptographic verification of the source-to-binary chain, SLSA provenance attestations, signed commits with hardware-backed keys, build-environment isolation (hermetic builds in ephemeral containers), and binary transparency logs so any tampering is publicly detectable. Mention Sigstore and cosign as the 2026 standard tooling.

### 2. Log4Shell made remote code execution possible through a logging library. What does the Go ecosystem do differently?

Go's logging libraries (`log/slog`, `zerolog`, `zap`) do not perform template expansion or JNDI-style lookup on logged values. The class of vulnerability is structurally impossible. That said, Go is not immune to all supply-chain risks: describe how you would audit a new Go dependency (license, maintainer activity, vulnerability history, dependency depth) and the tooling you would use (`govulncheck`, `osv-scanner`, dependency pinning in `go.sum`).

### 3. The XZ Utils backdoor was introduced through a two-year social-engineering campaign. How do you defend a Go OSS project against this?

Cover: reviewer diversity requirement (no single maintainer can merge to main), reproducible builds with binary diffing against source, build provenance attestations, and separation between the maintainer who can merge and the maintainer who can publish releases. Acknowledge that defense-in-depth is the only realistic answer because any security property that relies on a single human's judgment is vulnerable to social engineering over a long enough timeline.

### 4. Design a zero-trust access gateway for a Go microservice handling PII.

A Staff-level answer covers: MFA recency as a first-class request attribute (reject sessions where MFA is older than N hours), device compliance attestation, a behavioral risk score evaluated per request, session-anomaly detection (geo shift, impossible travel, user-agent change), and an append-only audit log streamed to a SIEM. Discuss the principle that every request is evaluated independently against all signals, with the most restrictive result winning.

### 5. How would you implement secrets management for a Go service fleet of 100 services?

Cover: no secrets in code, no secrets in environment variables committed to config, runtime fetch from a secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager), short-lived tokens via IAM role or workload identity, in-memory cache with TTL to reduce secret-manager load, cache fallback during secret-manager outages, and an audit log of every secret access. Discuss secret rotation (automated, hourly where possible) and the rollback path when a rotation breaks a downstream service.

### Junior → FAANG: Translating Security Incidents into Technical Interview Answers

The five questions above cover the full range of FAANG security interview formats: supply chain defense (Q1, Q3), language-specific security properties (Q2), system design with security requirements (Q4), and operational security practices (Q5). For each question, the structure is the same: name the specific breach that demonstrates why the topic matters, explain the root cause in one sentence, describe the Go-specific defense, and extend to the broader architectural principle. For Q2 (Log4Shell), that structure is: "Log4Shell demonstrated that logging frameworks that evaluate user input as executable code are a critical RCE vector. Go's `slog` treats all logged values as literal strings by design, so this class of vulnerability is structurally prevented. Beyond the language safety, I would audit any new Go dependency using govulncheck and go.sum hash pinning." This structure demonstrates both technical depth and the ability to connect technical details to historical precedent.

### Senior @ FAANG: Bar-Raiser Security Questions and Organizational Security Design

At the bar-raiser level, every question above has an organizational dimension. Q1 (build pipeline defense): the bar-raiser follow-up is "how do you ensure SLSA Level 3 compliance across all 50 services in your organization?" The answer requires platform engineering investment, not individual team compliance. Q4 (zero-trust gateway): the bar-raiser follow-up is "how do you ensure consistent zero-trust enforcement when different teams have built different authentication patterns?" The answer requires a shared authentication library that is the default for all services, with the gateway logic embedded in the library rather than individually implemented. Q5 (secrets management): the bar-raiser follow-up is "how do you ensure no service in your organization has hardcoded secrets in source code?" The answer requires secret scanning as a pre-receive hook on the repository server, not as an advisory check in CI. At the bar-raiser level, security engineering is organizational design: making secure patterns the default and insecure patterns structurally prevented across the entire engineering organization.

---
