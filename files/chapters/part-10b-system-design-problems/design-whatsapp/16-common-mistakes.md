## Common Mistakes and How to Avoid Them

These are the most frequent errors candidates make when designing a WhatsApp-like system in interviews. Each mistake reveals a misunderstanding of the scale or the nature of real-time messaging. Avoiding these pitfalls demonstrates that you understand why specific technology choices matter and how they directly impact performance, reliability, and user experience.

1. **HTTP polling instead of WebSocket**, at 500M concurrent users, polling means every client pays a full request round trip, headers and all, on a fixed interval whether or not anything arrived, and you still add latency equal to half the poll interval. A WebSocket is one upgrade handshake followed by frames costing a few bytes of overhead each, and the server pushes the instant a message exists. The saving is large but depends entirely on poll interval and message rate, so reason about it rather than quoting a percentage.
2. **MySQL for messages**, relational databases cannot sustain 1.16M writes/sec on average, with peaks two to three times higher. Cassandra handles this workload because it is designed for high-write, time-series data with linear horizontal scaling.
3. **Synchronous group fan-out**, sending a message to a 1,024-member group synchronously blocks the sender's thread. Use Kafka consumer groups for asynchronous fan-out on large groups.
4. **Ignoring E2E encryption**, interviewers expect at least a mention of the Signal Protocol. The server stores only ciphertext and holds no key that opens it. The opposite mistake is overclaiming: E2E hides content, not metadata, so do not call the server "zero-knowledge" and do not then propose server-side search, thumbnailing, or content moderation, all of which require the plaintext you just said you could not read.
5. **Single connection server**, 500M connections cannot fit on one server. You need roughly 1,000 servers at 500K connections each, with Redis-based presence routing between them.
6. **No offline message handling**, without an offline queue, messages sent to disconnected users are lost. Use a per-user Redis list that drains on reconnect.
7. **Per-member message storage**, storing a copy of every group message per member multiplies storage by the group size. Store once per conversation and fan out delivery references.
8. **No message ordering guarantees**, without a Cassandra clustering key on `(conv_id, message_id)` where `message_id` is a TimeUUID, messages can appear out of order in conversation history. Two related traps: comparing TimeUUIDs as strings rather than as TimeUUIDs silently scrambles anything older than about 7 minutes, and clustering on `sent_at` instead makes it impossible to update a single message by ID, because Cassandra requires an `UPDATE` to name the full primary key.
9. **Routing media through API servers**, large files (photos, videos) should bypass application servers entirely via presigned S3 URLs for direct upload/download.
10. **Missing read receipts**, delivery and read tracking are core WhatsApp features. Track `delivered_at` and `read_at` per message and push status updates back to the sender.

---
