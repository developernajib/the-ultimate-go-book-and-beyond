## Extended Capacity Planning

This detailed breakdown helps you choose the right instance types and estimate monthly costs. Notice that CPU utilization is very low because trie lookups are fast pointer chases through memory. The real bottleneck is RAM, which determines how many terms each server can hold. Understanding these numbers lets you right-size your infrastructure and avoid both over-provisioning and surprise scaling events.

```
Detailed capacity breakdown at 100K QPS:

Memory per server (20 servers):
  In-memory trie:       15GB (50M terms x ~300 bytes avg per term with top-K)
  Connection overhead:  2GB (goroutine stacks, buffers)
  Application code:     500MB
  OS/runtime:           500MB
  Total per server:     18GB -> use 32GB instances

CPU per server:
  Trie lookup: ~5us per request
  JSON serialization: ~2us per request
  Total per request: ~7us
  5000 QPS per server x 7us = 35ms of CPU per second = ~3.5% utilization
  CPU is NOT the bottleneck (memory is)

Network per server:
  Request: ~200 bytes (prefix + headers)
  Response: ~500 bytes (10 suggestions)
  5000 QPS x 700 bytes = 3.5MB/sec per server
  Network is NOT the bottleneck

Redis cluster (6 nodes):
  Storage: 20GB (50M precomputed prefix results)
  Ops/sec: ~50K reads, ~5K writes
  Memory per node: 4GB of data -> use 16GB instances for headroom

Cost estimate (AWS):
  20x r6g.xlarge (32GB, 4 vCPU): $0.30/hr x 20 = $6/hr = $4,320/month
  6x r6g.large Redis (16GB): $0.21/hr x 6 = $900/month
  Kafka (3 brokers): ~$1,500/month
  Total infrastructure: ~$7,000/month for 100K QPS autocomplete
```


---
