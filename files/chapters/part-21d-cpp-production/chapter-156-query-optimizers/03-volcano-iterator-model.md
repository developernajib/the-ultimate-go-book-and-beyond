## The Volcano Iterator Model

In 1990, Goetz Graefe published "Volcano, an Extensible and Parallel Query Evaluation System." It proposed a uniform interface for every operator: each pulls one tuple at a time from its child via three calls. `Open()` initializes state. `Next()` returns the next tuple or signals end of stream. `Close()` releases resources. Every operator (scan, filter, project, join, aggregate) implements the same interface.

This idea dominated database execution for two decades. Postgres still uses it. SQLite uses it. MySQL uses it. Oracle's row-store executor uses it. Then around 2005, MonetDB/X100 and Hyper showed it was wrong by 10x to 50x for analytical queries, and the industry rebuilt.

Understanding why Volcano lost is a prerequisite to understanding why vectorization and codegen won. We will write a real Volcano engine first.

### The Iterator Interface in C++

```cpp
#include <cstdint>
#include <memory>
#include <optional>
#include <variant>
#include <vector>
#include <string>

namespace volcano {

using Value = std::variant<int64_t, double, std::string>;
struct Tuple { std::vector<Value> values; };

class Iterator {
public:
    virtual ~Iterator() = default;
    virtual void Open() = 0;
    virtual std::optional<Tuple> Next() = 0;  // nullopt = end of stream
    virtual void Close() = 0;
};

class TableScan final : public Iterator {
    const std::vector<Tuple>* rows_;
    size_t pos_ = 0;

public:
    explicit TableScan(const std::vector<Tuple>* rows) : rows_(rows) {}
    void Open() override { pos_ = 0; }
    std::optional<Tuple> Next() override {
        if (pos_ >= rows_->size()) return std::nullopt;
        return (*rows_)[pos_++];
    }
    void Close() override {}
};

class Filter final : public Iterator {
    std::unique_ptr<Iterator> child_;
    std::function<bool(const Tuple&)> pred_;

public:
    Filter(std::unique_ptr<Iterator> c, std::function<bool(const Tuple&)> p)
        : child_(std::move(c)), pred_(std::move(p)) {}

    void Open() override { child_->Open(); }
    std::optional<Tuple> Next() override {
        while (auto t = child_->Next()) {
            if (pred_(*t)) return t;
        }
        return std::nullopt;
    }
    void Close() override { child_->Close(); }
};

class Project final : public Iterator {
    std::unique_ptr<Iterator> child_;
    std::vector<size_t> col_indices_;

public:
    Project(std::unique_ptr<Iterator> c, std::vector<size_t> idx)
        : child_(std::move(c)), col_indices_(std::move(idx)) {}

    void Open() override { child_->Open(); }
    std::optional<Tuple> Next() override {
        auto t = child_->Next();
        if (!t) return std::nullopt;
        Tuple out;
        out.values.reserve(col_indices_.size());
        for (auto i : col_indices_) out.values.push_back(t->values[i]);
        return out;
    }
    void Close() override { child_->Close(); }
};

}  // namespace volcano
```

A pipeline is composed by passing iterators into other iterators. `Project(Filter(TableScan))` is a valid expression. The tree of iterators is the physical plan, and execution is `for (auto t = root.Next(); t.has_value(); t = root.Next()) { emit(*t); }`.

### A Volcano Hash Join

The hash join is the operator that exposes Volcano's flaws most clearly. It is also the most common join in analytical workloads.

```cpp
class HashJoin final : public Iterator {
    std::unique_ptr<Iterator> build_, probe_;
    size_t build_key_, probe_key_;

    std::unordered_multimap<int64_t, Tuple> ht_;
    bool built_ = false;

    // Probe state (Volcano gotcha: must remember partial matches across calls).
    std::optional<Tuple> current_probe_;
    decltype(ht_)::iterator match_it_, match_end_;

public:
    HashJoin(std::unique_ptr<Iterator> b, std::unique_ptr<Iterator> p,
             size_t bk, size_t pk)
        : build_(std::move(b)), probe_(std::move(p)),
          build_key_(bk), probe_key_(pk) {}

    void Open() override {
        build_->Open();
        probe_->Open();
        // Build phase, fully materialize.
        while (auto t = build_->Next()) {
            int64_t k = std::get<int64_t>(t->values[build_key_]);
            ht_.emplace(k, std::move(*t));
        }
        build_->Close();
        built_ = true;
    }

    std::optional<Tuple> Next() override {
        while (true) {
            // If we have an active probe row with more matches, emit one.
            if (current_probe_ && match_it_ != match_end_) {
                Tuple out;
                out.values = current_probe_->values;
                out.values.insert(out.values.end(),
                                  match_it_->second.values.begin(),
                                  match_it_->second.values.end());
                ++match_it_;
                return out;
            }
            // Pull next probe row.
            current_probe_ = probe_->Next();
            if (!current_probe_) return std::nullopt;
            int64_t k = std::get<int64_t>(current_probe_->values[probe_key_]);
            auto range = ht_.equal_range(k);
            match_it_ = range.first;
            match_end_ = range.second;
        }
    }

    void Close() override {
        probe_->Close();
        ht_.clear();
    }
};
```

The build side is fully materialized at `Open()` time. This is what makes the operator "pipeline breaking." Volcano respects the abstraction: every operator looks the same from outside (Open, Next, Close), even when internally the operator must consume its entire input before emitting anything.

### Why Volcano Is Slow

Run the engine above on a 100-million-row scan-filter-aggregate. You will measure 50 to 200 nanoseconds per row. A modern CPU can do 4 billion adds per second per core. Volcano gives you 10 million rows per second. We are leaving 99% of the silicon on the table.

The reasons, in order of impact:

**Virtual function call overhead.** Each `Next()` call is an indirect branch through a vtable. The CPU's branch predictor handles this well when the same vtable target is hit in a loop, but the indirect call still costs around 1 to 5 cycles when predicted, 15 to 20 when mispredicted. Multiply by 4 to 6 operators in the pipeline and you have 30 to 100 cycles per row of pure dispatch overhead.

**Tuple-at-a-time prevents SIMD.** The inner loop of `Filter::Next` evaluates the predicate on one row, then returns. The compiler cannot vectorize across `Next()` calls because the boundary is opaque. A modern CPU has 256-bit (AVX2) or 512-bit (AVX-512) registers that could process 4 to 8 doubles in parallel. Volcano uses one lane.

**Type dispatch on every value.** `std::variant` access is itself a branch. Real Volcano engines avoid `std::variant` and use type-specific iterator subclasses, but they still pay per-tuple type checking somewhere (in the predicate, in the aggregator, in the projection).

**Instruction cache pressure.** A single `Next()` call traverses through 4 to 6 different operator implementations. The instruction working set is large enough to evict from L1 I-cache on every row. With vectorized execution, you stay in one operator's hot loop for thousands of rows before switching.

**Pessimistic boxing.** The `Tuple` struct holds a `vector<Value>`. Each row allocates and frees that vector. This is the Volcano equivalent of Java's `Object[]`: heap pressure proportional to row count.

The Hyper paper (Neumann, 2011) measured this carefully: for a scan with a single integer comparison, Volcano achieves around 0.1 instructions per row that are useful work, the other 50 to 100 are dispatch and bookkeeping.

### Where Volcano Still Wins

Volcano is not strictly worse than vectorization for every workload.

**OLTP point queries.** A query that returns one row from a primary key lookup does not benefit from batching. The fixed overhead of allocating and managing batches is wasted. Postgres, MySQL, and Oracle (which all favor OLTP) are right to stay with iterator models.

**Highly selective filters early in the pipeline.** If your filter rejects 99.999% of rows, batching is wasteful because most batches end up with one or zero qualifying rows. Vectorized engines handle this with bitmasks (selection vectors), which keeps them competitive but not strictly better.

**Pipelines with branchy logic.** A query with a CASE expression that calls different functions per row gets fewer SIMD wins. The vectorized engine still wins on dispatch but loses the inner-loop SIMD speedup.

**Engines that must integrate with row-oriented storage.** If your storage is B-tree row-store (Postgres, MySQL InnoDB, MongoDB), the pages are tuples already. Adding a vectorization layer means converting row to column and back, which can erase the win.

### Push vs Pull

Volcano is "pull-based": the consumer (parent) calls `Next()` on the producer (child). The alternative is push-based, where the producer calls a `Consume(Tuple)` method on the consumer. Push is more natural for code generation (Hyper's data-centric model) and for parallelism. Pull is more natural for materialization-heavy operators like sort.

Modern engines mix both. DuckDB uses a push-based pipeline executor with morsel-driven parallelism. ClickHouse uses a push-based `Pipe` model. Velox uses pull but with vectors so the dispatch cost amortizes.

### What Volcano Got Right

Two ideas from Volcano survived the vectorization revolution intact.

**Operator uniformity.** Every operator has the same interface, so the optimizer can compose them freely. This is how DuckDB still works: every operator implements `GetData(DataChunk&)` even though the unit is a chunk, not a tuple.

**The exchange operator.** Volcano introduced `Exchange` as a special iterator that handles parallelism transparently. Other operators do not need to know they are running in parallel. This is the foundation of every distributed query engine in production today.

The lesson is that Volcano's *abstraction* was right. Its *granularity* (one tuple per call) was wrong. The next chapter shows what changed.

---
