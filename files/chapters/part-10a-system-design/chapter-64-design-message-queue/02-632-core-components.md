## 64.2 Core Components

### Message Structure

The message structure encodes all metadata needed for reliable delivery: a unique ID for deduplication, a CRC32 checksum for corruption detection, a timestamp for ordering and TTL enforcement, and headers for routing metadata. Serializing messages to a compact binary format rather than JSON reduces storage and network overhead, which matters significantly at the throughput rates (millions of messages per second) that message queues are designed to handle. The checksum is validated at both write and read time, catching corruption that would otherwise silently deliver incorrect data to consumers.

```go
// message/message.go
package message

import (
    "encoding/binary"
    "hash/crc32"
    "time"
)

// Message represents a single message
type Message struct {
    Offset      int64             `json:"offset"`
    Key         []byte            `json:"key,omitempty"`
    Value       []byte            `json:"value"`
    Headers     map[string][]byte `json:"headers,omitempty"`
    Timestamp   time.Time         `json:"timestamp"`
    Partition   int32             `json:"partition"`
    Compressed  bool              `json:"compressed"`
}

// Checksum computes the CRC32 checksum of the message payload
func (m *Message) Checksum() uint32 {
    return crc32.ChecksumIEEE(m.Value)
}

// MessageBatch represents a batch of messages
type MessageBatch struct {
    FirstOffset    int64
    LastOffset     int64
    Messages       []*Message
    MaxTimestamp   time.Time
    CRC            uint32
    CompressedSize int
}

// Encode serializes a message to bytes
func (m *Message) Encode() []byte {
    // Calculate size
    size := 8 + // offset
            4 + len(m.Key) + // key length + key
            4 + len(m.Value) + // value length + value
            8 + // timestamp
            4 + // partition
            1 + // compressed flag
            4 // header count

    // Add headers
    for k, v := range m.Headers {
        size += 4 + len(k) + 4 + len(v)
    }

    buf := make([]byte, size)
    pos := 0

    // Offset
    binary.BigEndian.PutUint64(buf[pos:], uint64(m.Offset))
    pos += 8

    // Key
    binary.BigEndian.PutUint32(buf[pos:], uint32(len(m.Key)))
    pos += 4
    copy(buf[pos:], m.Key)
    pos += len(m.Key)

    // Value
    binary.BigEndian.PutUint32(buf[pos:], uint32(len(m.Value)))
    pos += 4
    copy(buf[pos:], m.Value)
    pos += len(m.Value)

    // Timestamp
    binary.BigEndian.PutUint64(buf[pos:], uint64(m.Timestamp.UnixNano()))
    pos += 8

    // Partition
    binary.BigEndian.PutUint32(buf[pos:], uint32(m.Partition))
    pos += 4

    // Compressed
    if m.Compressed {
        buf[pos] = 1
    }
    pos++

    // Headers
    binary.BigEndian.PutUint32(buf[pos:], uint32(len(m.Headers)))
    pos += 4
    for k, v := range m.Headers {
        binary.BigEndian.PutUint32(buf[pos:], uint32(len(k)))
        pos += 4
        copy(buf[pos:], k)
        pos += len(k)
        binary.BigEndian.PutUint32(buf[pos:], uint32(len(v)))
        pos += 4
        copy(buf[pos:], v)
        pos += len(v)
    }

    return buf
}

// Decode deserializes bytes to a message
func Decode(data []byte) (*Message, error) {
    m := &Message{
        Headers: make(map[string][]byte),
    }
    pos := 0

    // Offset
    m.Offset = int64(binary.BigEndian.Uint64(data[pos:]))
    pos += 8

    // Key
    keyLen := binary.BigEndian.Uint32(data[pos:])
    pos += 4
    m.Key = make([]byte, keyLen)
    copy(m.Key, data[pos:pos+int(keyLen)])
    pos += int(keyLen)

    // Value
    valueLen := binary.BigEndian.Uint32(data[pos:])
    pos += 4
    m.Value = make([]byte, valueLen)
    copy(m.Value, data[pos:pos+int(valueLen)])
    pos += int(valueLen)

    // Timestamp
    m.Timestamp = time.Unix(0, int64(binary.BigEndian.Uint64(data[pos:])))
    pos += 8

    // Partition
    m.Partition = int32(binary.BigEndian.Uint32(data[pos:]))
    pos += 4

    // Compressed
    m.Compressed = data[pos] == 1
    pos++

    // Headers
    headerCount := binary.BigEndian.Uint32(data[pos:])
    pos += 4
    for i := uint32(0); i < headerCount; i++ {
        keyLen := binary.BigEndian.Uint32(data[pos:])
        pos += 4
        key := string(data[pos : pos+int(keyLen)])
        pos += int(keyLen)
        valueLen := binary.BigEndian.Uint32(data[pos:])
        pos += 4
        value := make([]byte, valueLen)
        copy(value, data[pos:pos+int(valueLen)])
        pos += int(valueLen)
        m.Headers[key] = value
    }

    return m, nil
}
```

### Write-Ahead Log (WAL)

The WAL is the durability backbone of any message queue: every write is appended to a segment file before being acknowledged to the producer. Segments are fixed-size, append-only files named by their base offset, which makes crash recovery straightforward, the broker simply replays unacknowledged segments on restart. Rolling to a new segment when the current one reaches `maxSize` bounds the time required for a recovery scan and enables independent deletion of old segments during log compaction.

```go
// storage/log.go
package storage

import (
    "encoding/binary"
    "errors"
    "fmt"
    "io"
    "os"
    "path/filepath"
    "sync"

    "yourproject/message"
)

// Segment represents a log segment file
type Segment struct {
    mu          sync.RWMutex
    path        string
    file        *os.File
    index       *Index
    baseOffset  int64
    nextOffset  int64
    size        int64
    maxSize     int64
    closed      bool
}

// NewSegment creates a new log segment
func NewSegment(dir string, baseOffset int64, maxSize int64) (*Segment, error) {
    path := filepath.Join(dir, fmt.Sprintf("%020d.log", baseOffset))

    file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)
    if err != nil {
        return nil, err
    }

    stat, _ := file.Stat()

    indexPath := filepath.Join(dir, fmt.Sprintf("%020d.index", baseOffset))
    index, err := NewIndex(indexPath, baseOffset)
    if err != nil {
        file.Close()
        return nil, err
    }

    return &Segment{
        path:       path,
        file:       file,
        index:      index,
        baseOffset: baseOffset,
        nextOffset: baseOffset,
        size:       stat.Size(),
        maxSize:    maxSize,
    }, nil
}

// Append writes a message to the segment
func (s *Segment) Append(msg *message.Message) (int64, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if s.closed {
        return 0, errors.New("segment closed")
    }

    if s.size >= s.maxSize {
        return 0, errors.New("segment full")
    }

    msg.Offset = s.nextOffset
    data := msg.Encode()

    // Write length prefix
    lenBuf := make([]byte, 4)
    binary.BigEndian.PutUint32(lenBuf, uint32(len(data)))

    if _, err := s.file.Write(lenBuf); err != nil {
        return 0, err
    }
    if _, err := s.file.Write(data); err != nil {
        return 0, err
    }

    // Update index
    s.index.Append(s.nextOffset, s.size)

    s.size += int64(4 + len(data))
    s.nextOffset++

    return msg.Offset, nil
}

// Read reads a message at offset
func (s *Segment) Read(offset int64) (*message.Message, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    // Look up position in index
    position, err := s.index.Lookup(offset)
    if err != nil {
        return nil, err
    }

    // Read message
    lenBuf := make([]byte, 4)
    if _, err := s.file.ReadAt(lenBuf, position); err != nil {
        return nil, err
    }

    msgLen := binary.BigEndian.Uint32(lenBuf)
    data := make([]byte, msgLen)
    if _, err := s.file.ReadAt(data, position+4); err != nil {
        return nil, err
    }

    return message.Decode(data)
}

// ReadBatch reads messages starting from offset
func (s *Segment) ReadBatch(startOffset int64, maxCount int, maxBytes int64) ([]*message.Message, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    messages := make([]*message.Message, 0, maxCount)
    totalBytes := int64(0)
    offset := startOffset

    for len(messages) < maxCount && totalBytes < maxBytes {
        msg, err := s.Read(offset)
        if err != nil {
            // Running past the last written offset is the normal end
            // of a batch, not a failure: Lookup returns
            // ErrOffsetNotFound there. Return what we have.
            if errors.Is(err, ErrOffsetNotFound) || errors.Is(err, io.EOF) {
                break
            }
            return nil, err
        }

        messages = append(messages, msg)
        totalBytes += int64(len(msg.Value))
        offset++
    }

    return messages, nil
}

// Sync flushes data to disk
func (s *Segment) Sync() error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if err := s.file.Sync(); err != nil {
        return err
    }
    return s.index.Sync()
}

// Close closes the segment
func (s *Segment) Close() error {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.closed = true
    if err := s.file.Close(); err != nil {
        return err
    }
    return s.index.Close()
}

// Log manages multiple segments
type Log struct {
    mu         sync.RWMutex
    dir        string
    segments   []*Segment
    active     *Segment
    maxSegmentSize int64
}

// NewLog creates a new log
func NewLog(dir string, maxSegmentSize int64) (*Log, error) {
    if err := os.MkdirAll(dir, 0755); err != nil {
        return nil, err
    }

    l := &Log{
        dir:            dir,
        segments:       make([]*Segment, 0),
        maxSegmentSize: maxSegmentSize,
    }

    // Load existing segments
    if err := l.loadSegments(); err != nil {
        return nil, err
    }

    // Create initial segment if none exist
    if len(l.segments) == 0 {
        if err := l.newSegment(0); err != nil {
            return nil, err
        }
    }

    return l, nil
}

func (l *Log) loadSegments() error {
    files, err := filepath.Glob(filepath.Join(l.dir, "*.log"))
    if err != nil {
        return err
    }

    for _, file := range files {
        var baseOffset int64
        fmt.Sscanf(filepath.Base(file), "%020d.log", &baseOffset)

        segment, err := NewSegment(l.dir, baseOffset, l.maxSegmentSize)
        if err != nil {
            return err
        }
        l.segments = append(l.segments, segment)
    }

    if len(l.segments) > 0 {
        l.active = l.segments[len(l.segments)-1]
    }

    return nil
}

func (l *Log) newSegment(baseOffset int64) error {
    segment, err := NewSegment(l.dir, baseOffset, l.maxSegmentSize)
    if err != nil {
        return err
    }
    l.segments = append(l.segments, segment)
    l.active = segment
    return nil
}

// Append appends a message to the log
func (l *Log) Append(msg *message.Message) (int64, error) {
    l.mu.Lock()
    defer l.mu.Unlock()

    offset, err := l.active.Append(msg)
    if err != nil {
        if err.Error() == "segment full" {
            // Roll to new segment
            if err := l.newSegment(l.active.nextOffset); err != nil {
                return 0, err
            }
            return l.active.Append(msg)
        }
        return 0, err
    }

    return offset, nil
}

// Read reads a message from the log
func (l *Log) Read(offset int64) (*message.Message, error) {
    l.mu.RLock()
    defer l.mu.RUnlock()

    segment := l.findSegment(offset)
    if segment == nil {
        return nil, errors.New("offset not found")
    }

    return segment.Read(offset)
}

func (l *Log) findSegment(offset int64) *Segment {
    for i := len(l.segments) - 1; i >= 0; i-- {
        if l.segments[i].baseOffset <= offset {
            return l.segments[i]
        }
    }
    return nil
}
```

### Index File

Without an index, reading a message at a given offset requires scanning the entire segment file from the beginning, an O(n) operation that becomes unacceptable at GB-scale logs. The index stores fixed-width 16-byte entries (8-byte offset + 8-byte file position), which allows binary search to locate any message in O(log n) time. Because entries are appended in monotonically increasing offset order, the file is always sorted and no rebalancing is needed.

```go
// storage/index.go
package storage

import (
    "encoding/binary"
    "errors"
    "os"
    "sync"
)

// ErrOffsetNotFound is returned when an offset is not present in the
// index, which callers such as ReadBatch treat as end-of-log.
var ErrOffsetNotFound = errors.New("offset not found")

// Index maps offsets to file positions
type Index struct {
    mu         sync.RWMutex
    file       *os.File
    baseOffset int64
    entries    []indexEntry
}

type indexEntry struct {
    offset   int64
    position int64
}

// NewIndex creates a new index
func NewIndex(path string, baseOffset int64) (*Index, error) {
    file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
    if err != nil {
        return nil, err
    }

    idx := &Index{
        file:       file,
        baseOffset: baseOffset,
        entries:    make([]indexEntry, 0),
    }

    // Load existing entries
    if err := idx.load(); err != nil {
        file.Close()
        return nil, err
    }

    return idx, nil
}

func (i *Index) load() error {
    stat, err := i.file.Stat()
    if err != nil {
        return err
    }

    entrySize := 16 // 8 bytes offset + 8 bytes position
    numEntries := stat.Size() / int64(entrySize)

    i.entries = make([]indexEntry, numEntries)
    buf := make([]byte, entrySize)

    for j := int64(0); j < numEntries; j++ {
        if _, err := i.file.ReadAt(buf, j*int64(entrySize)); err != nil {
            return err
        }
        i.entries[j] = indexEntry{
            offset:   int64(binary.BigEndian.Uint64(buf[0:8])),
            position: int64(binary.BigEndian.Uint64(buf[8:16])),
        }
    }

    return nil
}

// Append adds an entry to the index
func (i *Index) Append(offset, position int64) error {
    i.mu.Lock()
    defer i.mu.Unlock()

    entry := indexEntry{offset: offset, position: position}
    i.entries = append(i.entries, entry)

    // Write to file
    buf := make([]byte, 16)
    binary.BigEndian.PutUint64(buf[0:8], uint64(offset))
    binary.BigEndian.PutUint64(buf[8:16], uint64(position))

    _, err := i.file.Write(buf)
    return err
}

// Lookup finds the file position for an offset
func (i *Index) Lookup(offset int64) (int64, error) {
    i.mu.RLock()
    defer i.mu.RUnlock()

    // Binary search
    left, right := 0, len(i.entries)-1
    for left <= right {
        mid := (left + right) / 2
        if i.entries[mid].offset == offset {
            return i.entries[mid].position, nil
        }
        if i.entries[mid].offset < offset {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return 0, ErrOffsetNotFound
}

// Sync flushes to disk
func (i *Index) Sync() error {
    return i.file.Sync()
}

// Close closes the index
func (i *Index) Close() error {
    return i.file.Close()
}
```

---

### Junior -> FAANG: Understanding the WAL and Index as a Unit

The write-ahead log and its companion index file are the two most important data structures in any durable message queue. The WAL guarantees durability: a message that is acknowledged to the producer is on disk. The index guarantees read performance: a consumer seeking to offset 5 million does not scan 5 million entries, it binary-searches the index in O(log n) steps.

The critical habit to develop early: always think about what happens on crash recovery. If the broker process dies after writing a message to the WAL but before updating the in-memory offset counter, what happens when it restarts? The segment file contains the message, but the in-memory state is gone. The recovery path must scan the tail of the active segment to rebuild the in-memory position. This is why segment files are named by their base offset: recovery only needs to process the last segment, not the entire log.

Interview entry-point: if asked "how does Kafka guarantee durability?", the answer involves two layers: the WAL (data is on disk before the leader acknowledges the producer) and replication (the leader waits for in-sync replicas to confirm the write before acknowledging, when configured with `acks=-1`).

### Senior @ FAANG: Segment File Design Decisions and Their Production Consequences

The segment `maxSize` parameter is not arbitrary. It directly controls the granularity of log compaction, crash recovery time, and disk space reclamation. A 1 GB segment means recovery must replay up to 1 GB of data after a crash to find the tail offset. A 100 MB segment reduces recovery time by 10x but creates 10x more index files and file descriptors. The right value depends on write throughput (how long before a segment fills), recovery SLO (how long an unclean shutdown is acceptable), and compaction frequency (how quickly old data can be freed).

The index file design choice of fixed-width entries (16 bytes: 8 for offset, 8 for file position) is deliberate. Fixed-width entries enable `mmap` into the index file and binary search without deserializing variable-length records. This is the same design used in Kafka's sparse index, which only writes one index entry per configurable number of bytes written (not per message). A sparse index trades lookup precision (you may need to scan a few kilobytes forward from the indexed position) for reduced index size, which matters when you have billions of messages per partition.

Platform-level concern: the `fsync` policy is a tunable knob that sits at the intersection of durability and throughput. `fsync` per message is safe but limits write throughput to the disk's sequential write speed, roughly 100-200 MB/s on spinning disk, 500 MB/s on SSD. Batching writes and `fsync`ing every N messages (or every T milliseconds) allows throughput to scale with batch size. The trade-off is the durability window: messages written after the last `fsync` are in the OS page cache and will be lost if the broker process dies without a graceful shutdown. For financial systems, `acks=-1` with replication to three brokers provides durability without relying on single-broker `fsync` on every write. The replication commit is the durability guarantee, not the local `fsync`.