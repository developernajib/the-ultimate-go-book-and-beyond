## Extended Capacity Planning

This section breaks down the real-world cost of running a 10,000-pages-per-second crawler on AWS. Understanding these numbers is essential for system design interviews because interviewers often ask "how much would this cost?" or "where would you optimize spending?" The dominant costs are storage (accumulating petabytes of raw content), the worker fleet, and the Redis cluster holding the exact dedup set.

The headline is the one that surprises people: **on AWS, the 86.4TB per day this crawler downloads costs nothing in data transfer.** Ingress from the internet is $0.00/GB in every commercial region. A crawler is almost pure ingress, which makes it one of the rare workloads whose defining resource is free. Charging it at some per-GB rate, as a generic "ISP cost" estimate would, produces a bandwidth line that dwarfs the real bill and is entirely fictional.

That free ingress has one enormous asterisk, and it is worth more in an interview than any instance-type trivia. **The bandwidth is free only if the packets do not cross a NAT Gateway.** Put the workers in private subnets behind NAT, which is the default posture in most well-architected VPCs, and every one of those gigabytes attracts a $0.045/GB data processing charge. That is $3,888 per day, more than twice the entire rest of the system combined, to route traffic that would otherwise be free. The fix is architectural rather than clever: give the crawler fleet public subnets with public IPv4 addresses (at $0.005 per address-hour, so $24/day for 200 of them) and let it egress directly. A crawler is a workload where the network topology, not the code, is the biggest line item.

```
Full crawl capacity at 10K pages/sec:

Worker fleet:
  200 c6g.xlarge instances (4 vCPU, 8GB)
  Each: 50 goroutines, 50 pages/sec
  Cost: $0.15/hr x 200 = $30/hr = $720/day

Network:
  Inbound: 10K pages/sec x 100KB = 1GB/sec = 86.4TB/day
  AWS ingress from internet: $0.00/GB = $0/day
  Public IPv4: 200 x $0.005/hr = $24/day
  (behind a NAT Gateway instead: 86,400GB x $0.045 = $3,888/day)

Storage:
  Raw HTML (compressed): 10K x 20KB x 86400 = 17.3TB/day
  S3 Standard: $0.023/GB/month
  30 days hot: 519TB x $0.023 = $12K/month = $398/day
  Move to Glacier after 30 days: 519TB x $0.004 = $2K/month

Metadata (PostgreSQL):
  16 shards on db.r6g.xlarge (4 vCPU, 32GB)
  Each shard: ~625M URL records, ~100GB
  Cost: $0.48/hr x 16 = $7.68/hr = $184/day

Redis (exact seen-set + crawl-delay cache):
  20 cache.r6g.2xlarge nodes (~52GB each)
  Total memory: ~1TB for 10B URL keys
  (the 12GB bloom filter lives in worker RAM, not here)
  Cost: ~$0.73/hr x 20 = $14.60/hr = $348/day

Kafka:
  3 kafka.m5.2xlarge brokers
  1000 partitions, RF=3
  Cost: ~$3/hr x 3 = $9/hr = $216/day

Total daily cost: ~$1,900/day (~$57K/month)
  workers $720 + storage $398 + Redis $348 + Kafka $216
  + PostgreSQL $184 + IPv4 $24 + bandwidth $0
Total for one full 11.5-day crawl pass: ~$22K
Same design behind a NAT Gateway: ~$5,800/day (~$173K/month)

Optimization opportunities:
  - Spot instances for workers: ~65% savings = $252/day instead of $720
  - S3 Intelligent Tiering: auto-moves cold data
  - Reserved instances for always-on components (DB, Redis, Kafka): 30% savings
  - Optimized: ~$1,200/day (~$36K/month), roughly 37% off
```

Two notes on reading this table. The Redis line is sized for the exact seen-set at the chapter's own figure of roughly 100 bytes per URL, so 10 billion URLs need about 1TB, not the 520GB a smaller node type would give you. The Bloom filter is not in Redis at all, it is 12GB of heap inside each worker process. And the storage line is a steady-state figure for 30 days of hot data. It is the one cost that grows with every pass rather than resetting, so on a long enough horizon it, not the fleet, is what you are really paying for.
