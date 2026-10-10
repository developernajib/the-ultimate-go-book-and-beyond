## 108.1 Cryptographic Primitives Overview

This section maps out the major categories of cryptographic operations and when to use each one.

```
Cryptographic Operations
├── Hashing (One-way functions)
│   ├── General Purpose: SHA-256, SHA-3
│   └── Password Hashing: bcrypt, argon2
├── Encryption (Two-way functions)
│   ├── Symmetric: AES-GCM, ChaCha20-Poly1305
│   └── Asymmetric: RSA, ECDH
└── Signatures (Proof of authenticity)
    ├── RSA signatures
    └── ECDSA signatures
```

**Hash Functions**: Take arbitrary input and produce fixed-size output. Cannot be reversed. Used for integrity checks, content addressing, and (with proper algorithms) password storage.

**Symmetric Encryption**: Same key for encryption and decryption. Fast. Used for encrypting bulk data. The challenge is securely sharing the key.

**Asymmetric Encryption**: Different keys for encryption (public) and decryption (private). Slower. Used for key exchange, digital signatures, and encrypting small amounts of data.

**Digital Signatures**: Prove that data came from a specific sender and hasn't been modified. Critical for authentication.

### Junior → FAANG: Selecting the Right Primitive

Primitive selection mistakes are the most common cryptographic error in real codebases. The interview question "which cryptographic primitive would you use for X?" is specifically designed to reveal whether you understand use cases, not just names.

**Gap to close:** Memorize this mapping: hashing is for integrity verification and password storage (not for hiding data because it is one-way). Symmetric encryption is for confidentiality when both sides share a secret. Asymmetric encryption is for key exchange and for confidentiality when you only have the recipient's public key. Digital signatures are for authentication and non-repudiation. MACs are for integrity verification when both sides share a secret (faster than signatures, no public key infrastructure needed).

**Common mistake:** Using asymmetric encryption to encrypt large data directly. RSA can only encrypt data smaller than its key size minus padding overhead. The correct pattern is hybrid encryption: generate a random symmetric key, encrypt the data with the symmetric key (AES-GCM), encrypt the symmetric key with the recipient's public key (RSA-OAEP or ECIES), and transmit both. This is what TLS does internally.

**Interview framing:** When asked "how do you encrypt a message for a recipient who only has a public key?", describe hybrid encryption. This answer demonstrates knowledge of why asymmetric encryption is not used directly for bulk data and shows understanding of the performance and size constraints.

### Senior @ FAANG: Building a Cryptographic Primitive Policy

At senior level, primitive selection is not left to individual judgment. The organization has a cryptographic policy that specifies approved algorithms, approved key sizes, and deprecated algorithms with migration timelines.

**Algorithm policy content:** A production cryptographic policy specifies: for symmetric encryption, AES-256-GCM (do not use CBC, ECB, or CTR without MAC). For hashing, SHA-256 or SHA-3-256 (do not use MD5, SHA-1, or SHA-224). For asymmetric encryption, RSA-2048 minimum or ECDH P-256 (prefer ECDH for new systems). For digital signatures, ECDSA P-256 or Ed25519 (do not use RSA-1024 or DSA). For password hashing, argon2id or bcrypt cost 12+ (do not use MD5, SHA-*, or unsalted hashing of any kind). This policy is a living document with an owner and a review cadence.

**Deprecation and migration planning:** When an algorithm is deprecated, the policy specifies a migration deadline and the team responsible for each affected system. Staff engineers track migration progress against the deadline in a quarterly security review. Algorithms are not "eventually deprecated" in a vague future: they have specific dates and specific owners.

**Regulatory context:** Some compliance frameworks (PCI DSS, FIPS 140-2/3) mandate specific algorithm choices. Know which frameworks apply to your product and verify your cryptographic policy satisfies them. A policy that is internally consistent but violates PCI DSS requirements will fail an audit. Senior engineers check compliance requirements before finalizing the policy.

---
