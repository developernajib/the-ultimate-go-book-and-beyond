package rank

import (
	"math"
	"sort"

	"github.com/example/search-engineering/internal/index"
)

// BM25 parameters
const (
	k1 = 1.5  // term frequency saturation parameter (1.2-2.0)
	b  = 0.75 // length normalization (0 = no normalization, 1 = full)
)

// BM25Scorer computes BM25 relevance scores
type BM25Scorer struct {
	idx *index.InvertedIndex
}

func NewBM25Scorer(idx *index.InvertedIndex) *BM25Scorer {
	return &BM25Scorer{idx: idx}
}

// Score computes the BM25 score of a document for a set of query terms
func (s *BM25Scorer) Score(docID index.DocID, terms []index.Term) float64 {
	s.idx.RLock()
	defer s.idx.RUnlock()

	score := 0.0
	docLen := float64(s.idx.DocLen(docID))

	for _, term := range terms {
		pl, ok := s.idx.GetIndex()[term]
		if !ok {
			continue
		}

		// Find this document's posting
		tf := 0.0
		for _, posting := range pl.Postings {
			if posting.DocID == docID {
				tf = float64(posting.Frequency)
				break
			}
		}
		if tf == 0 {
			continue
		}

		// IDF component
		df := float64(len(pl.Postings))
		N := float64(s.idx.DocCount())
		idf := math.Log((N-df+0.5)/(df+0.5) + 1)

		// TF normalization component
		avgDocLen := s.idx.AvgDocLen()
		if avgDocLen == 0 {
			avgDocLen = 1
		}
		tfNorm := tf * (k1 + 1) / (tf + k1*(1-b+b*docLen/avgDocLen))

		score += idf * tfNorm
	}

	return score
}

// Search finds and ranks documents matching the given terms
func (s *BM25Scorer) Search(terms []index.Term, topK int) []index.SearchResult {
	s.idx.RLock()

	// Collect candidate documents (union of all posting lists)
	candidates := make(map[index.DocID]bool)
	for _, term := range terms {
		if pl, ok := s.idx.GetIndex()[term]; ok {
			for _, posting := range pl.Postings {
				candidates[posting.DocID] = true
			}
		}
	}
	s.idx.RUnlock()

	// Score all candidates
	results := make([]index.SearchResult, 0, len(candidates))
	for docID := range candidates {
		score := s.Score(docID, terms)
		if score > 0 {
			results = append(results, index.SearchResult{DocID: docID, Score: score})
		}
	}

	// Sort by score descending
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	if topK > 0 && len(results) > topK {
		results = results[:topK]
	}

	return results
}

// TFIDFScorer is the simpler predecessor to BM25
type TFIDFScorer struct {
	idx *index.InvertedIndex
}

func NewTFIDFScorer(idx *index.InvertedIndex) *TFIDFScorer {
	return &TFIDFScorer{idx: idx}
}

func (s *TFIDFScorer) Score(docID index.DocID, terms []index.Term) float64 {
	s.idx.RLock()
	defer s.idx.RUnlock()

	score := 0.0
	for _, term := range terms {
		pl, ok := s.idx.GetIndex()[term]
		if !ok {
			continue
		}

		tf := 0.0
		for _, posting := range pl.Postings {
			if posting.DocID == docID {
				tf = 1 + math.Log(float64(posting.Frequency))
				break
			}
		}

		df := float64(len(pl.Postings))
		N := float64(s.idx.DocCount())
		idf := math.Log(N / (df + 1))

		score += tf * idf
	}

	// Length normalization
	if docLen := s.idx.DocLen(docID); docLen > 0 {
		score /= math.Sqrt(float64(docLen))
	}

	return score
}
