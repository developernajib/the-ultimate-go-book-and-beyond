## 108.12 Mid-Chapter Synthesis: Core Cryptography Concepts Recap

### What You Learned

- **Hash Functions**: SHA-256 for integrity, SHA-3 for future-proofing, HMAC for authentication
- **Symmetric Encryption**: AES-GCM provides authenticated encryption for bulk data
- **Asymmetric Encryption**: RSA and ECDH for key exchange and encrypting small data
- **Digital Signatures**: RSA-PSS and ECDSA for authentication and non-repudiation
- **Password Hashing**: bcrypt and argon2 for secure password storage
- **TLS Configuration**: Production-ready settings for secure network communication
- **Key Management**: Generate, derive, and store keys securely
- **Common Mistakes**: Recognize and avoid cryptographic pitfalls

### Security Checklist

- [ ] Use `crypto/rand` for all random number generation
- [ ] Use AES-GCM or ChaCha20-Poly1305 for encryption
- [ ] Never reuse nonces/IVs with the same key
- [ ] Use bcrypt (cost ≥ 10) or argon2 for password hashing
- [ ] Never store passwords in plaintext or hash with SHA-256
- [ ] Configure TLS with minimum version 1.2 (prefer 1.3)
- [ ] Use constant-time comparison for MACs and password hashes
- [ ] Store keys in secure key management systems
- [ ] Rotate keys regularly
- [ ] Use different keys for different purposes
- [ ] Never hard-code keys in source code
- [ ] Always check errors in cryptographic operations

### Key Takeaways

1. **Don't Roll Your Own Crypto**: Use established libraries and algorithms
2. **Defense in Depth**: Use authenticated encryption (encryption + MAC)
3. **Key Management is Critical**: The strongest algorithm is useless with poor key management
4. **Constant-Time Operations**: Prevent timing attacks with `subtle.ConstantTimeCompare` and `hmac.Equal`
5. **Fail Securely**: In crypto code, errors should abort operations, not continue with corrupted data
6. **Stay Updated**: Follow security advisories and update to newer algorithms when needed

### Interview Relevance

Security engineers at FAANG companies expect you to:
- Explain the difference between encryption and hashing
- Know when to use symmetric vs asymmetric encryption
- Understand why bcrypt is better than SHA-256 for passwords
- Configure TLS properly in production
- Recognize common cryptographic mistakes
- Understand the importance of randomness in cryptography

### Junior → FAANG: Cryptography as a Foundation Skill

Cryptography knowledge is table stakes for any backend role at a company that handles sensitive data. The summary above is the minimum you need to articulate fluently in an interview.

**Gap to close:** The most common gap for juniors summarizing cryptography knowledge is conflating confidentiality and integrity. AES-GCM provides both (authenticated encryption). SHA-256 provides only integrity verification, not confidentiality. bcrypt provides one-way transformation suitable for password verification, not confidentiality or integrity. Know which properties each primitive provides.

**Interview habit:** When asked any cryptography question, structure your answer around the CIA triad: Confidentiality (encryption), Integrity (hashing, HMAC, authenticated encryption), Availability (not a cryptographic concern but important to mention when discussing TLS and its role in preventing MITM attacks). This structure ensures completeness.

### Senior @ FAANG: Cryptography as an Organizational Responsibility

At senior level, the summary above represents individual knowledge. Your organizational responsibility is ensuring the entire team operates at this level and that the systems they build apply these principles correctly by default.

**Cryptographic posture review:** Conduct an annual cryptographic posture review for your product area. The review covers: all algorithms in use and their compliance with the algorithm policy, all key management practices and their alignment with the key management policy, all TLS configurations and their cipher suite and minimum version settings, and all dependencies that perform cryptographic operations and their CVE status. The review output is a list of findings with owners and remediation timelines.

**Evolving with the field:** The cryptographic field moves. Post-quantum algorithms are standardized. New attack techniques are published. Go's standard library adds new capabilities. Staff engineers maintain a reading practice (NIST publications, Go security advisories, academic cryptography blogs) and translate new developments into actionable policy updates for their team. The cryptography summary above is current as of the writing of this book: it will need updates as the field evolves, and those updates are an organizational responsibility.

---
