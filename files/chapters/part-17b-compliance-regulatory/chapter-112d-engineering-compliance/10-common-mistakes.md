## 112D.9 Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Logging full PANs/SSNs | PCI/HIPAA violation | Mask before logging, never log raw sensitive data |
| Mutable audit logs | Can be tampered with | Append-only storage with HMAC chain |
| Consent assumed granted by default | GDPR violation: silence, pre-ticked boxes, and inactivity are not consent | Fail closed: no affirmative record means no processing |
| Erasure wipes the consent and request records too | Can't prove the erasure was performed | Erase the personal data, retain a minimal record that the request was made and fulfilled |
| Encryption key stored with data | Useless encryption | Store keys in separate HSM/KMS |
| No data retention policy | Storing data forever | Automate deletion/anonymization |
| PAN stored in logs | PCI violation | Check all log pipelines for card data patterns |
| Missing data inventory | Can't respond to DSARs | Maintain automated data inventory |

### Junior → FAANG: The Mistakes That Trigger Regulatory Investigations

The mistakes in this table share a pattern: they are all invisible until an incident or audit reveals them. Logging PANs silently violates PCI DSS from the first log line. Mutable audit logs look fine in normal operation and only fail when someone asks to verify their integrity. First-job habit: treat each row in this table as a pre-launch checklist item. Before a service goes to production, confirm that it does not commit any of these mistakes by running the check explicitly: search the logging pipeline for card number patterns, verify that the audit table has no UPDATE or DELETE grants for the application role, confirm that the consent flow rejects unauthenticated processing attempts.

The "encryption key stored with data" mistake is narrower than it first appears, and it is worth being precise about where the line falls. The mistake is storing key *material* next to the ciphertext it protects, because then one database dump yields both halves and the encryption bought you nothing. Storing a key *identifier* or a KMS-wrapped data key alongside the ciphertext is not the same thing. It is standard envelope encryption and it is fine: the wrapped key is inert without a KMS call that IAM has to authorize and that leaves an audit trail.

Do not talk yourself into hiding key IDs as a control. Their secrecy protects nothing, and an attacker who can call KMS with an ID they should not have access to has an IAM failure, which is the thing to go fix. The control is the authorization boundary around the unwrap call, plus separation of duties so that the identity able to read the ciphertext is not the identity able to unwrap the key.

### Senior @ FAANG: Using This Table as a Control Gap Analysis Tool

At staff level, this table maps onto control categories in SOC 2 and PCI DSS. Mutable audit logs undermine the monitoring CC7.2 depends on. Missing data inventory is a GDPR Article 30 finding directly, and it also defeats the logical access controls of CC6.1, since you cannot restrict access to data you have not enumerated. Key co-location falls under the logical access criteria of the CC6 series. Treat these as pointers for the conversation with your auditor rather than as a fixed mapping: which criterion a given gap lands under depends on how your controls are described in your own control matrix. A staff engineer reviewing a new service's design can use this table as a rapid gap analysis: for each mistake, identify the control that prevents it, verify the control is implemented, and confirm the evidence that would satisfy an auditor.

The systemic fix for most of these mistakes is not better documentation but better platform primitives. If the default logging library automatically redacts PAN patterns, the "logging full PANs" mistake becomes opt-in rather than opt-out. If the default database provisioning script creates audit tables with append-only constraints on the application role, mutable audit logs require active subversion rather than passive oversight. Staff engineers at platform-owning organizations have leverage over these defaults that service-level engineers do not, which makes the ROI on fixing these mistakes at the platform layer much higher than fixing them service by service.

---
