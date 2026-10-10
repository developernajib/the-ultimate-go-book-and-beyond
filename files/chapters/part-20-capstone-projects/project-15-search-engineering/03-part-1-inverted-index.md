## Part 1: Inverted Index

The inverted index is the data structure at the heart of every search engine. Instead of mapping documents to the words they contain (like a table of contents), an inverted index flips the relationship: it maps every unique word to the list of documents where that word appears. This reversal is what makes search fast, given a query term, you can instantly look up which documents contain it without scanning every document in the collection. The code below builds an inverted index in Go that supports multi-field documents, field boosting, positional tracking for phrase queries, and concurrent-safe reads and writes.

```go
package index

import (
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"
)

// Term represents a single word token
type Term string

// DocID is a document identifier
type DocID uint32

// Posting represents a term occurrence in a document
type Posting struct {
	DocID     DocID
	Frequency uint32    // term frequency in document
	Positions []uint32  // positions for phrase queries
}

// PostingList is the list of documents containing a term
type PostingList struct {
	Term     Term
	Postings []Posting
}

// InvertedIndex maps terms to their posting lists
type InvertedIndex struct {
	mu          sync.RWMutex
	index       map[Term]*PostingList
	docLengths  map[DocID]int      // number of terms in each doc
	docCount    int                // total documents
	avgDocLen   float64            // average document length
	fieldBoosts map[string]float64 // field name → boost
}

// Document represents an indexable document
type Document struct {
	ID     DocID
	Fields map[string]string // field name → content
}

func NewInvertedIndex() *InvertedIndex {
	return &InvertedIndex{
		index:       make(map[Term]*PostingList),
		docLengths:  make(map[DocID]int),
		fieldBoosts: map[string]float64{
			"title":   2.0,
			"body":    1.0,
			"tags":    1.5,
			"author":  0.5,
		},
	}
}

// IndexDocument adds a document to the index
func (idx *InvertedIndex) IndexDocument(doc Document) {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	idx.docCount++
	totalTerms := 0

	// Track term frequencies per field
	termFreqs := make(map[Term]map[string]int) // term → field → freq
	termPositions := make(map[Term][]uint32)

	position := uint32(0)
	for field, content := range doc.Fields {
		boost := idx.fieldBoosts[field]
		if boost == 0 {
			boost = 1.0
		}

		tokens := tokenize(content)
		for _, token := range tokens {
			term := Term(token)
			if termFreqs[term] == nil {
				termFreqs[term] = make(map[string]int)
			}
			termFreqs[term][field]++
			termPositions[term] = append(termPositions[term], position)
			position++
			totalTerms++
		}
	}

	idx.docLengths[doc.ID] = totalTerms

	// Add postings to index
	for term, fieldFreqs := range termFreqs {
		// Compute weighted frequency across fields
		totalFreq := 0.0
		for field, freq := range fieldFreqs {
			boost := idx.fieldBoosts[field]
			if boost == 0 {
				boost = 1.0
			}
			totalFreq += float64(freq) * boost
		}

		if idx.index[term] == nil {
			idx.index[term] = &PostingList{Term: term}
		}

		idx.index[term].Postings = append(idx.index[term].Postings, Posting{
			DocID:     doc.ID,
			Frequency: uint32(math.Round(totalFreq)),
			Positions: termPositions[term],
		})
	}

	// Update average document length
	total := 0
	for _, l := range idx.docLengths {
		total += l
	}
	idx.avgDocLen = float64(total) / float64(idx.docCount)
}

// tokenize converts text into normalized tokens
func tokenize(text string) []string {
	text = strings.ToLower(text)
	var tokens []string

	f := func(c rune) bool {
		return !unicode.IsLetter(c) && !unicode.IsDigit(c)
	}

	for _, word := range strings.FieldsFunc(text, f) {
		if len(word) >= 2 && !isStopWord(word) {
			tokens = append(tokens, stem(word))
		}
	}
	return tokens
}

// Stop words to skip
var stopWords = map[string]bool{
	"the": true, "a": true, "an": true, "and": true, "or": true,
	"but": true, "in": true, "on": true, "at": true, "to": true,
	"for": true, "of": true, "is": true, "it": true, "as": true,
}

func isStopWord(word string) bool {
	return stopWords[word]
}

// stem is a simplified Porter stemmer
func stem(word string) string {
	// Very simplified; use github.com/kljensen/snowball in production
	suffixes := []string{"ing", "tion", "ed", "ly", "er", "est"}
	for _, suffix := range suffixes {
		if len(word) > len(suffix)+3 && strings.HasSuffix(word, suffix) {
			return word[:len(word)-len(suffix)]
		}
	}
	return word
}
```

---
