## Deep Dive: End-to-End Encryption

Start with what WebRTC gives you for free, because it is less than people assume. Every WebRTC connection is already encrypted: DTLS negotiates keys and SRTP encrypts the media. But that protection is **hop-by-hop**. The SFU is a TLS-style endpoint, not a passive pipe. It terminates DTLS-SRTP, decrypts every frame, and re-encrypts it toward each subscriber, because forwarding by simulcast layer means reading RTP headers. "Encrypted with DTLS-SRTP" and "end-to-end encrypted" are therefore different claims, and conflating them is not a hypothetical error. Zoom marketed "end-to-end, 256-bit encryption" for years while holding the keys itself, which the FTC called a deceptive practice in its November 2020 settlement.

Real E2EE adds a second, inner layer that the SFU has no key for. The browser hook is Insertable Streams (SFrame), which encrypts the frame payload after the encoder and before packetization, leaving the RTP headers in the clear so the SFU can still do its job. The SFU keeps forwarding and selecting layers. It just cannot see the pixels.

The key distribution design is where candidates usually go wrong. The intuitive move, pairwise ECDH between every pair of participants, is exactly wrong for an SFU: if a frame were encrypted separately for each recipient, the publisher would have to upload N different ciphertexts, which collapses the SFU back into a mesh and throws away the entire bandwidth argument for building one. The publisher uploads **one** stream, so all subscribers must be able to decrypt **one** ciphertext. That means a shared per-meeting group key. This is what Zoom actually does: the host generates a per-meeting key and distributes it to each participant wrapped under public-key crypto. Pairwise ECDH still appears, but only as the key-encryption key used to wrap the group key, never to encrypt media.

```go
package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
)

type E2EEManager struct{ curve ecdh.Curve }

// NewE2EEManager builds a manager with a curve set. The zero value of
// E2EEManager carries a nil curve and panics on first use.
func NewE2EEManager() *E2EEManager {
	return &E2EEManager{curve: ecdh.X25519()}
}

type E2EESession struct {
	MeetingID  string
	PrivateKey *ecdh.PrivateKey
	PublicKey  *ecdh.PublicKey

	mu sync.RWMutex
	// wrapKeys are pairwise ECDH-derived key-encryption keys, one per
	// peer. They never touch media. Their only job is to wrap meetingKey.
	wrapKeys map[string][]byte
	// meetingKey encrypts every media frame. One key shared by the whole
	// meeting, which is what lets the SFU forward one ciphertext to all.
	meetingKey []byte
}

func (m *E2EEManager) InitSession(meetingID string) (*E2EESession, error) {
	pk, err := m.curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &E2EESession{
		MeetingID:  meetingID,
		PrivateKey: pk,
		PublicKey:  pk.PublicKey(),
		wrapKeys:   make(map[string][]byte),
	}, nil
}

// DeriveWrapKey derives the pairwise key shared with one peer.
func (s *E2EESession) DeriveWrapKey(participantID string, theirPK *ecdh.PublicKey) error {
	secret, err := s.PrivateKey.ECDH(theirPK)
	if err != nil {
		return fmt.Errorf("ECDH with %s: %w", participantID, err)
	}

	// HKDF, not a bare SHA-256 over the secret. An ECDH output is a
	// uniformly random *point*, not a uniformly random *key*, and
	// extract-then-expand is what converts one into the other. Binding the
	// meeting and peer IDs into the info string domain-separates the
	// result, so a key from one meeting cannot be replayed into another.
	key, err := hkdf.Key(sha256.New, secret, []byte(s.MeetingID),
		"e2ee-wrap-key/"+participantID, 32)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.wrapKeys[participantID] = key
	return nil
}

// GenerateMeetingKey is called by the host. It is also called again on
// every roster change: rotating on join denies a newcomer the frames sent
// before they arrived, and rotating on leave stops someone who has left
// from decrypting anything after.
func (s *E2EESession) GenerateMeetingKey() error {
	key := make([]byte, 32) // AES-256
	if _, err := rand.Read(key); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meetingKey = key
	return nil
}

// WrapMeetingKeyFor encrypts the meeting key for one participant. The host
// sends the output over the signaling channel, where the server relays
// ciphertext it holds no key for.
func (s *E2EESession) WrapMeetingKeyFor(participantID string) ([]byte, error) {
	s.mu.RLock()
	wrapKey, ok := s.wrapKeys[participantID]
	mk := s.meetingKey
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("no wrap key for %s", participantID)
	}
	if mk == nil {
		return nil, fmt.Errorf("meeting key not generated")
	}

	gcm, err := newGCM(wrapKey)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, mk, []byte(s.MeetingID)), nil
}

// EncryptFrame encrypts one media frame under the meeting key.
//
// The nonce is constructed, never random. AES-GCM fails catastrophically
// on nonce reuse: two frames sealed with the same key and nonce leak the
// XOR of their plaintexts and, worse, enough to forge the authentication
// tag. At 30fps across a long meeting, random 96-bit nonces are fine on
// paper but leave nothing to reason about. Deriving the nonce from
// (SSRC, frame counter) makes uniqueness structural: distinct streams
// differ in the SSRC half, and one stream's frames differ in the counter.
// The counter must never wrap under a single key, which is another reason
// the meeting key rotates.
func (s *E2EESession) EncryptFrame(frame []byte, ssrc uint32, counter uint64) ([]byte, error) {
	s.mu.RLock()
	mk := s.meetingKey
	s.mu.RUnlock()

	if mk == nil {
		return nil, fmt.Errorf("meeting key not established")
	}

	gcm, err := newGCM(mk)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	binary.BigEndian.PutUint32(nonce[0:4], ssrc)
	binary.BigEndian.PutUint64(nonce[4:12], counter)

	return gcm.Seal(nil, nonce, frame, nil), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
```

Two things this code cannot fix on its own. First, the public keys are exchanged over the signaling channel, which the server runs, so a malicious server can hand each side its own key and sit in the middle. E2EE against a hostile server is only real if participants verify the keys out of band, which is what Zoom's security code (a digest over the participants' public keys, read aloud) is for. An E2EE design that never mentions key verification has not removed trust in the server, it has only moved it. Second, the meeting key is shared by everyone in the meeting, so E2EE protects against the server, not against a participant. Whoever is in the room can decrypt the room.

The trade-off is real and worth stating plainly: with E2EE on, the SFU forwards packets it cannot read, so anything that requires understanding the media is gone. No cloud recording, no live transcription, no server-side virtual backgrounds, no dial-in by phone (a PSTN bridge cannot hold a key).

---
