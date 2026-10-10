## 108.10 Company Case Studies: Cryptography at Scale

### Google: Tink Library

Google developed Tink for safe, easy-to-use cryptography:

```go
// Google Tink-style envelope encryption
package crypto

import (
    "github.com/tink-crypto/tink-go/v2/aead"
    "github.com/tink-crypto/tink-go/v2/keyset"
    "github.com/tink-crypto/tink-go/v2/tink"
)

func NewTinkAEAD() (tink.AEAD, error) {
    kh, err := keyset.NewHandle(aead.AES256GCMKeyTemplate())
    if err != nil {
        return nil, err
    }
    return aead.New(kh)
}
```

### Stripe: Payment Encryption

Stripe's approach to PCI-compliant encryption:

```go
package stripe

import (
    "crypto/cipher"
)

// Stripe-style field-level encryption
type FieldEncryptor struct {
    aead cipher.AEAD
}

func (e *FieldEncryptor) EncryptPAN(pan string) ([]byte, error) {
    // Tokenize, don't encrypt actual card numbers
    // Store only last 4 digits with token reference
    if len(pan) < 4 {
        return []byte("tok_invalid"), nil
    }
    return []byte("tok_" + pan[len(pan)-4:]), nil
}
```

### Amazon: KMS Integration

Amazon's envelope encryption pattern with KMS:

```go
package aws

import "context"

// AWS KMS envelope encryption
func EncryptWithKMS(ctx context.Context, data []byte) ([]byte, error) {
    // Generate data key from KMS
    // Encrypt data with data key
    // Return encrypted data key + ciphertext
    return data, nil
}
```

**Cryptography Patterns by Company**:

| Company | Key Management | Encryption Pattern |
|---------|---------------|-------------------|
| Google | Tink/Cloud KMS | Envelope encryption |
| Stripe | Vault + HSM | Field-level encryption |
| Amazon | KMS | Data key caching |

### Junior → FAANG: Learning From How Large Companies Handle Cryptography

The patterns used by Google, Stripe, and Amazon are not arbitrary. They are the result of operating at scale under regulatory scrutiny with adversarial threat models. Understanding why they made specific choices is more valuable than memorizing what they did.

**Gap to close:** Understand envelope encryption as a pattern, not just as "what Google does." Envelope encryption separates the concern of key security (handled by KMS infrastructure) from the concern of data encryption (handled by application code). This separation means application code never handles master keys, key rotation can happen at the KMS layer without touching application code, and access to encrypted data does not require access to the master key.

**Interview framing:** When asked "how would you implement field-level encryption for sensitive user data?", describe the envelope encryption pattern: generate a DEK per record, encrypt the field with the DEK, encrypt the DEK with a KEK from KMS, store the encrypted DEK with the record. This is the Stripe model and demonstrates production-level cryptographic system design.

### Senior @ FAANG: Designing Cryptographic Systems at FAANG Scale

The case studies in this section represent the outcome of years of iteration. Staff engineers at these companies made the architectural decisions that produced these systems. Understanding the decision-making process is the senior learning.

**Scale considerations that drive architectural choices:** Google encrypts data at rest at multiple layers (storage layer, service layer, and sometimes at the field level for the most sensitive data). The decision to add a layer is driven by threat modeling: what is the risk if the storage layer key is compromised? What is the blast radius? Each additional encryption layer reduces the blast radius of a key compromise at the cost of operational complexity and latency. Staff engineers make this trade-off explicitly and document it.

**Tink as a policy mechanism:** Google's decision to build and use Tink is not just a technical decision: it is a governance decision. By providing a library that makes safe choices the only choices, Google eliminated a class of cryptographic mistakes across thousands of engineers and services. The investment in building and maintaining Tink is justified by the risk reduction across the entire organization. Staff engineers evaluate whether building shared infrastructure (like Tink) is justified by the org-wide risk reduction, or whether adopting an existing library (like Tink itself) is the right choice.

**Data key caching trade-offs:** Amazon KMS supports data key caching: instead of calling KMS on every encryption operation, cache the DEK in memory for a configurable time window. This reduces KMS API calls (important for cost and latency at very high encryption volumes) but creates a window during which a revoked key is still in use. The correct cache TTL depends on the sensitivity of the data and the acceptable revocation delay. Document this trade-off explicitly in your architecture.

---
