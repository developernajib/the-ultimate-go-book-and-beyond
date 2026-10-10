## Database Schema

Cassandra's wide-column model is purpose-built for chat's dominant access pattern: fetching all messages in a conversation ordered by time. The schema denormalizes data across three tables so every query is a single-partition scan, there are no joins, no secondary index lookups, and no cross-node coordination. The `last_read_seq` field in `conversation_participants` enables efficient unread-count computation without scanning the messages table, and the `user_conversations` table keeps the inbox view O(1) by pre-materializing the data each user needs on login.

```cql
-- Cassandra schema optimized for chat patterns

-- Messages by conversation (main query pattern)
CREATE TABLE messages_by_conversation (
    conversation_id uuid,
    seq_num bigint,
    message_id uuid,
    sender_id uuid,
    content text,
    created_at timestamp,
    PRIMARY KEY (conversation_id, seq_num)
) WITH CLUSTERING ORDER BY (seq_num DESC);

-- Conversation participants
CREATE TABLE conversation_participants (
    conversation_id uuid,
    user_id uuid,
    joined_at timestamp,
    last_read_seq bigint,
    PRIMARY KEY (conversation_id, user_id)
);

-- User's conversations (for inbox)
CREATE TABLE user_conversations (
    user_id uuid,
    updated_at timestamp,
    conversation_id uuid,
    last_message_preview text,
    unread_count int,
    PRIMARY KEY (user_id, updated_at)
) WITH CLUSTERING ORDER BY (updated_at DESC);
```


### Junior → FAANG: Chat System Data Model

The chat system data model has three core entities: users, conversations (or channels), and messages. Messages are the hot path: they are written at high volume and read sequentially by time within a conversation. This access pattern makes a wide-column store (Cassandra) a natural fit: partition by conversation_id so all messages for a conversation are co-located, cluster by message_timestamp within the partition so range queries by time are efficient. The user and conversation metadata tables can live in a relational database where the volume is lower and the query patterns are more varied.

### Senior @ FAANG: Chat Database Schema Optimization, Retention, and Compliance

At the senior level, the chat database schema must account for retention policies and compliance requirements. Messages in a regulated environment (financial services, healthcare) may have mandatory retention periods and must be immutable (no edits or deletes from the storage layer, even if the UI shows an 'edited' state). This means the schema must support a message version chain: the original message is retained, and an edit creates a new version record that references the original. Compliance queries (e-discovery) require the ability to retrieve all messages for a specific user across all conversations within a date range, which is an expensive cross-partition query in a Cassandra model. The ADR for this trade-off captures the decision to maintain a secondary index or a separate compliance data store for e-discovery queries. Staff-level concerns include message archival: after the retention window expires, messages must be purged from the hot store, which requires a background archival job that processes messages in partition order and must be idempotent in case of failure.
