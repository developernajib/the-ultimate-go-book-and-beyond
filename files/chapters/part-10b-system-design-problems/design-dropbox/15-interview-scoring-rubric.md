## Interview Scoring Rubric

This rubric shows what interviewers expect at different seniority levels. Use it to gauge the depth of your answer and prioritize which topics to cover first. A solid L5 answer covers the fundamentals (delta sync, dedup, cursor-based sync), while an L6 answer demonstrates mastery of edge cases and operational concerns like garbage collection, storage tiering, and disaster recovery.

### L4, Expected
- Chunking files into blocks, basic upload/download, single DB

### L5, Strong Hire
- Content-addressed storage (SHA256 = key)
- Delta sync: only upload changed blocks
- Deduplication across users
- Cursor-based incremental sync
- Long-polling for notifications
- Conflict detection via revision numbers
- Pre-signed S3 URLs

### L6, Exceptional
- All L5 plus:
- Conflict resolution (conflicted copies)
- Storage tiering (hot/warm/cold)
- Garbage collection for orphaned blocks
- Split-brain recovery protocol
- Metadata sharding by owner_id
- Cross-region disaster recovery
- Convergent encryption for encrypted dedup

---
