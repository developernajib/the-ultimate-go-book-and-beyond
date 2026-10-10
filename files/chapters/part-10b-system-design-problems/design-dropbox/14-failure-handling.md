## Failure Handling

Reliable file sync must handle every kind of failure gracefully, from a dropped Wi-Fi connection mid-upload to a device that has been offline for weeks. The key insight in this design is that separating block uploads from metadata commits makes partial failures safe, blocks are immutable and idempotent, so retrying is always safe, and the file system state only changes when the final commit succeeds.

### Upload Failure Recovery

The upload protocol is designed so that every step is either idempotent or retryable. Because blocks are stored by their content hash, uploading the same block twice has no side effects. Pre-signed URLs can be refreshed if they expire. The metadata commit only happens after all blocks are confirmed in S3, so a crash mid-upload never leaves the file system in a corrupted state.

```
Client-side protocol:
1. Client chunks file, computes hashes
2. Server returns missing hashes + upload URLs
3. Client uploads each block to S3 via pre-signed URL
4. If block N fails: retry (idempotent: same hash = same key)
5. Pre-signed URL expired? Request new URL
6. Network down? Queue for upload when online
7. After all blocks uploaded: send "commit" request
8. If commit fails: blocks safe in S3, retry commit

Key insight: separating block upload from metadata commit means
partial failures never corrupt the file system.
Orphaned blocks -> garbage collected nightly.
```

### Split-Brain Recovery

Split-brain scenarios occur when a device is offline for an extended period while other devices continue making changes. The recovery protocol uses cursor-based sync to efficiently catch up on all missed changes, then applies conflict resolution rules for any files that were edited on both sides. Using server-side timestamps instead of device clocks avoids the classic distributed systems problem of clock skew.

```
Scenario: Device A offline 2 days, both devices editing

Resolution protocol:
1. Device A requests changes since cursor (2 days ago)
2. Server returns Device B's changes
3. Detect conflicts (files edited on both)
4. For each conflict:
   a. Only one edited -> take that version
   b. Both edited same file -> conflicted copy
   c. One deleted, other edited -> keep edit
5. Device A uploads offline changes
6. Server notifies Device B

All changes use server timestamps (not device clocks)
Cursor is server-side -> immune to clock skew
```

---
