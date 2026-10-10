## 5. Ranking Algorithms

Finding matching documents is only half the battle, you also need to decide which results appear first. Ranking algorithms assign a relevance score to every matching document so the most useful results float to the top. This section implements two industry-standard scoring models: TF-IDF (Term Frequency-Inverse Document Frequency), which rewards documents that mention the search term often while penalizing terms that appear everywhere, and BM25, an improved variant used by Elasticsearch and other modern engines that adds document-length normalization and a saturation curve so extremely long documents do not unfairly dominate.

### 5.1 TF-IDF Scorer

The TF-IDF scorer computes term frequency times inverse document frequency for each query term in each matching document, then sums the per-term scores to rank results.

```go
// internal/ranking/tfidf.go
package ranking

import (
    "math"

    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/index/posting"
    "github.com/yourorg/gosearch/internal/query/parser"
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

func (s *TFIDFScorer) scorePhraseQuery(q *parser.PhraseQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
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
```

### 5.2 BM25 Scorer

BM25 (Best Match 25) is the probabilistic ranking algorithm used by Elasticsearch, Solr, and most modern search engines to score document relevance. This implementation applies term frequency saturation and document length normalization to produce scores that generalize well across diverse corpora.

```go
// internal/ranking/bm25.go
package ranking

import (
    "math"

    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/index/posting"
    "github.com/yourorg/gosearch/internal/query/parser"
)

// BM25Scorer implements Okapi BM25 ranking
type BM25Scorer struct {
    k1         float64 // Term frequency saturation (usually 1.2-2.0)
    b          float64 // Length normalization (usually 0.75)
    avgDocLen  float64 // Average document length
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

func (s *BM25Scorer) scorePhraseQuery(q *parser.PhraseQuery, p posting.Posting, index *inverted.InvertedIndex) float64 {
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
```

### Junior → FAANG: BM25 as the Baseline Ranking Standard

BM25 (Best Match 25) is the ranking algorithm you should know for search-related interviews. It improved on TF-IDF by adding two important corrections: document length normalization (long documents are penalized because they are likely to contain more terms by chance rather than relevance) and term frequency saturation (the score increase from 10 occurrences of a term versus 5 occurrences is much smaller than the increase from 1 occurrence versus 0).

Know the BM25 formula's three parameters: IDF (inverse document frequency, penalizes common terms), TF-normalized (term frequency with saturation curve controlled by k1), and document length normalization (controlled by b). Default values in Elasticsearch are k1=1.2 and b=0.75. For specific domains (short product titles versus long product descriptions), tuning these parameters can significantly improve relevance.

For interviews, being able to say "I implemented BM25 for ranking and know that it outperforms TF-IDF for typical document corpora because of length normalization and saturation" positions you as someone who has done real information retrieval work.

### Senior @ FAANG: Ranking as a System, Not a Formula

At senior level, BM25 is the starting point for a ranking system, not the end state. Production search engines combine BM25 relevance scores with signals from multiple other sources: clickthrough rate (documents that are frequently clicked after being shown are probably more relevant), freshness (newer documents are often more relevant for time-sensitive queries), popularity (documents that are frequently accessed are often more relevant), and personalization (documents that match the user's history are often more relevant).

Learning to Rank (LTR) is the ML approach to combining these signals. Instead of hand-tuning weights for each signal (a brittle manual process), LTR trains a model (typically gradient-boosted trees or neural networks) on human-labeled relevance judgments to predict the relevance of a document-query pair given all available signals. The model output replaces the hand-tuned combination formula. This approach produces significantly better relevance at scale but requires a labeled dataset and an offline evaluation pipeline.

Relevance evaluation infrastructure is the prerequisite for any ranking improvement. Without a way to measure whether a ranking change improves relevance (using NDCG or MRR on a held-out labeled set), you cannot safely deploy ranking changes. Building this infrastructure (labeling pipeline, offline evaluation framework, A/B test analysis tooling) before attempting to improve ranking is a platform investment that pays dividends for every ranking change thereafter.

---
