# Capstone Project 6: Social Network Backend

**Difficulty**: Expert
**Estimated Time**: 120+ hours
**Lines of Code**: ~15,000
**Production Readiness**: 95%

---

### Junior → FAANG: Social Network as an Advanced System Design Target

A social network backend covers the hardest system design interview problems: news feed generation, social graph queries, notification fan-out, and media storage at scale. Working through this project gives you first-principles experience with each of these, transforming interview questions from abstract puzzles into familiar patterns.

For entry-level roles, understanding the fan-out on write (push) versus fan-out on read (pull) tradeoff for news feed generation is the key concept. Fan-out on write precomputes each user's feed when a post is created (fast reads, slow celebrity writes). Fan-out on read builds the feed at query time (slow reads, fast writes). Twitter uses a hybrid: fan-out on write for non-celebrity accounts, fan-out on read for celebrity accounts with millions of followers.

### Senior @ FAANG: Social Network as a Governance and Scale Problem

At senior level, a social network backend is not primarily a technical challenge. It is a governance challenge: who can see what data, how is content moderation enforced, what are the privacy defaults, and how does the system handle legal requests for user data?

Privacy-by-design means that every data flow in the social network must have an explicit privacy boundary: who is the data owner, who is the data consumer, and what use restrictions apply. These boundaries must be enforced at the API layer (through RBAC), at the data layer (through column-level encryption or row-level security), and at the infrastructure layer (through network policies). Building these boundaries into the architecture from the start is significantly easier than retrofitting them after a privacy incident.

---
