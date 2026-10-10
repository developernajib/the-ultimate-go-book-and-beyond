## Production Go Implementation: Message Backup Service

Message backups allow users to preserve their chat history when switching devices or reinstalling the app. Because messages are end-to-end encrypted, the backup must also be encrypted so that neither the cloud storage provider nor the messaging operator can read it.

**Where this code runs is the whole design.** It runs on the device. That sounds like a detail and it is the entire security property. If the backup service were a server endpoint that accepted the user's password and a list of their messages, then the server would hold both the plaintext and the key, and the E2E guarantee would be gone at exactly the moment users care about it most, with the added insult of a password now in transit. A backup service on the server can only ever be given ciphertext it cannot open. The code below therefore has no request struct carrying a password to a server: it takes a password and messages that are already local, encrypts in place, and hands an opaque blob to an uploader. The server's entire role is to store bytes and remember where they went.

The password is stretched with PBKDF2, using 600,000 iterations of HMAC-SHA256, which is the current OWASP guidance for this algorithm. The reason for the deliberate slowness is that a human-chosen password has perhaps 30 bits of entropy against an offline attacker who holds the blob and can guess forever. Iteration count buys back a fixed factor of work and no more, which is precisely why WhatsApp's real deployment offers a 64-digit random key as an alternative, and, when a password is used, escrows the key in an HSM that enforces a hard limit on wrong guesses. Hardware enforcement turns an unwinnable offline problem into a bounded online one. Key stretching alone narrows the gap, it does not close it.

```go
// Package backup runs ON THE DEVICE. It never runs on a server, because a
// server that can see the password or the plaintext defeats end-to-end
// encryption at the one moment users most rely on it.
package backup

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	// OWASP guidance for PBKDF2-HMAC-SHA256. Raise it as hardware improves,
	// which is why the value is versioned into the payload rather than assumed
	// on restore.
	pbkdf2Iters = 600_000
	saltLen     = 32
	keyLen      = 32
	formatV2    = 2
	// A gzipped JSON backup that decompresses to more than this is treated as
	// hostile rather than trusted, so a corrupted or malicious blob cannot
	// exhaust memory on restore.
	maxPlaintext = 2 << 30 // 2GiB
)

var ErrBadPassword = errors.New("incorrect password or corrupted backup")

// Uploader is the only thing that talks to the network, and everything handed
// to it is already opaque.
type Uploader interface {
	Upload(ctx context.Context, key string, data []byte) (int64, error)
	Download(ctx context.Context, key string) ([]byte, error)
}

// BackupService encrypts locally and uploads the result.
type BackupService struct {
	store Uploader
}

type BackupMetadata struct {
	UserID            string    `json:"user_id"`
	S3Key             string    `json:"s3_key"`
	SizeBytes         int64     `json:"size_bytes"`
	MessageCount      int       `json:"message_count"`
	CreatedAt         time.Time `json:"created_at"`
	EncryptionVersion int       `json:"encryption_version"`
}

// header is prepended to the ciphertext in plaintext. It is not secret, but it
// is authenticated: it travels as the AEAD's associated data, so an attacker
// who rewrites the iteration count down to 1 to make cracking cheap causes
// decryption to fail rather than succeed weakly.
type header struct {
	Version uint32
	Iters   uint32
	Salt    [saltLen]byte
}

func (h header) marshal() []byte {
	b := make([]byte, 0, 8+saltLen)
	b = binary.BigEndian.AppendUint32(b, h.Version)
	b = binary.BigEndian.AppendUint32(b, h.Iters)
	return append(b, h.Salt[:]...)
}

func parseHeader(b []byte) (header, []byte, error) {
	var h header
	// Bounds check before every slice. The original sliced payload[:32]
	// unconditionally, so a truncated or hostile object panicked the process
	// instead of returning an error.
	if len(b) < 8+saltLen {
		return h, nil, ErrBadPassword
	}
	h.Version = binary.BigEndian.Uint32(b[0:4])
	h.Iters = binary.BigEndian.Uint32(b[4:8])
	copy(h.Salt[:], b[8:8+saltLen])
	return h, b[8+saltLen:], nil
}

// CreateBackup serializes, compresses, encrypts, and uploads the user's
// messages. password and messages are already on this device.
func (s *BackupService) CreateBackup(ctx context.Context, userID, password string, messages []Message) (*BackupMetadata, error) {
	if password == "" {
		return nil, errors.New("empty backup password")
	}

	var h header
	h.Version = formatV2
	h.Iters = pbkdf2Iters
	if _, err := io.ReadFull(rand.Reader, h.Salt[:]); err != nil {
		return nil, fmt.Errorf("salt: %w", err)
	}

	key, err := pbkdf2.Key(sha256.New, password, h.Salt[:], int(h.Iters), keyLen)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	// Real serialization. A stub returning nil here encrypts zero bytes: the
	// upload succeeds, the metadata proudly reports the message count, and the
	// backup contains nothing at all. Nobody finds out until a restore.
	data, err := serializeMessages(messages)
	if err != nil {
		return nil, fmt.Errorf("serialize: %w", err)
	}
	if len(data) == 0 && len(messages) > 0 {
		return nil, fmt.Errorf("serialized %d messages to 0 bytes", len(messages))
	}

	aad := h.marshal()
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}

	payload := append(aad, gcm.Seal(nonce, nonce, data, aad)...)

	objKey := fmt.Sprintf("backups/%s/%s.enc", userID, time.Now().UTC().Format("20060102-150405"))
	size, err := s.store.Upload(ctx, objKey, payload)
	if err != nil {
		return nil, fmt.Errorf("upload backup: %w", err)
	}

	return &BackupMetadata{
		UserID:            userID,
		S3Key:             objKey,
		SizeBytes:         size,
		MessageCount:      len(messages),
		CreatedAt:         time.Now().UTC(),
		EncryptionVersion: formatV2,
	}, nil
}

// RestoreBackup downloads and decrypts a backup with the user's password.
func (s *BackupService) RestoreBackup(ctx context.Context, s3Key, password string) ([]Message, error) {
	payload, err := s.store.Download(ctx, s3Key)
	if err != nil {
		return nil, fmt.Errorf("download backup: %w", err)
	}

	h, ct, err := parseHeader(payload)
	if err != nil {
		return nil, err
	}
	if h.Version != formatV2 {
		return nil, fmt.Errorf("unsupported backup version %d", h.Version)
	}
	// Read the iteration count from the payload rather than assuming today's
	// constant, or every backup breaks the day the constant is raised.
	if h.Iters == 0 || h.Iters > 10_000_000 {
		return nil, ErrBadPassword
	}

	key, err := pbkdf2.Key(sha256.New, password, h.Salt[:], int(h.Iters), keyLen)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	if len(ct) < gcm.NonceSize() {
		return nil, ErrBadPassword
	}

	plaintext, err := gcm.Open(nil, ct[:gcm.NonceSize()], ct[gcm.NonceSize():], h.marshal())
	if err != nil {
		// Deliberately one error for both a wrong password and a corrupted
		// blob. Distinguishing them tells an attacker when they have found the
		// right password against a damaged file.
		return nil, ErrBadPassword
	}

	return deserializeMessages(plaintext)
}

// serializeMessages encodes to JSON and gzips it. Chat history compresses
// extremely well, and the bytes are about to become incompressible ciphertext,
// so this is the only place the saving is available.
func serializeMessages(msgs []Message) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(msgs); err != nil {
		return nil, err
	}
	// Close, not Flush: the gzip footer is written on Close, and skipping it
	// produces an archive that fails to decompress on restore.
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func deserializeMessages(data []byte) ([]Message, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer zr.Close()

	var msgs []Message
	// LimitReader bounds a decompression bomb: the AEAD proves the blob is ours
	// and unmodified, but a corrupted-then-reauthenticated archive from a
	// compromised device should still not be able to allocate without limit.
	if err := json.NewDecoder(io.LimitReader(zr, maxPlaintext)).Decode(&msgs); err != nil {
		return nil, err
	}
	return msgs, nil
}
```

---
