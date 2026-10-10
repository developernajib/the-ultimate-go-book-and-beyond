## Summary

The table below maps each major component to the technology chosen and its role in the system. This serves as a quick reference for understanding how the pieces fit together. Notice how each technology is selected to match its specific workload: Cassandra for high-write message storage, Redis for fast in-memory operations like presence and queuing, and S3 with a CDN for large media files.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Real-time messaging | WebSocket + Redis Pub/Sub | 500M concurrent connections |
| Message storage | Cassandra | High-write, time-series messages |
| Group membership | Cassandra + Redis cache | Fast member lookups |
| Offline queue | Redis List | 30-day message retention |
| Media storage | S3 + CloudFront CDN | Pre-signed direct uploads |
| Push notifications | APNs/FCM via Kafka | Offline user wake-up |
| Presence | Redis SETEX | User online status |
| E2E encryption | Signal Protocol: X3DH over Curve25519, Double Ratchet, AES-256-CBC + HMAC-SHA256 | Server holds ciphertext and no key |
| Group E2E | Sender Keys | Encrypt once, server-side fan-out |
| User metadata | PostgreSQL | Profile, phone lookup |

If you carry three things out of this chapter, make them these.

**The durable write is the guarantee, and everything else is an optimization.** The message is safe because it reached Cassandra before anyone tried to route it. Presence lookups, Pub/Sub hops, and offline queues all make delivery fast, and every one of them can silently fail: a publish to a dead server's channel succeeds with zero subscribers and reports nothing wrong. Recovery works because a reconnecting client pulls everything after its last acknowledged message ID. Designs that treat the fast path as the guarantee lose messages precisely when a server dies, which is the only time it matters.

**E2E encryption is a constraint you design around, not a feature you add.** It decides that thumbnails are generated on the device, that the push payload is a contentless doorbell, that search is local, that backups are encrypted before they leave, and that spam control works on metadata. Any component that needs to read a message is not compatible with the claim, and the contradiction is usually easier to spot in the code than in the prose. Equally, do not oversell it: the server must route, so it always knows who talks to whom and when, and that metadata is often the more sensitive half.

**At this scale, the interesting bugs are the quiet ones.** A stub returning `""` gives every row the same primary key. `LRANGE` plus `DEL` deletes messages nobody read. A parameter accepted and never checked lets a stranger answer your call. A TimeUUID compared as a string sorts correctly for seven minutes and then scrambles a year of history. None of these fail a compile, throw an error, or fire an alert. They are found by writing the test that would catch them, running it under `-race`, and pointing the query at a real database instead of an imagined one.

---
