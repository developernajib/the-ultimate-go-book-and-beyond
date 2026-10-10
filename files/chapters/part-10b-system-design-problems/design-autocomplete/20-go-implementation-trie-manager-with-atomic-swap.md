## Go Implementation: Trie Manager with Atomic Swap

The trie must be rebuilt periodically to reflect updated term frequencies, but you cannot take the service offline during a rebuild. The TrieManager solves this by building a brand-new trie in the background and then swapping it in atomically with a typed `atomic.Pointer[Trie]`, no locks and no `unsafe` required. A validation step compares the new trie against the old one, rejecting any rebuild that loses more than 10% of terms or fails baseline sanity checks.

```go
package autocomplete

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type Suggestion struct {
	Term  string
	Score float64
}

type Trie struct{}

func NewTrie(maxK int) *Trie { return &Trie{} }
func (t *Trie) Insert(term string, score float64) {}
func (t *Trie) Search(prefix string) []Suggestion { return nil }
func (t *Trie) TermCount() int64 { return 0 }

// TrieManager handles periodic trie rebuilds with zero-downtime swaps
type TrieManager struct {
	activeTrie atomic.Pointer[Trie]
	rebuiltAt  atomic.Int64 // unix seconds of last successful swap
	rdb        *redis.ClusterClient
	maxK       int
	logger     *slog.Logger
}

// GetActiveTrie returns the current live trie
func (tm *TrieManager) GetActiveTrie() *Trie {
	return tm.activeTrie.Load()
}

// LastRebuild returns the time of the last successful swap
func (tm *TrieManager) LastRebuild() time.Time {
	return time.Unix(tm.rebuiltAt.Load(), 0)
}

// RebuildLoop continuously rebuilds the trie every interval
func (tm *TrieManager) RebuildLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := tm.rebuildAndSwap(ctx); err != nil {
				tm.logger.Error("trie rebuild failed", "error", err)
			}
		}
	}
}

func (tm *TrieManager) rebuildAndSwap(ctx context.Context) error {
	start := time.Now()

	// 1. Read top terms from Redis
	// In production, scan in chunks instead of one giant range read
	terms, err := tm.rdb.ZRevRangeWithScores(ctx, "terms:freq", 0, 50_000_000).Result()
	if err != nil {
		return fmt.Errorf("read terms: %w", err)
	}

	if len(terms) == 0 {
		return fmt.Errorf("no terms found in frequency store")
	}

	// 2. Build new trie
	newTrie := NewTrie(tm.maxK)
	for _, t := range terms {
		term := t.Member.(string)
		newTrie.Insert(term, t.Score)
	}

	// 3. Validate new trie against current
	currentTrie := tm.GetActiveTrie()
	if currentTrie != nil && !tm.validateNewTrie(newTrie, currentTrie) {
		return fmt.Errorf("trie validation failed: new trie has significantly fewer terms")
	}

	// 4. Atomic swap
	tm.activeTrie.Store(newTrie)
	tm.rebuiltAt.Store(time.Now().Unix())

	tm.logger.Info("trie rebuilt",
		"terms", len(terms),
		"duration_ms", time.Since(start).Milliseconds())

	return nil
}

func (tm *TrieManager) validateNewTrie(newTrie, oldTrie *Trie) bool {
	newCount := newTrie.TermCount()
	oldCount := oldTrie.TermCount()

	// Reject if lost >10% of terms
	if float64(newCount) < float64(oldCount)*0.9 {
		tm.logger.Warn("trie validation: term count dropped",
			"old", oldCount, "new", newCount)
		return false
	}

	// Check baseline queries return results
	baselines := []string{"a", "the", "how", "what", "why"}
	for _, prefix := range baselines {
		if len(newTrie.Search(prefix)) == 0 {
			tm.logger.Warn("trie validation: empty results for baseline", "prefix", prefix)
			return false
		}
	}

	return true
}
```

---
