// internal/ranking/tfidf.go
package ranking

import (
	"math"

	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/index/posting"
	"github.com/example/search-engine/internal/query/parser"
)

// Scorer interface for scoring documents
type Scorer interface {
	Score(query parser.Query, posting posting.Posting, index *inverted.InvertedIndex) float64
}

// TFIDFScorer implements TF-IDF scoring
type TFIDFScorer struct {
	k1 float64 // Term frequency saturation (usually 1.2-2.0)
	b  float64 // Length normalization (usually 0.75)
}

func NewTFIDFScorer() *TFIDFScorer {
	return &TFIDFScorer{
		k1: 1.5,
		b:  0.75,
	}
}

func (s *TFIDFScorer) Score(query parser.Query, p posting.Posting, index *inverted.InvertedIndex) float64 {
	score := 0.0

	switch q := query.(type) {
	case *parser.TermQuery:
		score = s.scoreTermQuery(q, p, index)

	case *parser.PhraseQuery:
		score = s.scorePhraseQuery(q, p, index)

	case *parser.BoolQuery:
		score = s.scoreBoolQuery(q, p, index)

	default:
		score = float64(p.Frequency)
	}

	return score
}

func (s *TFIDFScorer) scoreTermQuery(q *parser.TermQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
	pl, ok := index.Search(q.Field, q.Term)
	if !ok {
		return 0.0
	}

	// TF (term frequency)
	tf := float64(p.Frequency)

	// IDF (inverse document frequency)
	stats := index.Stats()
	docCount := float64(stats.DocCount)
	termDocCount := float64(pl.DocCount)

	idf := math.Log(1.0 + (docCount-termDocCount+0.5)/(termDocCount+0.5))

	// TF-IDF score
	score := tf * idf * q.Boost

	return score
}

func (s *TFIDFScorer) scorePhraseQuery(q *parser.PhraseQuery, p posting.Posting, _ *inverted.InvertedIndex) float64 {
	// Score based on phrase frequency
	return float64(p.Frequency) * q.Boost
}

func (s *TFIDFScorer) scoreBoolQuery(q *parser.BoolQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
	score := 0.0

	// Sum scores from MUST clauses
	for _, clause := range q.Must {
		score += s.Score(clause, p, index)
	}

	// Add scores from SHOULD clauses
	for _, clause := range q.Should {
		score += s.Score(clause, p, index)
	}

	return score * q.Boost
}
