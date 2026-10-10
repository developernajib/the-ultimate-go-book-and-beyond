## Learning Objectives

By the end of this chapter, you will be able to:

- Apply normalization theory pragmatically, knowing when to normalize and when to deliberately denormalize
- Choose the right schema design pattern for semi-structured, polymorphic, temporal, and auditable data
- Execute zero-downtime schema migrations using the expand-and-contract pattern
- Model data correctly for microservices architectures, including cross-service synchronization
- Design and query time-series data efficiently using TimescaleDB, ClickHouse, and native PostgreSQL partitioning
- Represent hierarchical data (categories, org charts, threaded comments) using closure tables and ltree
- Implement full-text search with PostgreSQL tsvector and understand when to reach for Elasticsearch
- Recognize and avoid the most costly data modeling anti-patterns

### Junior → FAANG: Calibrating What "By the End" Means

Read each objective and grade yourself from 0 to 3. Zero means you have never done it. One means you have read about it. Two means you have shipped it in a side project. Three means you have debugged it in production at 2am. For L4 interviews at FAANG, most objectives should sit at 2. For L5, most should sit at 3 with at least one at "I have made the wrong choice once and written the postmortem." If you cannot yet explain why a `user.tags TEXT` column with comma-separated values will eventually break, start there. That single scenario is the most common data-modeling entry-point question in onsite loops. Worked example. A recruiter shows you `CREATE TABLE users (id SERIAL, email TEXT, roles TEXT);` and asks "what is wrong." The L3 answer is "roles should be normalized." The L4 answer adds "the SERIAL leaks row counts to competitors and UUID would be better for external exposure." The L5 answer adds "if roles is queried on every request we may still want a denormalized cache column, but the source of truth must be a `user_roles` junction table with proper foreign keys, and the cache must be reconciled on a schedule."

### Senior @ FAANG: The Objectives Behind the Objectives

At staff level the listed bullets are table stakes. The actual objectives your skip-level will evaluate you on are these. First, can you write an ADR that convinces a skeptical principal to approve a denormalization. That ADR must include the read-to-write ratio, the consistency window you are accepting, the reconciliation mechanism, and the rollback plan if the denormalization proves wrong. Second, can you detect a breaking schema change in a pull request without running the code. That means understanding forward and backward compatibility rules for Protobuf (never renumber fields, never change wire types, never reuse deleted field numbers), Avro (follow resolver rules for default values on added fields), and JSON Schema (additive changes only, `additionalProperties` default matters). `buf breaking` automates most of this for Protobuf, and Confluent Schema Registry and Buf Schema Registry enforce it at merge time. Third, can you design a data contract that survives a team reorg. Tools like data-contract-cli, Great Expectations, and OpenMetadata encode the contract as code with owners, SLAs, and quality tests. Fourth, can you choose between STI (single-table inheritance with a discriminator column) and CTI (class-table inheritance with a row per subclass across multiple tables) for a polymorphic model and defend the choice under adversarial review. STI is simpler and faster for shallow hierarchies with mostly shared columns. CTI is correct when subclasses have mostly distinct columns and you need proper foreign key constraints per subclass. Fifth, and the one most candidates miss, can you argue convincingly that soft delete is usually an anti-pattern. The legitimate use cases are regulatory undelete windows and user-facing "trash" folders. The illegitimate use cases (which is most of them) are "just in case" flags that poison every query with `WHERE deleted_at IS NULL` and every unique index with partial index workarounds. Your job at L6 is to know the difference and hold the line.

---
