## 112D.1 Compliance Engineering Overview

Modern software systems must satisfy multiple overlapping regulatory frameworks simultaneously. SOC 2, GDPR, PCI DSS, and HIPAA each impose distinct but complementary controls. Rather than treating compliance as a checkbox exercise, engineers who understand the shared patterns (immutable audit logs, encryption at rest and in transit, RBAC with least privilege, and breach notification procedures) can design systems where a single control satisfies multiple frameworks. The diagram below maps each framework to its core engineering obligations and highlights the controls that appear across all of them.

```
┌──────────────────────────────────────────────────────────────────┐
│                   Compliance Framework                           │
│                                                                  │
│  SOC 2              GDPR                PCI DSS       HIPAA      │
│  ──────             ────                ───────       ─────      │
│  Security           Consent mgmt        Tokenize      PHI audit  │
│  Availability       Right to erase      No store SAD  Access log │
│  Confidentiality    Data portability    Encrypt keys  Min access │
│  Processing Int.    Breach notify       Pen testing   BAA        │
│  Privacy            DPIA                Segmentation  Encrypt    │
│                                                                  │
│  Common Controls:                                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Audit logs: immutable, searchable, retained per framework  │  │
│  │ Encryption at rest + in transit (TLS 1.3+, AES-256)        │  │
│  │ Access controls (RBAC + MFA + least privilege)             │  │
│  │ Vulnerability management + patch tracking                  │  │
│  │ Incident response procedures                               │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Compliance Map Before You Write Code

New engineers often treat compliance as an audit team concern. At any company handling payments, health data, or personal information, compliance requirements directly shape system design choices. Start by mapping every data type your service touches to the frameworks that govern it: PAN data activates PCI DSS, PHI activates HIPAA, EU resident data activates GDPR, and SOC 2 applies to virtually any SaaS product. Before writing a single handler, confirm which frameworks apply, then identify the overlapping controls so you build once rather than retrofitting four separate implementations. The most common junior mistake is building a feature fully and then discovering a compliance requirement that forces a rewrite of the storage layer.

Concrete first-job habit: keep a compliance matrix in your team's design doc template. Columns are frameworks, rows are controls, cells mark which implementation satisfies which requirement. When a code reviewer sees that table, it signals you thought about compliance at design time, not after the fact.

### Senior @ FAANG: Compliance as a Platform Capability, Not a Per-Feature Tax

At staff level, the question is not "does this feature comply?" but "does our platform make compliance the path of least resistance for every team building on it?" The goal is compliance-by-default: a service built on your internal framework should automatically emit immutable audit logs, encrypt data at rest using envelope encryption with a centrally managed KMS key, and propagate the right retention labels without the feature team needing to know the details.

This requires treating each regulatory control as a platform primitive. Audit logging becomes a middleware or SDK interceptor, not a library teams optionally import. Encryption key management becomes a fleet-wide policy enforced at the infrastructure layer, not a choice left to individual service owners. Data classification becomes a metadata tag applied at schema-registration time, automatically triggering retention policies and access-control rules downstream.

Governance architecture decisions at this level include: which controls belong in the service mesh (mTLS, logging sidecars), which belong in the API gateway (rate limiting, authentication), which belong in the data platform (lineage, classification, retention), and which must remain in application code (business-logic authorization). Getting this wrong leads to either platform sprawl (teams implementing the same control six different ways) or over-centralization (the platform team becomes a bottleneck for every compliance question).

ADR signal for bar-raisers: a strong candidate defines a compliance maturity model with concrete levels. Level 1 is manual controls with spreadsheet evidence. Level 2 is automated controls with programmatic evidence collection. Level 3 is continuous compliance where evidence is generated as a side effect of normal operation and violations surface as deployment blockers, not annual audit findings. A staff engineer pushing for Level 3 can explain the engineering investment required, the risk reduction achieved, and the audit cost saved, in business terms an executive can act on.

---
