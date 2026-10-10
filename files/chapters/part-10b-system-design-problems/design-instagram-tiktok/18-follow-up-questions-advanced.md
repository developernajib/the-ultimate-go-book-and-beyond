## Follow-up Questions, Advanced

These advanced follow-ups probe deeper into areas that separate strong candidates from exceptional ones. Each question addresses a real production challenge that platforms like TikTok and Instagram solve daily.

**Q: How does TikTok's recommendation algorithm work?**

TikTok's "For You" feed uses a two-stage pipeline similar to YouTube's architecture but optimized for short-form video. Candidate generation pulls roughly 1,000 recent high-engagement posts from multiple sources: content-based similarity (posts similar to what the user has watched), collaborative filtering (posts liked by users with similar viewing patterns), and trending content in the user's preferred categories. A lightweight first-pass model scores all 1,000 candidates using features like creator engagement rate, video completion rate, and topic match. A heavier second-pass model re-ranks the top 100 using user-specific features: watch history, skip behavior, and interaction patterns. The final feed injects diversity (no more than 3 consecutive posts from the same creator or topic) and reserves 10% of slots for exploration content from new creators, ensuring the algorithm does not create filter bubbles. The feedback loop updates the model using watch time and skip rate as primary signals: a video watched to completion signals strong interest, while a skip within the first 2 seconds signals disinterest.

---

**Q: How do you implement hashtag trending?**

Tags are extracted from post captions at upload time and published as events to a Kafka topic. A Flink streaming job maintains per-hashtag counters in a sliding 1-hour window, computing both total count and velocity (count in the last 5 minutes). The top 30 hashtags by velocity-weighted score are cached in a Redis sorted set (`trending:hashtags`) and refreshed every 5 minutes. Users browsing the "Explore" page see these cached results. Hashtag search queries use Elasticsearch with a prefix query on the `tag` field, returning posts sorted by recency or engagement. Regional trending works by partitioning counters by country code, so users in different regions see locally relevant trends.

---

**Q: How do you handle the cold-start problem for new users?**

New users have no interaction history, so the recommendation engine cannot compute personalized scores. The onboarding flow presents an interest selection screen where users pick 5-10 categories (travel, food, sports, etc.), which seeds their preference profile. The initial feed uses a curated mix of high-quality posts from those categories plus globally trending content. As the user starts liking, commenting, and watching, the system progressively personalizes their feed. Typically within 20-50 interactions the model has enough signal to generate meaningful recommendations. Contact import from the phone's address book enables immediate friend suggestions, which generates social graph edges and further improves feed quality.

---

**Q: How do you handle DMCA takedowns at 100M uploads per day?**

Copyright enforcement uses a combination of proactive detection and reactive takedowns. Proactive detection runs a Content ID fingerprinting system during the media processing pipeline: each uploaded video is fingerprinted (perceptual hash of extracted frames) and compared against a reference database of copyrighted content using locality-sensitive hashing (LSH). Matches above a confidence threshold are auto-removed or flagged for rights-holder decision (monetize, track, or block). Reactive takedowns follow the standard DMCA process: rights holders submit a takedown form, which triggers a 24-hour legal review. Content is removed within 24 hours of a valid claim, and the uploader receives a counter-notice option. At 100 million uploads per day with approximately 0.1% flagged, the system processes roughly 100,000 reviews per day, prioritized by an ML model that ranks likely valid claims higher to reduce reviewer workload.

---
