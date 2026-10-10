## Follow-up Questions, Advanced

These advanced follow-ups go beyond the core design and test your ability to reason about real-world operational challenges. Interviewers at the L6 level expect you to discuss these topics with confidence, including LAN sync for local network optimization, handling very large files, and managing the thundering herd problem when many collaborators share a folder.

**Q: How does selective sync work?**
Each device registers synced folders. Server filters changes by device config. Adding a folder sends full contents, removing deletes local copy but server retains.

**Q: How would you implement LAN sync?**
Devices discover each other via mDNS. Device A announces block hashes, Device B downloads needed blocks via local HTTP. Verify with SHA256. Fallback: download from S3.

**Q: How do you handle 10GB+ video files?**
2,500 blocks at 4MB each. Parallel upload (10 concurrent S3 PUTs). Resume from failed blocks. Streaming through chunker (no full file in memory).

**Q: How about the thundering herd for shared folders with 10,000 collaborators?**
Don't notify all instantly. Batch in 1-second windows. Priority: active devices first. Rate limit: 100 notifications/sec per folder. Pull-based catchup for missed notifications.


---
