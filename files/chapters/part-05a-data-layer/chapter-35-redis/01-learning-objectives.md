## Learning Objectives

After completing this chapter, you will be able to:

1. **Use Redis data structures effectively** - Work with strings, hashes, lists, sets, sorted sets, and streams from Go
2. **Implement production caching** - Build cache-aside, write-through, and tagged caching patterns
3. **Build distributed coordination** - Implement distributed locking, rate limiting, and cross-process synchronization
4. **Design real-time features** - Use Pub/Sub and Streams for messaging and event delivery
5. **Optimize Redis throughput** - Apply pipelining, connection pooling, and cluster configurations
6. **Apply production patterns** - Implement patterns modeled on Twitter, Instagram, and Discord architectures

### Junior → FAANG: what these objectives really measure in your first year

Read these six objectives as interview questions, because that is exactly how they will show up. "Use Redis data structures effectively" is the phone screen where you are asked to build a rate limiter. "Implement production caching" is the take-home where you have to explain why `GET then SET` is wrong under concurrent load. "Build distributed coordination" is the whiteboard where you must say the phrase "SET key value NX EX" from memory and then defend it against clock skew. "Design real-time features" is the system design round where you draw a fanout service and decide between pubsub, streams, and a Kafka topic. "Optimize Redis throughput" is the follow-up where you explain why wrapping 1000 GETs in a goroutine-per-key is worse than a single pipelined round trip.

For each objective, the junior learning target is the mechanical skill. For each objective, the FAANG-level target is the failure mode. You will not be hired for knowing that `SET key value EX 3600` sets a key with a 1 hour TTL. You will be hired for knowing that if every key in your cache has the same TTL and was written during a deploy, every key will expire within the same second two hours later and your database will die. TTL jitter (randomize the TTL by 10 to 20 percent per key) is a one-line fix that ships to production every week at every FAANG, and the reason it keeps shipping is that new engineers keep forgetting it. Treat each objective below as a pair: learn the command, then learn the outage that teaches you why the command alone is not enough.

A concrete study path for your first 90 days. Week 1 to 2: install Redis locally, run every command in `redis-cli`, read the docs for each of the six data types, write a Go program that exercises each. Week 3 to 4: build a cache-aside wrapper around a slow function, then break it with concurrent requests and watch the stampede, then fix it with singleflight. Week 5 to 6: build a token-bucket rate limiter in Lua, deploy it behind an HTTP handler, load-test it with hey or vegeta, and watch the p99 latency. Week 7 to 8: set up Redis Sentinel in Docker Compose, kill the primary, watch go-redis fail over, then set up Redis Cluster and repeat. Week 9 to 12: read the source of go-redis's `Pipeline` implementation and the source of rueidis's auto-pipelining, and you will understand more about Redis clients than most senior engineers.

### Senior @ FAANG: what these objectives omit and what you must add

The published objective list is deliberately neutral because it is pedagogical. The staff-level objectives that the book does not state out loud are the ones you must carry into architecture reviews.

**Objective seven: write the cache-invalidation ADR before the first line of code.** Every caching strategy is a choice among TTL-only, event-driven invalidation via PubSub, explicit invalidation on write from the application, and CDC (Change Data Capture) from the database via Debezium or a native stream like Postgres logical replication. TTL-only is cheapest and most wrong. Event-driven via PubSub loses messages on client disconnect and is therefore a best-effort supplement, not a correctness mechanism. Application-level invalidation works until a second writer bypasses your cache layer (a batch job, another service, a human running a SQL console). CDC from the database is the only mechanism that survives all writers, and it is the mechanism that Shopify, Airbnb, and Netflix have converged on for any cache that backs a customer-visible read path. The ADR must state which mechanism covers which keyspace and what happens when the invalidation stream is down (fall back to TTL, serve stale with a header, or hard-fail).

**Objective eight: define the durability class of every Redis keyspace.** Classify each prefix as derived (cache, rebuildable from source of truth), ephemeral (rate limits, session tokens, acceptable to lose on failover), durable (job queues, must survive restart, require AOF-everysec minimum), or authoritative (last writes, require Active-Active CRDT or a different store entirely). The ADR must say that authoritative state does not belong in Redis unless you have paid for Enterprise Active-Active, and even then you must accept the convergence semantics.

**Objective nine: own the capacity model.** Redis memory usage is working-set plus replication backlog plus client-output buffers plus COW overhead during RDB. A 64 GB box holds at most 40 GB of working set before you start paying in latency spikes from fork-and-copy-on-write during BGSAVE. Plan at 50 percent headroom, alert at 70 percent, page at 80 percent. When you cross 100 GB of working set on a single primary, you are no longer debating whether to shard. You are debating how soon.

**Objective ten: own the client contract.** Every service in the org should pick exactly one of go-redis/v9 or rueidis per latency tier and enforce it in the monorepo lint rules. Mixing clients doubles the on-call surface. Every service must set: per-command context deadline (never rely on the client default), pool size sized to roughly `2 * GOMAXPROCS` for typical workloads, dial timeout under 500ms, read and write timeouts under the SLO, idle timeout below the load-balancer idle timeout, and explicit retry policy with jitter. These are boilerplate, but "we lost a region because nobody set a read timeout and the client pool drained" is a real postmortem from a real FAANG in 2024.

**Objective eleven: build the observability contract.** Every Redis-touching service must export: per-command latency histograms tagged by command name, hit and miss rates per prefix, pool saturation, reconnection count, and CROSSSLOT error count. Alerts on hit rate drops of more than 10 percent over 5 minutes catch invalidation storms. Alerts on pool saturation above 80 percent catch slow-command regressions before they page.

**Objective twelve: write the migration runbook for the Redis-to-Valkey move.** Most orgs in 2026 are somewhere on this path. The runbook names the service, the endpoint cutover mechanism (DNS, service mesh, connection-string config), the rollback plan (dual-write window or snapshot restore), the acceptance tests (hit rate parity, latency parity, error-rate parity), and the license exit criterion that triggered the move in the first place. Without this document the migration is a hope, not a plan.

---
