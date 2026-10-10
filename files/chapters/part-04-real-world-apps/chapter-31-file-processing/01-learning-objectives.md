## Learning Objectives

By the end of this chapter, you will be able to:

1. **Perform file operations** - Read, write, and manipulate files using Go's io, os, and bufio packages efficiently
2. **Process large files** - Stream gigabyte-sized files without loading them entirely into memory
3. **Work with formats** - Parse and generate CSV, JSON, XML, and binary file formats
4. **Handle compression** - Compress and decompress files using gzip, zlib, and zip archives
5. **Implement atomic operations** - Write files safely with atomic write patterns to prevent corruption
6. **Monitor file changes** - Watch directories for changes and implement hot-reload patterns
7. **Build production pipelines** - Design file processing pipelines used at Netflix, Uber, and Airbnb

### Junior to FAANG: objective ladder and how to self assess

The objectives above read as a single list, but at FAANG they are evaluated on a ladder. You do not earn credit for objective 7 if you cannot execute objective 1 under review pressure. A realistic self assessment goes in order. Can you write a correct `copyFile(src, dst string) error` that fsyncs and handles partial writes, without looking at documentation? That is the L3 bar. Can you then modify it to resume after a crash using a sidecar offset file with atomic rename? That is L4. Can you extend it to shard across workers with bounded concurrency, progress reporting via a `chan Progress`, and context cancellation that flushes partial state on shutdown? That is L5. Can you argue why the sharding strategy chosen preserves total ordering guarantees for downstream consumers, or explicitly does not, and document the cost model per GB? That is L6. Interview loops test the gap between adjacent rungs, so practice moving between them on the same problem.

Each objective also has a canonical failure mode that interviewers probe. Objective 1 fails on close error handling. Objective 2 fails on the 64 KB Scanner default. Objective 3 fails on CSV quoting and on float precision loss in JSON. Objective 4 fails on gzip reader close not being called. Objective 5 fails on the missing directory fsync. Objective 6 fails on the inotify event backlog under load. Objective 7 fails on the lack of idempotency and checkpointing. If you cannot name the failure mode before writing code, you are not ready for the objective.

### Senior @ FAANG: outcome objectives, not activity objectives

At staff level and above, the objectives shift from "can you do X" to "can you make the right X happen at scale across teams you do not control". The reframing matters because code review feedback at L6+ rarely touches syntax. It touches objectives. A senior file processing objective set reads more like this.

Define and publish the data contract. Every file flowing through your pipeline must have a schema with a version, a producer identity, a timestamp, a checksum, and a partition key. The contract lives in a registry (Confluent Schema Registry, Buf Schema Registry, or an internal equivalent) and evolution rules are enforced at CI time. Forward compatibility (old readers tolerate new fields) and backward compatibility (new readers tolerate old fields) are independent properties, and your contract must state which you guarantee.

Design for crash consistency as a first class property, not an afterthought. A pipeline is crash consistent if any partial execution can be resumed or rolled back without human intervention and without producing duplicate or missing records downstream. This drives idempotency keys on every write, exactly once semantics through two phase commit or transactional outbox patterns, and write ahead logs for stateful operators. The cost is real, typically 15 to 30 percent throughput, and the business case must justify it.

Own the cost model. You must be able to state, in dollars per TB processed, the cost of ingress, egress, compute, storage, and checksum verification, and the marginal cost of adding a new pipeline. Without that model you cannot prioritize optimization work, and finance will eventually force the conversation in a way you do not control.

Own the on call burden. A pipeline that wakes someone up at 3 AM more than once per quarter is a design failure, not an operations problem. The objective is not "build the pipeline" but "build the pipeline that does not page". That drives dead letter queues, automatic retry with exponential backoff and jitter, poison message quarantine, progress metrics with SLOs, and runbooks that encode the last five incidents.

Own the governance story. At FAANG scale, file processing intersects GDPR right to erasure, SOX audit trails, PCI DSS for payment data, and HIPAA for health data. You must be able to prove, with logs, that every byte can be traced from producer to every consumer, that deletions propagate within the contractual SLA (typically 30 days), and that access is logged with the subject and purpose. If you cannot prove it, compliance will block your launch.

These are the objectives that define senior impact. The code is the easy part.

---
