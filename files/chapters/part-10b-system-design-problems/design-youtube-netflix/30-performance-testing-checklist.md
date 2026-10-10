## Performance Testing Checklist

Before launching a video streaming platform at scale, verify these performance benchmarks:

| Test | Target | Method |
|------|--------|--------|
| Upload throughput | 500hr/min sustained | Load test with synthetic video files |
| Resumable upload | Part retry after a killed connection | Drop the socket mid-upload, resume, verify the assembled object's checksum |
| Transcoding latency | < 15 min for 1hr video | Benchmark FFmpeg across the full ladder |
| **Playback end to end** | **Every rung plays** | **Transcode a real file, then fetch the master playlist, every media playlist, and a sample of segments through the CDN. This is the test that catches a key-layout mismatch, and no unit test will.** |
| Keyframe alignment | IDR on the segment grid, all rungs | `ffprobe` the segment boundaries per rung and diff them |
| Time to first byte | < 200ms from edge | Measure at the CDN, per PoP |
| Time to first frame | < 2s | Measure in a real player, cold cache, from target markets |
| ABR quality switch | Within 1 segment (6s) | Throttle bandwidth mid-stream, confirm it drops fast and climbs slowly |
| ABR cold start | Watchable, no rebuffer | Start a session with an empty estimator on a slow link |
| CDN cache hit rate | > 95% | Monitor hit/miss ratio at PoPs |
| Search latency P99 | < 200ms | Load test Elasticsearch with real queries |
| Search failure mode | Errors, never empty results | Kill Elasticsearch mid-test, confirm the API returns 5xx rather than "0 results" |
| Recommendation latency P99 | < 100ms | Benchmark Redis cache + fallback |
| Concurrent streams | 41.7M simultaneous | Estimate from CDN capacity modeling |
| View count accuracy | Within 1% of actual | Replay a known event log, compare the aggregate. Include a duplicate-heavy replay |
| API error rate | < 0.1% | Chaos testing with service failures |

The bolded row is the most important line in this table. Most of what breaks a video platform never surfaces as an error: the transcode pipeline reports success and every segment 404s, search reports zero results throughout an outage, the counter faithfully counts one bot's refreshes. A test that asserts "no error was returned" is blind to all three. Assert on observed output, and drive the real path end to end.


---
