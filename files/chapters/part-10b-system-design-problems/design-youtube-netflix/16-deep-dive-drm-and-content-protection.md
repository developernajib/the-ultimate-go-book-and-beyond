## Deep Dive: DRM and Content Protection

Digital Rights Management is a contractual requirement before it is a technical one. Studios license content to Netflix on the condition that specific DRM systems protect it, and the required robustness level is written into the deal. That framing matters, because it explains why the goal is not "unbreakable".

First, separate two things this chapter's HLS work already touches, because they are constantly conflated.

**HLS AES-128 is encryption, not DRM.** RFC 8216 lets a playlist carry an `EXT-X-KEY` tag pointing at a key URI. The player fetches the key over HTTPS and decrypts. This is often called clear-key, and the description is exact: anyone who can fetch the key gets the key, in the clear, and can keep it forever. It raises the cost of casual copying and nothing more.

**Real DRM never hands the player the content key.** Widevine, FairPlay, and PlayReady each pair a client-side Content Decryption Module with a license server. The player sends a signed license request identifying its CDM - the license server checks entitlement and returns the content key *wrapped for that specific CDM's keys*, along with policy such as expiry, output restrictions, and maximum resolution. The key is unwrapped inside the CDM, and on hardware-backed implementations it lives in a secure enclave the host OS cannot read. The distinction that matters for your design: with clear-key, the security boundary is your CDN. With DRM, the boundary is the client's CDM, and a leaked session compromises one device rather than the title.

Now the honest limits, because an interviewer will probe them and overclaiming is how you lose the exchange. Every widely deployed DRM has been circumvented. Widevine's software tier (L3) has been broken repeatedly and keys extracted. Hardware-backed tiers raise the bar considerably but are not a proof. And no DRM can defeat the analog hole: a camera pointed at a screen still works. This is why studios tie *resolution* to *robustness level*, licensing 4K only to hardware-backed playback, and why the industry's real objective is economic. Piracy needs to be inconvenient enough, and legitimate playback easy enough, that almost nobody bothers. A design that claims to make content uncopyable is not a serious design.

The license service below shows the entitlement decision. Note what it does *not* do: it does not return a raw key.

```go
package drm

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

const licenseTTL = 4 * time.Hour

var (
	ErrNoSubscription = errors.New("no active subscription")
	ErrDeviceLimit    = errors.New("device limit reached")
)

type DRMService struct {
	keyStore    KeyStore
	licenseDB   LicenseStore
	subsService SubscriptionService
	// wrappers turn a content key into a license for one specific CDM. There is
	// one per DRM system because the license formats are not interchangeable.
	wrappers map[string]LicenseWrapper // "widevine", "fairplay", "playready"
}

type LicenseRequest struct {
	VideoID   string
	UserID    string
	DeviceID  string
	DRMSystem string
	// ChallengeBlob is the signed request the client's CDM generated. It carries
	// the device certificate the content key gets wrapped to. Without it there
	// is nobody to wrap for, and issuing a license would mean handing out a
	// bare key to whoever asked.
	ChallengeBlob []byte
}

type LicenseResponse struct {
	// License is the DRM-system-specific blob: the content key encrypted to this
	// CDM, plus policy. It is NOT the content key, and that difference is the
	// entire point of the system. Returning keyStore's raw key here would mean
	// any one subscriber could extract it once and decrypt that title forever,
	// for everyone, and no later revocation could help.
	License    []byte
	ExpiresAt  time.Time
	MaxQuality string
}

func (s *DRMService) IssueLicense(ctx context.Context, req LicenseRequest) (*LicenseResponse, error) {
	if len(req.ChallengeBlob) == 0 {
		return nil, fmt.Errorf("missing CDM challenge")
	}
	wrapper, ok := s.wrappers[req.DRMSystem]
	if !ok {
		return nil, fmt.Errorf("unsupported DRM system %q", req.DRMSystem)
	}

	sub, err := s.subsService.GetSubscription(ctx, req.UserID)
	if err != nil {
		// Distinguish "not entitled" from "we could not tell". Collapsing them
		// makes an outage in the subscription service indistinguishable from a
		// cancelled account, and you cannot alert on what you cannot see.
		return nil, fmt.Errorf("check subscription: %w", err)
	}
	if sub.Status != "active" {
		return nil, ErrNoSubscription
	}

	// Fail closed. Swallowing this error yields activeDevices == 0, which reads
	// as "no devices in use" and silently disables the concurrent-stream limit
	// exactly when the datastore is unhealthy. A security control that switches
	// itself off under load is not a control.
	activeDevices, err := s.licenseDB.CountActiveDevices(ctx, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("count active devices: %w", err)
	}
	if activeDevices >= sub.MaxDevices {
		return nil, ErrDeviceLimit
	}

	// Record the device BEFORE issuing. If this write fails and we issue anyway,
	// the device never counts against the limit and the cap becomes advisory.
	// The ordering also closes the race where two devices pass the check at the
	// same instant: RecordLicense enforces the cap atomically at the datastore.
	if err := s.licenseDB.RecordLicense(ctx, req.UserID, req.DeviceID, req.VideoID, licenseTTL); err != nil {
		return nil, fmt.Errorf("record license: %w", err)
	}

	key, err := s.keyStore.GetKey(ctx, req.VideoID)
	if err != nil {
		return nil, fmt.Errorf("fetch content key: %w", err)
	}

	// Resolution ceiling is policy carried INSIDE the license, enforced by the
	// CDM. Returning it as a plain response field would be a suggestion the
	// client is free to ignore.
	maxQ := "1080p"
	if sub.Tier == "premium" {
		maxQ = "4k"
	}

	license, err := wrapper.Wrap(ctx, key, req.ChallengeBlob, LicensePolicy{
		ExpiresAt:  time.Now().Add(licenseTTL),
		MaxQuality: maxQ,
	})
	if err != nil {
		return nil, fmt.Errorf("wrap license: %w", err)
	}

	return &LicenseResponse{
		License:    license,
		ExpiresAt:  time.Now().Add(licenseTTL),
		MaxQuality: maxQ,
	}, nil
}

// EncryptSegment implements HLS AES-128 as specified in RFC 8216: full-segment
// AES-128-CBC with PKCS#7 padding, CBC restarted at every segment boundary.
//
// When the playlist's EXT-X-KEY carries no IV attribute, the spec says to use
// the Media Sequence Number as the IV, written big-endian into a 16-octet
// buffer and left-padded with zeros. Write the whole thing. A tempting
// shorthand is to poke the sequence number into the last byte, which quietly
// truncates it to 8 bits, so segment 0, segment 256, and segment 512 all share
// an IV. Reusing an IV with the same key in CBC means identical plaintext
// blocks yield identical ciphertext blocks, which leaks structure across the
// stream. At 6 seconds per segment that collision arrives every 25.6 minutes.
func EncryptSegment(key, data []byte, mediaSequence uint64) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	iv := make([]byte, aes.BlockSize)
	binary.BigEndian.PutUint64(iv[8:], mediaSequence) // left-padded with zeros

	padding := aes.BlockSize - (len(data) % aes.BlockSize)
	padded := make([]byte, len(data)+padding)
	copy(padded, data)
	for i := len(data); i < len(padded); i++ {
		padded[i] = byte(padding) // PKCS#7: pad bytes hold the pad length
	}

	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)
	return ct, nil
}
```

Two caveats on `EncryptSegment` that an interviewer may well raise. CBC here is unauthenticated, so an attacker who can modify segments in flight can tamper with them undetected, and the usual answer is that HTTPS provides transport integrity while the DRM system provides the real protection. And this is the older HLS scheme. Modern CMAF content uses Common Encryption (CENC), which supports AES-CTR and AES-CBCS subsample encryption and lets one set of encrypted segments serve Widevine, PlayReady, and FairPlay from the same bytes with different license servers. That is the same "encode once, serve everyone" argument that put us on CMAF in the transcoding pipeline, applied to encryption.

---
