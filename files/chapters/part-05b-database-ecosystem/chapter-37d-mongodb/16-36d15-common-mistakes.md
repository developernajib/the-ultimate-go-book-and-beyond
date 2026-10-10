## 37D.15 Common Mistakes

### 1. Unbounded Array Growth

Embedding arrays that grow without bound (comments, events, log entries) eventually hits MongoDB's 16 MB document limit, causing inserts to fail and degrading index performance long before that limit is reached. The fix is to move unbounded subdocuments to a separate collection and maintain a count cache on the parent document.

```go
// BAD: comments array can grow to millions
type Post struct {
	ID       bson.ObjectID `bson:"_id"`
	Comments []Comment     `bson:"comments"` // document grows indefinitely
}

// Document limit is 16MB - unbounded arrays will hit it and degrade performance

// GOOD: separate collection with reference + count cache
type Post struct {
	ID           bson.ObjectID `bson:"_id"`
	CommentCount int           `bson:"comment_count"` // cached count
	// first N comments for display
	TopComments  []Comment     `bson:"top_comments"`
}
// Full comments in separate collection
```

### 2. Missing Index for Sort

A sort without a supporting index forces MongoDB to load the entire matched set into memory and sort it there. MongoDB enforces a 100 MB in-memory sort limit that aborts the query (error 292) when exceeded unless `allowDiskUse` is set. Creating a compound index that covers both the filter fields and the sort field eliminates the in-memory sort entirely.

```go
// BAD: sort without index causes full collection scan + in-memory sort (100MB limit)
filter := bson.D{{Key: "status", Value: "active"}}
opts := options.Find().SetSort(bson.D{{Key: "created_at", Value: -1}})
// Without index on {status:1, created_at:-1}, this is O(n)

// GOOD: create compound index covering both filter and sort
// db.orders.createIndex({ status: 1, created_at: -1 })
```

### 3. Ignoring Write Concern in Replica Sets

With the default `w:1` write concern, a write is acknowledged by the primary before it replicates to any secondary. If the primary crashes immediately after acknowledging, that data is lost during failover. Setting `writeconcern.Majority()` at the client level ensures the write is durable on a quorum of nodes before returning.

```go
// BAD: default write concern (w:1) - primary only, data loss on failover
coll.InsertOne(ctx, doc) // if primary crashes before replication: data lost

// GOOD: majority write concern for financial/critical data
opts := options.InsertOne().
    SetComment("financial-transaction")
// Set at client level: writeconcern.Majority()
```

### 4. ObjectID Generation in Application vs Database

Letting MongoDB generate the `_id` server-side means the application does not know the document's identity until after the round trip, making idempotent retries impossible. Generating `bson.NewObjectID()` in the application before insert allows the operation to be safely retried. A duplicate key error simply means the first attempt succeeded.

```go
// BAD: letting MongoDB generate the ID - you don't know it until after insert
result, _ := coll.InsertOne(ctx, bson.M{"name": "Alice"})
id := result.InsertedID // need this for subsequent operations

// GOOD: generate ObjectID before insert - enables idempotent inserts
id := bson.NewObjectID()
doc := User{BaseDocument: BaseDocument{ID: id}, Name: "Alice"}
coll.InsertOne(ctx, doc)
// Can retry insert safely - duplicate key error means first attempt succeeded
```

### 5. N+1 Problem with Manual Lookups

Fetching a list of orders and then issuing a separate `FindOne` per order to load the associated user results in N+1 round trips that compound latency with collection size. Replacing the loop with a single `$lookup` aggregation pipeline lets MongoDB resolve the join server-side in one query.

```go
// BAD: N+1 queries - one query per order to get user
orders, _ := ordersColl.Find(ctx, filter)
for _, order := range orders {
    user, _ := usersColl.FindOne(ctx, bson.D{{Key: "_id", Value: order.UserID}})
    // process user + order
}

// GOOD: $lookup aggregation - single query
pipeline := mongo.Pipeline{
    {{Key: "$lookup", Value: bson.D{
        {Key: "from", Value: "users"},
        {Key: "localField", Value: "user_id"},
        {Key: "foreignField", Value: "_id"},
        {Key: "as", Value: "user"},
    }}},
}
```

### 6. Schema Validation Not Enforced

Without collection-level JSON Schema validation, any document shape can be inserted. Typos in field names, missing required fields, or wrong BSON types silently corrupt the dataset. Attaching a `$jsonSchema` validator to the collection definition enforces required fields and type constraints at the database layer, independent of the application.

```go
// BAD: no validation - any document can be inserted
coll.InsertOne(ctx, bson.M{"random": "data"})

// GOOD: JSON Schema validation at collection level
validator := bson.D{
    {Key: "$jsonSchema", Value: bson.D{
        {Key: "bsonType", Value: "object"},
        {Key: "required", Value: bson.A{"name", "email", "created_at"}},
        {Key: "properties", Value: bson.D{
            {Key: "email", Value: bson.D{
                {Key: "bsonType", Value: "string"},
                {Key: "pattern", Value: `^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`},
            }},
        }},
    }},
}
db.CreateCollection(ctx, "users", options.CreateCollection().SetValidator(validator))
```

### Junior to FAANG: The Mistake Ladder and How to Defend Against It in Your First Year

The six mistakes above are the visible surface. Junior engineers fail production for a more specific catalog. Learn this list as the first-year smoke test.

1. No shard key chosen before a collection crosses one hundred GB. By the time you realize you need to shard, resharding exists in 8.0 but still takes days and burns IOPS. The reflex: when a collection is projected to exceed fifty GB in twelve months, open a shard-key ADR, not a ticket.
2. `retryWrites` disabled on the connection string. The official driver enables this by default, but a copy-pasted URI from a legacy service may set `retryWrites=false`. Without retryable writes, a primary step-down loses an in-flight insert and the application sees a network error it cannot safely retry. Always grep your repo for `retryWrites=false` in a first-week audit.
3. Projection omission. `Find` without `SetProjection` returns the entire document. On a 200 KB profile document, a feed query that needs only three fields wastes 99 percent of the wire budget. Build a linter rule: any `Find` without a projection on a collection with average document size greater than 2 KB is a PR blocker.
4. Using `$regex` without an anchored prefix. `/alice/i` is a collection scan. `/^alice/` with an index on the field is a range scan. Case-insensitive regex cannot use a standard index unless you build a case-insensitive collation index.
5. Reading from secondaries for read-your-writes flows. `readPreference: secondaryPreferred` on a write-then-read path returns stale data because replication is asynchronous. The correct pattern is `readConcern: "majority"` on the write followed by reads from primary, or causal consistency sessions (`client.StartSession()` with `CausalConsistency(true)`).
6. `w:1` on a payments collection. This is a resume-reducing mistake. If you own the write path for money, the review must check for `writeconcern.Majority()` and `journaled=true`. Flag this in every code review on a payments repo, every time.
7. Transactions that span four or more collections. MongoDB supports multi-document transactions but the commit path acquires two-phase locks. A transaction touching many collections amplifies contention and hurts tail latency. The reflex: if the transaction body is longer than ten lines, redesign the data model.

Worked example. You are asked to add a "last seen" timestamp to every user on every request. A junior writes `UpdateOne(ctx, {_id}, {$set: {last_seen: now}})` per request. At 10k requests per second this is 10k WiredTiger writes per second per user-heavy host, driving checkpoint stalls. The correct design is in-memory aggregation with a flush every minute, or a `$setOnInsert` plus an hourly batch. The interview-ready framing is "write amplification" which is the phrase senior engineers use when reviewing your PR.

"Why did this fail?" reflex. When a Mongo incident hits, run this checklist mentally before opening a dashboard: did we hit the 16 MB document limit, did we hit the 100 MB in-memory sort limit without `allowDiskUse`, did a primary step down while `retryWrites=false`, did a missing index trigger a COLLSCAN and saturate the WiredTiger cache, or did a dual-write diverge from the change-stream derived sink. Nine out of ten incidents are in this list.

Interview entry point. A standard L4 question: "give me three MongoDB antipatterns you have seen in code review". The expected answers are unbounded arrays, missing shard key, and `w:1` on critical writes. Naming `retryWrites=false` and projection omission pushes the scoring upward.

### Senior at FAANG: Mistake Governance, Review Gates, and Postmortem Templates

At staff and principal level, the job is to make these mistakes impossible, not to spot them. The lever is a review gate, a CI lint, or an Atlas policy, never a wiki page.

1. Unbounded array governance. Write an ADR that caps array cardinality at a number defensible in a cost model, typically one thousand elements. Implement a schema linter that parses every Go struct tagged `bson:"..."` and flags `[]T` fields without a documented bound. The linter runs in CI. Teams wanting an exception file an ADR with capacity math attached. Meta's internal Mongo usage in the MongoRocks era had a similar policy and it prevented a class of on-call incidents.
2. Shard-key review board. Every new sharded collection ships with a shard-key ADR covering: cardinality, write distribution histogram simulated against a week of production access logs, read access patterns with targeted vs scatter-gather ratio, and an exit plan (reshard, split collection, or tombstone). The board is chaired by a principal engineer. A shard key ADR that proposes a monotonically increasing key, such as `_id: 1` or a timestamp, is rejected on sight because it funnels all writes to a single shard.
3. Write concern policy. At L4 and above, `w:"majority"` plus `j:true` is the floor for any write that is legally or financially material. Enforce this in a driver wrapper that reads a per-collection policy file at startup and refuses to run if a critical collection is configured with `w:1`. The wrapper is mandatory for services under SOX, PCI, or GDPR scope.
4. Index governance. Atlas Performance Advisor plus a weekly `indexStats` report. Unused indexes cost both disk and write amplification (each write updates every index). The weekly job lists indexes with `accesses.ops == 0` over seven days and raises a PR to drop them. Indexes older than ninety days with zero access are auto-dropped after a second review. This policy saves serious IOPS at fleet scale.
5. Schema lint in CI. Build a lint that parses `$jsonSchema` validators, Go structs with bson tags, and migration files. It enforces: required fields present on every insert path, no optional enum fields without a default, no `interface{}` in critical documents, and every collection has `createdAt` and `updatedAt` unless an ADR exempts it. This is a code-review-killer in a good way.
6. Dual-write ban. A staff-level edict: no service writes to two data stores from application code. If a downstream system needs Mongo data, it consumes the change stream via Debezium to Kafka. This single policy eliminates a class of "the cache and the database disagree" postmortems. Document the exceptions explicitly in an ADR.
7. Postmortem template. Every MongoDB incident includes: the slow-query log excerpt, the `explain` output from the offending query with `executionStats`, the `oplog` position at incident time, the WiredTiger cache pressure metric, the shard balancer state, and a root-cause classification from a fixed taxonomy (shard hot spot, index missing, document-size blow-up, replication lag, transaction conflict, driver misconfiguration, human error). Fixed taxonomy is what turns postmortems into fleet-level metrics you can actually drive down.

Maturity model note. At L3 teams have none of these gates. At L4 they have CI lints. At L5 they have a platform layer that refuses to deploy a service violating any of the above. The principal engineer's job is to write the first draft of each ADR and socialise it until it becomes table stakes.

---
