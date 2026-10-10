## Summary

The table below contrasts Netflix and YouTube across the components where they genuinely diverge, despite solving the same underlying problem. Interviewers ask for this comparison constantly, and the valuable version of the answer is never a list of technologies. It is the causal chain: **catalog shape determines everything else**. Netflix has a bounded catalog it licenses and controls, so it can afford 24 hours of encoding per title, can predict what a region will watch tonight, and must satisfy studio DRM terms. YouTube ingests 500 hours a minute from anyone, so it must encode in minutes, cannot predict a long tail that is mostly never watched, and moderates at a scale Netflix never faces. Nearly every row below follows from that one difference.

A word on sourcing, since candidates lose credibility here. Marked rows are publicly documented by the companies themselves. Everything else is a reasonable inference, and you should present it as one.

| Component | Netflix | YouTube |
|-----------|---------|---------|
| Ingest | Studio masters delivered under contract, no user uploads | User uploads, resumable multipart, integrity checked |
| Transcoding | Per-title encoding, hours per title, VMAF-optimized ladder *(public)* | Fast-path in minutes, standard ladder |
| CDN | Open Connect appliances embedded in ISP networks, predictive off-peak fill *(public)* | Google's own edge and backbone, reactive caching |
| Streaming protocol | DASH and HLS | HLS and DASH |
| Recommendations | Two-stage: candidate generation, then ranking | Two-stage funnel, ranker predicts expected watch time *(public, RecSys 2016)* |
| View counting | Eventually consistent, batched | Eventually consistent, batched |
| DRM | Widevine, FairPlay, PlayReady | Only where content requires it |
| Metadata store | Sharded relational, plus a wide-column store for history | MySQL scaled horizontally with Vitess, which YouTube built and open-sourced *(public)* |
| Resilience | Chaos Monkey and the Simian Army, EVCache *(public)* | Internal infrastructure |
| Search | Full-text search cluster | Internal ranking infrastructure |

**Scale numbers to remember:**
- 500 hrs/min uploaded → 15,000 transcoding workers needed
- 208 Tbps CDN egress → 68 EB/month, hundreds of millions of dollars at any commercial rate, which is why both companies built their own edge
- 11,574 recommendation queries/sec → pre-compute and cache
- ~8.6PB new storage per day → aggressive cold tiering, or storage alone outruns the business
- 95%+ CDN cache hit rate → origin servers get minimal traffic

**The failures to remember**, because they are what this chapter is really about. Almost nothing that breaks a video platform announces itself. The transcoder writes one key layout and the player reads another, so every job succeeds and every stream 404s. The ABR controller reads a buffer level nothing ever writes, so it silently pins to one rung forever. The moderation pipeline confuses confidence with severity and removes a video for containing a cat. The view counter counts one bot's refreshes ten thousand times. The notification fan-out inherits a request context, gets cancelled the instant the handler returns, and reports 202 Accepted to everyone. Search returns "no results" for the duration of an outage. In every one of those, the error rate stays at zero and the dashboards stay green.

The habit worth taking away is narrow and specific: when a component reports success, ask what it would look like if it were lying. Then go and check the output rather than the status code.


---
