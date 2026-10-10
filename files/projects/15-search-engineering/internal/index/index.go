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
	Frequency uint32   // term frequency in document
	Positions []uint32 // positions for phrase queries
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
		index:      make(map[Term]*PostingList),
		docLengths: make(map[DocID]int),
		fieldBoosts: map[string]float64{
			"title":  2.0,
			"body":   1.0,
			"tags":   1.5,
			"author": 0.5,
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
		_ = boost
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

// GetIndex exposes the internal index map (read-only).
func (idx *InvertedIndex) GetIndex() map[Term]*PostingList {
	return idx.index
}

// DocCount returns the total number of indexed documents.
func (idx *InvertedIndex) DocCount() int {
	return idx.docCount
}

// AvgDocLen returns the average document length.
func (idx *InvertedIndex) AvgDocLen() float64 {
	return idx.avgDocLen
}

// DocLen returns the length of a document.
func (idx *InvertedIndex) DocLen(id DocID) int {
	return idx.docLengths[id]
}

// Lock acquires read lock.
func (idx *InvertedIndex) RLock() {
	idx.mu.RLock()
}

// RUnlock releases read lock.
func (idx *InvertedIndex) RUnlock() {
	idx.mu.RUnlock()
}

// Sort sorts the results slice by score.
func SortResults(results []SearchResult) {
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})
}

// SearchResult represents a ranked search result
type SearchResult struct {
	DocID DocID
	Score float64
}
