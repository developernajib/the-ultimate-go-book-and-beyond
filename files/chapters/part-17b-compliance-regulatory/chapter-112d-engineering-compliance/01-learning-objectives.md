## Learning Objectives

By the end of this chapter, you will:
- Implement SOC 2 controls in Go: audit logging, access controls, encryption
- Build GDPR-compliant data management: consent, erasure, portability
- Implement PCI DSS tokenization and cardholder data protection
- Design HIPAA-compliant PHI handling with audit trails
- Build automated compliance monitoring and evidence collection
- Implement data classification and retention policies

### Junior → FAANG: Compliance Learning Objectives as Career Requirements

The learning objectives in this chapter describe skills that are increasingly expected at mid-level positions (L4/L5) at companies that handle regulated data. Understanding them positions you for roles at fintech, healthtech, and enterprise SaaS companies.

**Gap to close:** The most commonly missing skill for juniors is audit logging design. Many engineers know how to add `log.Info("action performed")` but do not know how to design an audit log that can support SOC 2 CC7.2 monitoring: structured, immutable, queryable records of who did what to which resource when, from where, with what outcome. The design difference is significant: a compliance audit log is a system feature, not a debug tool.

**First-job application:** For your next feature that involves user data access or modification, design the audit log first: what fields are required, what is the retention period, how is it stored to prevent tampering, how can it be queried by auditors. Then implement it. Treating audit logging as a design exercise rather than an afterthought produces significantly better results.

### Senior @ FAANG: Compliance Objectives as an Organizational Capability Map

At senior level, the learning objectives map to organizational capabilities that must be present for a company to achieve and maintain its compliance posture, whether that is an AICPA attestation like SOC 2, a PCI DSS validation, or an ongoing statutory obligation like GDPR.

**Capability ownership:** For each compliance objective, identify the owning team and the owning engineer. "Implement audit logging for SOC 2" should have a specific team and a specific person who is accountable for the implementation, the testing, and the ongoing maintenance. Without ownership, compliance controls drift: they are implemented for the initial audit and then allowed to degrade as the system evolves. Staff engineers ensure that compliance capabilities have owners and that ownership is maintained through organizational changes.

---
