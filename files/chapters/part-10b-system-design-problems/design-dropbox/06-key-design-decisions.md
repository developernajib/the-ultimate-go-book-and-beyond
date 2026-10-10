## Key Design Decisions

Every design decision below involves a trade-off between simplicity, performance, and correctness. Understanding these trade-offs is what interviewers look for at the senior level.

**Block-based Delta Sync:** Files are chunked into 4MB content-addressed blocks. Only changed blocks are uploaded/downloaded. This makes syncing a modified document dramatically faster than re-sending the whole file. The 4MB block size is a deliberate compromise: smaller blocks (e.g., 256KB) would reduce transfer waste for small edits but increase metadata overhead (more hashes to store and compare per file). Larger blocks (e.g., 16MB) reduce metadata but waste more bandwidth when only a small portion of a block changes. Content-defined chunking (CDC) improves delta efficiency further, especially for insertions that shift byte offsets, and is covered in the deep dive section. Note that Dropbox's documented sync protocol has stayed with fixed 4MB blocks (its published `content_hash` is computed over fixed 4MB chunks), so treat CDC as an extension, not a description of Dropbox internals.

**Content-Addressed Storage:** Block key = SHA256(content). Deduplication is automatic, identical blocks across all users share one S3 object. Estimated 30% space savings from deduplication (with the privacy caveat from the introduction: production Dropbox retreated to per-user dedup scope). Blocks are immutable, so they can be cached with `max-age=31536000, immutable` headers. The alternative (random UUIDs as block keys) would require an explicit deduplication step and lose the property that uploading an already-stored block is a no-op.

**Client-Driven Sync Protocol:** The upload flow is designed to minimize server-side state and maximize parallelism:
1. Client sends block hashes for a file.
2. Server responds with which hashes are missing (checking S3 with HEAD requests).
3. Client uploads only missing blocks directly to S3 (pre-signed URLs bypass the API server).
4. Client notifies server that upload is complete.
5. Server commits the new file version to the metadata database.

This design keeps API servers stateless and lightweight, they never touch file content. All bandwidth-heavy work flows directly between client and S3.

**Cursor-Based Change Tracking:** Each device tracks a cursor (last-synced timestamp). On reconnect, request all changes after cursor. Server returns up to 1000 changes, client polls until `has_more=false`. This handles arbitrarily long offline periods without any special recovery protocol. A device that has been offline for a month simply requests more pages of changes. Using server-side timestamps (not client clocks) as cursors eliminates clock skew problems entirely.

---
