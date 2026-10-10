## Common Mistakes and How to Avoid Them

Knowing what not to do is just as important as knowing the right approach. These are the pitfalls that interviewers see most often, and any one of them can signal a lack of understanding of how file sync systems actually work at scale. Review this list before your interview to make sure you are not falling into these traps.

1. **Uploading entire files**: Not implementing block-level chunking. Delta sync is the entire value proposition of Dropbox. A 1GB file with a one-character edit should transfer 4MB (one block), not 1GB.
2. **Server-side chunking**: Chunking must happen on the client so that hash comparison can determine which blocks are already on the server before any upload begins. If the server chunks, you have already wasted bandwidth sending the whole file.
3. **No deduplication**: Content-addressing is fundamental. Same hash = same block across ALL users. Without it, you forfeit the ~30% space savings from deduplication (over 40% more raw storage) and lose the ability to skip uploads for blocks the server already has from other users.
4. **Polling for sync**: Periodic polling (e.g., every 5 seconds) across ~30M concurrently online devices means 6 million requests per second, most returning empty responses. Long-poll or WebSocket notifications reduce this to near-zero idle traffic while providing faster sync than polling.
5. **Ignoring conflicts**: Saying "last write wins" without explaining how to detect and preserve the losing version means you will silently destroy user data. The correct approach detects conflicts via revision comparison and saves the conflicting version as a separate file.
6. **No pre-signed URLs**: Routing uploads through API servers means every byte of every file passes through your infrastructure. Pre-signed S3 URLs let clients upload directly to object storage, keeping API servers lightweight and stateless.

---
