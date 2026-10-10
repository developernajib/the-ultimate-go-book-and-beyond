## Extended Scenarios

### Handling a Trending Query Spike

When a breaking news event causes a query to spike (e.g., "earthquake"):

1. **Query cache absorbs initial load**: Popular queries served from Redis (5-min TTL)
2. **Auto-scale query servers**: CPU-based autoscaling adds capacity within 2 minutes
3. **News index fast-path**: Dedicated news crawlers detect trending queries, prioritize crawling related pages
4. **Result blending**: Insert "Top Stories" block above regular results for queries with news intent
5. **Autocomplete update**: Trending query immediately promoted in autocomplete rankings

### Handling Index Corruption

If an index segment becomes corrupted:

1. **Health check detects**: Each shard runs periodic checksum validation
2. **Automatic failover**: Query routing switches to replica shard
3. **Rebuild from source**: Corrupted segment rebuilt from SSTable backup in cloud storage
4. **Validation**: New segment compared against healthy replica before activation
5. **Total recovery time**: < 30 minutes per corrupted segment


---
