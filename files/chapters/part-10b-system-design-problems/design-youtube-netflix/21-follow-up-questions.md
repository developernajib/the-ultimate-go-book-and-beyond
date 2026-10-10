## Follow-up Questions

These rapid-fire questions test whether you can extend your design beyond the core requirements. Interviewers use them to probe the boundaries of your knowledge, so you do not need deep answers, a few sentences showing you understand the approach is sufficient. Each answer below is intentionally brief to model what a strong 30-second response looks like.

**1. Live streaming?** RTMP or SRT ingest, real-time transcode, sliding-window HLS manifest, short segments. Sub-second needs LL-HLS or WebRTC, not plain HLS.

**2. Per-title encoding?** Netflix's published approach: encode a title at many resolution and bitrate combinations, score each with VMAF, and derive that title's ladder from the resulting quality curve instead of applying one fixed ladder to everything. Their later dynamic optimizer work pushes the same idea to shot level. Costs hours of compute per title, pays back on every stream.

**3. Watch party?** WebSocket room, host authority, clients adjust speed 0.95-1.05x to sync.

**4. Copyright claims?** Perceptual fingerprinting plus LSH lookup against a rights-holder reference database, which is what YouTube's Content ID does. Policy per claim: monetize, track, or block. The hard part is the dispute flow, since a match cannot distinguish infringement from fair use.

**5. Thumbnail generation?** 1 frame/sec, ML scoring, top 3 candidates, custom upload option.

**6. Peak traffic?** 2x CDN pre-scale, multi-CDN, degrade to 1080p max, auto-scale workers.

**7. Emerging markets?** Low default rung, more efficient codecs (HEVC, AV1) where the device can decode them in hardware, audio-only variant, Wi-Fi-only smart downloads. Check hardware decode support before assuming a codec: software decoding AV1 on a budget phone drains the battery and drops frames.

**8. Video chapters?** JSON metadata, seek bar markers, auto-detection via speech-to-text NLP.

**9. Device consistency?** Capability detection filters manifest to supported qualities only.

**10. Creator analytics?** Kafka -> Flink -> ClickHouse time-series. Views/hour, retention curve, traffic sources.


---
