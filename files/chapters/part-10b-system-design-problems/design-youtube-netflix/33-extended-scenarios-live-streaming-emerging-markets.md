## Extended Scenarios: Live Streaming and Emerging Markets

### Adding Live Streaming (YouTube Live)

Live streaming differs from video-on-demand in three key ways: the content is being created in real time, latency must be minimized (2-10 seconds for interactive streams), and the manifest is a sliding window rather than a static file.

1. **Ingest**: Streamer sends RTMP (or SRT, which handles lossy networks far better) to the nearest ingest server
2. **Real-time transcode**: Produce 3-4 rungs simultaneously. Encoding must beat realtime or the stream falls behind permanently, which rules out the slow presets and, usually, 4K
3. **Sliding HLS manifest**: New 2-second segments appended continuously, manifest lists a rolling window of recent segments. Note the trade against VOD's 6 seconds: shorter segments cut latency and cost compression efficiency, and the player cannot buffer ahead of a stream that does not exist yet. Going below a few seconds means LL-HLS with partial segments, or WebRTC if you need sub-second
4. **CDN push**: Each new segment is pushed to CDN edge as soon as it is ready, rather than waiting for a pull
5. **Chat integration**: Separate WebSocket service for live chat, messages are ephemeral and not stored after stream ends
6. **DVR mode**: Allow viewers to rewind by keeping completed segments on CDN (converts live to VOD on completion)

### Optimizing for Emerging Markets

Users in regions with limited bandwidth and older devices need a different streaming strategy:

1. **Default to a lower rung**: Start at 240p/360p so playback begins instead of buffering. The ABR controller climbs from there if the link allows
2. **More efficient codecs**: HEVC and AV1 buy meaningfully lower bitrate at equal quality against H.264, with the usual cited range around 30-50% depending on content and settings. The catch that matters here: check for **hardware** decode support. Software-decoding a modern codec on a budget phone burns battery and drops frames, so you have traded bandwidth the user could not spare for CPU they also could not spare. Keep an H.264 ladder for devices without it
3. **Audio-only variant**: For 2G/3G users who want to listen rather than watch
4. **Wi-Fi smart downloads**: Pre-fetch recommended content on Wi-Fi, which converts a bandwidth problem into a storage problem, and storage is the one resource these devices have
5. **Shorter segments**: 2 seconds rather than 6 lets ABR react faster on an unstable link. This is a genuine trade and not a free win, since shorter segments compress worse and multiply request overhead, both of which hurt most on exactly the connections you are trying to help. Measure it rather than assuming
6. **Regional edge priority**: Deploy PoPs in underserved regions and partner with local ISPs to embed caches, the same model as Netflix's Open Connect. In markets where transit is expensive and scarce, this is worth more than every client-side optimization above combined
