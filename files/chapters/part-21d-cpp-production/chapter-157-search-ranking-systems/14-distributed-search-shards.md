## Distributed Search and Sharding

A single machine can hold an inverted index of perhaps 100 million documents and serve a few thousand QPS. Web search runs at billions of documents and hundreds of thousands of QPS. The gap is bridged by sharding: split the corpus across N machines, query all of them, merge results. The interesting questions are how to shard, how to handle the stragglers, and how to keep p99 latency stable when N is large.

### Sharding Strategies

**Random sharding.** Hash the docID to a shard. Each shard gets an even random subset of the corpus. Simplest. Each query fans out to all N shards.

**Document-level sharding (a.k.a. document partitioning).** Same as random sharding for queries, the difference is that documents are kept in their entirety on one shard, including all term postings for those documents. This is the most common approach.

**Term-level sharding (term partitioning).** Each term's full posting list lives on one shard. A query for "machine learning" goes to whichever shards hold those two terms. Wins on read I/O (no fan-out per query). Loses on write throughput (every document update touches every shard for terms it contains) and on hot-shard skew (popular terms create hot shards).

In practice, document partitioning wins. Google's published designs (the original GFS / MapReduce papers, follow-ups) describe document partitioning. Lucene/Elasticsearch use document partitioning. Vespa uses document partitioning. Term partitioning lives in research papers.

**Hybrid: hash sharding by primary key.** If the application has a natural primary key (user ID, tenant ID), shard by that key. Queries scoped to that key go to one shard. Cross-key queries fan out. Works for multi-tenant search where most queries are tenant-scoped.

### Shard Sizing

The right shard size is bounded by:

- **Memory.** A shard's working set must fit in RAM (or NVMe with a hot cache). Index size on disk is typically 2-3x the working set. A 256 GB machine can hold a 100 GB shard comfortably.
- **Query latency.** Larger shards take longer to scan. A 100M-document shard at 5 ms p50 is reasonable, 1B-document shards push p50 toward 50 ms.
- **Build time.** Rebuilding a shard takes hours, this caps shard size for systems that rebuild frequently.

Production shard sizes vary widely. Web search shards are often 10-100M documents. Enterprise search and product search shards are 1-10M. ANN-only systems with HNSW typically shard at 1-10M vectors per shard because HNSW build time grows superlinearly.

### Replication

Each shard has R replicas (typically 2-3). Replicas serve reads, distributing query load. Writes go to a primary and replicate via:

- **Synchronous replication.** Writes confirm only after R replicas ack. Strong consistency. Slower writes.
- **Asynchronous replication.** Writes confirm after primary acks. Eventual consistency. Faster writes, possible stale reads.
- **Quorum.** Writes confirm after majority. Compromise.

Vespa uses a synchronous protocol with a replication factor configurable per group. Elasticsearch defaults to one replica per shard with synchronous replication and async write of segment files.

### Broker / Coordinator

The component that fans out queries and merges results.

```
                    +------------+
   query  ------>   |   broker   | ------> response
                    +------------+
                     /     |     \
                    /      |      \
              shard0   shard1     shardN-1
              (3 reps) (3 reps)   (3 reps)
```

The broker:

1. Receives the query.
2. Picks one replica per shard (typically random with stickiness for cache).
3. Sends the query in parallel to each.
4. Collects results.
5. Merges (top-K from each shard, take overall top-K').
6. Optionally runs second-stage ranking on the merged set.
7. Returns to client.

Brokers are themselves sharded for capacity but usually stateless and replicated behind a load balancer.

### Tail-at-Scale

Dean and Barroso (CACM 2013) coined "tail-at-scale". The argument: when the broker waits for N shards in parallel, the broker's response time is the **maximum** of the shards' response times. If each shard has a 1 percent chance of being slow (>50 ms), then with N=100 shards the probability that **at least one** is slow is `1 - 0.99^100 ≈ 63 percent`. The broker's p99 is dominated by the worst shard, not the average.

Causes of tail latency:

- GC pauses (Java).
- OS jitter (kernel scheduling, interrupts).
- Resource contention (network, disk).
- Long queries that took longer than expected.
- Replica that just lost its cache after restart.
- Background work (segment merge, log rotation).

### Mitigations

**Hedged requests.** Send the query to two replicas of the same shard, take whichever responds first. The probability that both replicas are simultaneously slow is much lower (assuming uncorrelated slowness). Cost: 2x the shard query load. Implementation: small delay (5-20 ms) before sending the second request to limit cost.

```cpp
// Hedged read with 10ms delay.
auto response_future = shard.query_async(req);
auto delay_future = std::async(std::launch::async, [&] {
    std::this_thread::sleep_for(10ms);
    return shard.query_replica_async(req);
});
auto first = wait_any(response_future, delay_future);
return first;
```

**Tied requests.** Like hedged but the first replica to start work tells the second to cancel. Reduces wasted compute. Used in Google's BigTable.

**Request reservation.** Reserve a slot on the replica before sending the query, ensuring no queueing. Limited by reservation overhead.

**Backup requests.** Send to one replica first, if no response after some threshold, send to another. The threshold is the p95 or p99 of normal responses.

**Cancel slow shards.** If the broker has results from N-k of N shards and the deadline is approaching, return what is available. Tradeoff: missing one shard means missing 1/N of the corpus, which may or may not affect result quality.

Google's published numbers from 2013 show that hedged requests at 95th percentile latency cost ~5 percent extra load and reduce p99 by 30-40 percent. The pattern is now ubiquitous.

### Cache Affinity and Sticky Routing

Each replica has its own caches (query result cache, posting list cache). If consecutive queries for the same term go to different replicas, every replica must independently warm its cache. Hash routing on a query feature (e.g., the first query term) keeps a query family on a fixed replica, improving cache hit rate.

Tradeoff: sticky routing reduces load balancing flexibility. If the sticky replica is slow, the broker still has to use it, hurting p99. Vespa's approach: try-sticky-first, fall back to least-loaded.

### Update Distribution

Writes go to:

1. The primary replica of the shard the document hashes to.
2. The primary replicates to follower replicas (sync or async).
3. Each replica writes the document to its in-memory buffer, periodically flushes to a new immutable segment.

Cross-shard updates do not exist in document-partitioned systems, each document is fully owned by one shard.

### Search Cluster Topology

A typical production search cluster:

- **Index builders.** Read source documents, produce immutable segments. Independent of serving.
- **Storage.** Segments persisted to durable storage (S3, HDFS, custom).
- **Content nodes.** Hold segments in memory, serve queries. Sharded and replicated.
- **Brokers.** Fan out queries to content nodes, merge.
- **Reranker nodes.** Run heavy second-stage models. Often GPU.
- **Feature service.** Serves per-document features from a key-value store.
- **Routers / load balancers.** In front of brokers.

Vespa's architecture is approximately this with different naming. Elasticsearch has a flatter design (no separate reranker nodes, reranking happens in the broker or in the content nodes).

### C++ Patterns

The broker's parallel fan-out is the main interesting concurrency pattern in a search system.

```cpp
class Broker {
public:
    std::vector<Hit> query(const Query& q, std::chrono::milliseconds budget) {
        auto deadline = std::chrono::steady_clock::now() + budget;
        std::vector<std::future<ShardResponse>> futures;
        futures.reserve(shards_.size());
        for (auto& shard : shards_) {
            futures.push_back(std::async(std::launch::async, [&] {
                return shard.query_with_deadline(q, deadline);
            }));
        }

        std::vector<ShardResponse> responses;
        responses.reserve(shards_.size());
        for (auto& f : futures) {
            // wait_until with deadline - skip slow shards.
            if (f.wait_until(deadline) == std::future_status::ready) {
                responses.push_back(f.get());
            }
        }

        return merge_topk(responses, q.k());
    }

private:
    std::vector<ShardClient> shards_;
};
```

Production code adds: hedged requests, retries with budgets, circuit breakers per shard, instrumentation per shard, and graceful degradation when shards are unavailable.

### Junior to FAANG

A junior shards by hash and ships. A senior at Google or Vespa thinks about the cache-affinity / load-balancing tradeoff, instruments per-shard p99, and tunes hedged-request thresholds based on observed tail behavior. A staff engineer reads the tail-at-scale paper and makes architectural arguments about why the broker is the right place to hide tail latency, and what the cost-quality tradeoff of partial-result fallback is. The hardest interview question: "your broker p99 is 80 ms. Each shard's p99 is 30 ms. Why the gap?" Senior answer: math of the order statistic, with 100 shards, p99 of the max grows. Great answer adds: hedged requests, partial-result return, and quantifies the load cost of the chosen mitigation.

---
