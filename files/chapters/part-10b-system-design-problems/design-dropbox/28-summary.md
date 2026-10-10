## Summary

This table provides a quick reference for every major component in the Dropbox design and the technology choice behind it. Use it as a checklist during interviews to make sure you have covered all the key pieces. Each row maps directly to a section discussed earlier in this chapter.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Block storage | S3 (content-addressed) | Deduplicated file chunks |
| Metadata | PostgreSQL | File tree, versions |
| Delta sync | Client-driven hash comparison | Efficient sync |
| Change notification | Redis Pub/Sub | Real-time sync trigger |
| Version history | DB + S3, 30-day TTL | File versioning |
| Deduplication | SHA256 content addressing | 30% space savings |
| Upload | Pre-signed S3 URLs | Direct client-to-S3 |
| Conflict detection | Revision comparison | Safe concurrent edits |


---
