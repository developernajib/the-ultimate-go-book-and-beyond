## Deep Dive: Autocomplete (Typeahead)

Autocomplete provides instant search suggestions as the user types, which must respond in under 50ms to feel instantaneous. The underlying data structure is a trie (prefix tree) where each node stores a character, and leaf nodes hold the full query phrase along with a popularity weight. When the user types a prefix, the service walks the trie to that node and then collects all completed phrases below it, returning the highest-weighted suggestions first.

```go
package autocomplete

import (
	"context"
	"sort"
	"strings"
)

type TrieNode struct {
	children map[rune]*TrieNode
	isEnd    bool
	weight   float64
	phrase   string
}

type AutocompleteService struct {
	root *TrieNode
}

func New() *AutocompleteService {
	return &AutocompleteService{root: &TrieNode{children: make(map[rune]*TrieNode)}}
}

func (s *AutocompleteService) Add(query string, weight float64) {
	node := s.root
	for _, ch := range strings.ToLower(query) {
		if node.children[ch] == nil {
			node.children[ch] = &TrieNode{children: make(map[rune]*TrieNode)}
		}
		node = node.children[ch]
	}
	node.isEnd = true
	node.weight = weight
	node.phrase = query
}

func (s *AutocompleteService) Suggest(ctx context.Context, prefix string, limit int) []string {
	node := s.root
	for _, ch := range strings.ToLower(prefix) {
		if node.children[ch] == nil {
			return nil
		}
		node = node.children[ch]
	}

	type cand struct {
		p string
		w float64
	}
	var cs []cand
	var dfs func(*TrieNode)
	dfs = func(n *TrieNode) {
		if n.isEnd {
			cs = append(cs, cand{n.phrase, n.weight})
		}
		for _, c := range n.children {
			dfs(c)
		}
	}
	dfs(node)

	sort.Slice(cs, func(i, j int) bool { return cs[i].w > cs[j].w })
	var r []string
	for i, c := range cs {
		if i >= limit {
			break
		}
		r = append(r, c.p)
	}
	return r
}
```

---
