## Deep Dive: Offensive Content Filtering

Serving offensive or inappropriate suggestions is a serious reputational and legal risk. A content filtering pipeline runs at two points: when search events are ingested (to prevent bad terms from ever entering the trie) and at serve time (to catch terms added to the blocklist after the trie was built). The filter uses a layered approach, starting with a fast O(1) blocklist check, then substring pattern matching, and finally an ML classifier for context-aware detection.

```go
package filter

import (
	"strings"
	"sync"
)

type Suggestion struct {
	Term  string
	Score float64
}

type ContentClassifier interface {
	Score(text string) float64
}

// ContentFilter prevents offensive terms from appearing in suggestions
type ContentFilter struct {
	blocklist    map[string]bool
	patterns     []string
	mlClassifier ContentClassifier
	mu           sync.RWMutex
}

func (f *ContentFilter) FilterSuggestions(suggestions []Suggestion) []Suggestion {
	var filtered []Suggestion
	for _, s := range suggestions {
		if f.isAllowed(s.Term) {
			filtered = append(filtered, s)
		}
	}
	return filtered
}

func (f *ContentFilter) isAllowed(term string) bool {
	normalized := strings.ToLower(strings.TrimSpace(term))

	// 1. Exact blocklist (O(1))
	f.mu.RLock()
	if f.blocklist[normalized] {
		f.mu.RUnlock()
		return false
	}

	// 2. Substring match for known bad patterns
	// (patterns share the lock: the admin API updates them at runtime)
	for _, pattern := range f.patterns {
		if strings.Contains(normalized, pattern) {
			f.mu.RUnlock()
			return false
		}
	}
	f.mu.RUnlock()

	// 3. ML classifier for context-aware detection
	if score := f.mlClassifier.Score(normalized); score > 0.8 {
		return false
	}

	return true
}

// Pipeline:
// 1. Check blocklist BEFORE incrementing frequency (blocked terms never enter trie)
// 2. Filter at serve time (in case blocklist updated)
// 3. ML flags borderline terms for human review queue
```

---
