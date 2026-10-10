## Capacity Estimation

Before designing any system, you need to understand the scale you are building for. Capacity estimation translates business requirements like "1 trillion impressions per day" into concrete engineering numbers such as requests per second, storage per day, and memory requirements. These numbers drive every architectural decision, from how many servers you need to which database can handle the write throughput. Getting these estimates right early prevents costly redesigns later.

```
Impressions/day:    1T → 11.6M/sec
RTB auctions/sec:   11.6M/sec
Bid requests/sec:   11.6M × 10 DSPs = 116M bid requests/sec
Ad click rate:      0.5% → 58K clicks/sec
Conversion rate:    2% of clicks = 1,160/sec
Storage:
  Impressions:      1T × 100B = 100TB/day
  Clicks:           5B/day × 100B = ~500GB/day
  Budget:           10M campaigns × 64B = 640MB in Redis
```

The 11.6M/sec figure comes from dividing 1 trillion by 86,400 seconds in a day. In practice, traffic is not uniformly distributed, peak hours in the US (6-10 PM EST) can see 2-3x the average, so the system must handle roughly 25-30M auctions/sec at peak. The bid request multiplier assumes an average of 10 DSPs participate per auction, though in practice, geographic filtering and content category exclusions mean only 5-10 DSPs actually bid on any given impression.

Each impression log entry contains the auction ID, winning ad ID, campaign ID, user ID, domain, win price, fraud flag, and timestamp, roughly 100 bytes. At 1 trillion impressions per day, this produces 100TB of raw log data daily, which is why ClickHouse (with its columnar compression achieving roughly 10:1 ratios on this type of data) is essential rather than a row-oriented database. The click volume is 200x smaller than impressions, but clicks are far more valuable per event because they drive billing and attribution.

Budget state in Redis is compact: each campaign needs its daily budget, remaining balance, and spend counter, roughly 64 bytes per campaign. With 10 million active campaigns, the total Redis footprint for budget tracking is only 640MB, which easily fits in a single Redis instance's memory. However, the operations-per-second requirement (millions of atomic budget checks and deductions) necessitates a Redis cluster with multiple shards.

---
