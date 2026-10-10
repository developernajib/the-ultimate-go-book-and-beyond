## Project Overview

### What We're Building

A production-grade social network backend similar to Twitter/Instagram with:

- **Social Graph**: Follow/unfollow relationships with 2-way tracking
- **User Profiles**: Rich profiles with avatars, bios, verification
- **Post System**: Text posts with media, hashtags, mentions, likes, comments
- **News Feed**: Personalized, ranked feeds with infinite scroll
- **Notifications**: Real-time notifications via WebSocket
- **Media Processing**: Image upload, resizing, thumbnail generation
- **Search**: Full-text search for users, posts, hashtags
- **Discovery**: Trending topics, user recommendations
- **Analytics**: Post impressions, engagement metrics

### Learning Objectives

By building this project, you'll master:

1. **Complex Data Modeling**: Social graph, feed storage, relationships
2. **Fan-Out Patterns**: Write vs read fan-out trade-offs
3. **Caching Strategies**: Multi-tier caching for feeds and graphs
4. **Graph Databases**: Neo4j for social graph queries
5. **Real-Time Systems**: WebSocket for live updates
6. **Media Processing**: Image upload, resize, CDN integration
7. **Search Systems**: Elasticsearch integration
8. **Performance at Scale**: Handling millions of users and posts
9. **System Design**: Twitter-scale architecture decisions

### Real-World Parallels

| Feature | Twitter Equivalent | Instagram Equivalent |
|---------|-------------------|---------------------|
| Posts | Tweets | Posts/Stories |
| Follow | Follow | Follow |
| Feed | Timeline | Feed |
| Retweet | Retweet | Share |
| Like | Like | Like |
| Reply | Reply | Comment |
| Hashtag | #trending | #explore |

---

### Junior → FAANG: Platform Comparison as an Interview Framing Tool

The Twitter/Instagram comparison table in this overview is a useful interview framing tool. When asked to "design a social network," the first question should be: "which platform's behavior are we targeting?" Twitter's public-by-default model (any post is publicly visible to non-followers) is architecturally very different from Instagram's follower-only model (posts only visible to followers). This distinction affects the news feed algorithm, the notification system, and the privacy controls.

The feature matrix (post, like, follow, hashtag, search) maps directly to the microservices in this project. Each feature row becomes a service responsibility boundary. Understanding which features belong to which service is the system decomposition exercise that FAANG system design interviews are evaluating.

For your interview, be able to justify why certain features are grouped in the same service (posts and likes, because likes are aggregations on posts) and why others are separate (posts and user profiles, because they have different scaling requirements and different data access patterns).

### Senior @ FAANG: Platform Scope as an Engineering Investment Decision

At senior level, the platform scope definition is the most important architectural decision made before any code is written. Adding features to a social network that is already in production requires backward-compatible changes to the data model, the API, and the feed algorithm. Defining the initial scope too narrowly means expensive retrofits. Defining it too broadly means building features that users do not need.

The Twitter/Instagram comparison also surfaces the content moderation challenge: Twitter's public-by-default model requires aggressive content moderation because any post is visible to the general public. Instagram's follower-only model reduces the moderation burden somewhat but does not eliminate it. Each moderation approach (automated classifiers, human review queues, appeal processes) has a cost and a latency. These are operational commitments that should be designed into the system from the beginning, not added as afterthoughts after the first abuse incident.

---
