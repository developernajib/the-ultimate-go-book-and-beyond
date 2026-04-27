export default `## 10B.10 Post-Quantum Cryptography (Go 1.26)

### Why Post-Quantum Cryptography Now?

Current public-key cryptography (RSA, ECDH, ECDSA) is vulnerable to attacks by sufficiently powerful quantum computers. NIST standardized post-quantum algorithms in 2024. Go 1.26 implements them.

\`\`\`
Threat: "Harvest now, decrypt later"
Attacker today: records TLS-encrypted traffic
Future attacker: uses quantum computer to decrypt the captured traffic
Solution: switch to post-quantum key exchange now, before quantum computers exist
\`\`\`

### ML-KEM (crypto/mlkem)

ML-KEM (Module Lattice Key Encapsulation Mechanism, FIPS 203) is the NIST-standardized replacement for ECDH in key exchange. The package \`crypto/mlkem\` landed in Go 1.24, with ML-KEM-768 and ML-KEM-1024 parameter sets. Unlike Diffie-Hellman, ML-KEM uses a KEM model: one party generates a keypair, the other encapsulates a random shared secret with the public key, and only the private key holder can recover it. The underlying hardness assumption, Module Learning With Errors, resists both classical and quantum attacks.

\`\`\`go
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
\`\`\`

### Hybrid Key Exchange in TLS (Go 1.26 Default)

Go 1.26 enables hybrid key exchange in TLS by default, combining classical ECDH with ML-KEM. "Hybrid" means both algorithms must be broken to compromise the session, a quantum computer can break ECDH but not ML-KEM, while no known classical attack breaks ML-KEM efficiently. The default \`SecP256r1MLKEM768\` curve requires no code changes. Existing TLS servers and clients pick it up automatically after upgrading.

\`\`\`go
import "crypto/tls"

// Go 1.26 default TLS config includes SecP256r1MLKEM768
// (X25519 ECDH + ML-KEM-768 hybrid)
// No code changes needed - it's the default

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
\`\`\`

### HPKE (crypto/hpke), Hybrid Public Key Encryption

HPKE (RFC 9180) combines a key encapsulation mechanism, a key derivation function, and an AEAD cipher into a single construction. It replaces the ad-hoc patterns developers previously built by hand-wiring ECDH key agreement to AES-GCM or ChaCha20-Poly1305. Go 1.26's implementation supports multiple cipher suites, including ML-KEM-based post-quantum variants.

\`\`\`go
import "crypto/hpke"

// HPKE replaces ad-hoc "encrypt with RSA or ECDH" patterns

// Setup: Recipient generates a key pair
recipientKey, err := ecdh.P256().GenerateKey(rand.Reader)
if err != nil {
    log.Fatal(err)
}

// Sender encrypts a message for the recipient
suite := hpke.NewSuite(hpke.KEM_P256_HKDF_SHA256, hpke.KDF_HKDF_SHA256, hpke.AEAD_AES128GCM)
sender, encapKey, err := suite.NewSender(recipientKey.PublicKey(), []byte("app context"))
if err != nil {
    log.Fatal(err)
}

plaintext := []byte("secret message")
aad := []byte("authenticated but not encrypted")
ciphertext, err := sender.Seal(aad, plaintext)

// Recipient decrypts
receiver, err := suite.NewReceiver(recipientKey, []byte("app context"))
if err != nil {
    log.Fatal(err)
}
decrypted, err := receiver.Open(encapKey, aad, ciphertext)
// decrypted == plaintext

// HPKE with ML-KEM (post-quantum HPKE)
pqSuite := hpke.NewSuite(hpke.KEM_MLKEM768, hpke.KDF_HKDF_SHA256, hpke.AEAD_AES256GCM)
// Usage is identical - just use pqSuite instead of suite
\`\`\`

---
`;
