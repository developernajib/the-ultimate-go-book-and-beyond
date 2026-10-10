## Core Components

### 1. Trie-Based Autocomplete

The trie (prefix tree) is the core in-memory data structure that makes sub-millisecond prefix lookups possible. Each `TrieNode` caches the top-K suggestions computed from all of its descendants, so a search for "go" returns pre-ranked results without traversing the entire subtree. A `sync.RWMutex` per node allows concurrent reads without contention, which is critical at 100K QPS, while writes (triggered by new search events) acquire exclusive locks only on the affected path from root to leaf.

```go
package autocomplete

import (
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

// TrieNode is a node in the prefix trie
type TrieNode struct {
	children map[rune]*TrieNode
	isEnd    bool
	// Top-K suggestions cached at this node
	// Updated when a child's count changes
	topK     []Suggestion
	mu       sync.RWMutex
}

// Suggestion is a single autocomplete result
type Suggestion struct {
	Term  string  `json:"term"`
	Score float64 `json:"score"` // frequency × recency boost
}

// Trie is a prefix tree for autocomplete
type Trie struct {
	root      *TrieNode
	maxK      int // max suggestions per node
	termCount atomic.Int64
}

// NewTrie creates a new empty trie
func NewTrie(maxK int) *Trie {
	return &Trie{
		root: &TrieNode{children: make(map[rune]*TrieNode)},
		maxK: maxK,
	}
}

// Insert adds or updates a term's score in the trie
func (t *Trie) Insert(term string, score float64) {
	term = normalizeQuery(term)
	if term == "" {
		return
	}

	node := t.root
	suggestion := Suggestion{Term: term, Score: score}

	for _, ch := range term {
		node.mu.Lock()
		if _, ok := node.children[ch]; !ok {
			node.children[ch] = &TrieNode{children: make(map[rune]*TrieNode)}
		}
		// Update top-K at this node
		node.topK = updateTopK(node.topK, suggestion, t.maxK)
		next := node.children[ch]
		node.mu.Unlock()
		node = next
	}

	// Mark end node
	node.mu.Lock()
	if !node.isEnd {
		node.isEnd = true
		t.termCount.Add(1)
	}
	node.topK = updateTopK(node.topK, suggestion, t.maxK)
	node.mu.Unlock()
}

// TermCount returns the number of distinct terms in the trie
func (t *Trie) TermCount() int {
	return int(t.termCount.Load())
}

// Search returns top-K suggestions for a prefix
func (t *Trie) Search(prefix string) []Suggestion {
	prefix = normalizeQuery(prefix)
	if prefix == "" {
		return nil
	}

	node := t.root
	for _, ch := range prefix {
		node.mu.RLock()
		next, ok := node.children[ch]
		node.mu.RUnlock()
		if !ok {
			return nil // no completions for this prefix
		}
		node = next
	}

	node.mu.RLock()
	result := make([]Suggestion, len(node.topK))
	copy(result, node.topK)
	node.mu.RUnlock()

	return result
}

// updateTopK maintains a sorted top-K list of suggestions
func updateTopK(topK []Suggestion, cand Suggestion, maxK int) []Suggestion {
	// If the term already exists, update its score
	for i, s := range topK {
		if s.Term == cand.Term {
			topK[i].Score = cand.Score
			sort.Slice(topK, func(i, j int) bool {
				return topK[i].Score > topK[j].Score
			})
			return topK
		}
	}

	// Add new term
	topK = append(topK, cand)
	sort.Slice(topK, func(i, j int) bool {
		return topK[i].Score > topK[j].Score
	})

	// Trim to maxK
	if len(topK) > maxK {
		topK = topK[:maxK]
	}
	return topK
}

// normalizeQuery lowercases and strips special characters
func normalizeQuery(q string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(q)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}
```

### 2. Autocomplete Service with Redis Cache

The `AutocompleteService` wraps the in-memory trie with a Redis cache layer and a personalization step. Cached results use a 30-second TTL because trending search terms can shift rapidly, a term that was not in the top 5 an hour ago might surge to #1 after a news event. The service checks Redis first (O(1) network round-trip), falls back to the trie on a cache miss, and then blends global suggestions with the user's recent search history to apply personal relevance boosting.

```go
package autocomplete

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

type PersonalizationService interface {
	GetUserHistoryForPrefix(ctx context.Context, userID, prefix string, limit int) ([]Suggestion, error)
}

// AutocompleteService handles suggestion requests
type AutocompleteService struct {
	trie      *Trie
	rdb       *redis.ClusterClient
	personSvc PersonalizationService
}

// SuggestRequest is a typeahead query
type SuggestRequest struct {
	Prefix string `json:"prefix"`
	UserID string `json:"user_id,omitempty"` // for personalization
	Limit  int    `json:"limit"`
	Domain string `json:"domain"` // "web", "product", "user"
}

// SuggestResponse is the autocomplete response
type SuggestResponse struct {
	Prefix      string       `json:"prefix"`
	Suggestions []Suggestion `json:"suggestions"`
	ElapsedMs   float64      `json:"elapsed_ms"`
}

// Suggest returns autocomplete suggestions
func (s *AutocompleteService) Suggest(ctx context.Context, req SuggestRequest) (*SuggestResponse, error) {
	start := time.Now()

	if req.Limit == 0 {
		req.Limit = 10
	}

	prefix := normalizeQuery(req.Prefix)
	if len(prefix) < 1 {
		return &SuggestResponse{Prefix: req.Prefix}, nil
	}

	// 1. Check Redis cache first
	cacheKey := fmt.Sprintf("ac:%s:%s", req.Domain, prefix)
	if cached, err := s.rdb.Get(ctx, cacheKey).Bytes(); err == nil {
		var suggestions []Suggestion
		if json.Unmarshal(cached, &suggestions) == nil {
			// Personalize cached results
			if req.UserID != "" {
				suggestions = s.personalize(ctx, suggestions, req.UserID, prefix, req.Limit)
			}
			return &SuggestResponse{
				Prefix:      req.Prefix,
				Suggestions: suggestions[:min(len(suggestions), req.Limit)],
				ElapsedMs:   float64(time.Since(start).Microseconds()) / 1000,
			}, nil
		}
	}

	// 2. Query trie for global suggestions
	suggestions := s.trie.Search(prefix)

	// 3. Cache result (short TTL, suggestions change with trends)
	data, _ := json.Marshal(suggestions)
	s.rdb.Set(ctx, cacheKey, data, 30*time.Second)

	// 4. Personalize: boost user's own history
	if req.UserID != "" {
		suggestions = s.personalize(ctx, suggestions, req.UserID, prefix, req.Limit)
	}

	if len(suggestions) > req.Limit {
		suggestions = suggestions[:req.Limit]
	}

	return &SuggestResponse{
		Prefix:      req.Prefix,
		Suggestions: suggestions,
		ElapsedMs:   float64(time.Since(start).Microseconds()) / 1000,
	}, nil
}

// personalize boosts suggestions from user's search history
func (s *AutocompleteService) personalize(ctx context.Context, global []Suggestion, userID, prefix string, limit int) []Suggestion {
	// Get user's recent searches matching the typed prefix
	personal, err := s.personSvc.GetUserHistoryForPrefix(ctx, userID, prefix, limit/2)
	if err != nil || len(personal) == 0 {
		return global
	}

	// Merge: personal suggestions first, then global
	personalSet := make(map[string]bool)
	result := make([]Suggestion, 0, limit)

	for _, p := range personal {
		if len(result) >= limit/2 { // max 5 personal, 5 global
			break
		}
		personalSet[p.Term] = true
		// Personal entries rank by position, Score carries the
		// recency timestamp from the user's history
		result = append(result, Suggestion{Term: p.Term, Score: p.Score})
	}

	for _, g := range global {
		if !personalSet[g.Term] {
			result = append(result, g)
		}
		if len(result) >= limit {
			break
		}
	}

	return result
}

// RecordSearch records a web-search term to update frequencies.
// Other domains route through their own recording path.
func (s *AutocompleteService) RecordSearch(ctx context.Context, term, userID string) {
	term = normalizeQuery(term)
	if term == "" {
		return
	}

	// Increment global frequency counter
	key := fmt.Sprintf("term:count:%s", term)
	newCount, _ := s.rdb.Incr(ctx, key).Result()

	// Update user history
	if userID != "" {
		userKey := fmt.Sprintf("user:history:%s", userID)
		s.rdb.ZAdd(ctx, userKey, redis.Z{
			Score:  float64(time.Now().Unix()),
			Member: term,
		})
		s.rdb.ZRemRangeByRank(ctx, userKey, 0, -101) // keep last 100
		s.rdb.Expire(ctx, userKey, 30*24*time.Hour)
	}

	// Update trie (with frequency count as score)
	// In production: batch updates to reduce lock contention
	score := computeScore(float64(newCount), time.Now())
	s.trie.Insert(term, score)

	// Invalidate cache for affected prefixes
	runes := []rune(term)
	for i := 1; i <= len(runes); i++ {
		s.rdb.Del(ctx, fmt.Sprintf("ac:web:%s", string(runes[:i])))
	}
}

// computeScore combines frequency with time decay
func computeScore(count float64, t time.Time) float64 {
	// Logarithmic frequency + time decay (trending boost)
	// Base score is log10(count): each 10x in count = +1 score
	base := math.Log10(count + 1)
	// Recency boost: decay over 7 days
	daysSince := time.Since(t).Hours() / 24
	recency := math.Exp(-daysSince / 7)
	return base + recency*0.5
}
```

### 3. Distributed Trie for Scale

A single in-memory trie works until the term set or traffic outgrows one machine. The `DistributedTrie` keeps a small local trie as an L1 cache for hot prefixes and falls back to Redis, which holds precomputed top-K lists per prefix, for the long tail. When a prefix has no precomputed entry, `ZRANGEBYLEX` on a lexicographically sorted set rebuilds the suggestion list on demand, so the service answers any query without inter-node RPC on the hot path. Section 28 shows how to shard the prefix keyspace across a server fleet.

```go
package autocomplete

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

// DistributedTrie stores trie data in Redis for horizontal scaling
// Partitioned by prefix shard, each server owns a range of prefixes
type DistributedTrie struct {
	rdb   *redis.ClusterClient
	local *Trie // L1 cache: in-memory trie for hot prefixes
}

// GetSuggestions retrieves suggestions from distributed trie
func (d *DistributedTrie) GetSuggestions(ctx context.Context, prefix string, limit int) ([]Suggestion, error) {
	// 1. Check local in-memory trie (hot path for common prefixes)
	if suggestions := d.local.Search(prefix); len(suggestions) >= limit {
		return suggestions[:limit], nil
	}

	// 2. Fall back to Redis (stores precomputed top-K per prefix)
	key := fmt.Sprintf("trie:prefix:%s", prefix)
	data, err := d.rdb.Get(ctx, key).Bytes()
	if err == nil {
		var suggestions []Suggestion
		if json.Unmarshal(data, &suggestions) == nil {
			return suggestions[:min(len(suggestions), limit)], nil
		}
	}

	// 3. Not cached, build from term frequency store
	suggestions, err := d.buildSuggestionsForPrefix(ctx, prefix, limit)
	if err != nil {
		return nil, err
	}

	// Cache result
	data, _ = json.Marshal(suggestions)
	d.rdb.Set(ctx, key, data, 5*time.Minute)

	// Warm local cache for hot prefix
	if len(suggestions) > 0 {
		for _, s := range suggestions {
			d.local.Insert(s.Term, s.Score)
		}
	}

	return suggestions, nil
}

// buildSuggestionsForPrefix queries term frequency store for completions
func (d *DistributedTrie) buildSuggestionsForPrefix(ctx context.Context, prefix string, limit int) ([]Suggestion, error) {
	// Use Redis ZRANGEBYLEX on a sorted set of all terms
	// Terms stored as: "golang" → score=frequency
	// Lexicographic range: [prefix, prefix\xff]
	min := fmt.Sprintf("[%s", prefix)
	max := fmt.Sprintf("[%s\xff", prefix)

	members, err := d.rdb.ZRangeByLex(ctx, "terms:all", &redis.ZRangeBy{
		Min:    min,
		Max:    max,
		Offset: 0,
		Count:  int64(limit * 10), // get extra for re-ranking
	}).Result()
	if err != nil {
		return nil, err
	}

	// Get scores for each term
	var suggestions []Suggestion
	for _, term := range members {
		score, err := d.rdb.ZScore(ctx, "terms:freq", term).Result()
		if err != nil {
			continue
		}
		suggestions = append(suggestions, Suggestion{Term: term, Score: score})
	}

	// Sort by score descending
	sort.Slice(suggestions, func(i, j int) bool {
		return suggestions[i].Score > suggestions[j].Score
	})

	if len(suggestions) > limit {
		suggestions = suggestions[:limit]
	}
	return suggestions, nil
}

// BulkIndex loads terms and frequencies into the distributed trie
func (d *DistributedTrie) BulkIndex(ctx context.Context, terms map[string]float64) error {
	pipe := d.rdb.Pipeline()

	for term, freq := range terms {
		// Lexicographic sorted set for prefix range queries
		pipe.ZAdd(ctx, "terms:all", redis.Z{Score: 0, Member: term})
		// Separate set for frequency scores
		pipe.ZAdd(ctx, "terms:freq", redis.Z{Score: freq, Member: term})
	}

	_, err := pipe.Exec(ctx)
	return err
}

// PrecomputeTopK precomputes top-K for all common prefixes
// Run as a batch job when term frequencies are updated
func (d *DistributedTrie) PrecomputeTopK(ctx context.Context, maxPrefixLen int) error {
	// Get all unique terms
	terms, err := d.rdb.ZRange(ctx, "terms:all", 0, -1).Result()
	if err != nil {
		return err
	}

	// Build set of all prefixes up to maxPrefixLen
	prefixes := make(map[string]struct{})
	for _, term := range terms {
		runes := []rune(term)
		for i := 1; i <= len(runes) && i <= maxPrefixLen; i++ {
			prefixes[string(runes[:i])] = struct{}{}
		}
	}

	// For each prefix, compute and cache top-K
	for prefix := range prefixes {
		suggestions, err := d.buildSuggestionsForPrefix(ctx, prefix, 10)
		if err != nil {
			continue
		}
		data, _ := json.Marshal(suggestions)
		d.rdb.Set(ctx, fmt.Sprintf("trie:prefix:%s", prefix), data, 1*time.Hour)
	}

	return nil
}
```

### 4. Query Frequency Aggregator

Raw search events flow into Kafka at millions of events per minute, and the aggregator's job is to reduce this firehose into the compact frequency data that the trie needs for ranking. The aggregator consumes Kafka events, batches them into 1-minute windows using a local map, and at the end of each window flushes accumulated counts to Redis. The `TrendingDetector` compares the current minute's search velocity against a rolling hourly average to surface terms that are spiking, not just terms that are always popular.

```go
package aggregator

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

type TrieUpdater interface {
	IncrementTerm(ctx context.Context, term string, count int64)
}

// FrequencyAggregator processes search query streams to build term frequencies
// Runs as a Flink/Spark Streaming job consuming Kafka events
type FrequencyAggregator struct {
	kafkaClient *kgo.Client
	trieUpdater TrieUpdater
	windowSec   int // aggregation window in seconds
}

// SearchEvent is a raw search event from the search service
type SearchEvent struct {
	Query     string    `json:"query"`
	UserID    string    `json:"user_id"`
	Timestamp time.Time `json:"timestamp"`
	Domain    string    `json:"domain"`
}

// RunAggregation continuously aggregates search term frequencies
func (a *FrequencyAggregator) RunAggregation(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(a.windowSec) * time.Second)
	defer ticker.Stop()

	localCounts := make(map[string]int64)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Flush current window counts to trie
			if len(localCounts) > 0 {
				a.flushCounts(ctx, localCounts)
				localCounts = make(map[string]int64)
			}
		default:
			// Consume from Kafka
			fetches := a.kafkaClient.PollFetches(ctx)
			fetches.EachRecord(func(r *kgo.Record) {
				var event SearchEvent
				if err := json.Unmarshal(r.Value, &event); err != nil {
					return
				}
				// normalizeQuery is the same helper the serving path uses,
				// so counted terms match trie keys exactly
				term := normalizeQuery(event.Query)
				if term != "" {
					localCounts[term]++
				}
			})
		}
	}
}

func (a *FrequencyAggregator) flushCounts(ctx context.Context, counts map[string]int64) {
	for term, count := range counts {
		a.trieUpdater.IncrementTerm(ctx, term, count)
	}
}

// TrendingDetector identifies trending search queries
type TrendingDetector struct {
	rdb *redis.Client
}

// DetectTrending finds queries with unusually high velocity
func (d *TrendingDetector) DetectTrending(ctx context.Context) ([]TrendingTerm, error) {
	now := time.Now().Unix() / 60 // current minute bucket

	// Compare current minute to avg of past hour
	type termScore struct {
		term  string
		score float64
	}
	var trending []termScore

	// Candidate terms recently seen, populated by the aggregator
	recentTerms, _ := d.rdb.ZRangeByScore(ctx, "trending:recent",
		&redis.ZRangeBy{Min: "-inf", Max: "+inf"}).Result()

	for _, term := range recentTerms {
		current := d.getCount(ctx, term, now)
		historical := d.getAvgCount(ctx, term, now-60, now-1) // avg over past hour

		if historical < 10 {
			continue // too little baseline
		}

		// Trending score = current velocity / historical avg
		if current > 0 {
			score := float64(current) / historical
			if score > 2.0 { // 2x spike = trending
				trending = append(trending, termScore{term: term, score: score})
			}
		}
	}

	sort.Slice(trending, func(i, j int) bool {
		return trending[i].score > trending[j].score
	})

	results := make([]TrendingTerm, min(len(trending), 20))
	for i, t := range trending[:len(results)] {
		results[i] = TrendingTerm{Term: t.term, VelocityMultiplier: t.score}
	}
	return results, nil
}

func (d *TrendingDetector) getCount(ctx context.Context, term string, minute int64) int {
	val, _ := d.rdb.Get(ctx, fmt.Sprintf("qcount:%s:%d", term, minute)).Int()
	return val
}

func (d *TrendingDetector) getAvgCount(ctx context.Context, term string, from, to int64) float64 {
	total := 0
	count := 0
	for m := from; m <= to; m++ {
		v, _ := d.rdb.Get(ctx, fmt.Sprintf("qcount:%s:%d", term, m)).Int()
		total += v
		count++
	}
	if count == 0 {
		return 0
	}
	return float64(total) / float64(count)
}

type TrendingTerm struct {
	Term               string  `json:"term"`
	VelocityMultiplier float64 `json:"velocity_multiplier"`
}

func normalizeQuery(q string) string {
	return strings.ToLower(strings.TrimSpace(q))
}
```

---
