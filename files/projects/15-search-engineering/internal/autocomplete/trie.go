package autocomplete

import (
	"sort"
	"strings"
	"sync"
)

// TrieNode represents a node in the trie
type TrieNode struct {
	children map[rune]*TrieNode
	isEnd    bool
	word     string  // full word at this node
	score    float64 // popularity/relevance score
}

// Trie provides prefix-based autocomplete
type Trie struct {
	root *TrieNode
}

func NewTrie() *Trie {
	return &Trie{root: &TrieNode{children: make(map[rune]*TrieNode)}}
}

// Insert adds a word with a score to the trie
func (t *Trie) Insert(word string, score float64) {
	node := t.root
	word = strings.ToLower(strings.TrimSpace(word))

	for _, ch := range word {
		if node.children[ch] == nil {
			node.children[ch] = &TrieNode{children: make(map[rune]*TrieNode)}
		}
		node = node.children[ch]
	}
	node.isEnd = true
	node.word = word
	node.score = score
}

// Suggest returns up to n suggestions for a given prefix
func (t *Trie) Suggest(prefix string, n int) []Suggestion {
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	node := t.root

	// Navigate to prefix
	for _, ch := range prefix {
		if node.children[ch] == nil {
			return nil // no completions
		}
		node = node.children[ch]
	}

	// Collect all completions under this node
	var suggestions []Suggestion
	t.collect(node, prefix, &suggestions)

	// Sort by score descending
	sort.Slice(suggestions, func(i, j int) bool {
		return suggestions[i].Score > suggestions[j].Score
	})

	if n > 0 && len(suggestions) > n {
		suggestions = suggestions[:n]
	}
	return suggestions
}

type Suggestion struct {
	Word  string
	Score float64
}

func (t *Trie) collect(node *TrieNode, prefix string, results *[]Suggestion) {
	if node.isEnd {
		*results = append(*results, Suggestion{Word: node.word, Score: node.score})
	}
	for ch, child := range node.children {
		t.collect(child, prefix+string(ch), results)
	}
}

// FuzzySearch finds words within edit distance of the query
func (t *Trie) FuzzySearch(query string, maxDistance int, maxResults int) []Suggestion {
	query = strings.ToLower(query)

	var results []Suggestion
	t.fuzzyDFS(t.root, "", query, maxDistance, &results)

	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	if maxResults > 0 && len(results) > maxResults {
		results = results[:maxResults]
	}
	return results
}

func (t *Trie) fuzzyDFS(node *TrieNode, current, query string, maxDist int, results *[]Suggestion) {
	if len(current) > len(query)+maxDist {
		return // pruning: can't possibly be within maxDist
	}

	if node.isEnd {
		dist := levenshtein(current, query)
		if dist <= maxDist {
			*results = append(*results, Suggestion{
				Word:  current,
				Score: node.score / float64(dist+1), // penalize by distance
			})
		}
	}

	for ch, child := range node.children {
		t.fuzzyDFS(child, current+string(ch), query, maxDist, results)
	}
}

// levenshtein computes the edit distance between two strings
func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	m, n := len(ra), len(rb)

	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
		dp[i][0] = i
	}
	for j := range dp[0] {
		dp[0][j] = j
	}

	for i := 1; i <= m; i++ {
		for j := 1; j <= n; j++ {
			if ra[i-1] == rb[j-1] {
				dp[i][j] = dp[i-1][j-1]
			} else {
				dp[i][j] = 1 + minOf3(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
			}
		}
	}
	return dp[m][n]
}

func minOf3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}

// PopularityRanker tracks query frequencies to score suggestions
type PopularityRanker struct {
	trie   *Trie
	counts map[string]int
	mu     sync.RWMutex
}

func NewPopularityRanker() *PopularityRanker {
	return &PopularityRanker{
		trie:   NewTrie(),
		counts: make(map[string]int),
	}
}

// RecordQuery records a user query for popularity scoring
func (r *PopularityRanker) RecordQuery(query string) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return
	}

	r.mu.Lock()
	r.counts[query]++
	count := r.counts[query]
	r.mu.Unlock()

	r.trie.Insert(query, float64(count))
}

// Suggest returns popular suggestions for a prefix
func (r *PopularityRanker) Suggest(prefix string, n int) []Suggestion {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.trie.Suggest(prefix, n)
}
