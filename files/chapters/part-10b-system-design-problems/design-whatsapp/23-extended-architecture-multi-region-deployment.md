## Extended Architecture: Multi-Region Deployment

For a global user base, a single-region deployment would cause unacceptable latency for users far from the data center. Multi-region deployment solves this by placing a complete stack (connection servers, chat service, databases, and media storage) in each major geographic region, and steering each user to the nearest one.

Two words worth using precisely, because they are routinely swapped. **Anycast** is a network-layer technique: the same IP address is advertised from many locations over BGP, and the internet's routing fabric delivers each packet to whichever site is closest in network terms. **GeoDNS** is a resolution-layer technique: the DNS server inspects the resolver's location and hands back a different, region-specific address. Anycast reconverges in seconds when a region dies and needs no client cooperation, but gives you little control and can rehome a live TCP flow if routes shift, which is unpleasant for connections meant to last hours. GeoDNS gives precise control and stable per-region addresses, at the cost of DNS caching, so failover waits out TTLs. Long-lived WebSockets generally favour GeoDNS for steering plus anycast for the stateless edge. "Anycast DNS", strictly, describes anycasting the DNS servers themselves, which is a third thing.

**Where does a cross-region conversation live?** This is the question that decides the design, and the diagram's "each region is self-contained" only holds for conversations whose participants share a region. Alice in the US messaging Bob in the EU belongs to neither. Three answers, and you must pick one:

- **Home region per conversation.** The `conv_id` deterministically maps to an owning region, which stores the authoritative history. Reads by the remote participant cross regions and pay the latency. Simple and consistent, but Bob's chat history loads slowly forever.
- **Cassandra multi-DC replication.** `NetworkTopologyStrategy` replicates the keyspace to both regions, each side reads locally at `LOCAL_QUORUM`, and Cassandra reconciles asynchronously. This is the mechanism actually built for this problem, and it is a better fit for message *data* than shipping rows over Kafka. The cost is cross-region replication traffic and last-write-wins conflict resolution, which is tolerable here because messages are immutable and keyed by a unique TimeUUID: two writers never contend for the same row.
- **Replicate only what is needed.** Kafka MirrorMaker carries delivery *events* between regions for real-time push, while the durable history stays in the owning region.

The pragmatic build combines the last two: MirrorMaker for the latency-sensitive delivery event, multi-DC Cassandra for the durable record. Note that immutability is what makes this comfortable. Multi-master replication is agony when rows are mutable and contended, and nearly free when every row is written exactly once by one author.

Data residency complicates all of it. If regulation requires a user's data to stay in-region, then a cross-region conversation cannot be fully replicated to both sides, and the home-region model wins by default regardless of latency. This is one of the places where a legal constraint, not an engineering one, picks the architecture.

```
                    ┌──────────────────┐
                    │  GeoDNS steering │
                    │  (+ anycast at   │
                    │   the edge)      │
                    └──────┬───────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  US Region   │ │  EU Region   │ │  AP Region   │
   │              │ │              │ │              │
   │  Conn Svrs   │ │  Conn Svrs   │ │  Conn Svrs   │
   │  Chat Svc    │ │  Chat Svc    │ │  Chat Svc    │
   │  Redis       │ │  Redis       │ │  Redis       │
   │  Cassandra   │ │  Cassandra   │ │  Cassandra   │
   │  Kafka       │ │  Kafka       │ │  Kafka       │
   │  S3 (media)  │ │  S3 (media)  │ │  S3 (media)  │
   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
          │                │                │
          └────────────────┼────────────────┘
                           ▼
        Kafka MirrorMaker (delivery events, low latency)
        Cassandra NetworkTopologyStrategy (durable history)

Message routing:
  - Sender in US, Recipient in EU
  - Message written to US Cassandra at LOCAL_QUORUM (fast local ack)
  - Cassandra replicates the row to the EU DC asynchronously
  - Kafka MirrorMaker carries the delivery event to EU immediately,
    so the push does not wait on replication
  - EU chat service delivers to the recipient's connection
  - Read receipt flows back the same way, in reverse

Each region is self-contained for conversations whose participants
share a region. A cross-region conversation is replicated to both,
so each side still reads its own history locally.
```

---
