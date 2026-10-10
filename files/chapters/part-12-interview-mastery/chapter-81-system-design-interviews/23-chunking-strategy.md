## Chunking Strategy

Large files are split into fixed-size chunks:

┌────────────────────────────────────────────────────────────────┐
│ CHUNKING DESIGN │
├────────────────────────────────────────────────────────────────┤
│ │
│ Original File (500 MB) │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Data Data Data Data Data Data Data Data Data Data Data │ │
│ └─────────────────────────────────────────────────────────┘ │
│ │ │
│ ▼ │
│ Split into 4MB chunks: │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │
│ │ Chunk1 │ │ Chunk2 │ │ Chunk3 │ ... │Chunk125│ │
│ │ (4MB) │ │ (4MB) │ │ (4MB) │ │ (4MB) │ │
│ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ │
│ │ │ │ │ │
│ ▼ ▼ ▼ ▼ │
│ SHA256 Hash: SHA256 Hash: SHA256 Hash: SHA256 Hash: │
│ abc123... def456... ghi789... xyz999... │
│ │
│ File Metadata: │
│ { │
│ "file_id": "uuid-123", │
│ "name": "video.mp4", │
│ "size": 524288000, │
│ "chunks": [ │
│ {"index": 0, "hash": "abc123...", "size": 4194304}, │
│ {"index": 1, "hash": "def456...", "size": 4194304}, │
│ ... │
│ ] │
│ } │
│ │
└────────────────────────────────────────────────────────────────┘

Why 4MB chunks?
- Small enough for quick upload/download
- Large enough to minimize metadata overhead
- Good for resumable transfers
- Works well with S3 multipart upload


### Junior → FAANG: Understanding File Chunking

Chunking is the practice of splitting files into fixed or variable-size pieces before upload, which enables delta sync (only upload changed chunks), parallel upload (multiple chunks in flight simultaneously), and deduplication (identical chunks share storage). Fixed-size chunking is simpler to implement. Content-defined chunking (e.g., Rabin fingerprinting) produces smaller deltas when content is inserted or deleted in the middle of a file. For interviews, know the trade-off: fixed-size is O(1) to compute chunk boundaries. Content-defined is more expensive to compute but produces better deduplication ratios for document and code workloads.

### Senior @ FAANG: Chunking as a Platform Optimization with Operational Trade-offs

At the senior level, the chunking strategy is a performance-reliability trade-off that affects multiple system layers. The chunk size directly controls the average number of chunks per file, the metadata storage overhead (one row per chunk per file version), the upload parallelism (smaller chunks allow finer-grained parallelism but increase HTTP overhead), and the deduplication hit rate (smaller chunks deduplicate more aggressively but generate more chunk metadata). The ADR for chunk size should capture the empirical file size distribution for your workload (derived from telemetry, not guessed), the target deduplication ratio, and the acceptable metadata storage overhead. At the staff level, chunking strategy also interacts with the disaster recovery plan: if a chunk is corrupted in object storage, what is the recovery procedure, and does the system detect and self-heal corruption via content-addressed storage (each chunk keyed by its hash, so a hash mismatch on retrieval signals corruption).
