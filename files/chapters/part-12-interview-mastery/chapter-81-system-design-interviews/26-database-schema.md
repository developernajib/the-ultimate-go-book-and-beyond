## Database Schema

The schema separates three distinct concerns: file identity and hierarchy in `files`, content history in `file_versions`, and access control in `shares`. Storing `chunk_hashes` as an array in `file_versions` enables delta sync, a client only uploads chunks whose hashes differ from the previous version, which is the core mechanism that makes incremental sync bandwidth-efficient. The `UNIQUE (user_id, parent_folder_id, name)` constraint on `files` enforces namespace isolation at the database level, preventing duplicate names within a folder without requiring application-layer guards.

```sql
-- File metadata
CREATE TABLE files (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    parent_folder_id UUID,
    name VARCHAR(255) NOT NULL,
    size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    is_folder BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    UNIQUE (user_id, parent_folder_id, name)
);

-- File versions for history
CREATE TABLE file_versions (
    id UUID PRIMARY KEY,
    file_id UUID NOT NULL REFERENCES files(id),
    version_number INT NOT NULL,
    chunk_hashes TEXT[] NOT NULL,
    size BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    created_by UUID NOT NULL
);

-- Sharing permissions
CREATE TABLE shares (
    id UUID PRIMARY KEY,
    file_id UUID NOT NULL REFERENCES files(id),
    shared_with UUID, -- NULL for link sharing
    permission VARCHAR(20) NOT NULL, -- 'view', 'edit', 'owner'
    link_token VARCHAR(100),
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL
);
```


### Junior → FAANG: Designing Database Schemas for System Design Interviews

A database schema in a system design interview demonstrates that you have thought through the data model concretely. Key tables for a file sync system: users, files (metadata: name, parent_id, owner_id, created_at, updated_at), file_versions (version number, chunk_manifest reference, created_at), chunks (content_hash as primary key, size, storage_path), and user_chunk_refs (linking users to chunks they reference, for billing and cleanup). Common mistakes include using natural keys for file names (file names change and are not unique), not including a soft-delete mechanism (users expect undo), and not designing for the access patterns that will drive query performance.

### Senior @ FAANG: Schema Governance, Migration Strategy, and Multi-Tenancy

Senior engineers approach schema design with two constraints that junior engineers often ignore: the schema must support the queries that drive the product without requiring full table scans, and the schema must be evolvable without downtime migrations. At the L6 level, the interview expects you to identify which columns need indexes based on the query patterns described, and to recognize when a denormalization is justified by read performance requirements. The migration governance concern is particularly sharp for file sync systems: the file_versions table can grow to billions of rows, so adding a column with a non-null default requires careful planning (the migration itself can lock the table for hours on a large dataset, requiring an online schema change tool like gh-ost or pt-online-schema-change). Staff-level schema concerns include multi-tenancy isolation: are all customers in the same schema with a tenant_id discriminator, or in separate schemas, or in separate databases? Each strategy has different security isolation, performance isolation, and operational complexity trade-offs that belong in an ADR.
