## 37D.14 Company Case Studies

### eBay: Product Catalog at Scale

eBay uses MongoDB to store 1.5 billion+ product listings. Key patterns:
- **Flexible schema**: different product categories have vastly different attributes (electronics vs clothing vs collectibles), and MongoDB's dynamic schema handles this elegantly without NULL columns
- **Attribute search**: compound indexes on `{category: 1, attributes.brand: 1, price: 1}` for faceted search
- **Sharding**: shard by `{category: "hashed"}` for even distribution. Use category+price for range queries within a category
- **Write scaling**: very high listing write rates during peak surges. Write to primary, read from secondaries with `readPreference: secondaryPreferred`

### Forbes: Content Management

Forbes migrated from Oracle to MongoDB for its CMS. Key architectural decisions:
- **Article versioning**: bucket pattern stores up to 50 revisions per article document, older revisions moved to archive collection
- **Multi-language**: single document stores `{en: {title, body}, es: {title, body}, fr: {...}}` - no join needed for localized reads
- **Analytics**: MongoDB Atlas Data Federation queries S3 Parquet files for historical analytics without loading into MongoDB
- **TTL collections**: session data auto-expires with `expireAfterSeconds` index

### Coinbase: Crypto Transaction Ledger

Coinbase uses MongoDB for user portfolio data. Key decisions:
- **Transactions**: multi-document ACID transactions for atomic debit+credit across accounts - critical for financial correctness
- **Write concern**: all financial writes use `{w: "majority", j: true}` - no data loss on failover
- **Immutable audit log**: append-only collection with `validator` that prevents updates/deletes
- **Change streams**: portfolio service subscribes to change stream on `transactions` collection to update user balances in real-time

### MongoDB Atlas: Managed Platform

Atlas provides:
- **Global clusters**: data residency zones for GDPR compliance - EU data stays in EU region
- **Atlas Search**: Lucene-based full-text search, no Elasticsearch needed
- **Vector Search**: native vector embeddings for semantic search and RAG applications
- **Atlas Device Sync**: offline-first mobile apps sync data when online using Realm SDK

### Junior to FAANG: Reading Case Studies as Evidence

A case study is not marketing. It is a distilled incident history. Learn to read each one by asking three questions: what was the failure mode that forced the design, what is the unit economics of the solution, and what would break if traffic grew 10x tomorrow. Below is how a junior engineer should process the four cases above plus the ones seniors are expected to know.

- eBay 1.5 billion listings. The failure mode that forced MongoDB was the relational catalog drowning in sparse columns per category. Read this as a schema flexibility story, not a throughput story. If you are asked "when would you pick MongoDB over Postgres in a junior interview" this is the canonical answer. The 10x stress: faceted search over sparse attributes is what pushed eBay toward Atlas Search plus sharding by hashed category.
- Forbes CMS. The lesson for juniors is the bucket pattern, not the Oracle migration headline. Memorize that a document containing up to 50 revisions is bounded and safe, while a document containing "all revisions forever" is the unbounded-array antipattern that breaks at some tenant scale.
- Coinbase ledger. Memorize three phrases: `w:"majority"`, `j:true`, and multi-document transaction. If you propose `w:1` on a payments write in a junior interview you will not progress. A case study citation here signals that you understand durability is an operational setting, not a default.
- Uber's datastore evolution (Postgres to MySQL, then the Schemaless sharding layer on MySQL, later Docstore). This is the most underread case study by juniors. Uber evaluated MongoDB, Cassandra, and Riak but chose to build Schemaless on MySQL rather than adopt a NoSQL store, wanting document-model flexibility with relational schema enforcement. Later Docstore replaced Schemaless, still on MySQL. The junior-level takeaway is not "MongoDB is bad" but "storage choice is load-pattern dependent, and evaluating then rejecting a datastore is a normal engineering decision". Interviewers use this case to probe whether a candidate understands how products evolve. Separately, early MongoDB 2.x really did have a database-level write lock, since replaced by document-level locking under WiredTiger in 3.0, a reminder that MongoDB 2.x is not MongoDB 8.0.

Worked example of a first-job reflex. Your PM says "let us build a CMS like Forbes on MongoDB". Before writing code you should ask: what is the max revision count per article, what is the p99 document size budget (Mongo limit is 16 MB but the internal budget should be 1 MB), and does editorial need cross-article search. If the answer to the last question is yes you are building Atlas Search plus Mongo, not Mongo alone, and your estimate must reflect that.

Interview entry point. A common L3 question is "name one company using MongoDB in production and describe one specific design decision they made". The candidate who says "Coinbase uses majority write concern plus journaling on the ledger collection because a single lost write is a regulatory event" clearly separates from the candidate who says "eBay uses MongoDB because it scales".

### Senior at FAANG: Case Studies, ADRs, Governance, and the Migration Decision

At staff and principal level, the value of a case study is the ADR you can derive from it and the failure modes it forecloses for your own organization. Below is the extended catalog senior engineers are expected to have internalised, including migrations away from MongoDB, because "when not to use it" is the bar-raiser question.

Bosch IoT. Telemetry at billions of events per day. Architecture: time-series collections introduced in MongoDB 5.0, now default in 8.0, with buckets keyed by `{deviceId, hour}`. Retention via TTL indexes. Cold tier to S3 via Atlas Online Archive. The staff-level lesson is that time-series collections are not general-purpose documents. You cannot update individual measurements efficiently. Your ADR should forbid update patterns on a time-series collection and route any correction path through a separate compensating collection.

Toyota Connected. Connected-vehicle telemetry across regions. Design driven by data residency. Zone sharding with a `region` shard key prefix pins EU data to eu-central mongod instances and JP data to ap-northeast. The ADR to write here covers GDPR article 44, CCPA, and the APPI. Principal engineers own the mapping between a regulatory clause and a shard tag. Without that mapping, you cannot defend the deployment in a privacy audit.

Adobe Experience Platform. Real-time customer profile store. The interesting decision is the dual-write pattern: profile updates go to MongoDB for low-latency reads and to Kafka for downstream stream processors. Dual write is correctness-dangerous. Adobe uses change streams as the source of truth to avoid the two-phase-commit trap. The ADR says: never dual-write from application code, always derive the second sink from the MongoDB change stream via Debezium or Kafka Connect Mongo Source. This is a review gate.

Cisco Webex. Meeting metadata and chat message store. Pattern: per-tenant database isolation with encryption at rest using customer-managed keys. The governance lesson is that at thousands of tenants, per-tenant database isolation costs you in connection pool fan-out and collection count. Cisco's internal playbook caps at roughly ten thousand databases per cluster and bins smaller tenants into a shared pool with a `tenantId` shard key. Principal engineers approve the cut-over threshold.

Meta and MongoRocks. Facebook (now Meta) contributed MongoRocks, a RocksDB-backed storage engine, and used it internally during the WiredTiger early years. The staff-level lesson: pluggable storage engines are a form of polyglot persistence at the engine layer. MongoDB 8.0 ships WiredTiger only in official builds. Anyone still running MongoRocks forks is by definition an outlier and should plan a migration path. The ADR template should include an engine lifecycle clause.

Uber's datastore choice. In 2015 to 2016 Uber migrated core trip data off a single Postgres instance to Schemaless, a sharding layer built on MySQL, after evaluating and rejecting Cassandra, Riak, and MongoDB. They wanted document-model flexibility with relational schema enforcement and preferred MySQL operational expertise. The output was Schemaless (sharded MySQL with a triggers + indexer layer), later evolved into Docstore. For senior engineers, the takeaway is the migration template itself. The Uber team documented: target latency SLO, write amplification budget, online migration via dual-write with shadow reads, and a kill switch. Copy this template. The general lesson about early MongoDB still holds: the 2.x database-level write lock drove some teams off pre-WiredTiger MongoDB, which is why the engine's document-level locking in 3.0 mattered.

Staff-level ADR for "should we use MongoDB". The checklist: is the access pattern document-shaped (nested, sparse, evolving), does the query set fit a small number of indexes (fewer than ten per collection), is the transaction boundary smaller than four collections (multi-doc transaction budget in 8.0 is comfortable but not free), is the team prepared to own shard-key choice forever (you can reshard as of 5.0, but it is a last resort), and what is the exit cost (Debezium change-stream connectors exist, so exit cost is bounded but nonzero). If three or more answers are uncertain, write a Postgres ADR instead and revisit in six months.

Governance. At L5 the platform team publishes a "MongoDB readiness" rubric scored by the requesting team. Scores below a threshold route the team to Postgres or DynamoDB. The rubric is itself an ADR and is revisited annually against the MongoDB release cadence (8.0 queryable encryption, vector search GA, and improved resharding materially changed the calculus in 2024 to 2026).

---
