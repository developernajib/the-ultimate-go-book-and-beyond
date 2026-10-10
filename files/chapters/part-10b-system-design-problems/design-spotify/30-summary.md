## Summary

The table below summarizes which technology powers each major component of the system. When discussing your design in an interview, this kind of concise mapping helps the interviewer see that you understand not just what to build, but which tool is the right fit for each job. Each choice is driven by the specific access pattern and scale requirements of that component.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Audio storage | S3 (segmented, 3 Vorbis + FLAC) | Multi-quality + lossless delivery |
| Audio delivery | CDN (Akamai/Cloudflare) | Low-latency streaming |
| Catalog/Search | Elasticsearch | Track/artist/album search |
| Recommendations | Spark ALS + Redis vectors | Personalized discovery |
| Playlists | PostgreSQL | User collections |
| Play history | Kafka → partitioned DB | Events + royalties |
| User vectors | Redis (128-dim embeddings) | Taste representation |
| Vector retrieval | Annoy / FAISS (ANN index) | Sublinear similarity search |
| Playback state | Redis + Pub/Sub (CAS on write) | Spotify Connect sync |
| Friend activity | Redis (fan-out on read) | Real-time social sidebar |
| Royalties | Spark batch, integer minor units | Auditable pro-rata payouts |
| Offline downloads | Pre-signed S3 URLs + AES-GCM + expiring license | Premium feature |


---
