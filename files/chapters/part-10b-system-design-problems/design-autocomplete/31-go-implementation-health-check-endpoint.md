## Go Implementation: Health Check Endpoint

Health checks are critical for load balancers and orchestration systems like Kubernetes to know whether an instance can serve traffic. This endpoint verifies that the trie is loaded and non-empty and that Redis is reachable. A "degraded" status (for example, Redis unreachable but trie still loaded) keeps the server in rotation serving from its local cache, while an "unhealthy" status removes it from the pool entirely.

```go
package health

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type Trie struct{}

func (t *Trie) TermCount() int { return 0 }

type TrieManager struct{}

func (tm *TrieManager) GetActiveTrie() *Trie { return &Trie{} }
func (tm *TrieManager) LastRebuild() time.Time { return time.Now() }

type RedisStatus interface {
	Err() error
}

type RedisClient interface {
	Ping(ctx context.Context) RedisStatus
}

// HealthChecker verifies all autocomplete dependencies are functional
type HealthChecker struct {
	trie      *TrieManager
	rdb       RedisClient
	startedAt time.Time
}

type HealthStatus struct {
	Status    string            `json:"status"` // "healthy", "degraded", "unhealthy"
	Checks    map[string]string `json:"checks"`
	TrieAge   string            `json:"trie_age"`
	TermCount int               `json:"term_count"`
	Uptime    string            `json:"uptime"`
	Timestamp time.Time         `json:"timestamp"`
}

func (h *HealthChecker) HandleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	status := HealthStatus{
		Status:    "healthy",
		Checks:    make(map[string]string),
		Uptime:    time.Since(h.startedAt).Round(time.Second).String(),
		Timestamp: time.Now(),
	}

	// Check trie
	trie := h.trie.GetActiveTrie()
	if trie == nil {
		status.Status = "unhealthy"
		status.Checks["trie"] = "not loaded"
	} else {
		status.Checks["trie"] = "ok"
		status.TermCount = trie.TermCount()
		status.TrieAge = time.Since(h.trie.LastRebuild()).Round(time.Second).String()
		if status.TermCount == 0 {
			status.Status = "unhealthy"
			status.Checks["trie"] = "empty"
		}
	}

	// Check Redis (never downgrade an unhealthy status to degraded)
	if err := h.rdb.Ping(ctx).Err(); err != nil {
		if status.Status == "healthy" {
			status.Status = "degraded"
		}
		status.Checks["redis"] = "unreachable"
	} else {
		status.Checks["redis"] = "ok"
	}

	w.Header().Set("Content-Type", "application/json")
	if status.Status == "unhealthy" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(status)
}
```

---
