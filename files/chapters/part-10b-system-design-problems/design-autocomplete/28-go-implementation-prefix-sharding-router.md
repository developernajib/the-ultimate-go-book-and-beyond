## Go Implementation: Prefix Sharding Router

When the trie grows too large for a single server, prefix sharding distributes the data across multiple machines. The router assigns each first character to a specific server, so all prefixes starting with "a" go to one shard and those starting with "b" go to another. This approach is simple to implement, keeps related prefixes together for cache locality, and scales linearly by adding more shards.

```go
package routing

import (
	"fmt"
	"strings"
)

// PrefixShardRouter routes requests to the correct shard based on prefix
// When trie is too large for a single server, shard by first character
type PrefixShardRouter struct {
	shards     map[string]string // prefix range -> server address
	shardCount int
}

// NewPrefixShardRouter creates a router that distributes across N shards
func NewPrefixShardRouter(servers []string) *PrefixShardRouter {
	router := &PrefixShardRouter{
		shards:     make(map[string]string),
		shardCount: len(servers),
	}

	// Simple: divide alphabet across servers
	// a-d -> server 0, e-h -> server 1, etc.
	chars := "abcdefghijklmnopqrstuvwxyz0123456789"
	charsPerShard := len(chars) / len(servers)

	for i, server := range servers {
		start := i * charsPerShard
		end := start + charsPerShard
		if i == len(servers)-1 {
			end = len(chars) // last shard gets remainder
		}
		for j := start; j < end; j++ {
			router.shards[string(chars[j])] = server
		}
	}

	return router
}

// Route returns the server address for a given prefix
func (r *PrefixShardRouter) Route(prefix string) (string, error) {
	if prefix == "" {
		return "", fmt.Errorf("empty prefix")
	}

	firstChar := strings.ToLower(prefix[:1])
	server, ok := r.shards[firstChar]
	if !ok {
		// Unknown character, route to first shard
		return r.shards["a"], nil
	}

	return server, nil
}

// Example: with 4 servers (36 chars / 4 = 9 per shard)
// Server 0: a-i (9 chars)
// Server 1: j-r (9 chars)
// Server 2: s-z and 0 (9 chars)
// Server 3: 1-9 (9 chars)
//
// Each shard holds ~12M terms (50M / 4)
// Memory per shard: ~4GB (15GB / 4)
// QPS per shard: ~25K (100K / 4, assuming uniform distribution)
```

---
