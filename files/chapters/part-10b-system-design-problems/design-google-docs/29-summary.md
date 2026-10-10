## Summary

This table provides a quick reference for each major component, the technology choice, and its role in the system. Use it as a cheat sheet during interviews to ensure you cover all the pieces when presenting your design. Each technology was chosen to match the specific access pattern and scale requirement of its component.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Real-time ops | WebSocket + OT engine | Concurrent editing |
| Operation serialization | Per-doc server (stateful) | Conflict resolution |
| Document storage | S3 (content) + PostgreSQL (metadata) | Persistence |
| Operation log | PostgreSQL / Cassandra | Catch-up & audit |
| Version history | S3 snapshots | Time travel / restore |
| Permissions | PostgreSQL + Redis cache | Access control |
| Presence / cursors | WebSocket broadcast | Live collaboration |
| Routing | Consistent hash on doc_id | Server stickiness |


---
