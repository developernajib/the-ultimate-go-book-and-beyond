## 81.6 Deep Dive Topics

### Database Selection

Choosing the right database for each component is one of the most consequential system design decisions. Interviewers expect candidates to justify their selection based on the data access patterns, consistency requirements, and scaling characteristics of each subsystem. The guide below maps database categories to their strengths and typical use cases.

```
┌─────────────────────────────────────────────────────────────────┐
│                    DATABASE SELECTION GUIDE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Relational (PostgreSQL, MySQL):                                │
│  + ACID transactions                                            │
│  + Complex queries, JOINs                                       │
│  + Strong consistency                                           │
│  Use for: Financial data, user accounts, order management       │
│                                                                 │
│  Document (MongoDB, CouchDB):                                   │
│  + Flexible schema                                              │
│  + Nested documents                                             │
│  + Horizontal scaling                                           │
│  Use for: Content management, catalogs, user profiles           │
│                                                                 │
│  Key-Value (Redis, DynamoDB):                                   │
│  + Ultra-fast reads/writes                                      │
│  + Simple data model                                            │
│  + Easy partitioning                                            │
│  Use for: Caching, sessions, real-time leaderboards             │
│                                                                 │
│  Wide-Column (Cassandra, HBase):                                │
│  + Write-optimized                                              │
│  + Linear scalability                                           │
│  + High availability                                            │
│  Use for: Time series, IoT, analytics                           │
│                                                                 │
│  Graph (Neo4j, Neptune):                                        │
│  + Relationship traversal                                       │
│  + Complex connections                                          │
│  Use for: Social networks, recommendations, fraud detection     │
│                                                                 │
│  Search (Elasticsearch):                                        │
│  + Full-text search                                             │
│  + Aggregations                                                 │
│  Use for: Log analysis, product search, analytics               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### CAP Theorem in Practice

The CAP theorem states that a distributed system can satisfy at most two of Consistency, Availability, and Partition Tolerance simultaneously, and understanding this trade-off is a prerequisite for any distributed systems discussion in a senior engineering interview. The table below maps real systems to their CAP position, etcd and ZooKeeper as CP examples, Cassandra and DynamoDB as AP, giving candidates concrete examples to anchor their discussion rather than speaking in abstractions.

```
CAP: Consistency, Availability, Partition Tolerance
- In a network partition, choose C or A (can't have both)

┌────────────────┬────────────────┬────────────────┐
│      CP        │      AP        │      CA        │
├────────────────┼────────────────┼────────────────┤
│ Consistency    │ Availability   │ Not possible   │
│ + Partition    │ + Partition    │ in distributed │
│ Tolerance      │ Tolerance      │ systems        │
├────────────────┼────────────────┼────────────────┤
│ PostgreSQL     │ Cassandra      │ Single-node    │
│ HBase          │ CouchDB        │ PostgreSQL     │
│ MongoDB        │ DynamoDB       │                │
│ (default)      │ (default)      │                │
├────────────────┼────────────────┼────────────────┤
│ Use for:       │ Use for:       │                │
│ Banking        │ Social media   │                │
│ Inventory      │ Metrics        │                │
│ Reservations   │ Shopping cart  │                │
└────────────────┴────────────────┴────────────────┘

PACELC extension:
If Partition: choose Availability or Consistency
Else: choose Latency or Consistency

Example: DynamoDB is PA/EL
- During partition: Available
- Else: Low latency (eventual consistency by default)
```

---

### Junior → FAANG: Deep Dive Topics as the Interview's Second Half

The deep dive phase of a system design interview is where junior candidates most often run out of material. The first half (requirements and high-level design) can feel familiar from practice, but when the interviewer says "let's go deeper on your database choice," candidates who have only surface-level knowledge of the options hit a wall.

Preparation approach: for each database category in this section (SQL, wide-column, document, key-value, time-series, graph), know: one representative system (PostgreSQL, Cassandra, MongoDB, Redis, InfluxDB, Neo4j), the canonical use case, and one concrete production scale (e.g., "Cassandra handles 1M writes per second at Apple's scale due to its LSM-tree storage engine and lack of a coordinator bottleneck"). This one-representative-system-per-category approach is manageable and covers 95% of interview scenarios.

CAP theorem entry-level framing: understand that in a real distributed system, partition tolerance is mandatory (networks do fail), so the real choice is between consistency and availability during a partition. CP systems (like Zookeeper for configuration management) reject writes during a partition to maintain consistency. AP systems (like Cassandra) accept writes during a partition and reconcile afterward. Know one concrete example of each.

### Senior @ FAANG: Database Selection as a Multi-Dimensional Architecture Decision

At senior level, database selection is not a choice between SQL and NoSQL. It is a multi-dimensional decision that includes: data model fit, access pattern fit, consistency requirements, operational complexity, team expertise, total cost of ownership, and future flexibility. A senior candidate who reaches for Cassandra because "it scales well" without discussing the data modeling constraints (no joins, denormalization required, partition key selection is critical) and the operational overhead (tuning GC, managing compaction, monitoring SSTables) is operating at the L4 level.

The CRDT (Conflict-free Replicated Data Type) mention in this section is a bar-raiser signal. CRDTs are the theoretical foundation for how systems like Riak, Cassandra (with LWW disabled), and Redis CRDT handle concurrent writes without coordination. A candidate who can explain why a CRDT counter converges correctly across replicas without locking, and give a concrete use case (view counts, like counts, shopping cart items), is demonstrating the kind of distributed systems depth that distinguishes L5 from L6.

ADR for database selection: at FAANG, major database choices are documented as ADRs reviewed by senior engineers and architects. The ADR format forces explicit documentation of alternatives considered, the decision criteria, and the trade-offs accepted. Demonstrating this decision-making discipline in an interview (by voluntarily discussing two or three alternatives before committing to a choice) signals that you operate at the level where your decisions need to be reviewed and justified to other senior engineers.
