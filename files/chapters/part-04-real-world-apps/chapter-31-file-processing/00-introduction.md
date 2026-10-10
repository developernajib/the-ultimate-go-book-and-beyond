# Chapter 31: File Processing and I/O

*"The fastest code is code that doesn't allocate. For I/O, streaming is the equivalent of not allocating."* - Anonymous

Data moves through every system as files. Log files, configuration files, data exports, uploads, archives, ETL inputs, and binary assets - handling them correctly and efficiently is a fundamental backend engineering skill. The naive approach, reading an entire file into memory before processing it, works fine for small inputs but falls apart catastrophically when processing gigabyte-scale CSV exports, multi-part uploads, or real-time log streams. The difference between a system that handles 10 MB and one that handles 10 GB is almost always in how it treats I/O.

Go's I/O model is built around the `io.Reader` and `io.Writer` interfaces - arguably the most elegant I/O abstractions in any systems language. Because files, network connections, HTTP bodies, gzip streams, and in-memory buffers all satisfy the same interface, you can compose transformations into streaming pipelines with zero copying between layers. A file can be read, decompressed, parsed, transformed, recompressed, and written back to disk using a chain of wrapped readers and writers that never materialize the full dataset in memory simultaneously.

This chapter covers Go I/O end to end: efficient file operations with `bufio`, streaming large files without memory pressure, parsing and generating CSV/JSON/XML/binary formats, compression and decompression, atomic file writes, directory watching for hot-reload, and building production-grade processing pipelines. These patterns appear throughout the data infrastructure at companies like Netflix, Uber, and Airbnb, where terabytes of files flow through Go pipelines daily.

**What you'll learn in this chapter:**
- Using Go's `io`, `os`, `bufio`, and `fs` packages for efficient and correct file operations
- Streaming gigabyte-scale files with constant memory usage using `io.Reader` pipeline composition
- Parsing and generating CSV, JSON, XML, and custom binary formats with proper error handling and validation
- Compressing and decompressing files with gzip, zlib, and zip using streaming interfaces
- Implementing atomic file writes with temp-file-and-rename patterns to prevent corruption on crash
- Watching directories for file system events with `fsnotify` for hot-reload and change-driven workflows
- Building concurrent file processing pipelines with fan-out, fan-in, and bounded parallelism
- Designing production I/O pipelines with backpressure, cancellation, progress reporting, and checkpointing

**Why this matters at scale:**
Netflix's data engineering platform ingests petabytes of viewing event files daily through Go streaming pipelines that maintain constant memory footprints regardless of input size. Cloudflare's log processing infrastructure uses Go's composable I/O to transform, compress, and route trillions of HTTP log records per day across their global edge network.

**Prerequisites:** Chapter 5 (Interfaces & io.Reader), Chapter 11 (Goroutines & Channels), Chapter 14 (Context & Cancellation)

### Junior to FAANG: where newcomers get file I/O wrong

Most junior engineers treat files the same way they treat strings. They reach for `os.ReadFile` because it returns a tidy `[]byte`, then iterate with `strings.Split`. That approach works on the 4 KB fixture in the unit test and detonates the first time production hands you a 12 GB log. Before you can operate at FAANG scale you need five habits wired into muscle memory.

First, always think in terms of `io.Reader` and `io.Writer`. A `*os.File`, an `http.Response.Body`, a `bytes.Buffer`, a `gzip.Reader`, and a `tar.Reader` are interchangeable. Functions should accept `io.Reader` rather than `*os.File` because that lets the caller feed you a gzip stream, an S3 object, or a fake buffer in tests.

Second, always close what you open and always check the close error for writers. A deferred `file.Close()` on a writer can silently eat a flush failure, and you will ship corrupted output. The pattern is `defer func() { if cerr := f.Close(); cerr != nil && err == nil { err = cerr } }()` when returning a named error.

Third, never trust a single `Read` call to return what you asked for. `io.Reader.Read` is allowed to return fewer bytes than the buffer. Use `io.ReadFull`, `bufio.Scanner`, or `io.Copy` rather than calling `Read` in a hand rolled loop.

Fourth, learn the difference between `bufio.Scanner` and `bufio.Reader`. Scanner has a default 64 KB token limit that will silently truncate long lines unless you call `Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)`. Reader is line agnostic and safer for unknown inputs.

Fifth, interview entry points in this area usually look like "count word frequencies in a 100 GB file" or "deduplicate a CSV that does not fit in memory". The answer is always streaming plus an external data structure (bounded map with spill to disk, bloom filter, or sort merge). If your first instinct is to load the whole file, you will fail the loop.

### Senior @ FAANG: petabyte-scale file infrastructure and the decisions that define it

At staff and principal level, file processing is rarely about a single program reading a single file. It is about operating a fleet that moves petabytes per day across object stores, columnar warehouses, and streaming pipelines. The decisions compound, and the wrong default at the platform layer costs tens of millions of dollars per year in egress, storage, and on call burden.

Start with the storage layout question. Row oriented formats such as CSV, JSONL, and Protobuf delimited streams are write friendly but read hostile because every analytical query pays for every column. Columnar formats (Parquet, ORC, Arrow IPC) invert that trade. At Netflix, Uber, and Meta, the canonical lake format is Parquet with ZSTD compression and column statistics written per row group, because predicate pushdown on partition and min/max stats routinely eliminates 99 percent of physical bytes read. Arrow is the in memory wire format for cross language zero copy. Avro is the schema evolution champion for Kafka topics because it carries writer and reader schemas and supports forward and backward compatible field additions through defaults.

Compression codec selection is not a taste question, it is a throughput calculation. LZ4 gives you 2 to 3 GB/s decode on a single core with ratios around 2x. Snappy is similar but slightly slower and was the default at Google for a decade because it is CPU cheap enough to leave cycles for the query engine. ZSTD at level 3 gives Snappy throughput with gzip ratios, and at level 19 gives archival ratios at the cost of 10x slower encode. Gzip is legacy and should only be chosen when the consumer is out of your control. The rule at scale is "ZSTD for warm data, LZ4 for hot intermediates, no compression for ephemeral shuffle data where CPU is the bottleneck".

Checksumming is non negotiable for anything that crosses a machine boundary. CRC32C (hardware accelerated via SSE4.2 and ARMv8 CRC instructions) is the standard for block level integrity because it runs at memory bandwidth. xxHash64 and xxHash3 are faster for larger blocks when you do not need CRC's mathematical guarantees. BLAKE3 is the modern choice when you need cryptographic integrity with SIMD speed. S3 computes MD5 for ETag on simple PUT but switches to a compound hash for multipart, which breaks naive integrity checks. Always compute and verify CRC32C end to end, and store it in object metadata.

Durability is where junior code silently corrupts data. `os.Rename` is atomic on the same filesystem on POSIX, but only after you have `fsync`d the file and then `fsync`d the parent directory. Skipping the directory fsync means the rename can be lost across a power failure even though the data blocks landed. The production pattern is write to temp, fsync file, rename, fsync directory. On networked storage this does not hold at all, and you must rely on the object store's conditional PUT semantics (`If-None-Match: *` on S3 for write once, GCS preconditions, or object versioning with compare and swap via generation numbers).

Streaming IO has three regimes that behave differently. Buffered reads through `bufio.Reader` with 1 MB buffers saturate sequential throughput on local SSD. Memory mapping via `mmap` wins when you have random access patterns that fit in page cache, because you pay zero syscall overhead per access, but it loses badly on sequential scans of data larger than RAM because the kernel readahead heuristics fight your access pattern. O_DIRECT bypasses page cache entirely and is mandatory for database storage engines that manage their own buffer pool (RocksDB, InnoDB, FoundationDB) because double buffering wastes RAM and breaks crash consistency guarantees. Go does not expose O_DIRECT directly, you pass the flag via `unix.O_DIRECT` and must align buffers to the device's logical block size, typically via `unix.Mmap` or manual alignment.

Object store uploads at scale require multipart. S3 multipart uploads should use 8 to 64 MB parts, 10000 part maximum, with parallel upload of 8 to 32 parts concurrently. The subtle failure mode is orphaned multipart uploads that accrue storage cost forever, so every production uploader must register a lifecycle rule that aborts incomplete multiparts after 7 days. Signed URL governance is a separate discipline. URLs should be scoped to a single object key, a single HTTP method, and a TTL under 15 minutes, and the signing service must log every URL issued with the subject and purpose for audit.

Security boundaries in file processing are underrated and cause most of the post mortems. CSV injection (formula injection) happens when a user supplied field starts with `=`, `+`, `-`, or `@` and is later opened in Excel, which then executes it as a formula and can exfiltrate data via `=WEBSERVICE(...)`. The mitigation is prefix any such field with a single quote or tab during export. Zip slip is the directory traversal attack where a zip entry named `../../etc/passwd` extracts outside the target directory. The mitigation is `filepath.Clean` plus a prefix check against the resolved target root, every time, no exceptions. TOCTOU on temp files is defeated by `os.CreateTemp` which atomically creates with O_EXCL, never by `os.TempDir` plus a predictable name. JSON DoS via deep nesting or huge strings is defeated by `json.Decoder` with a size limited `io.LimitReader` and a recursion guard. None of these are hypothetical, all have shipped as CVEs in major Go tools in the last five years.

Finally, the file watcher question. `fsnotify` is the cross platform wrapper around `inotify` (Linux), `kqueue` (BSD and macOS), and `ReadDirectoryChangesW` (Windows). It is adequate for config reload. It is inadequate for production workloads that watch millions of paths because inotify has a per user watch limit (default 8192) and drops events under pressure with no replay. At that scale you move to `fanotify` which watches mount points and does not require per path registration, or you skip kernel notification entirely and poll with a Merkle tree of directory hashes. Meta's `watchman` and Google's `fsmonitor` exist because fsnotify does not scale to a monorepo.

---
