## 31.5 Binary File Processing

### Reading Binary Data

Binary file parsing uses `encoding/binary` with `binary.Read` to decode fixed-width integers from the byte stream in the file's declared byte order (little-endian or big-endian), avoiding manual bit-shifting. The magic number at the start of the file is read and validated before attempting to parse the rest, returning an early error rather than producing nonsensical data from a file of the wrong type. Structs used with `binary.Read` must consist entirely of fixed-size types (no strings or slices), with variable-length fields handled by reading a length prefix and then reading that many bytes into a `[]byte`.

```go
package main

import (
    "encoding/binary"
    "io"
    "os"
)

type BinaryHeader struct {
    Magic     [4]byte
    Version   uint32
    Count     uint64
    Timestamp int64
}

func readBinaryHeader(path string) (*BinaryHeader, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    var header BinaryHeader
    if err := binary.Read(f, binary.LittleEndian, &header); err != nil {
        return nil, err
    }

    return &header, nil
}

// Read records from binary file
type Record struct {
    ID    uint32
    Value float64
}

func readBinaryRecords(path string) ([]Record, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    var records []Record
    for {
        var record Record
        if err := binary.Read(f, binary.LittleEndian, &record); err == io.EOF {
            break
        } else if err != nil {
            return nil, err
        }
        records = append(records, record)
    }

    return records, nil
}
```

### Writing Binary Data

Writing binary data mirrors the reading process: `binary.Write` encodes a fixed-size struct into the writer in the specified byte order. The header is written first, followed by each record in sequence. Because the struct fields are all fixed-width types, the on-disk format is deterministic and can be read back by any program that knows the struct layout and byte order.

```go
package main

import (
    "encoding/binary"
    "os"
)

func writeBinaryFile(path string, header BinaryHeader, records []Record) error {
    f, err := os.Create(path)
    if err != nil {
        return err
    }
    defer f.Close()

    // Write header
    if err := binary.Write(f, binary.LittleEndian, header); err != nil {
        return err
    }

    // Write records
    for _, record := range records {
        if err := binary.Write(f, binary.LittleEndian, record); err != nil {
            return err
        }
    }

    return nil
}
```

### Junior → FAANG: Prerequisites and Interview Framing

Before you can reason about binary formats, you need a concrete mental model of how bytes map to values. A `uint32` is four bytes. On little-endian systems (x86, ARM in its default mode, Apple Silicon) the least significant byte is stored first, so the value `0x11223344` is written as `44 33 22 11` on disk. On big-endian systems (network byte order, some older mainframes) the same value is written as `11 22 33 44`. When you call `binary.Read(f, binary.LittleEndian, &header)` the package does this swapping for you, which is why specifying the order explicitly matters more than the endianness of the machine you happen to be running on.

The magic number at the start of the file is the single most important defense against garbage input. Pick a four-byte sequence that is unlikely to appear in ASCII text or other common formats, verify it before reading anything else, and return a typed error like `ErrInvalidMagic` so callers can distinguish a wrong file type from a truncated or corrupt file. PNG uses `89 50 4E 47`, ZIP uses `50 4B 03 04`, and ELF uses `7F 45 4C 46`. The high bit in the first byte of PNG is deliberate so that a file transferred over an ASCII-only channel will be corrupted in a detectable way.

A worked example that a new engineer can walk through on a whiteboard: suppose you want to store a list of temperature readings, each with a timestamp and a sensor ID. You define a header with magic, version, and count, then a fixed-size record of `{ID uint32, Timestamp int64, Celsius float64}`. That is twenty bytes per record. A file with one thousand records is exactly `header_size + 20000` bytes, which lets you seek to any record in O(1) with `f.Seek(headerSize + int64(i)*20, io.SeekStart)`. This is the core idea behind every indexed binary file format, from SQLite pages to Parquet row groups.

First-job context matters. At a FAANG-scale company you will rarely invent a new binary format from scratch. You will read someone else's format (often protobuf or flatbuffers), add a field, and deal with the versioning fallout. The interview entry point is usually framed as "parse this fixed-width record file" or "decode this custom header." Demonstrate that you check the magic number, handle `io.ErrUnexpectedEOF` distinctly from `io.EOF`, and reject files whose declared length does not match the actual file size. Candidates who skip those checks fail the signal even if their happy-path code works.

### Senior @ FAANG: Binary Format Design, Zero-Copy Parsers, and Serialization Trade-offs

At staff and principal level, the decision is rarely "how do I parse this format" and almost always "which format do I pick, and what do I commit my team to for the next five years." The wrong answer here shows up as migration pain, on-call incidents from version skew, and CPU bills that scale with the wrong thing.

Format design starts with a versioned header. Reserve the first sixteen bytes: four-byte magic, two-byte major version, two-byte minor version, four-byte header length (so you can grow the header without breaking old readers), and a four-byte feature-flags bitmap. Major version bumps are breaking, minor versions are additive, and feature flags let you enable codec variants (for example bit zero means zstd compression, bit one means dictionary compression, bit two means encrypted payload). Old readers check required-feature flags in a "must-understand" subset and refuse files that use unknown required features, similar to how Matroska's EBML handles unknown element IDs.

TLV (type-length-value) encoding is the right default when fields are sparse or optional. Each record is a stream of `{tag uint16, length uint32, value [length]byte}` triples. Unknown tags are skipped by advancing `length` bytes. This gives you forward compatibility without reserving slots for fields you have not invented yet. Protobuf's wire format is essentially TLV with varint-encoded tags and lengths. The downside is random-access cost: to find field seven you must scan fields one through six. Fixed-offset layouts win for columnar access, TLV wins for sparse records.

The serialization matrix in 2026 sorts roughly as follows. Protobuf remains the default for RPC payloads and cross-language schemas, with mature tooling and small wire sizes, but it requires a parse pass that allocates. Flatbuffers skips the parse pass entirely: accessors read directly from the buffer via offset tables, which makes it the right choice for latency-sensitive read-mostly data like game assets, ML feature vectors, and mmap-backed indices. Cap'n Proto is philosophically similar to flatbuffers with a cleaner schema language and RPC story, but has less ecosystem traction. MessagePack is schemaless and compact, ideal for Redis payloads or language-internal caches where you do not need cross-team contracts. Avro dominates in Hadoop and Kafka pipelines because the schema travels with the data and schema evolution rules are baked in. For new Go code in 2026, the default is protobuf unless you have a concrete latency budget that only flatbuffers can hit.

Zero-copy parsers are the senior move for hot paths. The pattern is: mmap the file, cast the pointer to a struct layout that exactly matches the on-disk format, and read fields directly. Go's `unsafe.Slice` and `unsafe.Pointer` make this possible but dangerous because alignment and padding must match exactly between the file format and the struct. The correct approach is to write the struct with explicit padding, use `//go:notinheap` where appropriate, and add a compile-time assertion that `unsafe.Sizeof(Record{})` equals the documented record size. Flatbuffers-generated Go code does this for you with per-field accessors that bounds-check on each read. At FAANG scale, zero-copy matters when you are parsing terabytes per second of feature data for inference and the parse cost dominates the actual model forward pass.

Endianness in 2026 is almost always little-endian on the wire because every commodity server is x86 or ARM running in LE mode. The exception is network protocols that predate modern hardware and still use big-endian for historical reasons (TCP headers, DNS, most IETF wire formats). When you design a new format, pick little-endian and document it. When you inherit a format, never guess: parse the magic number both ways and pick the one that matches, or encode the byte order in the header like TIFF does with its `II` versus `MM` marker.

Checksums belong in the format, not as a separate file. CRC32C (Castagnoli) is the industry default because it has hardware acceleration on every modern CPU via SSE4.2 and ARMv8 CRC extensions. Put a four-byte CRC at the end of each record for per-record validation and a separate CRC over the whole file for end-to-end integrity. For cryptographic integrity use BLAKE3 or SHA-256, not both, and store the hash in a signed manifest rather than inline. Confusing integrity (detect corruption) with authenticity (detect tampering) is a classic interview failure and a real production incident class.

Common production pitfalls to flag in review: reading a `uint64` count field and immediately `make([]Record, count)` without bounding the value, which turns a one-byte flip in the header into an OOM kill. Always clamp allocations to a sanity limit derived from the file size. Using `binary.Read` with a reflect-based path in a hot loop, which allocates and is five to ten times slower than hand-written byte-slice decoders. Embedding `time.Time` in a wire struct, which is not fixed-size. Forgetting that a struct with a `bool` field has implicit padding that changes with the next field's alignment. These are the things staff engineers catch in code review that new engineers ship to production.

---
