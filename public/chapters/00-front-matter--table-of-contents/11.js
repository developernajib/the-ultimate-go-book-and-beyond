export default `## Part X: System Design

*Fundamentals, distributed patterns, real company designs, and 20 production-scale problem walkthroughs*

### Core System Design

| Chapter | Title | Focus |
|---------|-------|-------|
| 58 | System Design Fundamentals | Scalability, reliability, availability, CAP theorem, scaling 1 server to millions, database selection framework, interview playbook |
| 59 | Distributed System Patterns | Consensus, replication, partitioning, vector clocks |
| 60 | Design: URL Shortener | Consistent hashing, redirect strategies |
| 61 | Design: Rate Limiter | Token bucket, Redis Lua, distributed limiting |
| 62 | Design: Notification System | Push, email, SMS at scale, fan-out |
| 63 | Design: Distributed Cache | Consistent hashing, eviction, replication |
| 64 | Design: Message Queue | Kafka-like system, durability, ordering |
| 65 | Real Company Designs | How tech giants architect their systems |
| 65B | Distributed Consensus | Raft, Paxos, ZooKeeper, etcd |
| 65C | Capacity Planning | Estimation, cost modeling, auto-scaling |
| 65D | Advanced Consistency & Replication | CRDTs, vector clocks, HLCs, quorum systems |
| 65E | Distributed Primitives | Gossip, consistent hashing deep dive, fencing tokens |
| 65F | Multi-Region Architecture | Active-active, data replication, global load balancing |
| 65G | Disaster Recovery & Resilience | RPO/RTO, backup strategies, GameDay exercises |

### System Design Problems (20 Production-Scale Walkthroughs)

| Problem | Key Concepts |
|---------|-------------|
| Instagram / TikTok | Feed generation, media storage, CDN, recommendation engine |
| Twitter / X | Fan-out on write vs read, timeline, trending, celebrity problem |
| YouTube / Netflix | Video transcoding, adaptive bitrate, CDN, recommendation |
| Uber / Lyft | Geospatial indexing, driver matching, real-time tracking, ETA |
| WhatsApp | Real-time messaging, E2E encryption (Signal Protocol), presence |
| Google Search | Web crawler, inverted index, BM25 + PageRank, serving |
| Google Docs | Operational Transform, real-time collaboration, CRDT alternative |
| Payment System | Distributed transactions, idempotency, fraud detection, reconciliation |
| Dropbox | File chunking, delta sync, content-addressed storage, conflict resolution |
| Airbnb | Search, availability holds, two-phase booking, pricing |
| Spotify | Audio streaming, ALS collaborative filtering, Discover Weekly |
| Autocomplete | Trie, Redis sorted sets, trending detection, personalization |
| Web Crawler | Bloom filter dedup, SimHash near-duplicate, domain politeness |
| Metrics Platform | ClickHouse, time-series, stream aggregation, alert engine |
| Food Delivery | Order state machine, driver dispatch, H3 hex surge pricing |
| Stock Exchange | In-memory order book, price/time priority, WAL, market data |
| Zoom | SFU vs MCU, simulcast, WebRTC DTLS-SRTP, adaptive bitrate |
| Ad System | OpenRTB, second-price auction, budget pacing, frequency capping |
| Ticket Booking | Virtual queue, Redis Lua seat hold, QR barcodes, oversell prevention |
| LLM Serving | Continuous batching, KV cache, speculative decoding, GPU auto-scaling |

---
`;
