## High-Level Architecture

┌────────────────────────────────────────────────────────────────┐
│ FILE STORAGE SYSTEM │
├────────────────────────────────────────────────────────────────┤
│ │
│ ┌──────────────┐ ┌──────────────────────────────────┐ │
│ │ Client │─────▶│ API Gateway │ │
│ │ (Desktop/ │ │ (Upload/Download/Sync) │ │
│ │ Mobile) │ └──────────────┬───────────────────┘ │
│ └──────────────┘ │ │
│ ▼ │
│ ┌────────────────────────┴────────────────────┐ │
│ │ │ │
│ ▼ ▼ │
│ ┌─────────────────┐ ┌──────────────────┐
│ │ Metadata │ │ Block Storage │
│ │ Service │ │ Service │
│ │ (PostgreSQL) │ │ (S3/Custom) │
│ └─────────────────┘ └──────────────────┘
│ │ │ │
│ ▼ ▼ │
│ ┌─────────────────┐ ┌──────────────────┐
│ │ Sync Service │ │ Deduplication │
│ │ (Change Feed) │ │ Service │
│ └─────────────────┘ └──────────────────┘
│ │
└────────────────────────────────────────────────────────────────┘


### Junior → FAANG: Designing the Core Architecture

A high-level architecture diagram for a file sync system should include the client application (desktop or mobile), the sync client library responsible for chunking and delta computation, the API gateway, the metadata service (tracks file tree, chunk manifests, version history), the chunk storage service (backed by object storage like S3), and the notification service (push or long-poll for change events). Beginners often merge the metadata and chunk storage into one service, which is a design mistake: metadata and binary content have very different access patterns, scaling requirements, and consistency needs.

### Senior @ FAANG: Architecture Decomposition and Service Boundary Governance

Senior engineers treat the high-level architecture as a statement of service boundaries, which implies team boundaries and API contracts. The key decomposition question is: which services can evolve independently? The metadata service and the chunk service can deploy independently, which is the right property. The chunk service should not need to know about the file tree. It only stores and retrieves opaque byte chunks keyed by content hash. This separation enables the metadata service to upgrade its versioning model without requiring a chunk service deployment. At the staff level, you should also articulate the data ownership model: who is authoritative for each piece of data, and how do you handle the case where two services disagree. In file sync, the client is often the source of truth for the file tree during a sync operation, and conflict resolution is a reconciliation problem between the client state and the server state.
