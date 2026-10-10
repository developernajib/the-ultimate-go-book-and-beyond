## Redis Data Structures

Redis is used throughout the Twitter architecture for different purposes, and each use case maps to a specific Redis data structure. Sorted sets store timelines (ordered by Snowflake ID), regular sets store follow relationships (for fast membership checks), and hashes store user profile caches. Understanding which Redis data structure to use and why is essential for explaining your design clearly in an interview.

```
# User timeline (pre-computed, fan-out on write)
ZADD timeline:{user_id} {snowflake_id} {tweet_id}
ZREMRANGEBYRANK timeline:{user_id} 0 -801  # keep max 800
EXPIRE timeline:{user_id} 604800  # 7 days

# Celebrity tweet cache (shared across all followers)
ZADD celeb_tweets:{user_id} {snowflake_id} {tweet_id}
ZREMRANGEBYRANK celeb_tweets:{user_id} 0 -51  # keep last 50
EXPIRE celeb_tweets:{user_id} 300  # 5 min TTL

# Trending hashtags (per-minute buckets)
ZINCRBY trending:{unix_minute} 1 "golang"
EXPIRE trending:{unix_minute} 5400  # 90 minutes

# User follow relationships (for fast fan-out lookups)
SADD followers:{user_id} {follower_id_1} {follower_id_2}
SADD following:{user_id} {following_id_1} {following_id_2}

# User profile cache
HSET user:{user_id} username "gopher" display_name "Go Developer"
                      follower_count 5000 following_count 200 tweet_count 1234
                      avatar_url "cdn.example.com/avatar/123.jpg" is_verified true
EXPIRE user:{user_id} 300

# Rate limiting (sliding window)
ZADD rate:tweet_create:{user_id} {timestamp_ms} {request_id}
EXPIRE rate:tweet_create:{user_id} 900  # 15 minutes

# Like dedup check
SISMEMBER likes:{tweet_id} {user_id}

# Direct message conversations
ZADD dm_inbox:{user_id} {snowflake_id} {conv_id}
```

---
