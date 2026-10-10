## Interview Scoring Rubric

This rubric shows what interviewers expect at different engineering levels. Understanding these tiers helps you calibrate how deep to go. An L4 candidate needs a working design, while an L6 candidate must demonstrate expertise in audio processing, rights management, and ML-powered recommendations.

### L4 (Mid-Level), Meets Bar
The candidate stores audio files in S3, delivers them via a CDN, and builds a basic search using Elasticsearch. Has a reasonable database schema for tracks, playlists, and users. Gaps at this level: no audio segmentation (streams full files), no CDN hot/cold caching strategy, no recommendation system beyond "similar artists."

### L5 (Senior), Strong Hire
Implements audio segmentation (10-second chunks at multiple bitrates) for adaptive streaming. Designs a CDN caching strategy that differentiates hot tracks (proactive edge push) from cold tracks (origin fetch on demand). Builds a recommendation pipeline using collaborative filtering (ALS matrix factorization, user/track vectors, ANN lookup via Annoy or FAISS). Uses Kafka for play event streaming with the 30-second royalty threshold. Includes offline download with DRM (AES-GCM encryption, device limits, license expiry). Gaps at this level: no content-based audio features, no social activity feed, no gapless playback design.

### L6 (Staff), Exceptional
Everything from L5 plus: designs the full audio transcoding pipeline from upload to segmented delivery. Combines collaborative filtering with content-based features (Mel spectrograms, audio fingerprinting) for hybrid recommendations. Implements the complete royalty calculation pipeline with per-play accounting and financial reconciliation. Discusses rights management (regional licensing, track takedowns, label agreements). Adds podcast support with RSS polling, chapter markers, and variable-speed playback. Designs the social graph and real-time activity feed, and can argue why Friend Activity fans out on read when a timeline would fan out on write. Discusses A/B testing infrastructure for comparing recommendation algorithms using engagement metrics.

---
