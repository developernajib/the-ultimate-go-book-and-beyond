## 10B.10 Post-Quantum Cryptography (Go 1.26)

### Why Post-Quantum Cryptography Now?

Current public-key cryptography (RSA, ECDH, ECDSA) is vulnerable to attacks by sufficiently powerful quantum computers. NIST standardized post-quantum algorithms in 2024. Go's standard library implements them across recent releases: ML-KEM in `crypto/mlkem` (Go 1.24) and HPKE in `crypto/hpke` (Go 1.26).

```
Threat: "Harvest now, decrypt later"
Attacker today: records TLS-encrypted traffic
Future attacker: uses quantum computer to decrypt the captured traffic
Solution: switch to post-quantum key exchange now, before quantum computers exist
```

### ML-KEM (crypto/mlkem)

ML-KEM (Module Lattice Key Encapsulation Mechanism, FIPS 203) is the NIST-standardized replacement for ECDH in key exchange. The package `crypto/mlkem` landed in Go 1.24, with ML-KEM-768 and ML-KEM-1024 parameter sets. Unlike Diffie-Hellman, ML-KEM uses a KEM model: one party generates a keypair, the other encapsulates a random shared secret with the public key, and only the private key holder can recover it. The underlying hardness assumption, Module Learning With Errors, resists both classical and quantum attacks.

```go
import "crypto/mlkem"

// ML-KEM-768 (NIST Level 3, recommended for most uses)
func demonstrateMLKEM() error {
    // Alice generates a decapsulation key pair.
    dk, err := mlkem.GenerateKey768()
    if err != nil {
        return err
    }

    // Alice publishes her encapsulation key bytes.
    encapsulationKey := dk.EncapsulationKey().Bytes() // send to Bob

    // Bob reconstructs the encapsulation key and encapsulates a shared secret.
    ek, err := mlkem.NewEncapsulationKey768(encapsulationKey)
    if err != nil {
        return err
    }
    sharedSecretBob, ciphertext := ek.Encapsulate() // no error return

    // Alice decapsulates to get the same shared secret.
    sharedSecretAlice, err := dk.Decapsulate(ciphertext)
    if err != nil {
        return err
    }

    // Both parties now hold the same 32-byte secret without ever
    // transmitting it over the wire.
    fmt.Println("Keys match:", bytes.Equal(sharedSecretAlice, sharedSecretBob))
    return nil
}
```

### Hybrid Key Exchange in TLS (default since Go 1.24)

Go has enabled hybrid key exchange in TLS by default since Go 1.24, when `X25519MLKEM768` (X25519 ECDH + ML-KEM-768) became the default whenever `Config.CurvePreferences` is nil. Go 1.26 widens the default set to also offer the NIST P-curve hybrids `SecP256r1MLKEM768` and `SecP384r1MLKEM1024`. "Hybrid" means both algorithms must be broken to compromise the session, a quantum computer can break the classical ECDH half but not the ML-KEM half, while no known classical attack breaks ML-KEM efficiently. None of this requires code changes: existing TLS servers and clients pick the hybrids up automatically after upgrading (revert all with `GODEBUG=tlsmlkem=0`, P-curve hybrids only with `GODEBUG=tlssecpmlkem=0`).

```go
import "crypto/tls"

// Default TLS config includes X25519MLKEM768 since Go 1.24.
// Go 1.26 adds SecP256r1MLKEM768 and SecP384r1MLKEM1024 to the default set.
// No code changes needed: these are on by default.

// Explicit configuration:
tlsConfig := &tls.Config{
    // Go 1.26 default includes hybrid curves automatically
    // To opt out (not recommended):
    // CurvePreferences: []tls.CurveID{tls.CurveP256, tls.X25519},

    // Or to explicitly prefer hybrid:
    CurvePreferences: []tls.CurveID{
        tls.SecP256r1MLKEM768, // Hybrid: P-256 + ML-KEM-768
        tls.X25519MLKEM768,    // Hybrid: X25519 + ML-KEM-768
        tls.CurveP256,         // Fallback for older clients
        tls.X25519,            // Fallback for older clients
    },
    MinVersion: tls.VersionTLS13, // ML-KEM only works in TLS 1.3
}
```

### HPKE (crypto/hpke), Hybrid Public Key Encryption

HPKE (RFC 9180) combines a key encapsulation mechanism, a key derivation function, and an AEAD cipher into a single construction. It replaces the ad-hoc patterns developers previously built by hand-wiring ECDH key agreement to AES-GCM or ChaCha20-Poly1305. Go 1.26's implementation supports multiple cipher suites, including ML-KEM-based post-quantum variants.

```go
import (
    "crypto/ecdh"
    "crypto/hpke"
    "log"
)

// HPKE replaces ad-hoc "encrypt with RSA or ECDH" patterns

// Setup: recipient generates a key pair (DHKEM over P-256 here)
kem := hpke.DHKEM(ecdh.P256())
recipientKey, err := kem.GenerateKey()
if err != nil {
    log.Fatal(err)
}

// Sender encrypts a message for the recipient
encapKey, sender, err := hpke.NewSender(
    recipientKey.PublicKey(), hpke.HKDFSHA256(), hpke.AES128GCM(), []byte("app context"))
if err != nil {
    log.Fatal(err)
}

plaintext := []byte("secret message")
aad := []byte("authenticated but not encrypted")
ciphertext, err := sender.Seal(aad, plaintext)
if err != nil {
    log.Fatal(err)
}

// Recipient decrypts
receiver, err := hpke.NewRecipient(
    encapKey, recipientKey, hpke.HKDFSHA256(), hpke.AES128GCM(), []byte("app context"))
if err != nil {
    log.Fatal(err)
}
decrypted, err := receiver.Open(aad, ciphertext)
if err != nil {
    log.Fatal(err)
}
// decrypted == plaintext
_ = decrypted

// HPKE with ML-KEM (post-quantum HPKE)
pqKEM := hpke.MLKEM768()
pqKey, err := pqKEM.GenerateKey()
if err != nil {
    log.Fatal(err)
}
pqEncap, pqSender, err := hpke.NewSender(
    pqKey.PublicKey(), hpke.HKDFSHA256(), hpke.AES256GCM(), []byte("app context"))
if err != nil {
    log.Fatal(err)
}
_ = pqSender
_ = pqEncap
// Seal and Open work exactly as above, only the KEM changed
```

---
