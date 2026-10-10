// internal/storage/docstore/docstore.go
package docstore

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/example/search-engine/internal/index/inverted"
	"github.com/klauspost/compress/snappy"
)

// DocumentStore manages persistent document storage
type DocumentStore struct {
	mu          sync.RWMutex
	file        *os.File
	index       map[uint32]int64 // docID -> file offset
	compression bool
}

func NewDocumentStore(path string, compression bool) (*DocumentStore, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return nil, err
	}

	store := &DocumentStore{
		file:        file,
		index:       make(map[uint32]int64),
		compression: compression,
	}

	// Load index
	if err := store.loadIndex(); err != nil {
		return nil, err
	}

	return store, nil
}

func (ds *DocumentStore) Close() error {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	return ds.file.Close()
}

// Put stores a document
func (ds *DocumentStore) Put(doc *inverted.Document) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	// Serialize document
	data, err := ds.serializeDocument(doc)
	if err != nil {
		return err
	}

	// Compress if enabled
	if ds.compression {
		data = snappy.Encode(nil, data)
	}

	// Get current file position
	offset, err := ds.file.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}

	// Write length prefix
	length := uint32(len(data))
	if err := binary.Write(ds.file, binary.LittleEndian, length); err != nil {
		return err
	}

	// Write data
	if _, err := ds.file.Write(data); err != nil {
		return err
	}

	// Update index
	ds.index[doc.ID] = offset

	return nil
}

// Get retrieves a document
func (ds *DocumentStore) Get(docID uint32) (*inverted.Document, error) {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	offset, ok := ds.index[docID]
	if !ok {
		return nil, fmt.Errorf("document not found: %d", docID)
	}

	// Seek to position
	if _, err := ds.file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}

	// Read length
	var length uint32
	if err := binary.Read(ds.file, binary.LittleEndian, &length); err != nil {
		return nil, err
	}

	// Read data
	data := make([]byte, length)
	if _, err := io.ReadFull(ds.file, data); err != nil {
		return nil, err
	}

	// Decompress if needed
	if ds.compression {
		var err error
		data, err = snappy.Decode(nil, data)
		if err != nil {
			return nil, err
		}
	}

	// Deserialize
	doc, err := ds.deserializeDocument(data)
	if err != nil {
		return nil, err
	}

	return doc, nil
}

func (ds *DocumentStore) serializeDocument(doc *inverted.Document) ([]byte, error) {
	var buf []byte

	// Write doc ID
	docID := make([]byte, 4)
	binary.LittleEndian.PutUint32(docID, doc.ID)
	buf = append(buf, docID...)

	// Write field count
	fieldCount := make([]byte, 4)
	binary.LittleEndian.PutUint32(fieldCount, uint32(len(doc.Fields)))
	buf = append(buf, fieldCount...)

	// Write each field
	for name, value := range doc.Fields {
		// Field name length
		nameLen := make([]byte, 4)
		binary.LittleEndian.PutUint32(nameLen, uint32(len(name)))
		buf = append(buf, nameLen...)

		// Field name
		buf = append(buf, []byte(name)...)

		// Field value length
		valueLen := make([]byte, 4)
		binary.LittleEndian.PutUint32(valueLen, uint32(len(value)))
		buf = append(buf, valueLen...)

		// Field value
		buf = append(buf, []byte(value)...)
	}

	return buf, nil
}

func (ds *DocumentStore) deserializeDocument(data []byte) (*inverted.Document, error) {
	if len(data) < 8 {
		return nil, fmt.Errorf("invalid document data")
	}

	doc := &inverted.Document{
		Fields: make(map[string]string),
	}

	offset := 0

	// Read doc ID
	doc.ID = binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4

	// Read field count
	fieldCount := binary.LittleEndian.Uint32(data[offset : offset+4])
	offset += 4

	// Read each field
	for range fieldCount {
		// Field name length
		nameLen := binary.LittleEndian.Uint32(data[offset : offset+4])
		offset += 4

		// Field name
		name := string(data[offset : offset+int(nameLen)])
		offset += int(nameLen)

		// Field value length
		valueLen := binary.LittleEndian.Uint32(data[offset : offset+4])
		offset += 4

		// Field value
		value := string(data[offset : offset+int(valueLen)])
		offset += int(valueLen)

		doc.Fields[name] = value
	}

	return doc, nil
}

func (ds *DocumentStore) loadIndex() error {
	// Read through file and build index
	offset := int64(0)

	for {
		// Seek to current position
		if _, err := ds.file.Seek(offset, io.SeekStart); err != nil {
			if err == io.EOF {
				break
			}
			return err
		}

		// Read length
		var length uint32
		if err := binary.Read(ds.file, binary.LittleEndian, &length); err != nil {
			if err == io.EOF {
				break
			}
			return err
		}

		// Read minimal data to get doc ID
		data := make([]byte, 4)
		if _, err := io.ReadFull(ds.file, data); err != nil {
			return err
		}

		docID := binary.LittleEndian.Uint32(data)
		ds.index[docID] = offset

		// Skip rest of document
		offset += 4 + int64(length)
	}

	return nil
}
