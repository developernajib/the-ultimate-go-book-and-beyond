## Performance Characteristics

Understanding the expected performance numbers for each component helps you validate your design choices and set realistic SLOs (Service Level Objectives). These figures represent what a well-tuned production system should achieve at Spotify's scale. When discussing your design in an interview, citing specific latency targets and throughput numbers demonstrates that you think about real-world constraints, not just theoretical architecture.

```
Audio Streaming:
  - Segment size: ~1.6MB (10s FLAC lossless), ~400KB at 320kbps, ~120KB at 96kbps
  - CDN edge latency: 10-50ms (P99)
  - Origin fetch: 100-300ms (cache miss)
  - Startup latency (time to first audio): < 500ms (P95)
  - Buffer target: 3-5 segments ahead (30-50 seconds)
  - Gapless transition gap: 0 samples (encoder padding trimmed via manifest)

Search (Elasticsearch):
  - Index size: 80M tracks, 10M artists, 5M albums
  - Query latency: < 100ms (P95) for prefix search
  - Autocomplete latency: < 50ms (P95)
  - Index update lag: < 30 seconds for new releases

Recommendations:
  - Vector store: 600M user vectors + 80M track vectors
    @ 128 dims x float32 = ~350GB in Redis
  - Inference latency: < 100ms for top-50 recommendations
  - Model retraining: nightly batch, ~4-hour ALS run on Spark
  - Audio feature extraction: ~2 seconds per track (Mel spectrogram + CNN)

CDN Performance:
  - Cache hit rate (top 1% tracks): > 99%
  - Cache hit rate (top 20% tracks): > 95%
  - Cache hit rate (long tail): ~60%
  - Overall cache hit rate: ~90% (weighted by plays)
  - Edge PoP count: 200+ globally
  - Egress: ~1.9Tbps average, ~11Tbps peak (5% of plays lossless)
  - Origin bandwidth: ~190Gbps (the ~10% that misses the edge)

Data Pipeline:
  - Play events ingested: ~58K events/sec average, ~175K/sec peak
  - Kafka throughput: ~35MB/sec peak across play event topics (~200B/event)
  - Royalty calculation: 150B events/month processed in 4-hour nightly batch
  - User listening history: retained 3 years for recommendation training
```

---
