# Part XVII-B: Compliance & Regulatory Engineering

*Security is about preventing breaches. Compliance is about proving you tried.*

GDPR fines for the most serious infringements reach up to 4% of global annual turnover or EUR 20 million, whichever is higher. PCI DSS non-compliance exposes you to contractual card brand penalties that escalate the longer you stay out of compliance, plus the loss of your ability to process cards at all. HIPAA civil penalties are tiered by culpability and capped per violation category per calendar year, with the caps adjusted for inflation each year. At FAANG companies, compliance is not an afterthought handled exclusively by legal teams. It is an engineering discipline woven into every system from day one. Engineers who understand how to build compliant systems by design, rather than retrofitting compliance after the fact, are invaluable because they prevent costly rework, legal exposure, and reputation damage.

New privacy regulations continue to emerge across jurisdictions, data residency requirements vary by country, and audit requirements grow increasingly granular. As a Go engineer building backend services, you are directly responsible for how user data is collected, stored, processed, and deleted. You need to understand data classification, implement proper audit logging, design systems that support data subject access requests, and ensure that your services can demonstrate compliance to auditors through automated evidence collection.

Go's strong typing, explicit error handling, and excellent standard library make it well-suited for building compliance-aware systems. The language's clarity makes it easier to reason about data flows and access patterns, which is exactly what auditors and compliance officers need to verify. This part teaches you how to engineer compliance into your Go services so that passing audits becomes a routine, automated process rather than a stressful scramble.

**What this part covers:**
- Chapter 112D: Engineering for Compliance, covering GDPR data subject rights implementation, SOC 2 controls mapping, PCI DSS requirements for payment systems, HIPAA safeguards for health data, audit logging pipelines, data classification frameworks, and automated compliance evidence collection

**How to use this part:**
Chapter 112D is structured around the major compliance frameworks you will encounter at FAANG companies. Read it sequentially, as the foundational concepts of data classification and audit logging apply across all frameworks. Focus especially on the sections most relevant to your target domain: fintech engineers should prioritize PCI DSS, healthtech engineers should focus on HIPAA, and all engineers should understand GDPR and SOC 2.

**FAANG relevance:**
Every FAANG company operates under multiple compliance frameworks simultaneously and expects engineers to understand their obligations. System design interviews increasingly include compliance considerations. Interviewers may ask how you would handle data deletion across a distributed system for GDPR compliance, or how you would design audit logging for SOC 2. On the job, compliance reviews are a standard part of the design review process, and engineers who can navigate these requirements without blocking product launches are highly valued.

---

### Navigation & Cross-References

- **Previous Part:** [Part XVII-A: Security](../part-17a-security/00-part-intro.md)
- **Previous Chapter:** [Chapter 112C: Modern Authentication with Passkeys, WebAuthn & Zero-Trust](../part-17a-security/chapter-112c-modern-auth-passkeys/00-introduction.md)
- **Next Chapter:** [Chapter 112D: Engineering Compliance](chapter-112d-engineering-compliance/00-introduction.md)
