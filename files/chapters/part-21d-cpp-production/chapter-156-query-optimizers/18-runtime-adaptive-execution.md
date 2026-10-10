## Runtime Adaptive Execution

The optimizer picks a plan from estimates. Estimates are wrong. Adaptive execution monitors actual cardinalities and resource use during execution and changes the plan when reality diverges from prediction. Modern engines (BigQuery, Snowflake, Spark AQE, Photon) lean heavily on adaptive execution because no static optimizer can be right every time.

This chapter covers what to adapt, when to adapt, and the C++ patterns that make it work.

### What Goes Wrong At Runtime

The four most common runtime divergences:

1. **Cardinality estimate was wrong.** Optimizer predicted 1000 rows from a join, actual is 10 million. The next operator (now feeding 10K x more data) is the wrong choice.
2. **Skew in partition distribution.** Hash exchange should give uniform partitions. Reality: one partition has 80% of rows because of a hot key.
3. **Memory pressure.** A hash table that fit in memory at planning time exceeds budget because the build side was underestimated.
4. **Slow node.** A worker is taking 10x longer than its peers. Speculative execution should kick in.

Each requires a different adaptation.

### Adaptive Plan Switching

The classic approach: at a pipeline boundary (after a hash build, after an aggregation), check actual statistics. If they differ from estimates by more than a threshold (typically 10x), re-run the optimizer for the rest of the plan with the actual cardinalities.

```cpp
#include <cstdint>
#include <memory>

namespace adaptive {

struct ActualStats {
    double row_count;
    double avg_row_bytes;
    double distinct_values;
    double max_partition_size;  // for skew detection
};

class AdaptiveCoordinator {
    std::unique_ptr<LogicalPlan> remaining_plan_;
    PhysicalPlan current_;
    Optimizer& optimizer_;

public:
    void OnPipelineComplete(const ActualStats& actual) {
        const auto& estimated = current_.NextPipeline().estimated_stats;
        double err = actual.row_count / std::max(1.0, estimated.row_count);
        if (err > 10.0 || err < 0.1) {
            // Replan the rest with actual stats.
            UpdateStats(remaining_plan_.get(), actual);
            current_ = optimizer_.Optimize(*remaining_plan_);
        }
    }
};

}  // namespace adaptive
```

The key implementation challenge: re-optimization must be fast (under 100 ms) because the user is waiting. Cascades exhaustive search is too slow. Adaptive systems use the existing plan as a seed and apply local rewrites only.

### Spark Adaptive Query Execution (AQE)

Spark AQE (Spark 3.0+) is the most documented production implementation. It adapts at exchange boundaries:

**Coalescing partitions.** After a shuffle, if many partitions are tiny, merge them to reduce task overhead.

**Switching join strategy.** A planned shuffle hash join can become a broadcast hash join if the build side turns out to be small.

**Skew join handling.** A partition that is 5x larger than median is split into smaller sub-partitions and the build side replicated.

The implementation: each shuffle stage produces a "shuffle map" (partition sizes). The coordinator examines the map after the stage finishes and chooses adaptations for the next stage.

### Mid-Query Repartitioning

A more aggressive form: change the partitioning of an in-flight pipeline when skew is detected.

The trigger: producer-side workers report partition sizes to the coordinator periodically. If one consumer is overloaded (its partition is 10x median), the coordinator instructs the producer to repartition that key range across multiple new consumers.

This requires:

- **Restartable consumers.** Consumer must be able to spawn additional instances mid-query.
- **State migration.** Existing consumer's partial state (hash table, sort buffer) is checkpointed and split.
- **Consistent routing.** Producers learn the new partition map and route correctly thereafter.

BigQuery has this. Snowflake has this. Open-source engines mostly do not.

### Cost Recheck on Materialized Intermediates

When a pipeline-breaking operator (hash build, aggregate, sort) finishes, you have an exact count of its output - recheck downstream operator choices against that count before continuing.

```cpp
namespace adaptive {

void OnHashBuildComplete(double actual_build_rows, double actual_build_bytes) {
    PhysicalJoin* downstream_join = GetNextJoin();
    auto& original_choice = downstream_join->algo;

    // Was the choice still correct given actual size?
    if (actual_build_bytes < kBroadcastThreshold &&
        original_choice == JoinAlgo::HashShuffle) {
        downstream_join->algo = JoinAlgo::Broadcast;
    } else if (actual_build_rows > kSpillThreshold &&
               original_choice == JoinAlgo::HashInMemory) {
        downstream_join->algo = JoinAlgo::GraceHash;
    }
}

}  // namespace adaptive
```

This is "downcast" or "right-sizing" of the next operator. It is cheap (no full re-optimization) and catches the most common bad-plan cases.

### Adaptive Join Order

Reordering joins mid-query is the most ambitious adaptation. After two of five joins are done and intermediate result is much larger than predicted, the optimizer might want to commute the remaining join sequence.

Practical implementations are limited:

- **Snowflake** does limited adaptive join reordering. Not publicly documented in detail.
- **BigQuery** has adaptive join order for cases where the first one or two joins reveal cardinality.
- **Postgres pg_hint_plan** allows manual hints but not automatic adaptation.

The challenge: by the time a bad join order is detected, work has been done. Throwing it away is expensive. Most systems prefer to live with the chosen order and adapt only the join algorithm and partition strategy.

### Speculative Execution

For distributed plans, a slow worker can hold up the whole query. Speculative execution: when a task takes more than 1.5x the median time among its peers, dispatch a duplicate to a different worker. Take whichever finishes first.

```cpp
namespace adaptive {

class SpeculativeScheduler {
    struct Task { uint64_t id; double start_time; uint32_t worker; bool finished; };
    std::vector<Task> tasks_;

    static constexpr double kSpeculationFactor = 1.5;

public:
    void Tick(double now) {
        std::vector<double> elapsed;
        for (auto& t : tasks_) {
            if (!t.finished) elapsed.push_back(now - t.start_time);
        }
        if (elapsed.size() < 4) return;
        double median = Median(elapsed);
        for (auto& t : tasks_) {
            if (!t.finished && (now - t.start_time) > median * kSpeculationFactor) {
                LaunchSpeculative(t);
            }
        }
    }

private:
    static double Median(std::vector<double>& v) {
        std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
        return v[v.size() / 2];
    }
    void LaunchSpeculative(const Task& t);
};

}  // namespace adaptive
```

Hadoop MapReduce introduced this. Spark, Drill, and BigQuery all have it. The cost is doubled work on slow tasks, which is usually a good trade.

### Learning from Workload

The next level: use historical query results to improve future planning.

**Bao** (Marcus et al., 2021) trains a contextual bandit over a fixed set of optimizer hint configurations. Given a query, Bao predicts which hint set will work best, applies it, observes the result, updates the model. Production at Microsoft.

**Workload-aware index advisor.** Track which predicates appear most often and recommend new indexes or skipping structures. Postgres has `pg_stat_statements` for this.

**Plan caching with feedback.** When a plan is reused for a parameterized query, track its actual performance. If it consistently underperforms, invalidate the cached plan.

### BigQuery Dynamic Repartitioning

BigQuery's adaptive execution is documented obliquely in conference talks. The key features:

1. **Dynamic worker scaling.** Add or remove workers mid-query based on observed load.
2. **Repartition operator.** When skew is detected, the executor inserts a new exchange to redistribute data. The downstream pipeline restarts from that point.
3. **Cardinality-driven plan choice.** The executor picks join algorithm at runtime based on actual build size, not estimate.

These features rely on BigQuery's stateless worker architecture (workers can be added or removed without state loss). On-prem engines that bind state to workers cannot easily replicate this.

### Photon Adaptive Execution

Photon (Databricks, 2022) inherits Spark AQE and adds:

1. **Vectorized vs row execution choice per operator.** When a row's columns include heavily nested types, the row engine wins. Photon picks per-batch.
2. **Skew handling specifically for hash join.** Hot keys are detected via Count-Min sketch on producer side.
3. **Memory-aware downgrade.** When memory budget is exceeded, the engine switches a planned in-memory hash join to spilling automatically.

### Trade-Offs of Adaptation

Adaptation is not free.

**Latency overhead.** Monitoring, statistics collection, and re-optimization cost CPU. For sub-second queries this can be more expensive than the bad plan.

**Determinism loss.** The same query can produce different runtime plans on different runs. Customers complaining "yesterday it was fast" are tracing this.

**Bug surface.** Adaptive execution multiplies the number of plan paths. Each path needs its own test coverage.

The right balance: be aggressive at major boundaries (after a shuffle, after a build), conservative inside pipelines. Trade some peak performance for plan stability.

### What to Build First

If you are adding adaptive execution to a query engine, in priority order:

1. Speculative execution for slow workers.
2. Skew handling at hash exchanges.
3. Cardinality-driven join algorithm choice (broadcast vs shuffle, in-memory vs grace).
4. Partition coalescing after shuffle.
5. Re-optimization at pipeline breaks (last, hardest).

The first three give the biggest wins. The fourth is a routine improvement. The fifth is research-grade and brittle.

### What to Read

- Markl et al., "Robust Query Processing through Progressive Optimization," SIGMOD 2004.
- Kabra and DeWitt, "Efficient Mid-Query Re-Optimization," SIGMOD 1998.
- Spark AQE design documents.
- Photon paper, SIGMOD 2022.

The next chapter is about the layer underneath all of this: MVCC and snapshots.

---
