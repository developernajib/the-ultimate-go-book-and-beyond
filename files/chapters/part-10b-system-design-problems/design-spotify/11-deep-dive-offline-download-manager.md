## Deep Dive: Offline Download Manager

Premium users expect to download music for offline listening, on flights, in subways, or anywhere without a connection. The offline download manager generates encrypted download packages, enforces the device limit (Spotify allows offline downloads on up to 5 devices per account), and issues licenses that expire after 30 days, which is why an offline library goes silent if the app never gets back online.

Be honest about what the encryption buys. AES-GCM stops a casual user from pulling playable audio off the filesystem, and the expiring license is what actually enforces the subscription. It is not unbreakable, because the client necessarily receives the key in order to decrypt and play, and a key that reaches the device can be extracted from the device. Every software DRM scheme has this hole. Real deployments narrow it by keeping the key inside a hardware-backed keystore or a platform DRM module (Widevine, FairPlay) so the key never sits in ordinary application memory. The design goal is raising cost, not achieving impossibility, and an interview answer that claims otherwise is claiming something no shipped system delivers.

Two things in this code are load-bearing and both are easy to get wrong. The device check is a Lua script rather than SCard-then-SAdd because the read-then-write version is a TOCTOU race: five devices registering at once all observe a count of four and all pass. And every `crypto/rand` error is checked, because the failure mode of ignoring them is a silent one. `rand.Read` returning an error leaves the key as 32 zero bytes, and a short read on the nonce leaves an all-zero nonce, which under GCM means nonce reuse across tracks and total loss of confidentiality. Neither one is visible in testing. Both encrypt and decrypt fine.

```go
package offline

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxOfflineDevices = 5
	licenseTTL        = 30 * 24 * time.Hour
)

type Quality string

type S3Client interface {
	GeneratePresignedURL(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type OfflineManager struct {
	rdb *redis.Client
	s3  S3Client
}

type DownloadLicense struct {
	TrackID, UserID, DeviceID string
	EncryptKey                []byte
	ExpiresAt                 time.Time
}

// registerDevice adds deviceID to the account's device set only if the account
// is under the limit or the device is already registered. Check and write
// happen in one atomic script: Redis runs it single-threaded, so no concurrent
// registration can slip in between the SCARD and the SADD.
//
// Returns 1 on success, 0 when the limit is reached.
var registerDevice = redis.NewScript(`
	local devKey, deviceID, limit = KEYS[1], ARGV[1], tonumber(ARGV[2])
	if redis.call('SISMEMBER', devKey, deviceID) == 1 then
		return 1
	end
	if redis.call('SCARD', devKey) >= limit then
		return 0
	end
	redis.call('SADD', devKey, deviceID)
	return 1
`)

func (m *OfflineManager) GenerateDownload(ctx context.Context, userID, trackID, deviceID string, quality Quality) (*DownloadPackage, error) {
	// Entitlement check fails closed. A Redis error must not read as "premium".
	isPremium, err := m.rdb.Get(ctx, fmt.Sprintf("user:premium:%s", userID)).Bool()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("check entitlement for %s: %w", userID, err)
	}
	if !isPremium {
		return nil, fmt.Errorf("premium required")
	}

	devKey := fmt.Sprintf("user:devices:%s", userID)
	ok, err := registerDevice.Run(ctx, m.rdb, []string{devKey}, deviceID, maxOfflineDevices).Bool()
	if err != nil {
		return nil, fmt.Errorf("register device: %w", err)
	}
	if !ok {
		return nil, fmt.Errorf("device limit reached (%d)", maxOfflineDevices)
	}

	// A 32-byte AES-256 key. Check the error: on failure this slice stays all
	// zeros and every download on the platform shares one predictable key.
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate content key: %w", err)
	}

	// The license TTL is the real enforcement mechanism. Redis expiring the key
	// is what makes an offline library stop playing after 30 days without a
	// check-in, so this write has to be confirmed, not fired and forgotten.
	licKey := fmt.Sprintf("license:%s:%s:%s", userID, trackID, deviceID)
	if err := m.rdb.Set(ctx, licKey, key, licenseTTL).Err(); err != nil {
		return nil, fmt.Errorf("store license: %w", err)
	}

	// Same key layout the transcoder writes and the streaming service reads,
	// so the extension has to track the tier: a lossless download is FLAC, and
	// a hardcoded .ogg here hands the client a presigned URL to an object that
	// does not exist for exactly the premium users paying for the feature.
	ext := "ogg"
	if quality == "lossless" {
		ext = "flac"
	}
	objKey := fmt.Sprintf("audio/%s/%s/%s.%s", trackID, quality, trackID, ext)
	url, err := m.s3.GeneratePresignedURL(ctx, objKey, 24*time.Hour)
	if err != nil {
		return nil, fmt.Errorf("presign download: %w", err)
	}

	return &DownloadPackage{
		DownloadURL:   url,
		EncryptionKey: key,
		License: DownloadLicense{
			TrackID:    trackID,
			UserID:     userID,
			DeviceID:   deviceID,
			EncryptKey: key,
			ExpiresAt:  time.Now().Add(licenseTTL),
		},
	}, nil
}

func EncryptTrack(data, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		// Discarding this leaves block nil and the next line panics.
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		// An all-zero nonce reused across tracks under the same key is a total
		// break of GCM. It would still decrypt correctly, so nothing catches it.
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, data, nil), nil
}

type DownloadPackage struct {
	DownloadURL   string
	EncryptionKey []byte
	License       DownloadLicense
}
```

---
