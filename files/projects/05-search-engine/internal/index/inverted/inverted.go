// internal/index/inverted/inverted.go
package inverted

import (
	"sync"

	"github.com/example/search-engine/internal/analyzer"
	"github.com/example/search-engine/internal/index/posting"
	"github.com/google/btree"
)

// Document represents an indexed document
type Document struct {
	ID     uint32
	Fields map[string]string
}

// termItem for BTree storage
type termItem struct {
	term        string
	postingList *posting.PostingList
}

func (ti *termItem) Less(than btree.Item) bool {
	return ti.term < than.(*termItem).term
}

// InvertedIndex is the core index structure
type InvertedIndex struct {
	mu             sync.RWMutex
	index          *btree.BTree
	analyzer       *analyzer.Analyzer
	docCount       uint32
	nextDocID      uint32
	docStore       map[uint32]*Document
	fieldAnalyzers map[string]*analyzer.Analyzer
}

func NewInvertedIndex(defaultAnalyzer *analyzer.Analyzer) *InvertedIndex {
	return &InvertedIndex{
		index:          btree.New(32), // Degree 32 for BTree
		analyzer:       defaultAnalyzer,
		docStore:       make(map[uint32]*Document),
		fieldAnalyzers: make(map[string]*analyzer.Analyzer),
	}
}

// SetFieldAnalyzer sets a specific analyzer for a field
func (idx *InvertedIndex) SetFieldAnalyzer(field string, a *analyzer.Analyzer) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	idx.fieldAnalyzers[field] = a
}

// IndexDocument adds a document to the index
func (idx *InvertedIndex) IndexDocument(doc *Document) error {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	// Assign document ID if not set
	if doc.ID == 0 {
		idx.nextDocID++
		doc.ID = idx.nextDocID
	}

	// Store document
	idx.docStore[doc.ID] = doc
	idx.docCount++

	// Index each field
	for fieldName, fieldValue := range doc.Fields {
		if err := idx.indexField(doc.ID, fieldName, fieldValue); err != nil {
			return err
		}
	}

	return nil
}

func (idx *InvertedIndex) indexField(docID uint32, fieldName, fieldValue string) error {
	// Get appropriate analyzer
	a := idx.analyzer
	if fieldAnalyzer, ok := idx.fieldAnalyzers[fieldName]; ok {
		a = fieldAnalyzer
	}

	// Analyze text
	tokens := a.Analyze(fieldValue)

	// Build term -> positions map
	termPositions := make(map[string][]uint32)
	for _, token := range tokens {
		term := fieldName + ":" + token.Text
		termPositions[term] = append(termPositions[term], uint32(token.Position))
	}

	// Add to inverted index
	for term, positions := range termPositions {
		item := idx.index.Get(&termItem{term: term})

		var postingList *posting.PostingList
		if item == nil {
			postingList = posting.NewPostingList(term)
			idx.index.ReplaceOrInsert(&termItem{
				term:        term,
				postingList: postingList,
			})
		} else {
			postingList = item.(*termItem).postingList
		}

		postingList.Add(docID, positions)
	}

	return nil
}

// Search returns posting list for a term
func (idx *InvertedIndex) Search(field, term string) (*posting.PostingList, bool) {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	fullTerm := field + ":" + term
	item := idx.index.Get(&termItem{term: fullTerm})
	if item == nil {
		return nil, false
	}

	return item.(*termItem).postingList, true
}

// GetDocument retrieves a document by ID
func (idx *InvertedIndex) GetDocument(docID uint32) (*Document, bool) {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	doc, ok := idx.docStore[docID]
	return doc, ok
}

// DeleteDocument removes a document from the index
func (idx *InvertedIndex) DeleteDocument(docID uint32) error {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	_, ok := idx.docStore[docID]
	if !ok {
		return nil // Document doesn't exist
	}

	// Remove from doc store
	delete(idx.docStore, docID)
	idx.docCount--

	return nil
}

// Stats returns index statistics
type IndexStats struct {
	DocCount   uint32
	TermCount  int
	TotalTerms int64
}

func (idx *InvertedIndex) Stats() IndexStats {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	stats := IndexStats{
		DocCount: idx.docCount,
	}

	idx.index.Ascend(func(item btree.Item) bool {
		stats.TermCount++
		pl := item.(*termItem).postingList
		stats.TotalTerms += int64(pl.DocCount)
		return true
	})

	return stats
}

// ForEachTerm iterates over all terms
func (idx *InvertedIndex) ForEachTerm(fn func(term string, pl *posting.PostingList) bool) {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	idx.index.Ascend(func(item btree.Item) bool {
		ti := item.(*termItem)
		return fn(ti.term, ti.postingList)
	})
}
