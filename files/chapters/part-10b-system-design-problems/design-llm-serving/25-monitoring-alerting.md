## Monitoring & Alerting

Monitoring LLM infrastructure requires metrics that traditional web services do not track. Standard HTTP latency percentiles are not sufficient because LLM requests have two distinct latency phases: the prefill phase (processing all input tokens) and the decode phase (generating output tokens one by one). You need dedicated metrics for each phase, plus GPU-specific health indicators like memory utilization, temperature, and compute occupancy. The alert thresholds below are tuned for a production 70B model deployment and should be adjusted based on your specific SLA targets.

### Key Metrics Table

| Metric | Description | Alert Threshold | Dashboard |
|--------|-------------|-----------------|-----------|
| `llm.ttft_p99` | Time to first token (P99) | > 5s | Latency |
| `llm.tpot_p99` | Time per output token (P99) | > 100ms | Latency |
| `llm.request_latency_p99` | Total request latency (P99) | > 30s | Latency |
| `llm.tokens_per_sec` | Total tokens generated per second (cluster) | < 80% capacity | Throughput |
| `llm.batch_size_avg` | Average continuous batch size | < 4 (underutilized) | Throughput |
| `gpu.memory_utilization` | GPU memory used / total | > 95% | GPU Health |
| `gpu.compute_utilization` | GPU SM occupancy | < 50% (underutilized) | GPU Health |
| `gpu.temperature` | GPU temperature (Celsius) | > 85C | GPU Health |
| `kvcache.utilization_pct` | KV cache blocks allocated / total | > 90% | Memory |
| `kvcache.prompt_cache_hit_rate` | Prompt cache hit ratio | < 30% | Memory |
| `kvcache.eviction_rate` | Prompt cache evictions per minute | > 100/min | Memory |
| `router.queue_depth` | Pending requests in router queue | > 100 | Routing |
| `router.preemption_rate` | Requests preempted due to memory | > 5% | Routing |
| `autoscaler.gpu_count` | Total active GPU instances | Budget threshold | Cost |
| `autoscaler.spot_interruption` | Spot instance interruptions | > 2/hour | Cost |
| `billing.tokens_metered` | Tokens billed per minute | Anomaly detection | Revenue |
| `ratelimit.rejected_rate` | Rate-limited request percentage | > 10% | Traffic |

### Dashboard Recommendations

1. **Latency Dashboard**: TTFT and TPOT histograms, latency by model size, prefill vs decode phase timing, queue wait time breakdown.
2. **GPU Dashboard**: Per-GPU memory/compute utilization, temperature, power draw, KV cache pressure, batch occupancy.
3. **Throughput Dashboard**: Tokens/sec per node, requests/sec, batch size distribution, prefill vs decode ratio, input/output token length distributions.
4. **Cost Dashboard**: GPU hours consumed, cost per 1M tokens, spot vs on-demand utilization, idle GPU detection, prompt cache savings.
5. **Traffic Dashboard**: Requests by model/customer, rate limiting events, queue depth, geographic distribution, peak traffic patterns.

### Alerting Rules

The Prometheus alerting rules below encode the operational thresholds from the table above into actionable alerts. Each rule uses a `for` duration to suppress transient spikes, GPU memory, for example, must stay above 95% for two full minutes before paging an on-call engineer, filtering out brief allocation bursts during large batch prefills. The `SpotInterruption` alert deliberately uses `for: 0m` so it pages the moment the hourly interruption count crosses two, because a cluster losing spot capacity needs immediate failover decisions.

```yaml
groups:
  - name: llm_serving_critical
    rules:
      - alert: HighTTFT
        expr: histogram_quantile(0.99, rate(llm_ttft_seconds_bucket[5m])) > 5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "P99 time-to-first-token exceeds 5 seconds"

      - alert: GPUMemoryPressure
        expr: gpu_memory_utilization > 0.95
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "GPU memory utilization above 95% - risk of OOM"

      - alert: KVCacheExhaustion
        expr: kvcache_utilization_pct > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "KV cache utilization above 90% - preemptions likely"

      - alert: GPUTemperatureHigh
        expr: gpu_temperature_celsius > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU temperature exceeds 85C - throttling risk"

      - alert: SpotInterruption
        expr: increase(autoscaler_spot_interruptions_total[1h]) > 2
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Frequent spot interruptions - migrate to on-demand"
```

---
