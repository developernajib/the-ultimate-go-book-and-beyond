## Deep Dive: Distributed Index Architecture

With 1PB of index data, no single machine can hold the entire index. The solution is to shard the index across thousands of machines and use the scatter-gather pattern: every query is sent to all shards in parallel, each shard returns its top results, and a coordinator merges them into a final ranked list. This code shows how goroutines fan out the search concurrently and collect results through a channel, which is the idiomatic Go approach to this pattern.

```go
package index

import (
	"context"
	"sort"
	"sync"
)

type IndexCluster struct {
	shards []*IndexShard
}

func (c *IndexCluster) DistributedSearch(ctx context.Context, terms []string, limit int) []ScoredDoc {
	results := make(chan []ScoredDoc, len(c.shards))
	var wg sync.WaitGroup
	for _, s := range c.shards {
		wg.Add(1)
		go func(s *IndexShard) {
			defer wg.Done()
			results <- s.Search(ctx, terms, limit)
		}(s)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	var all []ScoredDoc
	for docs := range results {
		all = append(all, docs...)
	}
	sortByScore(all)
	if len(all) > limit {
		all = all[:limit]
	}
	return all
}

func sortByScore(docs []ScoredDoc) {
	sort.Slice(docs, func(i, j int) bool { return docs[i].Score > docs[j].Score })
}
```

---
