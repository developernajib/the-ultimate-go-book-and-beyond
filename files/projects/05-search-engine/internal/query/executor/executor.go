// internal/query/executor/executor.go
package executor

import (
	"fmt"
	"sort"
	"strings"

	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/index/posting"
	"github.com/example/search-engine/internal/query/parser"
	"github.com/example/search-engine/internal/ranking"
)

// SearchResult represents a single search result
type SearchResult struct {
	DocID uint32
	Score float64
	Doc   *inverted.Document
}

// SearchResults holds all search results
type SearchResults struct {
	Results   []SearchResult
	TotalHits int
	MaxScore  float64
	QueryTime int64 // Microseconds
}

// Executor executes queries against an index
type Executor struct {
	index  *inverted.InvertedIndex
	scorer ranking.Scorer
}

func NewExecutor(index *inverted.InvertedIndex, scorer ranking.Scorer) *Executor {
	return &Executor{
		index:  index,
		scorer: scorer,
	}
}

// Execute runs a query and returns results
func (e *Executor) Execute(query parser.Query, limit int) (*SearchResults, error) {
	// Get matching posting list
	postingList, err := e.executeQuery(query)
	if err != nil {
		return nil, err
	}

	if postingList == nil || len(postingList.Postings) == 0 {
		return &SearchResults{
			Results:   []SearchResult{},
			TotalHits: 0,
		}, nil
	}

	// Score documents
	results := make([]SearchResult, 0, len(postingList.Postings))
	for _, p := range postingList.Postings {
		doc, ok := e.index.GetDocument(p.DocID)
		if !ok {
			continue
		}

		score := e.scorer.Score(query, p, e.index)
		results = append(results, SearchResult{
			DocID: p.DocID,
			Score: score,
			Doc:   doc,
		})
	}

	// Sort by score
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	// Apply limit
	totalHits := len(results)
	if limit > 0 && limit < len(results) {
		results = results[:limit]
	}

	maxScore := 0.0
	if len(results) > 0 {
		maxScore = results[0].Score
	}

	return &SearchResults{
		Results:   results,
		TotalHits: totalHits,
		MaxScore:  maxScore,
	}, nil
}

func (e *Executor) executeQuery(query parser.Query) (*posting.PostingList, error) {
	switch q := query.(type) {
	case *parser.TermQuery:
		return e.executeTermQuery(q)

	case *parser.PhraseQuery:
		return e.executePhraseQuery(q)

	case *parser.BoolQuery:
		return e.executeBoolQuery(q)

	case *parser.FuzzyQuery:
		return e.executeFuzzyQuery(q)

	case *parser.WildcardQuery:
		return e.executeWildcardQuery(q)

	case *parser.PrefixQuery:
		return e.executePrefixQuery(q)

	case *parser.MatchAllQuery:
		return e.executeMatchAllQuery(q)

	default:
		return nil, fmt.Errorf("unsupported query type: %T", query)
	}
}

func (e *Executor) executeTermQuery(q *parser.TermQuery) (*posting.PostingList, error) {
	pl, ok := e.index.Search(q.Field, q.Term)
	if !ok {
		return posting.NewPostingList(q.Term), nil
	}
	return pl, nil
}

func (e *Executor) executePhraseQuery(q *parser.PhraseQuery) (*posting.PostingList, error) {
	if len(q.Terms) == 0 {
		return posting.NewPostingList(""), nil
	}

	// Get posting lists for all terms
	postingLists := make([]*posting.PostingList, 0, len(q.Terms))
	for _, term := range q.Terms {
		pl, ok := e.index.Search(q.Field, term)
		if !ok {
			// Term not found - phrase cannot match
			return posting.NewPostingList(""), nil
		}
		postingLists = append(postingLists, pl)
	}

	// Find documents containing all terms
	result := postingLists[0]
	for i := 1; i < len(postingLists); i++ {
		result = posting.Intersect(result, postingLists[i])
	}

	// Filter by position (phrase matching)
	phraseResult := posting.NewPostingList(q.Field + ":\"" + strings.Join(q.Terms, " ") + "\"")

	for _, p := range result.Postings {
		if e.matchesPhrase(p.DocID, q, postingLists) {
			phraseResult.Add(p.DocID, p.Positions)
		}
	}

	return phraseResult, nil
}

func (e *Executor) matchesPhrase(docID uint32, q *parser.PhraseQuery, postingLists []*posting.PostingList) bool {
	// Get positions for each term in this document
	termPositions := make([][]uint32, len(postingLists))
	for i, pl := range postingLists {
		p, ok := pl.Get(docID)
		if !ok {
			return false
		}
		termPositions[i] = p.Positions
	}

	// Check if terms appear in sequence with allowed slop
	for _, firstPos := range termPositions[0] {
		matches := true
		for i := 1; i < len(termPositions); i++ {
			expectedPos := firstPos + uint32(i)
			found := false

			for _, pos := range termPositions[i] {
				distance := int(pos) - int(expectedPos)
				if distance < 0 {
					distance = -distance
				}
				if distance <= q.Slop {
					found = true
					break
				}
			}

			if !found {
				matches = false
				break
			}
		}

		if matches {
			return true
		}
	}

	return false
}

func (e *Executor) executeBoolQuery(q *parser.BoolQuery) (*posting.PostingList, error) {
	var result *posting.PostingList

	// Process MUST clauses (AND)
	for i, clause := range q.Must {
		pl, err := e.executeQuery(clause)
		if err != nil {
			return nil, err
		}

		if i == 0 {
			result = pl
		} else {
			result = posting.Intersect(result, pl)
		}
	}

	// Process SHOULD clauses (OR)
	if len(q.Must) == 0 && len(q.Should) > 0 {
		for i, clause := range q.Should {
			pl, err := e.executeQuery(clause)
			if err != nil {
				return nil, err
			}

			if i == 0 {
				result = pl
			} else {
				result = posting.Union(result, pl)
			}
		}
	}

	// Process MUST_NOT clauses (subtract)
	for _, clause := range q.MustNot {
		pl, err := e.executeQuery(clause)
		if err != nil {
			return nil, err
		}

		if result != nil {
			result = e.subtract(result, pl)
		}
	}

	if result == nil {
		result = posting.NewPostingList("")
	}

	return result, nil
}

func (e *Executor) subtract(a, b *posting.PostingList) *posting.PostingList {
	result := posting.NewPostingList(a.Term)

	bDocs := make(map[uint32]struct{})
	for _, p := range b.Postings {
		bDocs[p.DocID] = struct{}{}
	}

	for _, p := range a.Postings {
		if _, exists := bDocs[p.DocID]; !exists {
			result.Postings = append(result.Postings, p)
			result.DocCount++
		}
	}

	return result
}

func (e *Executor) executeFuzzyQuery(q *parser.FuzzyQuery) (*posting.PostingList, error) {
	// Get all terms and find similar ones using Levenshtein distance
	result := posting.NewPostingList(q.Term + "~")

	e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
		// Extract term without field prefix
		parts := strings.SplitN(term, ":", 2)
		if len(parts) != 2 || parts[0] != q.Field {
			return true
		}

		termText := parts[1]

		if e.fuzzyMatch(q.Term, termText, q.MaxEdits, q.PrefixLength) {
			result = posting.Union(result, pl)
		}

		return true
	})

	return result, nil
}

func (e *Executor) fuzzyMatch(term1, term2 string, maxEdits, prefixLen int) bool {
	// Check prefix
	minLen := min(len(term2), len(term1))

	if prefixLen > 0 {
		if minLen < prefixLen {
			return false
		}

		if term1[:prefixLen] != term2[:prefixLen] {
			return false
		}
	}

	// Calculate Levenshtein distance
	distance := levenshteinDistance(term1, term2)
	return distance <= maxEdits
}

func levenshteinDistance(s1, s2 string) int {
	r1 := []rune(s1)
	r2 := []rune(s2)

	if len(r1) == 0 {
		return len(r2)
	}
	if len(r2) == 0 {
		return len(r1)
	}

	// Create distance matrix
	dp := make([][]int, len(r1)+1)
	for i := range dp {
		dp[i] = make([]int, len(r2)+1)
		dp[i][0] = i
	}
	for j := range dp[0] {
		dp[0][j] = j
	}

	for i := 1; i <= len(r1); i++ {
		for j := 1; j <= len(r2); j++ {
			cost := 1
			if r1[i-1] == r2[j-1] {
				cost = 0
			}

			dp[i][j] = minInt(
				dp[i-1][j]+1,      // Deletion
				dp[i][j-1]+1,      // Insertion
				dp[i-1][j-1]+cost, // Substitution
			)
		}
	}

	return dp[len(r1)][len(r2)]
}

func minInt(a, b, c int) int {
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

func (e *Executor) executeWildcardQuery(q *parser.WildcardQuery) (*posting.PostingList, error) {
	result := posting.NewPostingList(q.Pattern)

	e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
		parts := strings.SplitN(term, ":", 2)
		if len(parts) != 2 || parts[0] != q.Field {
			return true
		}

		if wildcardMatch(q.Pattern, parts[1]) {
			result = posting.Union(result, pl)
		}

		return true
	})

	return result, nil
}

func wildcardMatch(pattern, text string) bool {
	// Simple wildcard matching (* and ?)
	if pattern == "*" {
		return true
	}

	// Convert to regex-like matching
	pr := []rune(pattern)
	tr := []rune(text)

	return wildcardMatchRunes(pr, tr, 0, 0)
}

func wildcardMatchRunes(pattern, text []rune, pi, ti int) bool {
	if pi == len(pattern) && ti == len(text) {
		return true
	}

	if pi == len(pattern) {
		return false
	}

	if pattern[pi] == '*' {
		// Try matching zero or more characters
		for i := ti; i <= len(text); i++ {
			if wildcardMatchRunes(pattern, text, pi+1, i) {
				return true
			}
		}
		return false
	}

	if ti == len(text) {
		return false
	}

	if pattern[pi] == '?' || pattern[pi] == text[ti] {
		return wildcardMatchRunes(pattern, text, pi+1, ti+1)
	}

	return false
}

func (e *Executor) executePrefixQuery(q *parser.PrefixQuery) (*posting.PostingList, error) {
	result := posting.NewPostingList(q.Prefix + "*")

	e.index.ForEachTerm(func(term string, pl *posting.PostingList) bool {
		parts := strings.SplitN(term, ":", 2)
		if len(parts) != 2 || parts[0] != q.Field {
			return true
		}

		if strings.HasPrefix(parts[1], q.Prefix) {
			result = posting.Union(result, pl)
		}

		return true
	})

	return result, nil
}

func (e *Executor) executeMatchAllQuery(_ *parser.MatchAllQuery) (*posting.PostingList, error) {
	result := posting.NewPostingList("*:*")

	stats := e.index.Stats()
	for docID := uint32(1); docID <= stats.DocCount; docID++ {
		if doc, ok := e.index.GetDocument(docID); ok {
			result.Add(doc.ID, []uint32{0})
		}
	}

	return result, nil
}
