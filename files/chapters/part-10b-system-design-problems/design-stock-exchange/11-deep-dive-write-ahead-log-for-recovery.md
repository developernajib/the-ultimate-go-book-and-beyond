## Deep Dive: Write-Ahead Log for Recovery

The write-ahead log (WAL) is the durability backbone of the exchange. Every order, trade, and cancellation is serialized into a compact binary format and appended to a file on disk before the matching engine processes it. If the server crashes, the system replays the WAL from the last known snapshot to reconstruct the exact state of every order book. The binary format uses fixed-size headers (sequence number, timestamp, entry type, data length, and a CRC-32C checksum) followed by variable-length data, making it both fast to write and straightforward to parse during recovery.

The checksum is not optional decoration. A WAL that cannot detect a bad record cannot deliver the guarantee it exists for, because the failure it must survive is a crash partway through an append. Recovery has to distinguish three cases and treat them differently: a clean end of log, a torn record at the tail (normal after a crash, so replay stops there and everything before it is intact), and a record whose checksum fails in the body of the log (real corruption, which must halt recovery rather than quietly replay a shorter book than the one that existed). The version of this code that ignores the error from `io.ReadFull` collapses all three into "stop reading", which means a corrupt log recovers into a plausible-looking order book that never existed.

One simplification to flag: this snippet writes with an ordinary buffered `Write` plus `fsync`, which is correct and portable. The O_DIRECT path described in the design notes additionally requires the file to be opened with `syscall.O_DIRECT` and every write to be block-aligned in offset, length, and buffer address, which is Linux-specific and would bury the format in alignment arithmetic. O_DIRECT bypasses the page cache to remove latency variance, but it is not by itself a durability mechanism, so the `fsync` stays either way.

```go
package wal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
	"time"
)

// Header layout: sequence(8) | timestamp(8) | type(1) | length(4) | crc(4).
// The CRC covers the first 21 header bytes plus the payload, so a torn write
// or a flipped bit cannot pass as a valid entry.
const headerSize = 25

// castagnoli is the CRC-32C polynomial, which modern CPUs compute with a
// dedicated instruction, so the checksum costs almost nothing on the hot path.
var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// ErrTruncated reports that the log ends in a partial or corrupt record. This
// is the expected signature of a crash mid-append, not a bug: the entries
// returned alongside it are intact and safe to replay. A caller that gets any
// other error must stop, because that means corruption in the body of the log
// rather than a half-finished write at the end of it.
var ErrTruncated = errors.New("wal: log truncated at tail")

type WAL struct {
	file     *os.File
	mu       sync.Mutex
	sequence int64
	syncMode bool
}

type WALEntry struct {
	Sequence  int64
	Timestamp int64
	Type      byte // 'O'=order, 'T'=trade, 'C'=cancel, 'S'=snapshot
	Data      []byte
}

func NewWAL(path string, syncMode bool) (*WAL, error) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("open WAL: %w", err)
	}
	return &WAL{file: f, syncMode: syncMode}, nil
}

func (w *WAL) Append(entryType byte, data []byte) (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.sequence++
	buf := make([]byte, headerSize+len(data))
	binary.LittleEndian.PutUint64(buf[0:8], uint64(w.sequence))
	binary.LittleEndian.PutUint64(buf[8:16], uint64(time.Now().UnixNano()))
	buf[16] = entryType
	binary.LittleEndian.PutUint32(buf[17:21], uint32(len(data)))
	copy(buf[headerSize:], data)

	crc := crc32.Checksum(buf[0:21], castagnoli)
	crc = crc32.Update(crc, castagnoli, data)
	binary.LittleEndian.PutUint32(buf[21:25], crc)

	if _, err := w.file.Write(buf); err != nil {
		w.sequence-- // nothing was logged, do not burn the sequence number
		return 0, fmt.Errorf("write WAL entry: %w", err)
	}

	// A failed fsync must be reported, never swallowed. Returning success here
	// tells the engine the order is durable and frees it to match and print a
	// trade that a power cut would erase.
	if w.syncMode {
		if err := w.file.Sync(); err != nil {
			return 0, fmt.Errorf("fsync WAL: %w", err)
		}
	}

	return w.sequence, nil
}

// ReplayFrom reads entries with sequence >= fromSeq. It returns ErrTruncated
// (with the good entries) if the log ends mid-record, and a hard error if a
// record fails its checksum, which means corruption rather than a torn tail.
func ReplayFrom(path string, fromSeq int64) ([]WALEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []WALEntry
	header := make([]byte, headerSize)

	for {
		if _, err := io.ReadFull(f, header); err != nil {
			if errors.Is(err, io.EOF) {
				return entries, nil // clean end of log
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return entries, ErrTruncated // partial header
			}
			return nil, fmt.Errorf("read header after %d entries: %w", len(entries), err)
		}

		seq := int64(binary.LittleEndian.Uint64(header[0:8]))
		ts := int64(binary.LittleEndian.Uint64(header[8:16]))
		dataLen := binary.LittleEndian.Uint32(header[17:21])
		want := binary.LittleEndian.Uint32(header[21:25])

		data := make([]byte, dataLen)
		if _, err := io.ReadFull(f, data); err != nil {
			// The header promised more payload than the log holds, so the
			// process died between the write and the flush.
			return entries, ErrTruncated
		}

		crc := crc32.Checksum(header[0:21], castagnoli)
		crc = crc32.Update(crc, castagnoli, data)
		if crc != want {
			return entries, fmt.Errorf("WAL corruption at sequence %d: checksum mismatch", seq)
		}

		if seq >= fromSeq {
			entries = append(entries, WALEntry{
				Sequence:  seq,
				Timestamp: ts,
				Type:      header[16],
				Data:      data,
			})
		}
	}
}
```

---
