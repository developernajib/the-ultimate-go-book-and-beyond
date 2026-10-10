## Scaling Strategy

Scaling an LLM serving cluster requires balancing GPU cost against latency guarantees. The strategy below combines several techniques: routing simple queries to smaller (cheaper) models, using predictive auto-scaling to handle the 5-7 minute GPU startup delay, caching prompt prefixes to avoid redundant computation, and deploying across multiple regions to reduce network latency. Spot instances provide significant cost savings for workloads that can tolerate occasional interruptions.

```
GPU Cluster: 70B on 2xA100 workers (625 GPUs for the ~50% of traffic routed there), 7B on 1xA100 (50 GPUs serving the other ~50%)
Smart Routing: BERT classifier routes simple queries to 7B, complex to 70B
Auto-Scaling: 5-7min startup + 2min model load, predictive scaling 15min ahead
Prompt Cache: SHA256(model+system_prompt), 40% hit rate, NVMe storage (32GB/s), LRU eviction
Multi-Region: US/EU/APAC, model weights in regional S3, no cross-region forwarding
Spot Instances: 60-80% savings for batch/async workloads
```

---
