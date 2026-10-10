## End-to-End Encryption

End-to-end encryption (E2E) is the cornerstone of WhatsApp's privacy model. It means that only the sender and recipient can read a message: the server stores opaque ciphertext and holds no key that would open it.

Be precise about what that does and does not buy, because interviewers push on exactly this point. E2E protects message *content*. It does not hide *metadata*. The server still routes the message, so it necessarily learns who is talking to whom, when, how often, from which IP, with what message sizes, and in which groups. That social graph is frequently more revealing than the text, and it is why the server can honestly answer a lawful request for "who did this account message" while being unable to answer "what did they say". Sealed sender, which Signal deploys and which hides the sender identity from the server, narrows this but does not eliminate it: delivery still reveals the recipient and the timing. Avoid the phrase "zero knowledge" here. It is a term of art for zero-knowledge proofs, and it is not what E2E provides.

The implementation below demonstrates the core building blocks: Curve25519 for Diffie-Hellman key exchange, HKDF to turn the raw DH output into a usable key, and an AEAD for the message itself. Production WhatsApp uses the full Signal Protocol, which layers X3DH key agreement and the Double Ratchet on top of these primitives to add forward secrecy and break-in recovery. One detail worth not misremembering: the Double Ratchet does not encrypt messages with AES-GCM. The specification recommends an AEAD built either on SIV or on a composition of CBC with HMAC, and the concrete recommendation it spells out is AES-256-CBC with PKCS#7 padding plus HMAC-SHA256 in an encrypt-then-MAC arrangement. The message key is not used directly: HKDF expands it into 80 bytes that are split into an encryption key, an authentication key, and an IV, and the HMAC covers the associated data prepended to the ciphertext. The code below uses AES-256-GCM instead, because it is one call in the standard library and the subject here is the key exchange rather than the record layer. Say "an AEAD" in an interview unless you are certain which one.

```go
package e2e

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"

	"golang.org/x/crypto/curve25519"
)

// Simplified for illustration. In production use a maintained implementation
// of the Signal Protocol rather than assembling X3DH and the Double Ratchet
// yourself. This code shows the primitives, not a protocol.

// KeyPair is a Curve25519 key pair
type KeyPair struct {
	Private [32]byte
	Public  [32]byte
}

// GenerateKeyPair creates a new Curve25519 key pair.
//
// The private scalar is uniform random. RFC 7748 clamping (clearing the low
// three bits, forcing bit 254) is applied inside the X25519 implementation, so
// it is not done here.
func GenerateKeyPair() (*KeyPair, error) {
	kp := &KeyPair{}
	if _, err := rand.Read(kp.Private[:]); err != nil {
		return nil, err
	}
	pub, err := curve25519.X25519(kp.Private[:], curve25519.Basepoint)
	if err != nil {
		return nil, fmt.Errorf("derive public key: %w", err)
	}
	copy(kp.Public[:], pub)
	return kp, nil
}

// DeriveSharedSecret computes the Diffie-Hellman shared secret.
//
// Two things here are load-bearing, and both are routinely got wrong.
//
// First, this uses X25519 rather than the deprecated ScalarMult, and it must.
// theirPublic arrives over the network from someone who may be hostile. A
// handful of Curve25519 points have order 1, 2, 4 or 8, and multiplying any
// scalar by one of them yields all zeroes. ScalarMult returns those zeroes
// without complaint, so two parties who have never met would derive the very
// same key: SHA-256 of thirty-two zero bytes, a constant an attacker
// precomputes once and reuses forever. That is a total loss of confidentiality
// from a peer simply publishing a chosen public key. X25519 returns an error
// for exactly this case, which is why ScalarMult carries a deprecation notice.
//
// Second, the raw DH output is not a key. It is a uniformly random *point*, not
// uniformly random *bits*, and its low bits carry structure. Hashing it once
// with SHA-256 is better than nothing, but HKDF is the right tool: Extract
// concentrates the entropy, Expand binds the result to a context string, so the
// same DH secret used for two purposes yields two unrelated keys.
func DeriveSharedSecret(myPrivate, theirPublic [32]byte) ([32]byte, error) {
	var out [32]byte

	shared, err := curve25519.X25519(myPrivate[:], theirPublic[:])
	if err != nil {
		// Low-order point, or otherwise unusable peer key. Abort the session:
		// there is no safe way to continue.
		return out, fmt.Errorf("invalid peer public key: %w", err)
	}

	key, err := hkdf.Key(sha256.New, shared, nil, "whatsapp-clone/v1 message key", 32)
	if err != nil {
		return out, fmt.Errorf("hkdf: %w", err)
	}
	copy(out[:], key)
	return out, nil
}

// EncryptMessage encrypts with AES-256-GCM
func EncryptMessage(key [32]byte, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// DecryptMessage decrypts AES-256-GCM ciphertext
func DecryptMessage(key [32]byte, encoded string) ([]byte, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ciphertext, nil)
}

// Real WhatsApp uses the Signal Protocol (X3DH + Double Ratchet). The server
// never holds message keys: they exist only on devices. It does, unavoidably,
// see the routing metadata around every message.
```

---
