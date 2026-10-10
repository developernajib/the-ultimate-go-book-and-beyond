## 111.1 Zero-Trust Fundamentals

Traditional security assumed trust based on network location. If a request came from inside the corporate network, it was trusted. This model fails in modern environments where:

- Services run across multiple clouds
- Remote work blurs network boundaries
- Lateral movement attacks exploit internal trust
- Compromised credentials provide access to everything

### Core Principles

Zero-trust architecture enforces these principles:

**1. Never Trust, Always Verify**
Every request requires authentication and authorization, even from internal services.

**2. Assume Breach**
Design systems assuming attackers already have access somewhere. Limit blast radius.

**3. Least Privilege Access**
Grant minimum permissions necessary for a specific task, for a limited time.

**4. Verify Explicitly**
Use all available data points: identity, device, location, behavior, risk assessment.

**5. Micro-Segmentation**
Isolate resources and services. A breach in one area shouldn't compromise others.

**6. Monitor and Log Everything**
Comprehensive logging and analysis detect anomalies and attacks.

### Zero-Trust Architecture Model

The Policy Decision Point (PDP) is the brain of a zero-trust system: it evaluates identity, device health, risk score, and policy rules before emitting an allow or deny verdict. The Policy Enforcement Point (PEP) sits on the data path and enforces that verdict, terminating mTLS connections and validating SPIFFE SVIDs so that no service can communicate without a cryptographically verified identity. Every service-to-service call passes through both layers, ensuring lateral movement is blocked even when an internal network boundary is crossed.

```
┌──────────────────────────────────────────────────────────────┐
│                    Policy Decision Point                     │
│  ┌────────────┐  ┌──────────┐  ┌─────────┐  ┌────────────┐   │
│  │ Identity   │  │ Device   │  │ Risk    │  │ Policy     │   │
│  │ Validation │  │ Health   │  │ Score   │  │ Engine     │   │
│  └────────────┘  └──────────┘  └─────────┘  └────────────┘   │
└──────────────────────────────────────────────────────────────┘
                            ↓
                    Allow / Deny / Step-Up Auth
                            ↓
┌──────────────────────────────────────────────────────────────┐
│                   Policy Enforcement Point                   │
│                                                              │
│    ┌──────────┐        mTLS         ┌──────────┐             │
│    │ Service  │ ←─────────────────→ │ Service  │             │
│    │    A     │    Encrypted +      │    B     │             │
│    │          │    Authenticated    │          │             │
│    └──────────┘                     └──────────┘             │
│         ↑                                 ↑                  │
│         │                                 │                  │
│    ┌────┴────┐                       ┌────┴────┐             │
│    │ Cert    │                       │ Cert    │             │
│    │ (SPIFFE)│                       │ (SPIFFE)│             │
│    └─────────┘                       └─────────┘             │
└──────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Zero Trust Principles in Your First Job

The zero-trust principles in this section are not theoretical: they translate directly into specific design decisions you make in every feature you build.

**Gap to close:** The "verify explicitly" principle means that authentication is applied at every service boundary, not just at the edge. A common junior mistake is building a service that trusts requests from "internal" sources without verification. "Internal" means nothing in a zero-trust model: a compromised internal service is an attacker. Every request must be authenticated.

**First-job application:** In your next service design, explicitly identify every trust boundary and document how each one is enforced. If a service receives requests from another service, what credential does the caller present? Who issued that credential? How does the callee verify it? Writing these answers forces you to think about authentication at every boundary.

**Interview framing:** When asked "how do you design authentication for a microservices system?", describe the two layers: mTLS at the transport layer (both sides present certificates) and JWT/OIDC at the application layer (the calling service includes a service account token that the callee validates for authorization). Two layers is a zero-trust answer. One layer is a perimeter-model answer.

### Senior @ FAANG: Zero Trust as a Board-Level Concern

At senior and staff level, zero trust is a business and compliance concern as much as a technical one. NIST SP 800-207 (Zero Trust Architecture) is the authoritative federal guidance. ISO 27001 and SOC 2 assessors increasingly evaluate zero-trust practices. Regulatory frameworks for financial services and healthcare include zero-trust-aligned requirements.

**Compliance mapping:** Map your zero-trust implementation to specific control requirements in your compliance frameworks. NIST SP 800-207 provides a zero-trust architecture reference model. SOC 2 CC6.1 (logical access) maps to the "verify explicitly" principle. PCI DSS requirement 1 (network access control) can be satisfied by application-layer zero-trust controls when network segmentation is impractical. Document these mappings for your compliance team and auditors.

**Security incident impact reduction:** The core business case for zero trust is breach impact reduction. In a perimeter model, a single compromised service has access to everything on the internal network. In a zero-trust model, a compromised service has access only to the specific resources its identity is authorized to access. The blast radius of a breach is bounded by authorization policy, not by network topology. Quantify this benefit for your leadership: in a recent industry incident with a perimeter model, the attacker moved laterally to X systems. With zero-trust controls, movement would have been limited to Y systems (based on authorization policy analysis). This quantification makes the zero-trust investment concrete.

---
