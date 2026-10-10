## 90I.14 Security Engineering Checklist - Incident-to-Principle Mapping

The following checklist maps each incident in this chapter to the specific security engineering principles and
practices that would have prevented or significantly mitigated the damage. Use this as a baseline for security
architecture reviews, threat modeling sessions, and incident post-mortems.

### Master Incident-to-Principle Mapping Table

| # | Incident | Year | Root Cause Category | Key Failed Principle | Prevention Pattern | Go Defense |
|---|----------|------|--------------------|--------------------|-------------------|------------|
| 1 | SolarWinds SUNBURST | 2020 | Supply chain compromise | Build integrity | SLSA provenance, reproducible builds | SLSA attestation verification |
| 2 | Log4Shell | 2021 | Unsafe deserialization | Data/code separation | Safe logging, no expression evaluation | `slog` structured logging |
| 3 | xz Utils Backdoor | 2024 | Social engineering | Maintainer diversity | Multi-maintainer review, reproducible builds | Static linking, `go.sum` |
| 4 | Equifax | 2017 | Unpatched vulnerability | Patch management | Automated patching, cert monitoring | Certificate expiry monitoring |
| 5 | LastPass | 2022 | Personal device compromise | Device trust boundary | Zero-trust device posture, envelope encryption | Envelope encryption with Argon2id |
| 6 | Okta/Lapsus$ | 2022 | Third-party access | Vendor trust verification | Real-time audit logging, least privilege | Tamper-evident audit logs |
| 7 | CircleCI | 2023 | Session cookie theft | Session integrity | Device-bound sessions, re-authentication | Device-bound session tokens |
| 8 | Heartbleed | 2014 | Missing bounds check | Memory safety | Memory-safe languages, bounds checking | Go runtime bounds checking |
| 9 | Shellshock | 2014 | Code in data channel | Data/code separation | No shell interpretation of user data | `os/exec.Command` (no shell) |
| 10 | Cloudbleed | 2017 | Off-by-one bounds error | Bounds checking | `>=` not `==`, memory-safe parsing | Go slice bounds checking |
| 11 | Uber Cover-Up | 2016 | Hardcoded credentials | Secret management | Secret scanning, secrets managers | Pre-commit secret scanning |
| 12 | Debian SSH Keys | 2008 | Reduced entropy | Cryptographic integrity | Never modify crypto code without expert review | `crypto/rand` (no Seed method) |
| 13 | npm Supply Chain | 2016-2022 | Ecosystem trust model | Dependency integrity | Cryptographic verification, module proxy | `go.sum`, module proxy |

### Security Architecture Checklist

Use this checklist during design reviews, security audits, and incident response planning. Each item is directly
derived from the incidents analyzed in this chapter.

#### Build Pipeline Security (SolarWinds)

- [ ] Build servers are hardened, monitored, and access-restricted
- [ ] All builds produce SLSA provenance attestations signed by the build platform
- [ ] Build outputs are reproducible from source (identical inputs produce identical outputs)
- [ ] Code signing keys are stored in HSMs, not on build servers
- [ ] Build infrastructure is separate from corporate network (air-gapped or strongly segmented)
- [ ] Build servers have integrity monitoring (detect unauthorized processes like SUNSPOT)
- [ ] Software Bill of Materials (SBOM) is generated and published for every release

#### Logging and Input Handling (Log4Shell, Shellshock)

- [ ] Logging framework treats all message content as literal data, never as templates
- [ ] No expression evaluation, JNDI lookups, or code execution in log processing
- [ ] User-controlled input is never passed to shell interpreters
- [ ] External commands are invoked via `exec.Command`, not through shell evaluation
- [ ] Environment variables are sanitized before being passed to child processes
- [ ] Log output sanitizes sensitive data (credit cards, tokens, passwords)
- [ ] Log injection attacks (ANSI escapes, null bytes, newlines) are neutralized

#### Dependency Management (xz Utils, npm, Debian SSH)

- [ ] All dependencies have cryptographic integrity verification (`go.sum`)
- [ ] Dependencies are cached/vendored to prevent removal attacks
- [ ] Dependency count is minimized and regularly reviewed
- [ ] New dependencies require security review before adoption
- [ ] `govulncheck` runs in CI/CD on every build
- [ ] `go mod verify` confirms local cache integrity
- [ ] Upstream security-critical packages are never modified without expert review
- [ ] Dependencies are pinned to specific versions, not ranges

#### Certificate and Credential Management (Equifax, Uber)

- [ ] All TLS certificates are monitored with automated expiry alerting
- [ ] Certificate renewal is automated (ACME/Let's Encrypt where applicable)
- [ ] Warning threshold: 30 days before expiry
- [ ] Critical threshold: 7 days before expiry
- [ ] No credentials are stored in source code repositories
- [ ] Pre-commit hooks scan for secrets before code is committed
- [ ] CI/CD pipeline includes secret scanning as a blocking step
- [ ] All credentials are stored in a secrets manager (Vault, AWS Secrets Manager)
- [ ] Credentials are rotated on a regular schedule
- [ ] Least-privilege principle applied to all service accounts and API keys

#### Encryption and Key Management (LastPass, Heartbleed)

- [ ] Envelope encryption separates data encryption keys (DEKs) from key encryption keys (KEKs)
- [ ] Per-record DEKs limit the blast radius of any single key compromise
- [ ] Key derivation uses Argon2id with memory-hard parameters (not PBKDF2)
- [ ] All metadata is encrypted, not just passwords/secrets
- [ ] Key rotation is supported without re-encrypting all data
- [ ] Random number generation uses `crypto/rand` exclusively
- [ ] Entropy validation runs at application startup
- [ ] Memory is zeroed after cryptographic operations

#### Authentication and Session Management (CircleCI, Okta)

- [ ] Sessions are bound to the device that created them (device fingerprinting)
- [ ] Session cookies use HttpOnly, Secure, SameSite=Strict flags
- [ ] Periodic re-authentication is required (1-hour intervals for sensitive systems)
- [ ] IP network changes trigger elevated risk scoring or re-authentication
- [ ] Session lifetime is limited (8 hours maximum)
- [ ] All sessions can be revoked immediately (per-user and global)
- [ ] Third-party access is monitored with the same rigor as internal access
- [ ] Support agent actions are logged with full context and alerting

#### Audit Logging and Monitoring (Okta, Equifax)

- [ ] All privileged actions are logged with actor, target, timestamp, outcome
- [ ] Audit logs are tamper-evident (cryptographic hash chain)
- [ ] Real-time alerting on suspicious patterns:
  - Rapid password resets by single actor
  - Cross-tenant access
  - MFA factor changes for other users
  - Access from new IP addresses
  - After-hours privileged actions
- [ ] Audit logs are stored in a separate, independently secured system
- [ ] Monitoring infrastructure monitors itself (monitoring-of-monitoring)
- [ ] Log retention meets regulatory requirements (typically 1-7 years)

#### Vulnerability Management (Equifax, Heartbleed, Log4Shell)

- [ ] Critical vulnerabilities (CVSS 9+) are patched within 48 hours
- [ ] High vulnerabilities (CVSS 7-8.9) are patched within 7 days
- [ ] Automated vulnerability scanning runs on all deployed systems
- [ ] Patch deployment is tracked and verified (not just "notification sent")
- [ ] Incident response plan accounts for incomplete initial patches
- [ ] Dependencies are scanned for known vulnerabilities in CI/CD
- [ ] Memory-safe languages are preferred for new development

#### Incident Response (Uber Cover-Up, Okta)

- [ ] Incident response plan exists and is practiced regularly
- [ ] Disclosure obligations are understood and documented
- [ ] Legal counsel is involved in incident response (not just after the fact)
- [ ] Breach notifications meet legal deadlines (72 hours under GDPR)
- [ ] Communications are honest, timely, and complete
- [ ] Bug bounty programs have clear policies that exclude extortion
- [ ] Post-incident reviews identify systemic improvements, not just immediate fixes

#### Device and Network Security (LastPass, Equifax)

- [ ] Device posture verification before granting access to sensitive systems
- [ ] Personal devices require MDM enrollment and compliance verification
- [ ] Network segmentation limits lateral movement after initial compromise
- [ ] Internal traffic is encrypted and inspected (with valid, monitored certificates)
- [ ] Principle of least privilege applied to database access
- [ ] Zero-trust architecture: verify every request regardless of network location

### The Security Mindset for Go Engineers

The incidents in this chapter share a common thread: they were all preventable with known techniques applied with
consistent discipline. Security is not a feature you add at the end - it is an architectural property that must
be designed in from the beginning. Go provides excellent foundations: memory safety eliminates buffer overflows,
static linking reduces dependency chain risks, `crypto/rand` prevents entropy failures, `os/exec.Command` bypasses
shell injection, and `go.sum` provides cryptographic dependency verification. But these language-level protections
are necessary, not sufficient.

The security engineering checklist above is your bridge between the language's built-in protections and the
organizational, architectural, and operational practices that complete the defense. Every item on that checklist
corresponds to a real breach that affected real people at massive scale. Apply them not as theoretical best
practices, but as direct lessons from the incidents that proved their necessity.

The difference between a senior engineer and a staff/principal engineer in the security domain is not the ability
to write more secure code - it is the ability to design systems where security failures in any single component
do not cascade into catastrophic breaches. Defense in depth, least privilege, zero trust, tamper-evident logging,
envelope encryption, device-bound sessions, build provenance - these are the architectural patterns that create
that resilience. Build them into your Go systems from day one, and study the incidents in this chapter so you can
recognize the warning signs before they become headlines.

---

*The breaches and security disasters documented in this chapter represent collective damage in the hundreds of
billions of dollars, affected hundreds of millions of individuals, and in some cases compromised national security.
Every one of them was preventable with techniques that were well-understood at the time. The question is not
whether you will face similar attacks - it is whether your systems will be designed to withstand them when they
arrive. Study these failures. Build the defenses. Test them rigorously. The attackers are patient, skilled, and
relentless. Your architecture must be more resilient than their persistence.*


---

### Junior → FAANG: Using the Checklist for Security Design Questions

The security engineering checklist in this section is your preparation guide for FAANG security design questions. For each question ("design a secret management system," "how would you secure a CI/CD pipeline," "how do you prevent injection vulnerabilities"), find the relevant checklist section and ensure your answer covers every item. For "design a secret management system," the credential management section covers: secrets manager integration, rotation automation, no plaintext storage, least-privilege scoping. For "how do you secure a CI/CD pipeline," the supply chain section covers: SLSA provenance, go.sum verification, vendor locking, build isolation. For "how do you prevent injection vulnerabilities," the input handling section covers: never evaluate user data as code, use parameterized queries, sanitize at input boundary. The checklist converts your preparation from "remember security principles" to "verify coverage against a structured list."

### Senior @ FAANG: Security Architecture Review Using the Checklist as a Maturity Model

At L6, the security engineering checklist is a maturity assessment framework, not a personal study guide. Apply it to your organization's services: for each checklist item, determine the current compliance percentage across your service portfolio. Items with low compliance are the highest-priority security investments. Present the gap analysis to engineering leadership as a risk register: "42% of our services do not have automated secret rotation, which represents the same risk vector as the Uber and CircleCI breaches. Closing this gap requires building the rotation automation platform and integrating it into the production readiness review." This framing converts security improvement from a cost center request to a risk mitigation investment with quantified exposure. The staff engineer's security contribution is building the platform controls that move compliance from 42% to 95% across the organization, not writing more secure code in individual services.

---

