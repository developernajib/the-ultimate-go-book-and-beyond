## Go Implementation: Content-Aware Chunking (CDC)

Content-Defined Chunking (CDC) is an advanced alternative to fixed-size 4MB blocks that dramatically improves sync efficiency for files that grow or change incrementally. With fixed-size chunking, inserting a single byte at the beginning of a file shifts every block boundary, causing the entire file to appear changed. CDC solves this by using a rolling hash to determine chunk boundaries based on the file content itself, so an insertion only affects the one or two chunks around the edit point. This is particularly valuable for documents and source code where edits insert or delete bytes mid-file rather than rewriting the entire file. Pure appends do not need CDC, fixed chunking already localizes those to the last block.

```go
package chunking

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// ContentDefinedChunking uses Rabin fingerprinting for variable-size blocks
// Unlike fixed 4MB blocks, CDC creates boundaries based on content
// This means inserting bytes at the start of a file only changes the first chunk,
// not all subsequent chunks (which would happen with fixed-size chunking)
type ContentDefinedChunker struct {
	minSize   int // minimum chunk size (e.g., 1MB)
	maxSize   int // maximum chunk size (e.g., 8MB)
	avgSize   int // target average chunk size (e.g., 4MB)
	mask      uint64 // bit mask for boundary detection
}

func NewCDC(avgSize int) *ContentDefinedChunker {
	// mask determines average chunk size: avgSize ≈ 2^(bits in mask)
	// For 4MB avg: need 22 bits in mask (2^22 = 4194304)
	bits := 0
	n := avgSize
	for n > 1 {
		n >>= 1
		bits++
	}

	return &ContentDefinedChunker{
		minSize: avgSize / 4,
		maxSize: avgSize * 2,
		avgSize: avgSize,
		mask:    (1 << bits) - 1,
	}
}

type Chunk struct {
	Hash    string
	Size    int
	Content []byte
}

// ChunkReader splits a file using content-defined boundaries
func (c *ContentDefinedChunker) ChunkReader(reader io.Reader) ([]Chunk, error) {
	var chunks []Chunk
	buf := make([]byte, c.maxSize)
	carry := []byte{}

	for {
		n, err := reader.Read(buf[len(carry):])
		if len(carry) > 0 {
			copy(buf, carry)
			n += len(carry)
			carry = nil
		}

		if n == 0 {
			break
		}

		data := buf[:n]
		offset := 0

		for offset < len(data) {
			// Find next chunk boundary using rolling hash
			end := c.findBoundary(data[offset:])
			if end == -1 || offset+end > len(data) {
				// No boundary found in remaining data, carry to next read
				carry = make([]byte, len(data)-offset)
				copy(carry, data[offset:])
				break
			}

			chunk := data[offset : offset+end]
			hash := sha256.Sum256(chunk)
			chunks = append(chunks, Chunk{
				Hash:    hex.EncodeToString(hash[:]),
				Size:    len(chunk),
				Content: append([]byte{}, chunk...), // copy
			})
			offset += end
		}

		if err == io.EOF {
			if len(carry) > 0 {
				hash := sha256.Sum256(carry)
				chunks = append(chunks, Chunk{
					Hash:    hex.EncodeToString(hash[:]),
					Size:    len(carry),
					Content: carry,
				})
			}
			break
		}
		if err != nil {
			return nil, err
		}
	}

	return chunks, nil
}

// findBoundary uses a rolling hash to find chunk boundaries
func (c *ContentDefinedChunker) findBoundary(data []byte) int {
	if len(data) <= c.minSize {
		return -1
	}

	var hash uint64
	for i := c.minSize; i < len(data) && i < c.maxSize; i++ {
		// Simple rolling hash (Buzhash or Rabin in production)
		hash = hash*31 + uint64(data[i])

		// Check if hash matches boundary pattern
		if hash&c.mask == 0 {
			return i
		}
	}

	// Hit max size without finding boundary
	if len(data) >= c.maxSize {
		return c.maxSize
	}

	return -1
}

// Why CDC over fixed chunking:
// Fixed 4MB: insert 1 byte at position 0 shifts ALL blocks, causing full re-upload
// CDC: boundary defined by content, so an insert only changes 1-2 chunks
// For mid-file inserts and deletes, CDC avoids re-uploading everything after the edit
```

---
