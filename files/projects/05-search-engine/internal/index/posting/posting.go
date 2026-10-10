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
	DocID      uint32
	PostingIdx uint32 // Index in the posting list
}

type SkipList struct {
	Skips        []SkipPosting
	SkipInterval uint32 // Every N postings
}

func NewSkipList(postings []Posting, interval uint32) *SkipList {
	if interval == 0 {
		interval = 128 // Default skip interval
	}

	sl := &SkipList{
		Skips:        make([]SkipPosting, 0),
		SkipInterval: interval,
	}

	for i := uint32(0); i < uint32(len(postings)); i += interval {
		sl.Skips = append(sl.Skips, SkipPosting{
			DocID:      postings[i].DocID,
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
