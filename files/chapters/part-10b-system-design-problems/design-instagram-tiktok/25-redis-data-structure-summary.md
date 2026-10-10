## Redis Data Structure Summary

Redis serves as the fast-access layer for nearly every feature in the system. This reference shows every Redis key pattern, what data structure it uses, and what purpose it serves. Understanding these patterns is useful both for interviews (where you need to explain your caching layer) and for production operations (where you need to estimate memory usage and debug issues). Notice how different Redis data structures are chosen to match access patterns: sorted sets for ranked data, HyperLogLog for cardinality estimation, sets for membership checks, and plain strings for counters.

```
# Feed cache (per user)
feed:{userID}          ZSET  (member=postID, score=ranking_score)

# Post counters
post:likes:{postID}    STRING (integer)
post:comments:{postID} STRING (integer)
views:total:{postID}   STRING (integer, write-coalesced)
views:hll:{postID}     HYPERLOGLOG (unique viewers)

# Per-user recent likes (powers is_liked flags in feeds)
user:likes:{uid}       SET   (recently liked postIDs, TTL=24h)

# Follow counts
user:follower_count:{uid}  STRING (integer)
user:following_count:{uid} STRING (integer)

# Stories
stories:{userID}       ZSET  (member=storyID, score=expiry_timestamp)
story:seen:{viewer}:{owner} SET (storyIDs viewed)
story:views:{storyID}  STRING (integer)

# Hashtags
hashtag:hourly:{hour}  ZSET  (member=tag, score=count)
hashtag:alltime        ZSET  (member=tag, score=total_count)

# Notifications
notif:pending:{uid}    LIST  (pending notification JSONs)
notif:badge:{uid}      STRING (unread count)

# Hot posts cache
hot:posts              ZSET  (member=postID, score=engagement_score)
post:detail:{postID}   STRING (JSON, TTL=5min)

# Session
session:{token}        HASH  (user_id, created_at, device)
```


---
