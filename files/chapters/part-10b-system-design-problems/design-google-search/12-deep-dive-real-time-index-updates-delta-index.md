## Deep Dive: Real-Time Index Updates (Delta Index)

A search engine that only updates its index once a week would miss breaking news and new content. The delta index solves this by maintaining a small, fast-to-update index for recently crawled pages alongside the large main index. Queries search both indexes and merge results. Periodically, the delta index is compacted into the main index using a merge operation similar to how LSM trees work. This gives you near-real-time freshness without the cost of rebuilding the entire index.

```go
package index

import (
	"sync"
	"time"
)

type DeltaIndex struct {
	mu       sync.RWMutex
	index    map[string]PostingList
	docStore map[string]DocMeta
	created  time.Time
	maxSize  int
}

type MergeEngine struct {
	mainIndex *IndexShard
	deltas    []*DeltaIndex
}

func (m *MergeEngine) Merge(delta *DeltaIndex) {
	delta.mu.RLock()
	defer delta.mu.RUnlock()
	m.mainIndex.mu.Lock()
	defer m.mainIndex.mu.Unlock()

	for term, dpl := range delta.index {
		main := m.mainIndex.index[term]
		m.mainIndex.index[term] = mergePL(main, dpl)
	}
	for id, meta := range delta.docStore {
		m.mainIndex.docStore[id] = meta
	}
}

// mergePL merges two posting lists, preferring the delta (b) entry
// when a document appears in both
func mergePL(a, b PostingList) PostingList {
	seen := make(map[string]bool)
	var r PostingList
	for _, p := range b {
		seen[p.DocID] = true
		r = append(r, p)
	}
	for _, p := range a {
		if !seen[p.DocID] {
			r = append(r, p)
		}
	}
	return r
}
```

---
