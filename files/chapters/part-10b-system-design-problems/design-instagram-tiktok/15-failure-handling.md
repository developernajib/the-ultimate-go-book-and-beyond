## Failure Handling

Designing for failure is what separates a production system from a whiteboard sketch. At Instagram/TikTok scale, components fail constantly: servers crash, network partitions happen, and queues back up. This section describes how to make each subsystem resilient so that individual failures degrade gracefully rather than causing cascading outages.

### Media Processing Recovery

The media processing pipeline is the most failure-prone component because it involves heavy computation (FFmpeg transcoding), large file transfers, and external service calls. The recovery strategy uses SQS visibility timeouts for automatic retries, dead letter queues for persistent failures, and checkpointing at each pipeline stage so that retries resume from where they left off rather than starting over.

```
Most failure-prone component. Recovery strategy:

1. SQS visibility timeout: if worker doesn't ACK in 10 min, message reappears
2. Dead letter queue: after 3 retries, move to DLQ
3. Partial processing: if thumbnail OK but transcode fails, publish with thumbnail + retry
4. User notification: if DLQ, notify to re-upload

Pipeline stages (each independently retryable):
  Stage 1: Download from S3
  Stage 2: Content moderation
  Stage 3: Resize/transcode
  Stage 4: Generate thumbnail
  Stage 5: Upload processed files
  Stage 6: Update metadata with CDN URLs
  Stage 7: Fan-out to feeds

Each stage checkpoints to S3. On retry, resume from checkpoint.
```

### Feed Cache Failure

Losing the Redis feed cache is a high-impact event because it forces every feed read to fall back to the expensive pull model, increasing latency from ~20ms to ~200ms. The mitigation strategy relies on Redis cluster replication for prevention and a background rebuild process for recovery. Understanding this failure mode is important because interviewers often ask "what happens when your cache goes down?" to test your understanding of graceful degradation.

```
If Redis feed cache lost:
  Immediate: all reads use pull model (~200ms vs 20ms)
  Background: rebuild for active users (10K/sec, ~14 hours full)
  Prevention: Redis cluster with 3 replicas, separate clusters per concern
```

---
