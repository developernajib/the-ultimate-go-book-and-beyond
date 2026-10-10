## Performance Testing Checklist

| Test | Target | Method |
|------|--------|--------|
| Query latency P50 | < 100ms | Load test with real query distribution |
| Query latency P99 | < 500ms | Include long-tail queries |
| Autocomplete latency P99 | < 50ms | Measure prefix lookup + render |
| Crawl throughput | > 40K pages/sec | Distributed crawler benchmark |
| Index build time | < 4 hours for full rebuild | Measure distributed indexing pipeline |
| PageRank convergence | < 50 iterations | Test with real web graph sample |
| Spell correction accuracy | > 85% | Evaluate against ground truth dataset |
| Query cache hit rate | > 40% | Monitor with production query mix |
| Shard query fan-out latency | < 50ms per shard | Benchmark with all shards active |
| Index freshness | < 1 hour for news sites | Measure time from page change to indexing |

---
