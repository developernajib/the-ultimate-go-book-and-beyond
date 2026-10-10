## Go Implementation: Load Shedding

At 100K QPS, even a brief traffic spike can overwhelm servers and cause cascading latency for all users. Load shedding protects the service by rejecting requests when concurrency exceeds a threshold, returning a fast 503 instead of letting requests queue up and timeout. For autocomplete specifically, shedding is preferable to queuing because a delayed suggestion is useless to a user who has already typed the next character.

```go
package middleware

import (
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// LoadShedder protects the service from overload
// At 100K QPS, a sudden spike could overwhelm servers
type LoadShedder struct {
	maxConcurrent int64
	current       int64
	maxQueueTime  time.Duration
}

func NewLoadShedder(maxConcurrent int64, maxQueueTime time.Duration) *LoadShedder {
	return &LoadShedder{
		maxConcurrent: maxConcurrent,
		maxQueueTime:  maxQueueTime,
	}
}

// Middleware wraps an HTTP handler with load shedding
func (ls *LoadShedder) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if at capacity
		current := atomic.AddInt64(&ls.current, 1)
		defer atomic.AddInt64(&ls.current, -1)

		if current > ls.maxConcurrent {
			// Over capacity: shed load
			w.Header().Set("Retry-After", "1")
			http.Error(w, "service overloaded", http.StatusServiceUnavailable)
			return
		}

		// Reject requests that already waited too long in the LB queue,
		// the client has typed the next character and moved on
		if reqTime := r.Header.Get("X-Request-Start"); reqTime != "" {
			if startMs, err := strconv.ParseInt(reqTime, 10, 64); err == nil {
				if time.Since(time.UnixMilli(startMs)) > ls.maxQueueTime {
					http.Error(w, "request expired", http.StatusServiceUnavailable)
					return
				}
			}
		}

		next.ServeHTTP(w, r)
	})
}

// For autocomplete specifically:
// - Max concurrent: 200 per server (Little's law: 5K QPS x 5ms = 25 in
//   flight at steady state, 200 leaves 8x headroom for spikes)
// - On shed, the client shows no suggestions (graceful degradation)
// - Never queue autocomplete requests, they are latency-critical
// - Shed percentage monitored and alerted
```

---
