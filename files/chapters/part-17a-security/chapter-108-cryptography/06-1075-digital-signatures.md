## 108.5 Digital Signatures

Digital signatures prove that a message was created by a specific sender and hasn't been modified. They're essential for authentication and non-repudiation.

### RSA Signatures

RSA signatures in Go hash the message with SHA-256 before signing, because RSA operates on fixed-size inputs and signing a collision-resistant digest is what binds the signature to the full message. The `rsa.SignPSS` function applies Probabilistic Signature Scheme padding, which produces a different signature for the same message on each invocation (unlike the deterministic PKCS1v15 scheme) and carries a security proof that PKCS1v15 lacks. The verifier must use the corresponding `rsa.VerifyPSS` with the same hash and PSS options. Mixing padding schemes between signer and verifier silently produces verification failures that can be mistaken for data corruption.

```go
package main

import (
    "crypto"
    "crypto/rand"
    "crypto/rsa"
    "crypto/sha256"
    "fmt"
)

func main() {
    // Generate key pair
    privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
    if err != nil {
        panic(err)
    }
    publicKey := &privateKey.PublicKey

    message := []byte("Important message to sign")

    // Hash the message
    hashed := sha256.Sum256(message)

    // Sign the hash using PSS (Probabilistic Signature Scheme)
    // PSS is the recommended signature scheme
    signature, err := rsa.SignPSS(
        rand.Reader,
        privateKey,
        crypto.SHA256,
        hashed[:],
        nil, // Default salt length
    )
    if err != nil {
        panic(err)
    }
    fmt.Printf("Signature: %x\n", signature)

    // Verify signature
    err = rsa.VerifyPSS(
        publicKey,
        crypto.SHA256,
        hashed[:],
        signature,
        nil,
    )
    if err != nil {
        fmt.Printf("Signature verification failed: %v\n", err)
    } else {
        fmt.Println("Signature verified successfully")
    }

    // Tamper with message
    message[0] ^= 0xff
    hashed = sha256.Sum256(message)
    err = rsa.VerifyPSS(publicKey, crypto.SHA256, hashed[:], signature, nil)
    if err != nil {
        fmt.Printf("Tampered message detected: %v\n", err)
    }
}
```

### ECDSA Signatures

ECDSA (Elliptic Curve Digital Signature Algorithm) provides the same security as RSA with much smaller keys and signatures.

```go
package main

import (
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/sha256"
    "fmt"
)

func main() {
    // Generate key pair using P-256 curve
    privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil {
        panic(err)
    }
    publicKey := &privateKey.PublicKey

    message := []byte("Important message to sign")
    hashed := sha256.Sum256(message)

    // Sign the hash
    signature, err := ecdsa.SignASN1(rand.Reader, privateKey, hashed[:])
    if err != nil {
        panic(err)
    }
    fmt.Printf("ECDSA Signature: %x\n", signature)

    // Verify signature
    valid := ecdsa.VerifyASN1(publicKey, hashed[:], signature)
    fmt.Printf("Signature valid: %v\n", valid)

    // Tamper with message
    message[0] ^= 0xff
    hashed = sha256.Sum256(message)
    valid = ecdsa.VerifyASN1(publicKey, hashed[:], signature)
    fmt.Printf("Tampered message valid: %v\n", valid)
}
```

### Junior → FAANG: Digital Signatures and Code Signing

Digital signatures appear in more contexts than most juniors realize: JWT validation, code signing, artifact integrity, API authentication. Understanding signatures in all these contexts is expected at FAANG companies.

**Gap to close:** Know the difference between a MAC and a digital signature. A MAC uses a shared secret and can only be verified by someone who knows the secret: it is symmetric. A digital signature uses asymmetric keys: the private key signs, the public key verifies, and anyone with the public key can verify without access to the private key. Use MACs for two-party authentication where both parties share a secret. Use signatures for multi-party or public verification.

**JWT signing context:** Most Go engineers encounter digital signatures through JWTs. `RS256` uses RSA signatures. `ES256` uses ECDSA P-256 signatures. `HS256` uses HMAC-SHA256 (which is not a signature, it is a MAC). Know which algorithm your JWT library uses and why. Prefer `ES256` over `RS256` for new systems: smaller signatures, faster verification, equivalent security.

**Interview framing:** When asked "how do you verify that a binary artifact has not been tampered with?", describe code signing: the build system signs the artifact hash with the build pipeline's private key, the deployment system verifies the signature against the public key before executing the artifact. This is the sigstore/cosign model used by modern supply chain security tooling.

### Senior @ FAANG: Digital Signature Infrastructure and Non-Repudiation

At senior level, digital signatures are organizational infrastructure, not just a cryptographic primitive. Decisions about key management, signature verification policy, and trust anchors have company-wide implications.

**Sigstore and transparency logs:** The modern approach to code signing uses transparency logs (append-only, publicly verifiable logs of all signing events) in addition to cryptographic signatures. Sigstore (rekor) provides this infrastructure. When your build pipeline signs an artifact, the signature is recorded in a transparency log. Consumers can verify both the signature and that the signing event is in the log. This detects key compromise: if an attacker steals your signing key and signs a malicious artifact, the unauthorized signing event will appear in the transparency log and can trigger alerts.

**Signature verification as a deployment gate:** At Google and Amazon, artifact signatures are verified by the deployment infrastructure before any binary is executed. This is a mandatory gate, not an advisory check. The verification policy specifies: which signing keys are trusted, which artifacts require a signature, and what happens when verification fails (deployment blocked, alert fired, on-call notified). Staff engineers define and maintain this verification policy for their product area.

**Key rotation for signing keys:** Signing keys must be rotatable without invalidating existing signed artifacts. The pattern is: each signing key has a version identifier, signed artifacts include the key version used for signing, the verification infrastructure can verify against any of the currently trusted key versions, and old key versions are retired on a schedule after all artifacts signed with them have been replaced by re-signed versions. Design this rotation mechanism before the first signing key is generated.

---
