## Problem Statement

Design a Twitter-like social messaging platform that supports:
- 200M daily active users
- 500M tweets posted per day (~5,800/sec average)
- 800M+ timeline reads per day
- Real-time trending topics
- Search across all tweets
- @mentions, hashtags, retweets, likes
- Direct Messages

**Clarifying Questions:**

1. Is this read-heavy? - Yes. 800M timeline reads against 500M tweets looks close, but each read hydrates roughly 20 tweets, so tweet fetches outnumber tweet writes by about 30:1
2. Eventual consistency OK for timelines? - Yes, a few seconds delay is fine
3. Media attachments? - Yes: photos, videos, GIFs (handle via CDN)
4. What's the fan-out strategy for celebrities? - Hybrid: push for <100K followers, pull for celebrities
5. Global or regional? - Global with regional Kafka clusters
6. Do we need DMs? - Yes, encrypted, not shown in timeline

---
