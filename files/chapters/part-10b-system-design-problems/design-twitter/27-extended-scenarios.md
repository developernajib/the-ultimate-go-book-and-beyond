## Extended Scenarios: Viral Load and Celebrity Growth

Real-world Twitter encounters edge cases that standard designs do not cover. The scenarios below walk through what happens when a tweet goes viral, when a user gains millions of followers overnight, when someone posts a long thread, and how content moderation works. Interviewers love to throw these at you to see if your design holds up under unusual conditions.

### Handling a Viral Tweet (10M+ Impressions/Hour)

When a tweet goes viral:

1. **Celebrity detection**: Tweet author has >100K followers, skip fan-out
2. **Celebrity cache**: Store in dedicated celeb_tweets:USER_ID with 5-min TTL
3. **Shared cache**: All 10M followers read from the SAME cache entry
4. **Engagement counter isolation**: Like/RT counters for viral tweets use dedicated Redis key to avoid hot-key issues (use Redis Cluster with hash tags)
5. **Search ranking boost**: Viral tweets get temporary search ranking boost based on engagement velocity

### Handling a Mass Follow Event

When a user suddenly gains millions of followers, for example an account that gets promoted onto a default recommendation surface:

1. **Follow graph update**: Batch SADD to Redis in chunks of 10K
2. **Timeline backfill**: New followers do NOT get the user's historical tweets pushed, they see them via pull-on-read
3. **Notification throttle**: Aggregate "X and 1M others followed you" instead of 1M individual notifications
4. **Celebrity threshold check**: Automatically reclassify user as celebrity when follower count > 100K (switch from push to pull model)

The reclassification in step 4 is the interesting part, because crossing the threshold is not a clean switch. Tweets the author posted just before the flip are already sitting in follower timelines from push, and the moment they are reclassified those same tweets also start arriving via pull-on-read. Every follower sees them twice unless the read path merges by tweet ID rather than concatenating the two sources. Crossing back down is the mirror image: pull stops, push has not started, and the tweets posted in the gap reach nobody. Neither direction announces itself, which is why the merge dedupes and why the threshold wants hysteresis, promoting at 100K and demoting only well below it, so an account hovering at the boundary does not flap between two delivery models on every follow and unfollow.


---
