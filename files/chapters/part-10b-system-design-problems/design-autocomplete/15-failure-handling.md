## Failure Handling

### Graceful Degradation

In a latency-critical system like autocomplete, a hard failure is worse than returning slightly stale results. The fallback chain pattern ensures the service always responds, even when individual layers are unavailable. If the in-memory trie is empty, the system falls back to Redis, if Redis is down, it serves from a static precomputed cache. The worst case is an empty response, which the client can handle gracefully.

```go
package autocomplete

import (
	"context"
	"time"
)

type Suggestion struct {
	Term  string
	Score float64
}

type Trie struct{}

func (t *Trie) Search(prefix string) []Suggestion { return nil }

type RedisCache struct{}

func (c *RedisCache) Get(ctx context.Context, prefix string) ([]Suggestion, error) { return nil, nil }

// FallbackChain: try each layer until one succeeds
type FallbackChain struct {
	primaryTrie    *Trie
	redisCache     *RedisCache
	staticFallback map[string][]Suggestion // precomputed for top 1000 prefixes
}

func (f *FallbackChain) SuggestWithFallback(ctx context.Context, prefix string, limit int) []Suggestion {
	// Layer 1: In-memory trie
	if f.primaryTrie != nil {
		if results := f.primaryTrie.Search(prefix); len(results) > 0 {
			return results[:min(len(results), limit)]
		}
	}

	// Layer 2: Redis (slightly stale)
	if f.redisCache != nil {
		ctx2, cancel := context.WithTimeout(ctx, 5*time.Millisecond)
		defer cancel()
		if results, err := f.redisCache.Get(ctx2, prefix); err == nil && len(results) > 0 {
			return results[:min(len(results), limit)]
		}
	}

	// Layer 3: Static fallback (very stale, guaranteed available)
	if results, ok := f.staticFallback[prefix]; ok {
		return results[:min(len(results), limit)]
	}

	// Layer 4: Empty (graceful failure)
	return nil
}

// Trie corruption recovery:
// Health check compares new trie stats vs previous
// If total terms dropped >10% or baseline queries empty -> reject new trie
// Continue serving with last-good trie (up to 10 min stale)
```

---
