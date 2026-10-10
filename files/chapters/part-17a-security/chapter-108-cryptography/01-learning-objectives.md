## Learning Objectives

By the end of this chapter, you will:

- Understand cryptographic primitives and when to use each one
- Implement secure hashing for data integrity and password storage
- Use symmetric encryption (AES-GCM) for encrypting data at rest
- Implement asymmetric cryptography (RSA, ECDH) for encryption and secure key exchange
- Generate and verify digital signatures
- Hash passwords securely with bcrypt and argon2
- Configure TLS properly in production Go applications
- Manage cryptographic keys safely
- Recognize and avoid common cryptographic mistakes

### Junior → FAANG: Mapping Learning Objectives to Interview Questions

Each objective in this list is a potential interview question. Cryptography questions at FAANG companies are designed to distinguish engineers who use correct primitives from engineers who understand why those primitives are correct.

**Gap to close:** The most commonly tested objective is password hashing. Many juniors know to use bcrypt but cannot explain why: bcrypt is intentionally slow (configurable cost factor), it includes a built-in salt (preventing rainbow table attacks), and it produces a self-contained hash string that includes the algorithm, cost, and salt. Being able to explain the design rationale, not just the API, is the difference between an L3 and an L4 answer.

**First-job checklist:** For each objective, verify you can: (1) name the correct Go package, (2) write a working implementation without consulting documentation, (3) name two common mistakes and explain why they are mistakes. If you cannot complete all three for an objective, that objective needs more practice.

### Senior @ FAANG: Cryptography Learning Objectives as a Team Competency Bar

At senior level, these objectives define a minimum competency floor for every engineer on the team, not just a personal learning agenda.

**Competency assessment:** Design a cryptography competency assessment for your team. It should cover: can engineers correctly identify when to use hashing vs encryption? Can they configure TLS with a correct cipher suite list? Can they explain the nonce reuse problem in AES-GCM and its consequences? Use the results to identify training needs. Engineers below the floor on any objective receive targeted mentoring.

**Cryptographic code review standard:** For any PR that touches cryptographic code, require review by at least one engineer who can explain the rationale for every primitive choice, not just verify that the code compiles. This standard prevents cryptographic mistakes that pass functional tests but fail security analysis. At Google, cryptographic code requires security team review. At smaller organizations, designate a cryptography reviewer for your team.

---
