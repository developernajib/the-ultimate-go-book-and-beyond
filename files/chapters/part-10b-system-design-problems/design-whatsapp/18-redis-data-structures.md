## Redis Data Structures

Redis plays several critical roles in this architecture, each using a different data structure optimized for the use case. Understanding which Redis data structure to use and why is important for system design interviews. For example, a sorted set could track presence, but a simple key with TTL is simpler and sufficient. A list is ideal for the offline queue because it preserves message order and supports atomic pop operations. Below are the exact Redis commands used for each feature.

```
# User presence (which server owns this connection)
SET presence:{user_id} "conn-server-042" EX 300  # 5 min TTL, refreshed

# Offline message queue (per user)
RPUSH offline:{user_id} '<encrypted_message_bytes>'
EXPIRE offline:{user_id} 2592000  # 30 days

# Drain on reconnect: pop and remove in ONE atomic step.
# Do NOT use LRANGE 0 -1 followed by DEL. Those are two round trips, and any
# message RPUSHed between them is deleted having never been delivered.
LPOP offline:{user_id} 64
# Return undelivered messages to the head, preserving order:
LPUSH offline:{user_id} '<msg_n>' ... '<msg_1>'

# Group member cache
SADD group:members:{group_id} "user_1" "user_2" "user_3"
EXPIRE group:members:{group_id} 600  # 10 min

# Unread count per conversation per user
HINCRBY unread:{user_id} {conv_id} 1
# Reset on read: HSET unread:{user_id} {conv_id} 0

# Last seen timestamp
SET lastseen:{user_id} "1711234567" EX 86400

# Rate limiting per user, fixed window keyed by minute
INCR msg_rate:{user_id}:{minute}
EXPIRE msg_rate:{user_id}:{minute} 60
# INCR then EXPIRE is two commands: if the client dies in between, the key
# never expires and that user is counted forever. Send both in one MULTI, or
# use a small Lua script, so the TTL cannot be orphaned.

# Typing indicator (ephemeral)
SETEX typing:{conv_id}:{user_id} 5 "1"  # 5 second TTL
```

---
