// internal/ranking/bm25.go
package ranking

import (
	"math"

	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/index/posting"
	"github.com/example/search-engine/internal/query/parser"
)

// BM25Scorer implements Okapi BM25 ranking
type BM25Scorer struct {
	k1         float64        // Term frequency saturation (usually 1.2-2.0)
	b          float64        // Length normalization (usually 0.75)
	avgDocLen  float64        // Average document length
	docLengths map[uint32]int // Cache of document lengths
}

func NewBM25Scorer(index *inverted.InvertedIndex) *BM25Scorer {
	scorer := &BM25Scorer{
		k1:         1.2,
		b:          0.75,
		docLengths: make(map[uint32]int),
	}

	// Calculate average document length
	totalLen := 0
	docCount := 0

	stats := index.Stats()
	for docID := uint32(1); docID <= stats.DocCount; docID++ {
		if doc, ok := index.GetDocument(docID); ok {
			length := scorer.calculateDocLength(doc)
			scorer.docLengths[docID] = length
			totalLen += length
			docCount++
		}
	}

	if docCount > 0 {
		scorer.avgDocLen = float64(totalLen) / float64(docCount)
	} else {
		scorer.avgDocLen = 1000 // Default
	}

	return scorer
}

func (s *BM25Scorer) calculateDocLength(doc *inverted.Document) int {
	totalLen := 0
	for _, value := range doc.Fields {
		totalLen += len([]rune(value))
	}
	return totalLen
}

func (s *BM25Scorer) Score(query parser.Query, p posting.Posting, index *inverted.InvertedIndex) float64 {
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

func (s *BM25Scorer) scoreTermQuery(q *parser.TermQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
	pl, ok := index.Search(q.Field, q.Term)
	if !ok {
		return 0.0
	}

	// Get document statistics
	stats := index.Stats()
	N := float64(stats.DocCount)
	n := float64(pl.DocCount)

	// IDF component
	idf := math.Log(1.0 + (N-n+0.5)/(n+0.5))

	// TF component with document length normalization
	tf := float64(p.Frequency)
	docLen := float64(s.docLengths[p.DocID])

	normalizedTF := (tf * (s.k1 + 1.0)) /
		(tf + s.k1*(1.0-s.b+s.b*(docLen/s.avgDocLen)))

	// BM25 score
	score := idf * normalizedTF * q.Boost

	return score
}

func (s *BM25Scorer) scorePhraseQuery(q *parser.PhraseQuery, p posting.Posting, _ *inverted.InvertedIndex) float64 {
	// Use similar calculation but with phrase frequency
	tf := float64(p.Frequency)
	docLen := float64(s.docLengths[p.DocID])

	normalizedTF := (tf * (s.k1 + 1.0)) /
		(tf + s.k1*(1.0-s.b+s.b*(docLen/s.avgDocLen)))

	return normalizedTF * q.Boost
}

func (s *BM25Scorer) scoreBoolQuery(q *parser.BoolQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
	score := 0.0

	for _, clause := range q.Must {
		score += s.Score(clause, p, index)
	}

	for _, clause := range q.Should {
		score += s.Score(clause, p, index)
	}

	return score * q.Boost
}
