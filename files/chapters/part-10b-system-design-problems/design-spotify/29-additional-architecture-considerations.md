## Additional Architecture Considerations

### Content Delivery Strategy

The audio delivery architecture uses a multi-tier caching strategy:

1. **Client Cache**: Mobile app caches recently played segments (up to 1GB configurable). Listening is heavily repetitive, so this absorbs a meaningful share of requests before they ever reach the network.
2. **Edge PoP Cache (CDN)**: 200+ global PoPs cache popular segments. Eviction policy: LRU with frequency boost (LFU-hybrid). Hot tracks pinned for 24 hours.
3. **Regional Origin Cache**: Mid-tier cache in each region (US-East, EU-West, AP-South, etc.) absorbs cache misses from edge. Holds top 20% of catalog.
4. **Primary Origin (S3)**: Complete catalog in multi-region S3. Only accessed for cache misses on long-tail content.

### Audio Fingerprinting for Content Moderation

Incoming audio uploads (for podcasts and user-generated playlists) are fingerprinted using Chromaprint/AcoustID:

- Detect duplicate uploads and copyright violations before publishing
- Cross-reference against a database of copyrighted works
- Automated takedown for matches above 95% similarity threshold
- Manual review queue for 80-95% similarity (potential covers, remixes)

The two-tier threshold is the whole design. A fingerprint match is evidence, not a verdict, and a licensed cover version matches the original strongly enough to trip a naive filter. Auto-removing everything above the bar would take down legitimate content and hand an artist a takedown notice for their own licensed recording, so the ambiguous band routes to humans instead.

---
