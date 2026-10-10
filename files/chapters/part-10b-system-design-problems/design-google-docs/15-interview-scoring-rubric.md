## Interview Scoring Rubric

This rubric shows what interviewers expect at different seniority levels. A mid-level candidate (L4) should demonstrate basic understanding of real-time communication and conflict resolution concepts. Senior candidates (L5) need to show they can design a working system with correct OT logic and recovery mechanisms. Staff candidates (L6) must discuss trade-offs, edge cases, and advanced topics that separate a good design from a production-grade one.

**L4 (Mid-Level), Meets Bar:** The candidate uses WebSocket for real-time communication and mentions OT or CRDT as the conflict resolution mechanism. Has a basic storage layer for documents. Gaps at this level: cannot explain how the transform function works, no operation log for durability, no offline editing support.

**L5 (Senior), Strong Hire:** Implements a correct OT transform function (handles insert-vs-insert, insert-vs-delete, delete-vs-delete). Designs a single-server-per-document architecture with consistent hashing for stickiness. Includes an operation log (append-only) for crash recovery. Handles offline editing by queuing ops with base revisions and transforming on reconnect. Implements a permission system (view/comment/edit roles). Gaps at this level: does not discuss OT vs CRDT trade-offs, no comment anchoring, no hot document mitigation.

**L6 (Staff), Exceptional:** Everything from L5 plus: articulates the trade-offs between OT and CRDT (OT requires central serialization but has lower memory overhead. CRDTs are decentralized but carry per-character metadata). Designs comment anchoring that adjusts positions as the document changes. Handles the hot document problem (a viral doc with 50+ editors creating disproportionate load on one server). Discusses the consistency model (strong consistency within a document session, eventual consistency for offline reconciliation). Implements split-brain prevention using a coordination service (ZooKeeper/etcd) with graceful failover under 10 seconds.

---
