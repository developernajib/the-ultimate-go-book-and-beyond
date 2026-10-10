## Distributed Query Execution

A single node executes a query as a tree of operators. A distributed engine executes a query as a graph of operators across many nodes, with data shuffled between them. The fundamental new operator is the **exchange**, which transfers tuples between nodes.

This chapter covers the distributed execution model used by BigQuery's Dremel, Apache Calcite-based engines, and the Spanner query coordinator.

### The Exchange Operator

Volcano (Graefe, 1990) introduced the exchange as a transparent parallelism operator. In distributed form, it has three responsibilities:

1. Hash, broadcast, or merge data across nodes.
2. Adapt the parallelism degree (1 producer, N consumers, or M producers, N consumers).
3. Hide network latency behind asynchronous I/O.

```cpp
#include <cstdint>
#include <memory>
#include <vector>

namespace dist {

enum class ExchangeKind : uint8_t {
    Singleton,        // gather all data on one node
    Hash,             // partition by hash on key columns
    Broadcast,        // copy entire stream to every consumer
    RangePartition,   // partition by ordered range
    Merge,            // ordered merge of pre-sorted inputs
};

struct ExchangeSpec {
    ExchangeKind kind;
    std::vector<uint32_t> partition_keys;   // for hash and range
    std::vector<uint32_t> sort_keys;        // for merge
    size_t consumer_count;
};

class ExchangeSink {
public:
    virtual ~ExchangeSink() = default;
    virtual void Send(uint32_t consumer_id, std::vector<std::byte> chunk) = 0;
    virtual void Finish() = 0;
};

class ExchangeSource {
public:
    virtual ~ExchangeSource() = default;
    virtual std::optional<std::vector<std::byte>> Recv() = 0;
};

}  // namespace dist
```

A producer-side exchange takes its input batch, computes the destination consumer for each row (by hash or by broadcast or by range), and ships the appropriate slice to each consumer over the network.

A consumer-side exchange receives chunks from many producers, possibly merges them by sort order, and feeds them into the local pipeline.

### Partitioning Schemes

**Hash partitioning** is the workhorse. For an exchange before a hash join, both sides hash on the join key, so equal-key rows land on the same node. For an exchange before a hash aggregation, hash on the group keys.

**Broadcast** is right when one side is small. The optimizer picks broadcast when the smaller side fits in memory on every consumer node. Threshold is typically 10-100 MB per node.

**Range partitioning** is needed for global sort or merge join. The producer side knows the boundary keys (computed from a sample) and routes rows to the consumer responsible for that range.

**Singleton (gather)** is the final exchange before result collection: all data goes to the coordinator. Used for the root of the plan and for operators that require global state (final aggregation in two-phase, top-K with global limit).

### Inserting Exchanges into the Plan

The optimizer's distribution-property analyzer inserts exchanges. Each operator has a required input distribution and a guaranteed output distribution. When the child's output does not match the parent's requirement, an exchange is inserted as an enforcer.

```cpp
namespace dist {

enum class Distribution { Any, Singleton, HashPartitioned, Broadcast };

struct DistProps {
    Distribution dist = Distribution::Any;
    std::vector<uint32_t> hash_keys;
};

bool Satisfies(const DistProps& provided, const DistProps& required) {
    if (required.dist == Distribution::Any) return true;
    if (required.dist == Distribution::Singleton) {
        return provided.dist == Distribution::Singleton;
    }
    if (required.dist == Distribution::HashPartitioned) {
        return provided.dist == Distribution::HashPartitioned
            && provided.hash_keys == required.hash_keys;
    }
    return false;
}

}  // namespace dist
```

For a `PhysicalHashJoin`, the build side requires `Distribution::HashPartitioned` on the build keys, and the probe side requires `HashPartitioned` on the probe keys. If neither child satisfies, two hash exchanges are inserted.

For a small-build join, the build side gets a `Broadcast` exchange and the probe side stays partitioned (whatever its existing distribution is, or unpartitioned).

This is the same property propagation system from Cascades (chapter 08), now extended to distribution properties.

### Pipelined Execution Across Nodes

A naive distributed plan stages each exchange (producer finishes, then consumer starts). This serializes phases and wastes resources.

A pipelined distributed plan streams data through exchanges as it is produced. The producer keeps emitting while the consumer is processing. This requires:

1. **Backpressure.** When consumer is slow, producer must pause, not buffer unbounded.
2. **Async network I/O.** Producer should not block on `send`, consumer should not block on `recv`.
3. **Flow control.** Per-stream credits so one slow consumer does not back up the whole producer.

```cpp
namespace dist {

class FlowControlledSink {
    std::queue<std::vector<std::byte>> buffer_;
    std::atomic<int64_t> credits_;
    std::condition_variable cv_;
    std::mutex mu_;

public:
    void Send(std::vector<std::byte> chunk) {
        std::unique_lock lk(mu_);
        cv_.wait(lk, [&] { return credits_.load() > 0; });
        buffer_.push(std::move(chunk));
        credits_.fetch_sub(1);
        // Notify network thread.
    }

    void GrantCredits(int64_t n) {
        credits_.fetch_add(n);
        cv_.notify_all();
    }
};

}  // namespace dist
```

This is the credit-based flow control used by Apache Drill, Impala, and Presto/Trino. BigQuery's Dremel uses a similar scheme based on observed downstream rate.

### Dremel and Multi-Level Serving Trees

BigQuery's Dremel paper (Melnik et al., VLDB 2010) introduced the multi-level serving tree. The query coordinator splits the query among root nodes, each root splits among intermediate nodes, intermediate nodes split among leaves. Leaves scan storage. Results aggregate up the tree.

The genius of Dremel:

1. **Static schema with nested types** (the "record shredding" algorithm) lets columnar storage handle nested data.
2. **Multi-level tree** scales beyond single coordinator by adding intermediate aggregation tiers.
3. **Speculative execution**: root sends the same task to two leaf candidates, takes whichever finishes first, kills the other.

The architecture appears in production at Google internally (Dremel proper), in Apache Drill (which mirrors Dremel design), and in F1 Query (the Spanner front-end).

### F1 Query and Spanner

F1 Query (Shute et al., VLDB 2013, with extensions in 2018) is the distributed query engine over Spanner storage. Its design:

- **Catalog** lives in a central metadata service.
- **Workers** are stateless. Spanner storage holds the data.
- **Coordinator** plans the query, dispatches to workers, collects results.
- **Worker pool** is pre-warmed and load-balanced.

For OLTP queries, F1 uses local Spanner indexes and small fan-out. For OLAP queries, it spins up many workers and uses Dremel-style multi-level aggregation.

The interesting C++ detail: F1's worker code is a single binary that contains the full executor, the column compression library, and the protobuf serialization. The same binary is used for OLTP and OLAP, with the optimizer choosing the execution shape.

### Apache Drill

Drill is the open-source Dremel-clone. Its execution model uses "fragments" (a subtree of the plan running on one node) connected by exchanges. The coordinator computes the plan as a DAG of fragments and dispatches to workers via Zookeeper-coordinated assignments.

Drill's C++ side is mostly the storage plugins (Parquet, JSON, CSV). The execution engine is Java. This is one reason Drill has not become dominant: the Java executor's per-row overhead is significant.

### ClickHouse Distributed

ClickHouse has a distinctive distributed model. Tables are physically sharded across nodes, with optional replicas. The `Distributed` table engine is a virtual layer that fans out queries.

A query against a Distributed table:

1. Coordinator parses and plans.
2. Plan is sent to all shards.
3. Each shard executes its slice locally (using a `Local` table that is the actual data on that shard).
4. Partial results stream back to the coordinator.
5. Coordinator merges results (final aggregation, sort, limit).

ClickHouse's design keeps most query work on the data nodes. The coordinator is thin. This works because ClickHouse is OLAP-only and most queries are aggregations that benefit from pushing work down.

### Trino and Presto C++

Trino (formerly PrestoSQL) is Java. Presto C++ (also called Prestissimo) is Meta's port of the Presto coordinator and worker logic on top of Velox. The coordinator stays Java, the workers are C++.

The architecture:

- Coordinator parses, plans, schedules. Uses Java's HotSpot JIT. Spends 10ms-100ms per query.
- Worker receives a fragment, executes via Velox. C++ end-to-end.
- Exchange is HTTP-based. Workers pull from each other.

The Velox-based worker is 2x to 5x faster than the original Java worker on TPC-H. Meta runs Prestissimo at scale internally.

### Distributed Cost Model

Distribution costs are added to the cost model from chapter 07:

```cpp
double NetworkCost(double bytes, double num_consumers, bool intra_dc) {
    double per_byte = intra_dc ? 0.01e-3 : 0.5e-3;
    double setup_per_consumer = 100.0;  // microseconds
    return bytes * per_byte + num_consumers * setup_per_consumer;
}
```

For a hash exchange of 10 GB across 100 workers in the same DC: `10e9 * 0.01e-3 + 100 * 100 = 110000 us = 110 ms`. For broadcast of 100 MB to 100 workers: `100e6 * 100 * 0.01e-3 = 100 us per byte * num_workers + setup = 100 ms + 10 ms = 110 ms`.

The optimizer compares these against compute costs and picks the better plan.

### Common Failure Modes

1. **Skewed partitioning.** A few hot keys overload one consumer. Detect with sketch on producer side, replicate hot keys.
2. **Slow nodes.** One worker is slow (failing disk, GC, noisy neighbor). Mitigate with speculative execution and backup tasks.
3. **Network partitions.** Producers cannot reach some consumers. Retry with circuit breakers, fail the query if persistent.
4. **Memory pressure on shuffle.** Exchange buffers exceed memory, force spill. Production engines use disk-backed shuffle.

### What to Read

- Melnik et al., "Dremel: Interactive Analysis of Web-Scale Datasets," VLDB 2010.
- Shute et al., "F1: A Distributed SQL Database That Scales," VLDB 2013.
- Shute et al., "F1 Query: Declarative Querying at Scale," VLDB 2018.
- Sethi et al., "Presto: SQL on Everything," ICDE 2019.
- Photon paper, SIGMOD 2022.

The next chapter goes from static distribution to runtime adaptation.

---
