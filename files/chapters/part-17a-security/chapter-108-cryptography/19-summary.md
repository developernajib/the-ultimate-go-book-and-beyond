## Summary

- **Prefer high-level APIs**: Use `golang.org/x/crypto` and standard library primitives (`crypto/aes`, `crypto/tls`) over rolling your own - custom cryptography is almost always wrong.
- **AES-GCM for symmetric encryption**: AES-256-GCM provides authenticated encryption (confidentiality + integrity). Always generate a unique random nonce per encryption and never reuse it.
- **Argon2id for password hashing**: Use `argon2.IDKey` with tuned memory/time parameters for password storage. bcrypt is acceptable but Argon2id is the modern recommendation.
- **TLS 1.3 minimum**: Configure `tls.Config` with `MinVersion: tls.VersionTLS13`. Disable weak cipher suites and rely on Go's default secure cipher ordering.
- **ECDSA and Ed25519 for signatures**: Prefer Ed25519 for new systems (faster, smaller keys, no parameter misuse risk) and ECDSA P-256 for FIPS-compliant environments.
- **Key derivation with HKDF**: Derive multiple purpose-specific keys from a single master secret using HKDF rather than using the same key for different operations.
- **Envelope encryption**: Encrypt data with a Data Encryption Key (DEK). Encrypt the DEK with a Key Encryption Key (KEK) managed by a cloud KMS - separates key management from data storage.
- **Cryptographic randomness**: Always use `crypto/rand` for security-sensitive random values. `math/rand` is not cryptographically secure and must never be used for tokens, nonces, or keys.
- **Post-quantum readiness**: Begin migrating long-lived secrets to ML-KEM hybrid schemes (HPKE with KEM_DHKEM_P256_HKDF_SHA256_ML_KEM_768). Data encrypted today may be harvested and decrypted by future quantum computers.
- **Key rotation**: Design systems to support key versions from day one. Store the key version alongside ciphertext so decryption can use the correct historical key while new data uses the latest.

### Junior → FAANG: Carrying These Cryptography Principles Into Your First Role

The summary above is the cryptographic foundation for a production Go engineer. If you can apply every principle here by default, without consulting documentation, you are cryptographically safer than the majority of engineers at most companies.

**Gap to close:** The hardest principle for juniors is "prefer high-level APIs." Under time pressure, it can feel faster to assemble primitives directly. Resist this: assembling primitives correctly requires knowing every detail discussed in this chapter. Using a high-level API like Go's `crypto/tls` or Google's Tink means the correct details are handled for you by engineers who specialize in cryptography.

**Interview habit:** Keep the HKDF pattern in mind for any interview question about deriving multiple keys from one secret. "I would use HKDF to derive purpose-specific keys from a master secret" is a Level 5 answer to a question that most candidates answer with "store multiple separate keys."

### Senior @ FAANG: Cryptography Summary as a Team Standard

At senior level, each bullet in this summary is a team engineering standard. The standard is enforced through code review checklists, linter rules, shared libraries, and security posture reviews.

**Standard ownership:** Assign an owner to each standard. The owner is responsible for: ensuring the standard is documented and accessible, monitoring compliance through automated metrics, updating the standard when the field evolves (new Go versions, new NIST recommendations, new vulnerability disclosures), and driving remediation when compliance gaps are identified. Without ownership, standards become aspirational rather than operational.

**Post-quantum integration:** The post-quantum readiness bullet is the newest addition to this summary. Staff engineers are responsible for incorporating post-quantum readiness into their team's cryptographic standard now, not when quantum computers arrive. The time to plan a multi-year migration is years before the deadline, not after it.

---

## Navigation

- **Previous Chapter:** [Chapter 107: Application Security](../chapter-107-application-security/18-summary.md)
- **Part Overview:** [Part XVII-A: Security](../00-part-intro.md)
- **Next Chapter:** [Chapter 109: Secrets Management](../chapter-109-secrets-management/00-introduction.md)
