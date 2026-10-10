## Capacity Estimation

Before designing any system, you need to understand the scale you are working with. Capacity estimation helps you choose the right technologies, plan storage, and determine how many machines you need. The numbers below drive every architectural decision in this chapter, from the number of crawler workers to the size of the Bloom filter. Getting these estimates wrong means either over-provisioning (wasting money) or under-provisioning (failing to meet throughput targets).

```
Pages to crawl:     10B pages
Throughput target:  10K pages/sec
Time for full pass: 10B / 10K = 1M seconds ≈ 11.5 days
Avg page size:      100KB HTML
Network bandwidth:  10K × 100KB = 1GB/sec inbound
Storage (raw):      10B × 100KB = 1PB (compressed: ~200TB)
Storage (URLs):     10B × 100 bytes = 1TB
Workers needed:     10K req/sec / 50 req/sec per worker = 200 workers
Frontier size:      ~1B queued URLs at any time
```

---
