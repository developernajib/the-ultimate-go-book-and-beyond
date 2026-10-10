## Part 2: BM25 Ranking

BM25 (Best Match 25) is the standard ranking function used by Elasticsearch, Solr, and Lucene. Once the inverted index tells you which documents contain a query term, you need a way to decide which documents are the most relevant, that is what BM25 does. It scores each document based on two key ideas: how often the query term appears in that specific document (term frequency) and how rare the term is across all documents (inverse document frequency). BM25 improves on the older TF-IDF formula by adding term frequency saturation (so repeating a word 100 times does not make a document 100 times more relevant) and document length normalization (so a short, focused document scores higher than a long one that happens to mention the term). The implementation below also includes a simpler TF-IDF scorer for comparison.

```go
package rank

import "math"

// BM25 parameters
const (
	k1 = 1.5  // term frequency saturation parameter (1.2-2.0)
	b  = 0.75 // length normalization (0 = no normalization, 1 = full)
)

// BM25Scorer computes BM25 relevance scores
type BM25Scorer struct {
	index *InvertedIndex
}

func NewBM25Scorer(index *InvertedIndex) *BM25Scorer {
	return &BM25Scorer{index: index}
}

// Score computes the BM25 score of a document for a set of query terms
// BM25(D, Q) = Σ IDF(qi) × (f(qi,D) × (k1+1)) / (f(qi,D) + k1×(1-b+b×|D|/avgdl))
func (s *BM25Scorer) Score(docID DocID, terms []Term) float64 {
	s.index.mu.RLock()
	defer s.index.mu.RUnlock()

	score := 0.0
	docLen := float64(s.index.docLengths[docID])

	for _, term := range terms {
		pl, ok := s.index.index[term]
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
		df := float64(len(pl.Postings)) // document frequency
		N := float64(s.index.docCount)
		idf := math.Log((N-df+0.5)/(df+0.5) + 1)

		// TF normalization component
		tfNorm := tf * (k1 + 1) / (tf + k1*(1-b+b*docLen/s.index.avgDocLen))

		score += idf * tfNorm
	}

	return score
}

// SearchResult represents a ranked search result
type SearchResult struct {
	DocID DocID
	Score float64
}

// Search finds and ranks documents matching the given terms
func (s *BM25Scorer) Search(terms []Term, topK int) []SearchResult {
	s.index.mu.RLock()

	// Collect candidate documents (union of all posting lists)
	candidates := make(map[DocID]bool)
	for _, term := range terms {
		if pl, ok := s.index.index[term]; ok {
			for _, posting := range pl.Postings {
				candidates[posting.DocID] = true
			}
		}
	}
	s.index.mu.RUnlock()

	// Score all candidates
	results := make([]SearchResult, 0, len(candidates))
	for docID := range candidates {
		score := s.Score(docID, terms)
		if score > 0 {
			results = append(results, SearchResult{DocID: docID, Score: score})
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
	index *InvertedIndex
}

func (s *TFIDFScorer) Score(docID DocID, terms []Term) float64 {
	s.index.mu.RLock()
	defer s.index.mu.RUnlock()

	score := 0.0
	for _, term := range terms {
		pl, ok := s.index.index[term]
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
		N := float64(s.index.docCount)
		idf := math.Log(N / (df + 1))

		score += tf * idf
	}

	// Length normalization
	if docLen := s.index.docLengths[docID]; docLen > 0 {
		score /= math.Sqrt(float64(docLen))
	}

	return score
}
```

---
