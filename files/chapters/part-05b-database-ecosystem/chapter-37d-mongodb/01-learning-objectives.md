## Learning Objectives

By the end of this chapter, you will be able to:
- Design MongoDB schemas optimized for Go applications using the document model
- Implement full CRUD operations, aggregation pipelines, and transactions with `go.mongodb.org/mongo-driver`
- Model relationships using embedding vs referencing with real-world trade-off analysis
- Build efficient indexes including compound, sparse, partial, and text indexes
- Implement Change Streams for real-time event-driven architectures in Go
- Configure and manage replica sets and sharded clusters
- Apply MongoDB Atlas search and vector search for AI applications
- Write production-grade Go code with connection pooling, retries, and observability

### Junior → FAANG: what to actually learn first

Treat the objectives above as a two-week ladder rather than a single sprint. Week one is the document model, struct-tag fluency, and the five CRUD methods on `mongo.Collection`. Get comfortable with `bson.D`, `bson.M`, and typed structs, and understand when each is appropriate (`bson.D` for ordered pipelines, `bson.M` for unordered filter literals, typed structs for application code). Build a single-collection CRUD service end to end with proper context propagation and `errors.Is(err, mongo.ErrNoDocuments)` handling. Week two is aggregation pipelines, indexes, and one `$lookup` join against a secondary collection. By the end of week two you should be able to explain the ESR rule (Equality, Sort, Range) for compound index ordering from memory, because it is the most common MongoDB question in screens.

A worked example that ties the objectives together: build a URL shortener in Go with MongoDB. One collection for short codes, one collection for hit events. This forces you to choose between embedding hits in the short-code document (wrong, unbounded) or referencing them (right), to pick a TTL index on hit events for retention, to build an aggregation pipeline that groups hits by day, and to create a unique compound index on `(user_id, short_code)` for multi-tenancy. These four decisions map directly to the chapter's later sections and each is a plausible interview prompt.

### Senior @ FAANG: the objectives behind the objectives

At staff level the objective is not "use MongoDB" but "defend a document-store choice against skeptical peers." The deliverables for a new service should include an ADR that documents the query access pattern, the top three write paths, the embedding-versus-referencing decision with cardinality estimates, the read and write concerns chosen, the index plan with expected selectivity, the retention policy (TTL, archival, or `$merge` into cold storage), and the disaster-recovery posture (Atlas point-in-time restore, or self-hosted snapshot cadence). Every bullet in the junior list above collapses into a single line in that ADR.

Beyond the list, a staff-level curriculum adds: queryable encryption schema design and key rotation cadence, time series collection bucketing parameters and their effect on compression ratios, Atlas Search index definitions versus server-side text indexes (and when Atlas Search is worth the Atlas lock-in), Atlas Vector Search index tuning (HNSW `numCandidates` and `numDimensions` trade-offs), change stream resume token durability and post-image configuration, and the operational runbook for a rolling primary stepdown during driver upgrades. The driver skills list adds OpenTelemetry command monitoring, custom BSON codecs for domain types such as `time.Time` with nanosecond precision or decimal money types via `primitive.Decimal128`, and generic helpers built on top of the v2 driver's typed collection API to eliminate repeated decoding boilerplate across services.

---
