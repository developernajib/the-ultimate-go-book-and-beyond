## Interview Follow-Ups

These questions probe deeper into the index management, ranking, and anti-abuse layers of the search engine. Interviewers use these to separate candidates who understand the theory from those who have thought about production operations.

**Q: How do you handle index updates at scale?**

The main index is immutable once built, no in-place modifications. New and updated pages are written to a separate "delta index" that is small (millions of pages vs billions) and fast to rebuild. Queries search both the main index and the delta index, merging results transparently. Periodically (every few hours), the delta index is compacted into the main index using a merge operation analogous to LSM tree compaction: the old main index and the delta index are merged into a new main index, and an atomic pointer swap activates it. During the merge, the old main index continues serving queries with zero downtime.

**Q: How does Google handle personalized results?**

User search history (queries, clicks) and click-through data are encoded into a 128-dimensional personalization vector, updated daily. During Phase 2 ranking, this vector is fed as an additional feature into the learned ranking model (LambdaMART or gradient-boosted decision tree). The model combines BM25 text relevance, PageRank authority, CTR prediction, dwell time signals, and the user's personalization features. The trade-off is relevance vs diversity: heavy personalization risks filter bubbles. Privacy is handled by storing personalization vectors encrypted per user with the ability to delete them on request (GDPR compliance).

**Q: How do you prevent link spam from gaming PageRank?**

TrustRank seeds the PageRank computation from a manually curated set of high-quality pages (Wikipedia, .gov, .edu sites). Trust propagates through the link graph but decays with distance from the seed set. Spam pages receive low TrustRank even if they accumulate many inbound links from other spam pages, because those linking pages themselves have low trust. Link farms, clusters of sites that exist solely to link to each other, are detected by spectral clustering analysis of the link graph. Pages in detected clusters are demoted or removed from the index. Additionally, rapid link velocity (a page gaining thousands of inbound links overnight) triggers a review flag.

---
