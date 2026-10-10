## Redis Data Structures

Redis serves as the fast caching and coordination layer for several time-sensitive operations. Permission checks happen on every WebSocket message, so caching them in Redis avoids hitting PostgreSQL on every keystroke. The active editors set and cursor pub/sub channel power the presence and cursor features that make collaboration feel real-time. Document routing entries tell the gateway which doc server currently owns each document.

```
# Permission cache (written by the permissions service, read by doc servers)
SET perm:role:{doc_id}:{user_id} "editor" EX 300  # 5 min TTL

# Active editors per document (for presence)
SADD active:{doc_id} "user_123" "user_456" "user_789"
EXPIRE active:{doc_id} 600  # 10 min TTL

# Document routing (which server owns this doc)
HSET doc_routing:{doc_id} server_id "docserver-042" loaded_at "1711234567"

# User's recent documents
ZADD recent_docs:{user_id} {timestamp} {doc_id}
ZREMRANGEBYRANK recent_docs:{user_id} 0 -101  # keep last 100
EXPIRE recent_docs:{user_id} 604800  # 7 days

# Document lock for exclusive operations (e.g., restore version)
SET doc_lock:{doc_id} "user_123" EX 30 NX  # 30 second exclusive lock

# Cursor positions (broadcast via pub/sub, not persisted)
PUBLISH cursor:{doc_id} '{"user_id":"u123","position":456,"color":"#FF6B6B"}'
```

---
