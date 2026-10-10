## Go Implementation: Media CDN URL Signing

Signed URLs prevent unauthorized access to media files and stop hotlinking (other sites embedding your images and consuming your CDN bandwidth). Each URL includes an expiration timestamp and an HMAC signature computed from a server-side secret. The CDN edge server validates the signature before serving content, rejecting expired or tampered URLs. Different content types get different expiration windows: photos are immutable so they get long-lived URLs, while private content gets short-lived URLs that must be re-signed on each access.

```go
package cdn

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// CDNURLSigner generates signed URLs for media access
// Prevents hotlinking and unauthorized access to media
type CDNURLSigner struct {
	cdnBase string
	secret  []byte
}

// SignURL creates a time-limited signed URL for a media asset
func (s *CDNURLSigner) SignURL(mediaKey string, expiry time.Duration) string {
	expires := time.Now().Add(expiry).Unix()

	// Payload: mediaKey + expiry timestamp
	payload := fmt.Sprintf("%s:%d", mediaKey, expires)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	signature := hex.EncodeToString(mac.Sum(nil))

	return fmt.Sprintf("%s/%s?expires=%d&sig=%s", s.cdnBase, mediaKey, expires, signature)
}

// ValidateSignature checks if a signed URL is valid
func (s *CDNURLSigner) ValidateSignature(mediaKey string, expires int64, signature string) bool {
	if time.Now().Unix() > expires {
		return false // expired
	}

	payload := fmt.Sprintf("%s:%d", mediaKey, expires)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	expected := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(expected), []byte(signature))
}

// URL signing strategy:
// - Photos: long-lived URLs (1 year), content is immutable
// - Videos: medium-lived URLs (24 hours), re-sign on access
// - Stories: 25-hour URLs, matches story TTL plus a grace window
// - Private content: short-lived URLs (1 hour), re-sign per request
```

---
