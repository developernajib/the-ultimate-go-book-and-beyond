// internal/query/parser/ast.go
package parser

import "strings"

// Query represents a search query AST
type Query interface {
	String() string
}

// TermQuery - search for a single term
type TermQuery struct {
	Field string
	Term  string
	Boost float64 // Optional boost factor
}

func (q *TermQuery) String() string {
	return q.Field + ":" + q.Term
}

// PhraseQuery - search for exact phrase
type PhraseQuery struct {
	Field string
	Terms []string
	Slop  int // Maximum distance between terms
	Boost float64
}

func (q *PhraseQuery) String() string {
	return q.Field + ":\"" + joinStrings(q.Terms, " ") + "\""
}

// BoolQuery - boolean combination of queries
type BoolQuery struct {
	Must    []Query // AND
	Should  []Query // OR
	MustNot []Query // NOT
	Boost   float64
}

func (q *BoolQuery) String() string {
	return "BoolQuery{...}"
}

// RangeQuery - range search
type RangeQuery struct {
	Field        string
	LowerBound   string
	UpperBound   string
	IncludeLower bool
	IncludeUpper bool
	Boost        float64
}

func (q *RangeQuery) String() string {
	lb := "["
	if !q.IncludeLower {
		lb = "{"
	}
	ub := "]"
	if !q.IncludeUpper {
		ub = "}"
	}
	return q.Field + ":" + lb + q.LowerBound + " TO " + q.UpperBound + ub
}

// FuzzyQuery - fuzzy search with edit distance
type FuzzyQuery struct {
	Field        string
	Term         string
	MaxEdits     int // Levenshtein distance (1 or 2)
	PrefixLength int // Common prefix length
	Boost        float64
}

func (q *FuzzyQuery) String() string {
	return q.Field + ":" + q.Term + "~" + string(rune('0'+q.MaxEdits))
}

// WildcardQuery - wildcard search (* and ?)
type WildcardQuery struct {
	Field   string
	Pattern string
	Boost   float64
}

func (q *WildcardQuery) String() string {
	return q.Field + ":" + q.Pattern
}

// PrefixQuery - prefix search
type PrefixQuery struct {
	Field  string
	Prefix string
	Boost  float64
}

func (q *PrefixQuery) String() string {
	return q.Field + ":" + q.Prefix + "*"
}

// MatchAllQuery - matches all documents
type MatchAllQuery struct {
	Boost float64
}

func (q *MatchAllQuery) String() string {
	return "*:*"
}

func joinStrings(strs []string, sep string) string {
	if len(strs) == 0 {
		return ""
	}
	var result strings.Builder
	result.WriteString(strs[0])
	for i := 1; i < len(strs); i++ {
		result.WriteString(sep + strs[i])
	}
	return result.String()
}
