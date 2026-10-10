## Failure Handling

At 50 million concurrent streams, failure is not an exception to handle, it is a constant background rate. The principle is graceful degradation. If the primary CDN is down, fall back to a secondary. If that fails too, serve directly from S3 with pre-signed URLs, which is slower and more expensive but still plays music. On the client side, buffering 3 to 5 segments ahead absorbs brief network interruptions, and automatic quality downgrading keeps audio flowing on a degraded connection instead of stopping dead.

The circuit breaker is the part people leave out, and leaving it out inverts the purpose of the fallback. A bare try-primary-then-secondary chain means that during a primary CDN outage every single request still pays the full primary timeout before moving on. Add a couple of seconds of timeout to every stream start and you have converted a CDN outage into a latency outage across the whole platform, plus you keep hammering a dependency that is trying to recover. The breaker trips after a threshold of failures and sends traffic straight to the secondary, then lets a trickle of probes through to notice when the primary comes back.

```go
package resilience

import (
	"context"
	"fmt"
	"time"
)

type Quality string

type CDNProvider interface {
	GetURL(ctx context.Context, trackID string, q Quality) (string, error)
}

type S3Client interface {
	GeneratePresignedURL(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type CircuitBreaker interface {
	Allow(provider string) bool
	Success(provider string)
	Failure(provider string)
}

type StreamingFallback struct {
	primaryCDN, secondaryCDN CDNProvider
	s3                       S3Client
	breaker                  CircuitBreaker // per-provider failure state
}

func (f *StreamingFallback) GetURL(ctx context.Context, trackID string, q Quality) (string, error) {
	// Skip the primary entirely while its breaker is open. This is the whole
	// point: an open breaker converts a timeout into an instant decision.
	if f.breaker.Allow("primary") {
		url, err := f.primaryCDN.GetURL(ctx, trackID, q)
		if err == nil {
			f.breaker.Success("primary")
			return url, nil
		}
		f.breaker.Failure("primary")
	}

	if f.breaker.Allow("secondary") {
		url, err := f.secondaryCDN.GetURL(ctx, trackID, q)
		if err == nil {
			f.breaker.Success("secondary")
			return url, nil
		}
		f.breaker.Failure("secondary")
	}

	// Last resort: origin. Same key layout the transcoder writes, and the
	// extension has to follow the tier: hardcoding .ogg here would 404 every
	// lossless stream at exactly the moment both CDNs are already down.
	ext := "ogg"
	if q == "lossless" {
		ext = "flac"
	}
	key := fmt.Sprintf("audio/%s/%s/%s.%s", trackID, q, trackID, ext)
	return f.s3.GeneratePresignedURL(ctx, key, 1*time.Hour)
}

// Client: buffer 3-5 segments ahead, retry 3x with backoff, skip unavailable tracks
// Quality downgrade on slow network: lossless->320->160->96 kbps
```

---
