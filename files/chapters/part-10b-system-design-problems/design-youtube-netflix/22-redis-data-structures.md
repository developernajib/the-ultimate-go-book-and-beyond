## Redis Data Structures

Redis serves as the fast-access caching layer for data read constantly and tolerant of short staleness. Video metadata caches for 5 minutes to keep page loads off MySQL, watch positions for instant resume, and pre-computed recommendations per user. Hashes hold structured records, sorted sets hold ranked lists, and counters do rate limiting.

Store **keys, not URLs**, exactly as the database does. Caching `https://cdn.example.com/...` means a CDN change is invisible until every cache entry expires, and mixing hosts across a live playback session is its own kind of bad day.

```
# Video metadata cache. Note the videos/ prefix: same layout as the transcoder
# wrote and the player reads. One layout, one source of truth, no exceptions.
HSET video:{video_id} title "Go Tutorial" duration 3600 view_count 1000000
                      master_key "videos/{video_id}/master.m3u8"
                      thumbnail_key "videos/{video_id}/thumb_0.jpg"
                      status "ready" category "education"
EXPIRE video:{video_id} 300  # 5 min TTL

# User watch position (for resume).
# EXPIRE applies to the whole hash, and writing a field does NOT extend it, so
# this refreshes the TTL on every write. Otherwise the hash evaporates 24h after
# the FIRST write and takes every resume point with it, including the one for
# the show the user is in the middle of right now. This is a cache in front of
# the durable watch history, never the only copy.
HSET watch_pos:{user_id} {video_id} 1234.5
EXPIRE watch_pos:{user_id} 86400

# Pre-computed recommendations per user.
# ZADD, not "ZSET": ZSET is the type name, not a command.
# The score is predicted watch time in seconds, matching the ranker and the
# recommendations table. Sorted sets sort ascending, so read the top 20 with
# ZREVRANGE (or ZRANGE ... REV on Redis 6.2+).
ZADD recs:{user_id} 312.4 {video_id_1} 287.1 {video_id_2} 250.9 {video_id_3}
EXPIRE recs:{user_id} 3600
ZREVRANGE recs:{user_id} 0 19 WITHSCORES

# Trending videos, per-hour buckets unioned into a sliding window.
# INCR-then-EXPIRE is two round trips and a real bug: if the client dies between
# them the key has no TTL and leaks forever. Do it in one atomic step.
EVAL "local n = redis.call('ZINCRBY', KEYS[1], 1, ARGV[1])
      redis.call('EXPIRE', KEYS[1], 7200)
      return n" 1 trending:{hour_bucket} {video_id}

# Read the last 3 hours as one ranking.
ZUNIONSTORE trending:3h 3 trending:{h} trending:{h-1} trending:{h-2}
ZREVRANGE trending:3h 0 49

# Upload rate limiter: 10 per hour per user (matches the security section).
# Same atomicity problem, same fix. A non-atomic INCR/EXPIRE here fails in the
# user's favour on a crash (no TTL, counter never resets, user locked out) which
# is the wrong direction for a limiter to fail.
EVAL "local c = redis.call('INCR', KEYS[1])
      if c == 1 then redis.call('EXPIRE', KEYS[1], 3600) end
      return c" 1 upload_rate:{user_id}:{hour}

# Video processing status. quality_done drives which rungs the manifest
# advertises, so a rung appears here only after its segments are in S3.
HSET processing:{video_id} status "transcoding" progress 45
                           quality_done "240p,360p" quality_pending "480p,720p,1080p,4k"
EXPIRE processing:{video_id} 86400
```

---
