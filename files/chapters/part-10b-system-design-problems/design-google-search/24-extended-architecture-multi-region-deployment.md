## Extended Architecture: Multi-Region Deployment

Serving search queries from a single data center introduces unacceptable latency for users on distant continents and creates a single point of failure. The solution is to deploy fully independent, self-contained regions, US, EU, and AP, each holding a complete replica of the index so that every query is answered locally without cross-region round trips. Anycast DNS routes each user to the nearest region at the IP routing level, and Kafka fans index updates out to all three regions in parallel so that freshly crawled content propagates globally within seconds rather than requiring a coordinated cross-region write.

```
                    ┌──────────────────┐
                    │  Anycast DNS     │
                    └──────┬───────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  US Region   │ │  EU Region   │ │  AP Region   │
   │              │ │              │ │              │
   │  Query Svrs  │ │  Query Svrs  │ │  Query Svrs  │
   │  Index Shards│ │  Index Shards│ │  Index Shards│
   │  Autocomplete│ │  Autocomplete│ │  Autocomplete│
   │  Redis Cache │ │  Redis Cache │ │  Redis Cache │
   │  Crawlers    │ │  Crawlers    │ │  Crawlers    │
   └──────────────┘ └──────────────┘ └──────────────┘

Each region has a FULL copy of the index (replicated via Kafka).
Queries always served locally: no cross-region calls during search.
Crawlers distributed globally for politeness (crawl from nearest region).
Index updates: crawl results -> Kafka -> all regions index in parallel.
PageRank: computed centrally, distributed to all regions.
```

---
