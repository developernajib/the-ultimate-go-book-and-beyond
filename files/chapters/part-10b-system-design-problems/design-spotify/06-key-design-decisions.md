## Key Design Decisions

Each decision below addresses a specific challenge in audio delivery, content discovery, or rights management. Understanding the trade-offs behind each choice demonstrates production-level thinking.

**Audio Segmentation:** Tracks are stored as 10-second segments at each bitrate (96, 160, 320 kbps Ogg Vorbis, plus lossless FLAC). The client buffers 3-5 segments ahead for smooth playback. When network quality changes (e.g., entering a tunnel), the client switches bitrate at the next segment boundary without any audible gap. The alternative, streaming full files, wastes bandwidth whenever a user skips (a large share of plays are abandoned in the first half minute) and makes quality adaptation impossible mid-track. The 10-second segment size is a compromise: shorter segments (1-2s) add HTTP overhead from more requests, while longer segments (30s+) delay quality adaptation.

**CDN Strategy:** With 80M songs at 4 tiers, and each of those cut into 10-second segments, the catalog is roughly 7.7 billion objects and 4.5PB. No CDN caches that at every edge. The strategy uses popularity-based tiering: the top 1% of tracks (800K songs, about 45TB across all four tiers) are proactively pushed to all edge PoPs worldwide. The remaining 99% are served from S3 via CDN origin fetch on first request, then cached at the edge with a long TTL.

Lossless complicates that push. It is 69% of the bytes but a small minority of the plays, since it needs Premium, an opt-in, a wired or exact-transport output, and about 1.6 Mbps of headroom. Pushing all four tiers of the top 1% costs 45TB per PoP where the three lossy tiers cost 14TB, and most of that extra 31TB serves a listener who never arrives. The better shape is to pre-push the lossy rungs everywhere and let the FLAC rung populate on demand, accepting a first-request origin fetch for the few listeners entitled to it. They are on fast connections by definition, which is precisely the population that tolerates one cold fetch. Audio content is immutable (a new version of a song gets a new ID), so `Cache-Control: immutable` headers avoid unnecessary revalidation. This tiering keeps segment fetches for popular tracks in the tens of milliseconds at the edge while keeping CDN storage costs manageable.

**Recommendation Architecture:** The recommendation pipeline runs in four stages, the first two offline and the last two on the request path:
1. **Data collection:** Play events flow to Kafka, where Spark Streaming extracts features (which tracks a user played, skipped, saved, or added to playlists).
2. **Model training (nightly batch):** ALS (Alternating Least Squares) matrix factorization decomposes the 600M users x 80M tracks interaction matrix into 128-dimensional user taste vectors and track content vectors.
3. **Storage:** User and track vectors are stored in Redis for fast retrieval.
4. **Serving:** For a given user, the system finds tracks with the highest cosine similarity to the user's taste vector using Annoy (Approximate Nearest Neighbors), Spotify's own ANN library. Brute-force cosine similarity over 80M tracks would take seconds. Annoy returns results in single-digit milliseconds.

**Search with Popularity Boost:** Elasticsearch runs a multi-match query across title, artist, and album fields. Results are sorted by a combination of text relevance score and a `popularity` field (derived from play count and recency), ensuring that the most relevant AND most popular results appear first. Fuzzy matching with edit distance 2 catches common typos. The typeahead/autocomplete feature uses an edge n-gram tokenizer so that partial prefixes match immediately as the user types.

---
