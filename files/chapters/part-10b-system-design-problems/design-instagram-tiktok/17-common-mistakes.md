## Common Mistakes and How to Avoid Them

These are the pitfalls that interviewers see most often. Each one represents a fundamental misunderstanding of how social media platforms operate at scale. Reviewing these before an interview helps you avoid the traps that weaker candidates fall into, and proactively addressing them in your design shows the interviewer that you have real-world awareness.

1. **Fan-out for celebrities.** Pushing a single post to 400 million follower feed caches creates massive write amplification that would take minutes to complete and overwhelm your Redis cluster. Use a hybrid model: push for users with fewer than 100K followers, pull at read time for celebrities.
2. **Real-time database counters.** At 115K views per second, running `UPDATE posts SET view_count = view_count + 1` on every view saturates the database. Use Redis counters with write-through for real-time display and periodic batch sync to the durable store.
3. **Synchronous media processing.** Video transcoding takes 30+ seconds per file, and photo resizing takes several seconds. Running this inside an API request handler would cause timeouts and block the upload endpoint. Process media asynchronously via an SQS-driven worker pipeline.
4. **No content moderation.** CSAM detection is a legal requirement in most jurisdictions, and NSFW filtering is essential for user safety. Content moderation must run as an asynchronous pipeline stage between upload and publication, with ML-based classification and human review for borderline cases.
5. **Single CDN origin.** Users in Asia downloading photos from a US-East S3 bucket experience 200ms+ latency per image. Deploy S3 buckets in multiple regions and use a global CDN with 200+ points of presence so that media is served from the nearest edge node.
6. **Storing media in the database.** Binary blobs in PostgreSQL or Cassandra consume expensive storage, bloat backup sizes, and cannot be served through a CDN. Object storage (S3 or GCS) with CDN delivery is the only scalable approach for media at this volume.
7. **No cursor-based pagination.** OFFSET/LIMIT pagination becomes progressively slower as users scroll deeper because the database must skip over all previous rows. Use cursor-based pagination with the last post ID as the cursor, which performs consistently regardless of position.
8. **Ignoring notification batching.** Sending individual push notifications for every like on a viral post overwhelms users and causes them to disable notifications entirely. Batch low-priority signals (likes, follows) over 30-60 second windows while delivering high-priority interactions (comments, mentions) immediately.

---
