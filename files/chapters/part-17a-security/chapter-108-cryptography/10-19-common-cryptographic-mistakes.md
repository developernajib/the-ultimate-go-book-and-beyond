## 108.9 Common Cryptographic Mistakes

### Mistake 1: Using ECB or CBC Mode Without Authentication

CBC mode encrypts data in chained blocks but provides no integrity guarantee, leaving ciphertext open to padding oracle attacks where an attacker systematically manipulates bytes to decrypt arbitrary messages. ECB mode is worse still: each block is encrypted independently, so identical plaintext blocks produce identical ciphertext blocks, leaking structural patterns in the data.

```go
// NEVER DO THIS
// CBC mode without authentication allows padding oracle attacks
cipher.NewCBCEncrypter(block, iv) // No integrity protection!

// ECB mode is even worse - identical plaintext blocks produce
// identical ciphertext blocks, revealing patterns:
// block.Encrypt(ciphertext, plaintext) // in a loop = ECB
```

**Fix**: Use GCM mode for authenticated encryption.

### Mistake 2: Reusing Nonces/IVs

A nonce (number used once) is only safe when it is truly unique per encryption operation under a given key. Reusing a nonce with GCM allows an attacker to XOR two ciphertexts together and recover keystream material. The code below demonstrates the pattern to avoid: calling `gcm.Seal` twice with the exact same nonce value, which catastrophically breaks confidentiality.

```go
// NEVER DO THIS
nonce := make([]byte, 12)
// Reusing same nonce with same key breaks security
gcm.Seal(nonce, nonce, plaintext1, nil)
gcm.Seal(nonce, nonce, plaintext2, nil) // BROKEN!
```

**Fix**: Generate a new random nonce for every encryption.

### Mistake 3: Not Authenticating Ciphertext

Encryption alone ensures confidentiality but not integrity: a network attacker can flip bits in the ciphertext, causing the decrypted plaintext to be silently corrupted or crafted to exploit the consuming code. Without a MAC or an AEAD mode like GCM, there is no way for the receiver to distinguish a legitimate ciphertext from a tampered one.

```go
// NEVER DO THIS
// Using encryption without authentication allows tampering
ciphertext := encryptCBC(plaintext, key)
// Attacker can modify ciphertext
```

**Fix**: Use authenticated encryption (GCM) or add HMAC.

### Mistake 4: Weak Password Hashing

General-purpose hash functions like SHA-256 are designed to be fast, which is the opposite of what you want for password storage: an attacker with a GPU can compute billions of SHA-256 hashes per second and crack common passwords in minutes. Password-specific algorithms like bcrypt and argon2 introduce a tunable cost factor that keeps brute-force attacks computationally expensive even as hardware improves.

```go
// NEVER DO THIS
hash := sha256.Sum256([]byte(password)) // Fast = crackable
```

**Fix**: Use bcrypt or argon2.

### Mistake 5: Predictable Randomness

`math/rand` is a pseudorandom number generator optimized for speed and uniformity in simulations, not for unpredictability. An attacker who knows or guesses the seed can reproduce every value it produces. Cryptographic keys, nonces, tokens, and any other security-sensitive byte sequences must be generated with `crypto/rand`, which reads from the OS entropy pool.

```go
// NEVER DO THIS: math/rand is NOT cryptographically secure
key := make([]byte, 32)
rand.Read(key) // Predictable output: do not use math/rand for secrets
```

**Fix**: Always use `crypto/rand`.

### Mistake 6: Ignoring Errors

Cryptographic operations in Go return errors to signal authentication tag mismatches, malformed inputs, and other failure modes that indicate active tampering or data corruption. Discarding those errors with `_` means the program silently continues with a nil or zero-value plaintext, potentially processing attacker-controlled data as if it were legitimate.

```go
// NEVER DO THIS
plaintext, _ := decrypt(ciphertext, key)
// Ignoring errors can lead to using corrupted data
```

**Fix**: Always check errors, especially in crypto operations.

### Junior → FAANG: Avoiding the Most Dangerous Cryptographic Mistakes

Cryptographic mistakes are uniquely dangerous because they often produce code that appears to work correctly while providing no security. Tests pass, the application runs, and the vulnerability is invisible until a breach occurs.

**Gap to close:** Understand why AES-ECB is always wrong for anything except exactly one block of data. ECB mode encrypts each 16-byte block independently with the same key. Identical plaintext blocks produce identical ciphertext blocks, which leaks patterns in the plaintext. The classic demonstration is encrypting an image: the ECB-encrypted image shows the outlines of the original image. For any data longer than one block, use GCM.

**First-job habit:** Before using any cryptographic function, check: am I using an authenticated mode (GCM, CCM, or GCM-SIV for symmetric encryption)? Am I generating the nonce/IV correctly (crypto/rand, fresh for each operation)? Am I checking errors? Am I using constant-time comparison for the output? These four questions catch the majority of cryptographic mistakes.

**Interview framing:** When an interviewer presents code using CBC mode or ECB mode, identify it as a problem immediately. Explain why (no authentication in CBC leads to padding oracle attacks, ECB leaks patterns). Propose GCM as the replacement and explain what "authenticated encryption" means (encryption plus integrity verification in a single operation).

### Senior @ FAANG: Systematic Cryptographic Mistake Prevention

At senior level, preventing individual cryptographic mistakes is not the goal. The goal is making the mistake impossible to make by default.

**Wrappers that eliminate mistakes:** Build cryptographic wrapper functions for your team that accept only safe inputs and produce correct outputs. A `EncryptAES256GCM(key, plaintext []byte) ([]byte, error)` function that handles nonce generation, GCM initialization, and ciphertext formatting internally eliminates the entire class of nonce reuse and mode selection mistakes for callers. Callers cannot accidentally use ECB or CBC because the wrapper does not expose those modes. This is the "paved road" approach applied to cryptography.

**Library selection over primitive assembly:** At org scale, evaluate cryptographic libraries that are designed to be safe by default. Google's Tink library exposes only safe primitives (no ECB, no CBC without authentication, no MD5) and makes the safe choice the only choice. Adopting Tink org-wide eliminates an entire class of cryptographic mistakes by removing the ability to make them.

**Code review for cryptographic code:** Establish a requirement that any code touching cryptographic primitives directly (not through a wrapper or library) requires review by a designated cryptography reviewer. The reviewer checks: algorithm selection, mode selection, nonce/IV generation, authentication tag verification, error handling, and key management. This review requirement applies even to experienced engineers: cryptographic code is subtle enough that fresh eyes add value regardless of experience level.

---
