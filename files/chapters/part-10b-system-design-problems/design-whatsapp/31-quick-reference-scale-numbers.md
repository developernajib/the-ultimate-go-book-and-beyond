## Quick Reference: Scale Numbers

These are the key numbers to remember for a WhatsApp system design interview. Being able to cite specific scale figures makes your design credible and shows you understand the quantitative constraints driving each technology choice.

- 100B messages/day = 1.16M messages/sec average, 2-3x that at peak
- 500M concurrent WebSocket connections across 1,000 servers (500K each)
- 10TB text/day, ~2PB media/day: media is ~200x text and drives the bill
- Cassandra: partitioned by `conv_id`, clustered on TimeUUID `message_id`, 30-day TTL
- Redis: 500M presence keys (5-min TTL), offline queues drained with `LPOP count`, 30-day retention
- Group fan-out: direct delivery for <100 members, Kafka for 100-1,024
- Group E2E: Sender Keys, encrypt **once**, server-side fan-out. Not once per recipient
- E2E: Signal Protocol (X3DH once per session, Double Ratchet per message). Ratchet cost is tens of microseconds per message, a DH step around a millisecond
- Media: presigned S3 URLs, 100MB max, CDN delivery of ciphertext
- Push: contentless wakeup, client fetches and decrypts locally. A "from Alice" body would leak the social graph to APNs and FCM
- Contact sync: batch lookup plus batched block filter. Hashing phone numbers does **not** make this private, since a 10-digit space is exhaustible in hours on a laptop

---
