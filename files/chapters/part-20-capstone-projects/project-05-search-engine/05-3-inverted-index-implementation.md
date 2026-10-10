## 3. Inverted Index Implementation

An inverted index is the core data structure behind every modern search engine. Instead of mapping documents to the words they contain (a "forward" index), an inverted index maps each unique word to the list of documents where it appears. This reversal is what makes keyword lookups nearly instant, even across millions of documents. In this section you will build posting lists that store per-document term frequencies and positions, and then assemble them into a full inverted index backed by a B-tree for fast, sorted term lookups.

### 3.1 Posting List

Each posting list stores a sorted slice of document IDs along with per-document term frequencies and field positions, enabling both Boolean matching and ranked retrieval.

```go
// internal/index/posting/posting.go
package posting

import (
    "encoding/binary"
    "io"
    "sort"
)

// Posting represents a single posting (document + position)
type Posting struct {
    DocID     uint32
    Frequency uint32   // Term frequency in document
    Positions []uint32 // Positions where term appears
}

// PostingList stores all postings for a term
type PostingList struct {
    Term     string
    DocCount uint32    // Number of documents containing term
    Postings []Posting
}

func NewPostingList(term string) *PostingList {
    return &PostingList{
        Term:     term,
        Postings: make([]Posting, 0),
    }
}

// Add a posting to the list
func (pl *PostingList) Add(docID uint32, positions []uint32) {
    // Check if document already exists
    idx := sort.Search(len(pl.Postings), func(i int) bool {
        return pl.Postings[i].DocID >= docID
    })

    if idx < len(pl.Postings) && pl.Postings[idx].DocID == docID {
        // Update existing posting
        pl.Postings[idx].Frequency = uint32(len(positions))
        pl.Postings[idx].Positions = positions
    } else {
        // Insert new posting
        posting := Posting{
            DocID:     docID,
            Frequency: uint32(len(positions)),
            Positions: positions,
        }

        pl.Postings = append(pl.Postings, Posting{})
        copy(pl.Postings[idx+1:], pl.Postings[idx:])
        pl.Postings[idx] = posting
        pl.DocCount++
    }
}

// Get posting for specific document
func (pl *PostingList) Get(docID uint32) (Posting, bool) {
    idx := sort.Search(len(pl.Postings), func(i int) bool {
        return pl.Postings[i].DocID >= docID
    })

    if idx < len(pl.Postings) && pl.Postings[idx].DocID == docID {
        return pl.Postings[idx], true
    }
    return Posting{}, false
}

// Intersect two posting lists (AND operation)
func Intersect(a, b *PostingList) *PostingList {
    result := NewPostingList(a.Term + " AND " + b.Term)

    i, j := 0, 0
    for i < len(a.Postings) && j < len(b.Postings) {
        if a.Postings[i].DocID == b.Postings[j].DocID {
            result.Postings = append(result.Postings, a.Postings[i])
            result.DocCount++
            i++
            j++
        } else if a.Postings[i].DocID < b.Postings[j].DocID {
            i++
        } else {
            j++
        }
    }

    return result
}

// Union two posting lists (OR operation)
func Union(a, b *PostingList) *PostingList {
    result := NewPostingList(a.Term + " OR " + b.Term)

    i, j := 0, 0
    for i < len(a.Postings) || j < len(b.Postings) {
        if i >= len(a.Postings) {
            result.Postings = append(result.Postings, b.Postings[j])
            result.DocCount++
            j++
        } else if j >= len(b.Postings) {
            result.Postings = append(result.Postings, a.Postings[i])
            result.DocCount++
            i++
        } else if a.Postings[i].DocID == b.Postings[j].DocID {
            result.Postings = append(result.Postings, a.Postings[i])
            result.DocCount++
            i++
            j++
        } else if a.Postings[i].DocID < b.Postings[j].DocID {
            result.Postings = append(result.Postings, a.Postings[i])
            result.DocCount++
            i++
        } else {
            result.Postings = append(result.Postings, b.Postings[j])
            result.DocCount++
            j++
        }
    }

    return result
}

// Encoding/Decoding for disk persistence

// Encode posting list to binary format
func (pl *PostingList) Encode(w io.Writer) error {
    // Write term length and term
    termBytes := []byte(pl.Term)
    if err := binary.Write(w, binary.LittleEndian, uint32(len(termBytes))); err != nil {
        return err
    }
    if _, err := w.Write(termBytes); err != nil {
        return err
    }

    // Write doc count
    if err := binary.Write(w, binary.LittleEndian, pl.DocCount); err != nil {
        return err
    }

    // Write number of postings
    if err := binary.Write(w, binary.LittleEndian, uint32(len(pl.Postings))); err != nil {
        return err
    }

    // Write each posting
    for _, p := range pl.Postings {
        if err := binary.Write(w, binary.LittleEndian, p.DocID); err != nil {
            return err
        }
        if err := binary.Write(w, binary.LittleEndian, p.Frequency); err != nil {
            return err
        }

        // Write positions
        if err := binary.Write(w, binary.LittleEndian, uint32(len(p.Positions))); err != nil {
            return err
        }
        for _, pos := range p.Positions {
            if err := binary.Write(w, binary.LittleEndian, pos); err != nil {
                return err
            }
        }
    }

    return nil
}

// Decode posting list from binary format
func DecodePostingList(r io.Reader) (*PostingList, error) {
    pl := &PostingList{}

    // Read term
    var termLen uint32
    if err := binary.Read(r, binary.LittleEndian, &termLen); err != nil {
        return nil, err
    }
    termBytes := make([]byte, termLen)
    if _, err := io.ReadFull(r, termBytes); err != nil {
        return nil, err
    }
    pl.Term = string(termBytes)

    // Read doc count
    if err := binary.Read(r, binary.LittleEndian, &pl.DocCount); err != nil {
        return nil, err
    }

    // Read number of postings
    var numPostings uint32
    if err := binary.Read(r, binary.LittleEndian, &numPostings); err != nil {
        return nil, err
    }

    pl.Postings = make([]Posting, numPostings)

    // Read each posting
    for i := uint32(0); i < numPostings; i++ {
        var p Posting
        if err := binary.Read(r, binary.LittleEndian, &p.DocID); err != nil {
            return nil, err
        }
        if err := binary.Read(r, binary.LittleEndian, &p.Frequency); err != nil {
            return nil, err
        }

        // Read positions
        var numPos uint32
        if err := binary.Read(r, binary.LittleEndian, &numPos); err != nil {
            return nil, err
        }
        p.Positions = make([]uint32, numPos)
        for j := uint32(0); j < numPos; j++ {
            if err := binary.Read(r, binary.LittleEndian, &p.Positions[j]); err != nil {
                return nil, err
            }
        }

        pl.Postings[i] = p
    }

    return pl, nil
}

// SkipList for efficient posting list navigation
type SkipPosting struct {
    DocID     uint32
    PostingIdx uint32 // Index in the posting list
}

type SkipList struct {
    Skips     []SkipPosting
    SkipInterval uint32 // Every N postings
}

func NewSkipList(postings []Posting, interval uint32) *SkipList {
    if interval == 0 {
        interval = 128 // Default skip interval
    }

    sl := &SkipList{
        Skips: make([]SkipPosting, 0),
        SkipInterval: interval,
    }

    for i := uint32(0); i < uint32(len(postings)); i += interval {
        sl.Skips = append(sl.Skips, SkipPosting{
            DocID:     postings[i].DocID,
            PostingIdx: i,
        })
    }

    return sl
}

// Find the best skip position for a target docID
func (sl *SkipList) Skip(targetDocID uint32) uint32 {
    idx := sort.Search(len(sl.Skips), func(i int) bool {
        return sl.Skips[i].DocID >= targetDocID
    })

    if idx == 0 {
        return 0
    }
    return sl.Skips[idx-1].PostingIdx
}
```

### 3.2 Inverted Index

The inverted index is the core data structure of any search engine, mapping terms to the set of documents that contain them. This implementation demonstrates how to build and query an index that supports fast full-text retrieval without scanning every document on each query.

```go
// internal/index/inverted/inverted.go
package inverted

import (
    "sync"

    "github.com/google/btree"
    "github.com/yourorg/gosearch/internal/analyzer"
    "github.com/yourorg/gosearch/internal/index/posting"
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
    mu            sync.RWMutex
    index         *btree.BTree
    analyzer      *analyzer.Analyzer
    docCount      uint32
    nextDocID     uint32
    docStore      map[uint32]*Document
    fieldAnalyzers map[string]*analyzer.Analyzer
}

func NewInvertedIndex(defaultAnalyzer *analyzer.Analyzer) *InvertedIndex {
    return &InvertedIndex{
        index:         btree.New(32), // Degree 32 for BTree
        analyzer:      defaultAnalyzer,
        docStore:      make(map[uint32]*Document),
        fieldAnalyzers: make(map[string]*analyzer.Analyzer),
    }
}

// SetFieldAnalyzer sets a specific analyzer for a field
func (idx *InvertedIndex) SetFieldAnalyzer(field string, analyzer *analyzer.Analyzer) {
    idx.mu.Lock()
    defer idx.mu.Unlock()
    idx.fieldAnalyzers[field] = analyzer
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
    analyzer := idx.analyzer
    if fieldAnalyzer, ok := idx.fieldAnalyzers[fieldName]; ok {
        analyzer = fieldAnalyzer
    }

    // Analyze text
    tokens := analyzer.Analyze(fieldValue)

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

    doc, ok := idx.docStore[docID]
    if !ok {
        return nil // Document doesn't exist
    }

    // Remove from doc store
    delete(idx.docStore, docID)
    idx.docCount--

    // Remove from posting lists (expensive - better to mark as deleted)
    // In production, use a deletion bitmap and merge during compaction

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

// Iterate over all terms
func (idx *InvertedIndex) ForEachTerm(fn func(term string, pl *posting.PostingList) bool) {
    idx.mu.RLock()
    defer idx.mu.RUnlock()

    idx.index.Ascend(func(item btree.Item) bool {
        ti := item.(*termItem)
        return fn(ti.term, ti.postingList)
    })
}
```

### Junior → FAANG: Inverted Index as the Core Data Structure Interview

The inverted index is the data structure interview that appears in every search engineering interview. The implementation in this chapter (posting lists with document IDs, term frequencies, and positions) is the minimum viable form. Know the two operations: index (add a term-document pair) and query (retrieve all documents containing a term).

Boolean AND query (intersection of two posting lists) is the algorithm interview question. The efficient two-pointer approach (advance the pointer in the smaller list when its document ID is less than the other pointer) produces the intersection in O(min(|A|, |B|)) time. Know this algorithm by heart.

Skip lists (a probabilistic data structure that adds "skip" pointers at intervals through a sorted list) accelerate intersection for large posting lists: instead of scanning one-by-one, you can skip ahead by N documents when the other pointer is far ahead. Know that skip lists exist and what problem they solve, even if you did not implement them.

### Senior @ FAANG: Inverted Index at Production Scale

At senior level, the in-memory inverted index in this chapter is a starting point for a full implementation. Production search engines (Lucene, the basis of Elasticsearch) use immutable on-disk index segments (inverted index files, term dictionary files, posting list files) with a merge process that combines small segments into larger ones.

Segment-based indexing (write new documents to a new small in-memory segment, periodically merge segments to disk) enables concurrent indexing and searching without locking the entire index. Lucene's segment architecture is the direct implementation of this approach. Understanding why Lucene uses segments (to avoid global index locks) is more important than knowing the file format details.

Posting list compression is the production technique for reducing index size and improving cache efficiency. Delta encoding (store the difference between consecutive document IDs rather than absolute IDs) combined with variable-byte encoding (use fewer bytes for small numbers) can compress posting lists by 60-80%. For a large-scale search engine where the posting list for a common word may span hundreds of millions of entries, compression is not optional.

---
