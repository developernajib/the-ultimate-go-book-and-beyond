## Go Implementation: Bandwidth Throttling

Bandwidth throttling prevents the sync client from saturating the user's network connection, which would make browsing and other applications unusable during large syncs. This implementation uses Go's `x/time/rate` package to create a token bucket rate limiter that wraps any `io.Reader`, transparently limiting the bytes-per-second throughput. The `BandwidthManager` adapts the limit based on network conditions, for example, throttling to 25% of maximum speed on metered mobile connections and deferring large uploads when the device is on battery power.

```go
package sync

import (
	"context"
	"io"

	"golang.org/x/time/rate"
)

// ThrottledReader limits download bandwidth to avoid saturating network
type ThrottledReader struct {
	reader  io.Reader
	limiter *rate.Limiter
}

// NewThrottledReader creates a reader limited to bytesPerSec
func NewThrottledReader(r io.Reader, bytesPerSec int) *ThrottledReader {
	return &ThrottledReader{
		reader:  r,
		limiter: rate.NewLimiter(rate.Limit(bytesPerSec), bytesPerSec), // burst = 1 second
	}
}

func (tr *ThrottledReader) Read(p []byte) (int, error) {
	// Cap the read at the burst size so WaitN never exceeds its limit
	if b := tr.limiter.Burst(); len(p) > b {
		p = p[:b]
	}

	// Read first, then charge the limiter for the bytes actually read.
	// Reserving len(p) up front would over-throttle on short reads.
	n, err := tr.reader.Read(p)
	if n > 0 {
		if werr := tr.limiter.WaitN(context.Background(), n); werr != nil {
			return n, werr
		}
	}
	return n, err
}

// BandwidthManager adapts bandwidth based on network conditions
type BandwidthManager struct {
	maxUploadBps   int
	maxDownloadBps int
	autoDetect     bool
}

// GetUploadLimit returns current upload bandwidth limit
// Reduces limit when on metered (mobile) connections
func (bm *BandwidthManager) GetUploadLimit(isMetered bool) int {
	if isMetered {
		return bm.maxUploadBps / 4 // 25% of max on mobile
	}
	return bm.maxUploadBps
}

// SmartSync schedules sync operations based on conditions:
// - On WiFi: sync immediately at full speed
// - On metered: sync only small files (<10MB), throttled
// - On battery: defer large syncs until charging
// - Nighttime: batch large uploads for off-peak
```

---
