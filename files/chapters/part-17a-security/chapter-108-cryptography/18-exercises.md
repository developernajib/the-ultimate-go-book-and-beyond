## Exercises

1. **AES-GCM File Encryption CLI**: Build a command-line tool that encrypts and decrypts arbitrary files using AES-256-GCM. The tool must derive a key from a passphrase using Argon2id (not PBKDF2), store the salt and nonce alongside the ciphertext in a structured binary header, and verify the authentication tag on decryption to detect tampering. Expected outcome: a portable encrypted file format that fails loudly on any modification.

2. **RSA Signing and Verification Service**: Implement an HTTP service that issues signed JSON payloads using RSA-PSS with SHA-256 and exposes a `/verify` endpoint that confirms signature validity. Generate a 4096-bit key pair on startup, persist the private key as an encrypted PEM file (AES-256-CBC, passphrase from environment), and publish the public key as JWKS at `/.well-known/jwks.json`. Expected outcome: a lightweight signing authority that any JWKS-aware client can verify against.

3. **ECDH Key Exchange Protocol**: Implement a two-party ECDH key agreement over P-256 in Go using only the standard library `crypto/ecdh` package. Both peers generate ephemeral key pairs, exchange public keys over a simulated channel, derive a shared secret, and then use HKDF-SHA256 to produce separate encryption and MAC keys. Expected outcome: identical derived keys on both sides, confirmed by encrypting and decrypting a test message end-to-end.

4. **Hybrid HPKE Encryption Library**: Wrap the standard library `crypto/hpke` suite (KEM_P256_HKDF_SHA256 + AES-256-GCM) into a reusable Go package with a clean `Encrypt(recipientPubKey, plaintext, context []byte) ([]byte, error)` / `Decrypt(recipientPrivKey, ciphertext, context []byte) ([]byte, error)` API. Write table-driven unit tests covering wrong key, wrong context, and truncated ciphertext cases. Expected outcome: a drop-in encryption package with 100% branch coverage on error paths.

5. **Post-Quantum Hybrid TLS Server**: Configure a Go TLS server to advertise both X25519 and the X25519+ML-KEM-768 hybrid key-exchange group. Write a test client that records which group was negotiated, asserts the hybrid group is selected when the server offers it, and falls back gracefully to X25519 when the hybrid group is unavailable. Expected outcome: a server that is quantum-safe for clients that support hybrid KEM and classically safe for all others.

6. **Cryptographic Audit Logger**: Build a tamper-evident log writer that appends entries as `hash(prev_hash || timestamp || message)` using SHA-256 chain linking. Expose a `Verify() error` method that replays the chain from genesis and returns the first corrupted entry index if any link is broken. Store entries in an append-only file and write a fuzzer that flips random bytes and confirms that `Verify` always detects the corruption. Expected outcome: any single-byte modification anywhere in the log file is detected within O(n) verification time.

**Next Chapter**: Chapter 109: Secrets Management - Learn how to manage, rotate, and secure cryptographic keys and secrets at scale using HashiCorp Vault and cloud KMS systems.

### Junior → FAANG: Maximizing the Value of Cryptography Exercises

These exercises are deliberately challenging. Completing them correctly, including handling all error cases and writing the specified tests, is equivalent to demonstrating cryptographic competence in a take-home interview.

**Gap to close:** Exercise 1 (AES-GCM file encryption) is the most important. If you can implement it correctly including: Argon2id key derivation with correct parameters, correct nonce generation and storage, authentication tag verification, and a fuzzer that catches tampering, you have demonstrated the core AES-GCM skill set completely.

**Portfolio value:** These exercises produce runnable Go programs. Keep them in a personal repository. When interviewers ask for examples of your security work, pointing to a correctly implemented AES-GCM tool with proper tests is more persuasive than describing the theory.

### Senior @ FAANG: Using These Exercises as Interview Take-Homes

The exercises in this section are calibrated to FAANG-level take-home interview standards. They can be used directly as take-home exercises for senior engineering candidates.

**Evaluation criteria for Exercise 1:** Correct argon2id parameters (memory 64MB, iterations 3, parallelism 4, key length 32 bytes). Fresh crypto/rand nonce per encryption. Structured binary header including salt, nonce, and version. Authentication tag verification that returns an error (not panic) on failure. A working fuzzer that confirms any single-byte modification is detected. Candidates who produce this correctly without reference to solutions demonstrate production-grade cryptographic engineering skills.

**Escalation exercises for L6 candidates:** For senior candidates, escalate Exercise 1: "Your encryption CLI needs to support key rotation. Add a `--rekey` flag that decrypts a file with an old passphrase and re-encrypts with a new one. The file format must be backward compatible." This escalation tests cryptographic agility and format versioning design, which are L6-level concerns.

---
