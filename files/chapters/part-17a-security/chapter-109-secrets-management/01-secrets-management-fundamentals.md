## 109.1 Secrets Management Fundamentals

### The Secret Lifecycle

Every secret, whether an API key, a database password, or a TLS private key, passes through a predictable set of states from the moment it is generated to the moment it is permanently revoked. Understanding this lifecycle is the foundation of a sound secrets-management strategy, because vulnerabilities typically arise at transition points: secrets that are never rotated accumulate exposure risk, while secrets that lack an audited access log cannot be investigated after a breach. The diagram below maps each phase and its security requirement.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Creation  │────►│   Storage    │────►│   Rotation  │
│             │     │  (Encrypted) │     │  (Periodic) │
└─────────────┘     └──────────────┘     └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │    Access    │
                    │  (Audited)   │
                    └──────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  Revocation  │
                    │  (Immediate) │
                    └──────────────┘
```

### Core Principles

1. **Never hardcode secrets**: No secrets in source code, ever
2. **Encrypt at rest**: All secrets encrypted in storage
3. **Encrypt in transit**: TLS for all secret transmission
4. **Principle of least privilege**: Minimal access scope
5. **Audit all access**: Log who accessed what and when
6. **Rotate regularly**: Automated rotation reduces exposure window
7. **Revoke immediately**: Fast revocation when compromise suspected

### Junior → FAANG: The Secret Lifecycle as a Mental Model

The secret lifecycle (create, distribute, use, rotate, revoke) is the correct mental model for thinking about any secret. Juniors who think only about "how do I get the secret into my service?" are thinking about one step of a five-step lifecycle.

**Gap to close:** Know what happens at each lifecycle stage and what can go wrong. At creation: is the secret generated with sufficient entropy? At distribution: is it transmitted over TLS? At use: is it logged anywhere (an API key in a URL parameter will appear in access logs)? At rotation: is the service designed to pick up the new value without restarting? At revocation: how quickly can you invalidate the secret if it is compromised?

**Interview framing:** When asked "design a secrets management system for a microservices architecture," walk through the lifecycle. Creation: Vault generates secrets. Distribution: services fetch via authenticated API. Use: in-memory only, never logged. Rotation: Vault's dynamic secrets have a TTL and are renewed automatically. Revocation: Vault token is revoked and the secret expires within the TTL. This structured answer demonstrates that you think about secrets holistically, not just as "database passwords stored somewhere."

### Senior @ FAANG: Secret Lifecycle Governance Across Services

At senior level, the secret lifecycle is an organizational process with owners at each stage. The failure modes at each stage are documented, and controls are in place to detect and respond to failures.

**Lifecycle stage ownership:** Each stage of the lifecycle has a system or team responsible for it. Creation: the secrets manager generates secrets with entropy policies you define. Distribution: the platform team maintains the Vault or cloud KMS infrastructure. Use: each service team is responsible for correct secret use (not logging, not persisting to disk). Rotation: the secrets manager automates rotation. Service teams are responsible for making their services rotation-compatible. Revocation: on-call procedures specify who has the authority to revoke a secret and what the escalation path is for emergency revocation.

**Rotation compatibility as a design requirement:** Services that require a restart to pick up a new secret value have an operational problem: rotation causes downtime or requires coordination. Design services to refresh secrets without restarting. The Vault agent sidecar model, the AWS SDK's automatic credential refresh, and the periodic re-fetch pattern all achieve rotation compatibility. Make rotation compatibility a non-functional requirement for every new service, reviewed in the design phase rather than retrofitted.

**Audit log as a security control:** Secrets manager audit logs are not just records: they are a detection mechanism. Anomalous secret access (a service accessing a secret it does not normally access, access from an unexpected IP, access outside normal business hours) is an early indicator of compromise. Build detection rules in your SIEM that alert on anomalous patterns in secrets manager audit logs. This converts audit logs from a forensic tool (useful after a breach) into a detection tool (useful during a breach).

---
