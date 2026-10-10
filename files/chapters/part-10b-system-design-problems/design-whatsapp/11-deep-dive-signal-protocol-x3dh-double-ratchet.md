## Deep Dive: Signal Protocol (X3DH + Double Ratchet)

The Signal Protocol is what gives WhatsApp its strong encryption guarantees. It combines two mechanisms: X3DH (Extended Triple Diffie-Hellman) for the initial key exchange when two users start a conversation, and the Double Ratchet algorithm for ongoing message encryption.

Get the two guarantees straight, because they come from different halves of the design and interviewers do ask which is which. **Forward secrecy** means an attacker who steals your keys today cannot read yesterday's messages. It comes from the *symmetric* ratchet: the chain key is hashed forward for every message and the old one is destroyed, and a hash cannot be run backwards. **Break-in recovery**, also called post-compromise security, means that an attacker who steals your keys today loses the ability to read messages at some point in the *future*. That one comes from the *DH* ratchet: each time the conversation changes direction, both sides mix a fresh Diffie-Hellman output into the root key, and an attacker who is not actively intercepting those new public keys is locked back out. The symmetric ratchet alone cannot give you this: an attacker holding a chain key can hash it forward forever. Saying "forward secrecy means past and future messages are safe" merges two distinct properties with two distinct mechanisms, and it is a reliable way to signal that you have read a summary rather than the spec.

Why two ratchets rather than one? The DH ratchet is the strong one, but it can only turn when the other side replies, and a monologue of forty messages produces no round trips. The symmetric ratchet fills those gaps, giving per-message forward secrecy between DH steps. The pair covers both cases.

The code below is a simplified implementation to illustrate the concepts. Production systems use libsignal, and the gap between the two is enormous: what follows omits header encryption, out-of-order window limits, replay protection, and the constant-time discipline that real cryptographic code requires. Note also that this uses AES-GCM for the record layer, while the Double Ratchet specification recommends AES-256-CBC with HMAC-SHA256 in an encrypt-then-MAC construction. GCM is used here to keep the focus on the ratchet.

```go
package signal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/curve25519"
)

// ---------- X3DH ----------

// KeyBundle is what a sender fetches for an offline recipient.
type KeyBundle struct {
	IdentityKey   [32]byte
	SignedPreKey  [32]byte
	OneTimePreKey *[32]byte // nil when the recipient's pool is exhausted
}

// X3DHResult is the output of the handshake.
type X3DHResult struct {
	SharedSecret   [32]byte
	AssociatedData []byte
}

// InitiateSession performs the sender's half of X3DH.
//
// The four DH values are not interchangeable, and each is there for a reason:
//
//	DH1 = DH(IK_A, SPK_B)  authenticates A to B  (A's long-term identity)
//	DH2 = DH(EK_A, IK_B)   authenticates B to A  (B's long-term identity)
//	DH3 = DH(EK_A, SPK_B)  forward secrecy       (both ephemeral-ish)
//	DH4 = DH(EK_A, OPK_B)  one-time forward secrecy, when a prekey is available
//
// Drop DH1 and anyone could impersonate A. Drop DH2 and A has no proof it is
// talking to B. Drop DH3 and compromising both identity keys retroactively
// opens every session. They are combined by concatenation and then run through
// a KDF, so the secret is only as compromised as the *weakest combination* an
// attacker holds, which is to say all of them or none.
//
// OPK is optional by design: a sender must be able to open a session while the
// recipient is offline and their one-time prekeys are used up. Sessions without
// DH4 have slightly weaker forward secrecy for the first message, which is the
// price of asynchrony.
func InitiateSession(aIdentityPriv, aIdentityPub, aEphemeralPriv, aEphemeralPub [32]byte, bob KeyBundle) (*X3DHResult, error) {
	dh1, err := dh(aIdentityPriv, bob.SignedPreKey)
	if err != nil {
		return nil, fmt.Errorf("dh1: %w", err)
	}
	dh2, err := dh(aEphemeralPriv, bob.IdentityKey)
	if err != nil {
		return nil, fmt.Errorf("dh2: %w", err)
	}
	dh3, err := dh(aEphemeralPriv, bob.SignedPreKey)
	if err != nil {
		return nil, fmt.Errorf("dh3: %w", err)
	}

	// The X3DH spec prepends F, a byte string of 0xFF the length of a curve
	// scalar, to domain-separate this KDF from any other use of the curve.
	secret := make([]byte, 0, 32*5)
	for i := 0; i < 32; i++ {
		secret = append(secret, 0xFF)
	}
	secret = append(secret, dh1[:]...)
	secret = append(secret, dh2[:]...)
	secret = append(secret, dh3[:]...)

	if bob.OneTimePreKey != nil {
		dh4, err := dh(aEphemeralPriv, *bob.OneTimePreKey)
		if err != nil {
			return nil, fmt.Errorf("dh4: %w", err)
		}
		secret = append(secret, dh4[:]...)
	}

	sk, err := hkdf.Key(sha256.New, secret, nil, "WhatsAppClone/X3DH/v1", 32)
	if err != nil {
		return nil, fmt.Errorf("kdf: %w", err)
	}

	// AD binds both identity keys into every message's authentication tag, so
	// a swapped identity key breaks decryption instead of going unnoticed.
	ad := make([]byte, 0, 64)
	ad = append(ad, aIdentityPub[:]...)
	ad = append(ad, bob.IdentityKey[:]...)

	var out X3DHResult
	copy(out.SharedSecret[:], sk)
	out.AssociatedData = ad
	return &out, nil
}

// dh wraps X25519. It returns an error rather than a silent all-zero secret
// when the peer supplies a low-order point, which the deprecated ScalarMult
// would not.
func dh(priv, pub [32]byte) ([32]byte, error) {
	var out [32]byte
	s, err := curve25519.X25519(priv[:], pub[:])
	if err != nil {
		return out, fmt.Errorf("x25519: %w", err)
	}
	copy(out[:], s)
	return out, nil
}

// ---------- Double Ratchet ----------

const maxSkip = 1000

// skippedKey identifies a message key held for an out-of-order message.
type skippedKey struct {
	dhPub   [32]byte
	counter int
}

// DoubleRatchet holds one side of a conversation.
type DoubleRatchet struct {
	DHSendPriv, DHSendPub [32]byte
	DHRecvPub             [32]byte
	RootKey               [32]byte
	SendChain, RecvChain  [32]byte
	SendCount, RecvCount  int
	PrevChainLen          int

	// Message keys for messages that arrived late or not at all. Without this
	// the ratchet only decrypts a perfectly ordered stream, and a single
	// reordered packet on a mobile network breaks the conversation forever.
	Skipped map[skippedKey][32]byte
}

// EncMsg is the wire format. DHPub is the header that drives the DH ratchet,
// PrevChainLen tells the receiver how many messages the previous chain held so
// it knows how many keys to skip.
type EncMsg struct {
	DHPub        [32]byte
	Counter      int
	PrevChainLen int
	Ciphertext   []byte
}

// Encrypt ratchets the sending chain forward and encrypts one message.
func (r *DoubleRatchet) Encrypt(plaintext, ad []byte) (EncMsg, error) {
	mk := chainStep(&r.SendChain)
	r.SendCount++

	ct, err := gcmEnc(mk[:], plaintext, ad)
	if err != nil {
		return EncMsg{}, err
	}
	return EncMsg{
		DHPub:        r.DHSendPub,
		Counter:      r.SendCount,
		PrevChainLen: r.PrevChainLen,
		Ciphertext:   ct,
	}, nil
}

// Decrypt handles the three cases that matter: a message from a new DH chain,
// a message that skipped ahead, and a straggler from an old chain.
func (r *DoubleRatchet) Decrypt(msg EncMsg, ad []byte) ([]byte, error) {
	// A straggler whose key we saved earlier.
	if mk, ok := r.Skipped[skippedKey{msg.DHPub, msg.Counter}]; ok {
		pt, err := gcmDec(mk[:], msg.Ciphertext, ad)
		if err != nil {
			return nil, err
		}
		// One-time use. Keeping it would defeat forward secrecy and allow
		// replay of the same message.
		delete(r.Skipped, skippedKey{msg.DHPub, msg.Counter})
		return pt, nil
	}

	// The peer moved to a new DH key: bank the tail of the old chain, then turn
	// the ratchet.
	if msg.DHPub != r.DHRecvPub {
		if err := r.skipTo(msg.PrevChainLen); err != nil {
			return nil, err
		}
		if err := r.advanceRatchet(msg.DHPub); err != nil {
			return nil, err
		}
	}

	// Messages ahead of us in the current chain: derive and bank the keys we
	// jumped over so those messages still decrypt if they turn up later.
	if err := r.skipTo(msg.Counter - 1); err != nil {
		return nil, err
	}

	mk := chainStep(&r.RecvChain)
	r.RecvCount++
	return gcmDec(mk[:], msg.Ciphertext, ad)
}

// skipTo advances the receiving chain to until, storing each message key it
// passes over.
func (r *DoubleRatchet) skipTo(until int) error {
	if until-r.RecvCount > maxSkip {
		// An attacker could otherwise send Counter = 2^31 and make us derive
		// two billion keys. Bounding the window is not optional.
		return errors.New("too many skipped messages")
	}
	if r.Skipped == nil {
		r.Skipped = make(map[skippedKey][32]byte)
	}
	for r.RecvCount < until {
		mk := chainStep(&r.RecvChain)
		r.RecvCount++
		r.Skipped[skippedKey{r.DHRecvPub, r.RecvCount}] = mk
	}
	return nil
}

// advanceRatchet performs a DH ratchet step. The order is load-bearing: the
// receiving chain is derived from the *old* sending key against the new peer
// key, and only then is a fresh key pair generated for the new sending chain.
func (r *DoubleRatchet) advanceRatchet(newPub [32]byte) error {
	r.PrevChainLen = r.SendCount
	r.SendCount, r.RecvCount = 0, 0
	r.DHRecvPub = newPub

	d1, err := dh(r.DHSendPriv, r.DHRecvPub)
	if err != nil {
		return err
	}
	r.RootKey, r.RecvChain = kdfRoot(r.RootKey, d1)

	r.DHSendPriv, r.DHSendPub, err = genKP()
	if err != nil {
		return err
	}

	d2, err := dh(r.DHSendPriv, r.DHRecvPub)
	if err != nil {
		return err
	}
	r.RootKey, r.SendChain = kdfRoot(r.RootKey, d2)
	return nil
}

// chainStep derives the message key from the chain key and advances the chain
// in place, per the spec's KDF_CK: HMAC(ck, 0x01) is the message key and
// HMAC(ck, 0x02) is the next chain key. Distinct constants matter, since
// deriving both from the same input would make the message key and the next
// chain key equal, and leaking one would leak the whole future chain.
//
// The old chain key is overwritten and unrecoverable, and that one-way step is
// precisely what forward secrecy is.
func chainStep(ck *[32]byte) [32]byte {
	var mk [32]byte
	h := hmac.New(sha256.New, ck[:])
	h.Write([]byte{0x01})
	copy(mk[:], h.Sum(nil))

	h = hmac.New(sha256.New, ck[:])
	h.Write([]byte{0x02})
	copy(ck[:], h.Sum(nil))
	return mk
}

// kdfRoot mixes a DH output into the root key and produces the next root key
// and a chain key.
//
// HKDF emits 64 bytes which are split into two full 32-byte keys. The obvious
// shortcut is to take one SHA-256 digest and slice it in half, but that yields
// two 16-byte keys that then get copied into [32]byte arrays and silently
// padded with zeroes: a 256-bit key with 128 bits of entropy and a constant
// upper half. Worse, the truncated root key feeds the next step, so the
// entropy never comes back.
func kdfRoot(rootKey, dhOut [32]byte) (newRoot, chainKey [32]byte) {
	// The DH output is the input keying material, the current root key is the
	// salt: that is what chains this step to every step before it.
	out, err := hkdf.Key(sha256.New, dhOut[:], rootKey[:], "WhatsAppClone/DoubleRatchet/RootKey/v1", 64)
	if err != nil {
		// Only possible with absurd length arguments, which are constants here.
		panic(fmt.Sprintf("hkdf: %v", err))
	}
	copy(newRoot[:], out[:32])
	copy(chainKey[:], out[32:])
	return newRoot, chainKey
}

func gcmEnc(key, plaintext, ad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	// Never ignore this error. A silent failure here leaves the nonce all
	// zeroes, and a repeated nonce is catastrophic for GCM: two messages under
	// one key and nonce leak their XOR and let an attacker forge the tag.
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	return g.Seal(nonce, nonce, plaintext, ad), nil
}

func gcmDec(key, ct, ad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// ct arrives from the network. Without this check a runt frame panics on
	// the slice bounds, which is a remote crash.
	if len(ct) < g.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	return g.Open(nil, ct[:g.NonceSize()], ct[g.NonceSize():], ad)
}

func genKP() (priv, pub [32]byte, err error) {
	if _, err = rand.Read(priv[:]); err != nil {
		return priv, pub, err
	}
	p, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return priv, pub, err
	}
	copy(pub[:], p)
	return priv, pub, nil
}
```

---
