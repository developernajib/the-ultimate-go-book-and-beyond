## Capacity Estimation

**Write volume:**
- 500M tweets/day
- 500M / 86400 ≈ 5800 tweets/second (TPS)

**Read volume:**
- 150M DAU × 5 timeline views/day = 750M reads/day
- 750M / 86400 ≈ 8700 reads/second

**Ratio**: ~1.5:1 read:write (lower than typical, but tweets fan out)

**Storage:**
- Tweet: ~300 bytes (id, user, text, media refs, timestamp)
- 500M × 300 bytes = 150 GB/day
- 55 TB/year


### Junior → FAANG: Capacity Estimation Fundamentals

Capacity estimation is an exercise in order-of-magnitude reasoning, not precision arithmetic. The goal is to size your components correctly and identify potential bottlenecks before designing around them. Know the key numbers: a modern server handles roughly 10k-100k requests per second depending on workload, an SSD read is around 0.1ms, a disk read is around 10ms, a network round-trip within a data center is under 1ms. Memorize these and use them to sanity-check your estimates. The common junior mistake is either skipping estimation entirely or spending too long on it. Aim for a 5-10 minute estimation phase that produces a rough QPS number, a storage estimate, and a bandwidth estimate.

### Senior @ FAANG: Estimation as a Tool for Design Decisions

Senior engineers use estimation to drive design decisions, not to produce a number. If your QPS estimate exceeds what a single database can handle, that directly motivates sharding or a read replica strategy. If your storage estimate grows to petabytes over five years, that motivates a tiered storage policy. At the L6 bar, interviewers expect you to draw a line from the estimate to a concrete design constraint and then to a technology choice. Staff-level thinking extends to cost estimation: what does this system cost to run at stated scale, how does cost scale with growth, and where are the cost cliffs (e.g., egress costs, licensing thresholds). Including cost in your estimation signals awareness of real-world platform economics. In an ADR context, capacity estimates belong in the context section and influence which alternatives are viable.
