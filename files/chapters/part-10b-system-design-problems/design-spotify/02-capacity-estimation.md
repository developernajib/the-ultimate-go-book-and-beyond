## Capacity Estimation

Before diving into the design, you need to estimate the scale of the system. Capacity estimation helps you choose the right storage technology, determine how many servers you need, and identify which components will be bottlenecks. The numbers below are based on Spotify's publicly reported statistics and reasonable assumptions about user behavior.

```
Users:              600M total, 200M daily active (DAU)
Concurrent streams: 50M at peak
Songs total:        80M × 4.8MB avg (160kbps, 4min) = 384TB at one bitrate
Lossy rungs:        (96+160+320) kbps × 4min = 17.3MB/track × 80M = 1.4PB
Lossless rung:      FLAC ~1300 kbps × 4min = 39.0MB/track × 80M = 3.1PB
Catalog total:      56.3MB/track × 80M = 4.5PB
Streams/sec:        50M concurrent streams / 10s segments = 5M segment req/sec
Search QPS:         200M DAU × 20 searches/day / 86400 = 46K/sec
Play events:        200M × 25 plays/day = 5B play events/day
```

The lossless rung deserves its own line rather than a footnote, because it is 69% of the catalog on its own. One rung outweighs the other three put together by better than two to one, and the reason is worth internalizing: the lossy ladder squeezes the source by 7x to 22x, so all three rungs together are nearly free, while FLAC only reaches 1.6x and still carries 61% of the master. Adding a tier that sounds like a modest product change more than tripled the storage footprint, from 1.4PB to 4.5PB.

That 1300 kbps is derived, not quoted. Spotify publishes no bitrate for lossless and cannot, because FLAC is variable and the answer depends on the music: a sparse acoustic track compresses far better than a loud, dense master. So the number comes from the ceiling. Stereo PCM at 24-bit/44.1 kHz is 2117 kbps, FLAC typically returns about 60% of that on real masters, and 60% of 2117 is roughly 1300. Plan with that and treat any single track as free to miss it in either direction. If you are ever asked for Spotify's lossless bitrate in an interview, the honest answer is that the question has no single number, and explaining why earns more than a confident wrong figure.

---
