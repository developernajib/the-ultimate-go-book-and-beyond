## 37D.1 MongoDB Architecture & Document Model

### The Document Model

MongoDB stores data as BSON (Binary JSON) documents, enabling flexible schemas that map naturally to Go structs. Unlike relational databases, related data is often embedded within a single document - reducing joins and improving read performance.

```
MongoDB Architecture
═══════════════════════════════════════════════════════════════════

  ┌──────────────────────────────────────────────────────────┐
  │                    MongoDB Cluster                       │
  │                                                          │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
  │  │   mongos     │  │   mongos     │  │  Config SVR  │    │
  │  │  (Router)    │  │  (Router)    │  │  Replica Set │    │
  │  └──────┬───────┘  └──────┬───────┘  └──────────────┘    │
  │         │                  │                             │
  │    ┌────▼──────────────────▼────┐                        │
  │    │        Shard Cluster       │                        │
  │    │  ┌──────────┐ ┌─────────┐  │                        │
  │    │  │ Shard 1  │ │ Shard 2 │  │                        │
  │    │  │ RS: P S S│ │ RS:P S S│  │                        │
  │    │  └──────────┘ └─────────┘  │                        │
  │    └────────────────────────────┘                        │
  └──────────────────────────────────────────────────────────┘

  Document Model:
  ┌────────────────────────────────────────────────────────┐
  │  {                                                     │
  │    "_id": ObjectId("..."),                             │
  │    "name": "Alice",                                    │
  │    "orders": [          ← Embedded array               │
  │      { "item": "Book", "qty": 2 },                     │
  │      { "item": "Pen",  "qty": 10 }                     │
  │    ],                                                  │
  │    "address": {         ← Embedded document            │
  │      "city": "NYC", "zip": "10001"                     │
  │    }                                                   │
  │  }                                                     │
  └────────────────────────────────────────────────────────┘

  WiredTiger Storage Engine:
  ┌──────────────────────────────────────┐
  │  Document → BSON → B-Tree pages      │
  │  Compression: Snappy/zlib/zstd       │
  │  Journal: WAL for durability         │
  │  Cache: 50% of RAM (default)         │
  └──────────────────────────────────────┘
```

### WiredTiger Internals

WiredTiger is MongoDB's default storage engine since v3.2. Key characteristics:
- **Document-level locking**: concurrent reads/writes on different documents
- **MVCC**: snapshot isolation for consistent reads
- **Compression**: snappy by default for collections (zstd is the default for time-series collections) - zlib and zstd are opt-in for better ratios (up to 3-5x space savings)
- **Block cache**: configurable, defaults to 50% of (RAM - 1 GB) or 256 MB, whichever is larger
- **Journal**: write-ahead log synced every 100ms (or per-write if `j:true`)
- **Checkpoints**: dirty pages flushed every 60 seconds or when journal hits 2 GB

### MongoDB Version Landscape (2026)

- **8.0** (GA October 2024) - current stable: 36% higher read throughput, 59% faster bulk writes, 200% faster time-series aggregations, queryable encryption with range queries ($gt/$lt/$gte/$lte on encrypted fields), up to 50x faster shard data distribution
- **7.0** LTS - production-supported, safe default if 8.0 adoption is premature in your organization
- **6.0** LTS - receives only critical security fixes. Upgrade planning should be underway
- **5.0 and earlier** - end of life. Do not deploy

### Time-Series Collections (5.0+)

Time-series collections store many small documents (sensor readings, metrics, trading ticks) using columnar internal layout, cutting disk footprint by 70 percent and accelerating range aggregations by an order of magnitude versus regular collections. Declared at create-collection time with `timeseries` options. They cannot be sharded arbitrarily and have specific update/delete restrictions pre-7.0.

```go
// Create a time-series collection (run once, ideally in migrations)
opts := options.CreateCollection().SetTimeSeriesOptions(
    options.TimeSeries().
        SetTimeField("ts").         // required: BSON Date field
        SetMetaField("sensor_id").  // optional: grouping key for buckets
        SetGranularity("seconds"),  // seconds | minutes | hours
)
if err := db.CreateCollection(ctx, "sensor_readings", opts); err != nil {
    return err
}
```

### Queryable Encryption (6.0+, Expanded in 8.0)

Queryable Encryption encrypts sensitive fields client-side before they ever reach the server, using a deterministic scheme that still supports server-side queries. Equality queries landed in 6.0. MongoDB 8.0 adds range queries on encrypted numeric and date fields. The encryption keys never leave the client, which means a compromised server or a malicious DBA cannot recover the plaintext. This is the correct mechanism for PII, payment identifiers, and medical record fields in regulated workloads. regular TLS-in-transit plus disk-at-rest encryption does not achieve the same threat model.

### BSON Types and Go Mapping

Every BSON type has a direct Go counterpart. The `bson` struct tags control how fields are encoded and decoded, following the same conventions as `encoding/json`. The `omitempty` option excludes zero-value fields from the stored document, and pointer types like `*time.Time` distinguish between "not set" (nil, omitted) and "set to zero value."

```go
// go.mod
// require go.mongodb.org/mongo-driver/v2 v2.0.0

package mongodb

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// BSON type mapping examples
type BSONTypes struct {
	// ObjectID - 12-byte unique identifier
	ID bson.ObjectID `bson:"_id,omitempty"`

	// String
	Name string `bson:"name"`

	// Int32 / Int64
	Age   int32 `bson:"age"`
	Score int64 `bson:"score"`

	// Float64
	Rating float64 `bson:"rating"`

	// Boolean
	Active bool `bson:"active"`

	// Date (stored as milliseconds since epoch)
	CreatedAt time.Time `bson:"created_at"`
	UpdatedAt time.Time `bson:"updated_at"`

	// Array
	Tags []string `bson:"tags"`

	// Embedded document
	Address Address `bson:"address"`

	// Null / omitempty
	DeletedAt *time.Time `bson:"deleted_at,omitempty"`

	// Raw BSON for dynamic fields
	Metadata bson.M `bson:"metadata,omitempty"`

	// Decimal128 for financial data
	Price bson.Decimal128 `bson:"price,omitempty"`
}

type Address struct {
	Street string `bson:"street"`
	City   string `bson:"city"`
	State  string `bson:"state"`
	Zip    string `bson:"zip"`
	Coords GeoPoint `bson:"coords,omitempty"`
}

type GeoPoint struct {
	Type        string    `bson:"type"`        // "Point"
	Coordinates []float64 `bson:"coordinates"` // [longitude, latitude]
}
```

### Junior → FAANG: reading the architecture picture

The cluster diagram above looks intimidating, but most production services only interact with two layers: the driver on the client side and a replica set or sharded cluster on the server side. For a first job, the mental model you need is this. A replica set is a group of three or more `mongod` processes. One is the primary and accepts writes. The others replicate the oplog and can serve reads if you configure `readPreference` accordingly. If the primary fails, the remaining members elect a new primary within about ten seconds. A sharded cluster is a federation of replica sets fronted by a `mongos` router. Sharding is a scale-out answer, not a high-availability answer. Replica sets give you HA. Sharding adds horizontal throughput at the cost of query complexity.

The WiredTiger internals matter in exactly one scenario during your first year: when a query feels slow, check whether the working set fits in the cache. If your data is fifty gigabytes and the cache is eight, every query that touches cold data pays a disk seek. The junior fix is almost always "add an index so only the hot pages are read" rather than "buy more RAM." Use `db.collection.explain("executionStats")` in the mongo shell, or in Go pass `options.Find().SetExplain(...)` when debugging.

The BSON-to-Go mapping in the code block is the single most copied snippet in MongoDB Go projects. Memorize it. The only two gotchas for a junior: `bson:"_id,omitempty"` is required on the ID field so that inserts without an ID let the server generate one, and `time.Time` fields always serialize with millisecond precision because BSON dates are sixty-four-bit milliseconds since the epoch. If you need nanosecond precision, store an additional `int64` nanos field.

Interview entry-point questions: "What is the oplog?" (a capped collection on every replica set member that records every write, used for replication and change streams), "What is the default read preference?" (primary), and "Why does `omitempty` matter on `_id`?" (so that the server's `ObjectID` generation triggers for new inserts instead of attempting to insert a zero-value ID, which would fail as a duplicate).

### Senior @ FAANG: architectural trade-offs and the 2026 feature surface

Staff-level architecture work starts with picking the topology. Three-node replica set is the default for most services, but the quorum math matters: a five-node set tolerates two failures and is the right choice for stateful services with strict RPO requirements, while a hidden member with `priority:0` is the canonical pattern for offline analytics without affecting primary election. Arbiters are almost always the wrong answer in 2026. They save hardware cost but degrade durability guarantees because they cannot hold data, so a failover after a data-bearing member crash leaves only one data-bearing copy until recovery. Use full data-bearing members and size the hardware down if cost is the concern.

Sharding decisions are driven by two limits: working set exceeding available RAM across the largest feasible single-machine deployment, and write throughput exceeding the oplog's sustainable rate on a single primary. The shard key is the most consequential design decision in the lifetime of a MongoDB cluster, and it is effectively immutable before 5.0 and expensive to change after (`reshardCollection` exists but is an online migration with its own cost model). The three failure modes are monotonically increasing shard keys (every write lands on the last chunk, creating a hotspot), low-cardinality keys (chunks cannot split), and keys that do not align with the query pattern (every query becomes a scatter-gather across all shards). Hashed shard keys solve the hotspot but defeat range queries. Compound shard keys with a hashed prefix and a natural suffix often hit the sweet spot.

WiredTiger tuning in 2026 is mostly about compression and checkpoint cadence. Zstd compression, available since 4.2 and the default for time-series collections, delivers better ratios than the snappy default at comparable CPU for mixed workloads, so enabling it for regular collections is a deliberate per-collection choice. For write-heavy workloads, lower the compression level to trade CPU for write throughput. The cache eviction thread count (`wiredTigerConcurrentWriteTransactions` and its read equivalent) is an underused lever on large instances. On a 128 GB machine with 64 cores, the default of 128 concurrent transactions can bottleneck write-heavy services. Raise it cautiously with benchmarks. Journal compaction and checkpoint tuning rarely need manual intervention outside of very high-throughput time series ingestion paths.

MongoDB 8.0 features that change staff-level design. Queryable encryption with range support means the ADR for a PII-bearing service no longer has to choose between "encrypt and lose queryability" and "leave plaintext." The key rotation story uses a Key Management Service (AWS KMS, Azure Key Vault, GCP KMS, or a local keyfile for dev) and a per-field Data Encryption Key derived from a Customer Master Key. Rotation cadence is typically annual for CMKs and quarterly for DEKs in regulated workloads, with `rewrapManyDataKey` used to rotate without re-encrypting the underlying documents. Time series collections with `bucketMaxSpanSeconds` and `bucketRoundingSeconds` (both 6.3+) let you control the bucket granularity independently of the declared granularity string, which is essential for workloads with irregular sample rates. Columnstore indexes (Atlas only) accelerate analytical queries over time series collections by storing measurements in a columnar layout, and are worth evaluating whenever an aggregation reads a small subset of fields across many documents.

For a staff-level ADR on MongoDB topology, document: the replica set size and voting topology, the shard key choice with cardinality and access-pattern analysis, the compression codec, the journal commit interval (`journalCommitIntervalMs`), the read and write concerns per API surface, the failover target RTO and RPO, and the observability baseline (OTEL command spans, the metrics scraped from `serverStatus` and `currentOp`, and the alerting thresholds on replication lag, oplog window, and primary step-downs). That document is the staff deliverable, not the code.

---
