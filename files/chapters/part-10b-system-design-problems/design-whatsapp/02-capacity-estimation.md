## Capacity Estimation

Before diving into the design, you need to understand the scale of the system. Capacity estimation helps you decide which technologies to use and how to partition your data. For example, 100 billion messages per day translates to 1.16 million messages per second on average and two to three times that at peak, which rules out traditional relational databases for message storage. These numbers also tell you that you need hundreds of servers just to hold WebSocket connections for all concurrent users.

```
Messages/day:       100B → ~1.16M/sec average, 2-3x at peak
Users online:       500M concurrent users
Connections:        500M WebSocket connections
Text size avg:      100 bytes (ciphertext + envelope)
Media messages/day: ~10B, i.e. ~10% of traffic. WhatsApp publicly reported
                    4.5B photos + 1B videos against 55B messages in 2017,
                    so ~10% is the ratio to scale from.
Media size avg:     200KB blended, after client-side compression
Storage/day:        100B × 100 B    = 10TB text/day
                    10B × 200KB     = 2PB media/day
Groups:             2B users × 20 groups each = 40B group memberships
```

The connection count is the most infrastructure-defining number. At 500 million concurrent WebSocket connections, you need approximately 1,000 servers each handling 500,000 connections. Each connection consumes roughly 10KB of kernel memory for the TCP socket buffer, plus application-level state, totaling about 5GB of memory per server just for connection overhead. The message throughput of 1.16 million per second on average, and two to three times that at peak, eliminates any single-writer database from consideration, pointing toward Cassandra's distributed, leaderless write architecture. Media dwarfs text by two orders of magnitude: 2 petabytes per day against 10 terabytes of text, or roughly 730 petabytes per year. That gap is the whole reason media never touches the message store. Blobs go to object storage (S3 or GCS) with lifecycle policies tiering older media to colder classes, and the message row carries only a pointer and a decryption key.

---
