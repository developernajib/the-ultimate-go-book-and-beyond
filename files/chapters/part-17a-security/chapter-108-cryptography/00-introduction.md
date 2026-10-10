# Chapter 108: Cryptography in Go

*Don't roll your own crypto. But do understand the crypto you're using.*

In 2011, the PlayStation Network was compromised, exposing 77 million accounts. The breach was devastating not because the attackers broke a strong cipher, but because Sony had protected passwords with only a plain cryptographic hash, no salt, no slow adaptive hashing, leaving them cheap to crack at scale. In 2012, LinkedIn was breached and 117 million password hashes were stolen - hashed with unsalted SHA-1, an algorithm so fast that attackers cracked the vast majority of them within days using commodity GPUs. In 2014, researchers discovered Heartbleed, a vulnerability in OpenSSL that exposed private keys and session tokens across hundreds of thousands of HTTPS servers - not because the cryptographic algorithm was wrong, but because a single missing bounds check allowed attackers to read 64KB of server memory at a time. The lesson in each case is the same: using cryptography is not the same as using cryptography correctly.

Go's standard library is one of the strongest cryptographic toolkits available in any language. The `crypto` package ships with constant-time implementations of AES-GCM, ChaCha20-Poly1305, RSA, ECDSA, ECDH, SHA-2, SHA-3, and a correctly seeded cryptographic random number generator, with bcrypt and argon2 a well-audited import away in `golang.org/x/crypto`. Unlike OpenSSL - a C library infamous for subtle API misuse - Go's interfaces are designed to steer you toward secure defaults. But the library cannot protect you from choosing the wrong algorithm for your use case, using CBC mode without authentication, generating weak nonces, or storing keys in environment variables that leak into crash dumps. Correctness still requires understanding.

This chapter teaches you to use Go's cryptographic primitives correctly for every common use case: hashing data for integrity checks, hashing passwords for storage, encrypting data at rest, encrypting data in transit, signing data to prove authenticity, and managing keys across their full lifecycle. You will understand not just the API but the security properties each algorithm provides, the failure modes to avoid, and the operational practices - key rotation, secure storage, algorithm agility - that keep cryptographic systems secure as threats evolve over years of production operation.

**What you'll learn in this chapter:**
- Cryptographic primitives taxonomy: when to use hashing, symmetric encryption, asymmetric encryption, and digital signatures
- Hash functions with `crypto/sha256` and `crypto/sha512` for data integrity and content addressing
- Password hashing with `bcrypt` and `argon2` - why they differ from general-purpose hashes and how to tune their cost parameters
- Symmetric authenticated encryption with AES-GCM and ChaCha20-Poly1305, including nonce generation and key derivation
- Asymmetric encryption and key exchange with RSA and ECDH for securing communications between parties
- Digital signatures with ECDSA and Ed25519 for proving data authenticity and integrity
- TLS configuration in Go: cipher suites, certificate pinning, mutual TLS, and minimum version enforcement
- Key management patterns: generation, storage, rotation, and destruction across the key lifecycle

**Why this matters at scale:**
Signal, which encrypts messages for hundreds of millions of users, built its protocol on the same standard primitives available in Go's crypto libraries - X25519 key agreement, AES, HMAC-SHA256 - demonstrating that correct use of standard algorithms is sufficient even for the most demanding security requirements. Google's internal infrastructure relies on application-layer encryption using similar primitives to protect data in transit between services that already run over TLS, implementing defense-in-depth at the cryptographic layer.

**Prerequisites:** Chapter 107 (Application Security), Chapter 6 (Go interfaces), Go 1.27.1 baseline, basic understanding of binary data and byte slices

### Junior → FAANG: The Cryptography Knowledge Floor

Cryptography is the area where juniors most often make mistakes that cannot be patched without a full data migration or a key rotation. Understanding why you use specific algorithms, not just which ones to use, prevents the most costly mistakes.

**Gap to close:** Know the difference between hashing, symmetric encryption, asymmetric encryption, and MAC. Know which Go package implements each. Know which is appropriate for which use case. If someone asks "how do you store a password securely?" and you answer "encrypt it," that is wrong: passwords are hashed (bcrypt, argon2id), not encrypted. This distinction comes up in nearly every security interview.

**First-job habit:** Never implement a cryptographic primitive from scratch. Go's `crypto` standard library provides correct, audited implementations of every primitive you need. Your job is to use them correctly, not to build them. If you find yourself implementing XOR-based encryption or a custom hash, stop and use the standard library.

**Interview entry-point framing:** When asked "how do you encrypt data at rest?", describe AES-256-GCM from `crypto/aes` and `crypto/cipher`. Mention that you use `crypto/rand` for nonce generation, never reuse nonces, and store the nonce with the ciphertext. This answer demonstrates correct primitive selection, correct nonce handling, and knowledge of authenticated encryption.

### Senior @ FAANG: Cryptography Policy as an Organizational Asset

At senior level, cryptographic decisions are long-lived and expensive to change. An algorithm choice made today may need to be migrated in 5-10 years when advances in cryptanalysis or quantum computing change the security landscape. Senior engineers make cryptographic decisions with this lifecycle in mind.

**ADR for cryptographic algorithm selection:** When choosing an algorithm for any persistent data (encrypted data at rest, signed tokens, password hashes), write an ADR that includes: the algorithm and parameters chosen, why alternatives were rejected, the expected security lifetime of the choice, and the migration plan when the algorithm needs to be replaced. An ADR that does not include a migration plan is incomplete because algorithm migration is inevitable.

**Post-quantum readiness:** NIST finalized post-quantum cryptographic standards in 2024 (ML-KEM for key encapsulation, ML-DSA for digital signatures). Go's `crypto/tls` has enabled hybrid post-quantum key exchange (X25519MLKEM768) by default since Go 1.24, and Go 1.26 added `crypto/hpke`. Staff engineers are planning migration timelines now: which key exchange mechanisms need to be upgraded, which signatures are long-lived enough to be vulnerable to "harvest now, decrypt later" attacks, and which data has a sensitivity lifetime that exceeds the estimated timeline to quantum advantage. This is an active planning concern, not a future consideration.

**Key management as a first-class concern:** The security of every cryptographic operation depends on key security. A perfect AES-256-GCM implementation is worthless if the key is stored in an environment variable in plaintext. At senior level, key management (storage, rotation, access control, audit logging) is explicitly designed before any cryptographic system is built. The question "where does the key live?" must have a documented answer before the first line of cryptographic code is written.

**Cryptographic agility:** Build systems that can swap cryptographic algorithms without a full code rewrite. Store the algorithm identifier alongside encrypted data so you can decrypt legacy data with the old algorithm while encrypting new data with the new algorithm. This "cryptographic agility" pattern is required for any data with a long lifetime and is a mark of senior-level cryptographic system design.

---
