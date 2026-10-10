## Query Execution: Volcano Model and Vectorized Execution

A query optimizer produces a plan tree, a DAG of relational operators (scan, filter, join, aggregate). The query executor walks this tree and produces tuples. How it walks the tree defines the execution model, and the choice of model determines whether you process 50 million or 5 billion rows per second on the same hardware.

### The Volcano (Iterator) Model

The Volcano model, described by Goetz Graefe in 1994, is the dominant query execution architecture in traditional OLTP databases: PostgreSQL, MySQL, Oracle, SQLite. Every operator exposes three methods:

- `Open()`, initialize state, recursively open children
- `Next()`, produce one tuple and return it
- `Close()`, release resources

```cpp
#include <cassert>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

struct Tuple {
    std::vector<int64_t> columns;
};

// Abstract operator interface: every node in the query plan tree implements this
class Operator {
public:
    virtual ~Operator() = default;
    virtual void open()  = 0;
    virtual std::optional<Tuple> next() = 0;
    virtual void close() = 0;
};

// SeqScan: reads all tuples from a table (simulated as an in-memory vector)
class SeqScan : public Operator {
    const std::vector<Tuple>& table_;
    size_t                    cursor_ = 0;

public:
    explicit SeqScan(const std::vector<Tuple>& table) : table_(table) {}

    void open()  override { cursor_ = 0; }
    void close() override {}

    std::optional<Tuple> next() override {
        if (cursor_ >= table_.size()) return std::nullopt;
        return table_[cursor_++];
    }
};

// Filter: passes tuples for which predicate(tuple) == true
class Filter : public Operator {
    std::unique_ptr<Operator>       child_;
    std::function<bool(const Tuple&)> predicate_;

public:
    Filter(std::unique_ptr<Operator> child,
           std::function<bool(const Tuple&)> pred)
        : child_(std::move(child)), predicate_(std::move(pred)) {}

    void open()  override { child_->open(); }
    void close() override { child_->close(); }

    std::optional<Tuple> next() override {
        while (auto t = child_->next()) {
            if (predicate_(*t)) return t;
        }
        return std::nullopt;
    }
};

// Project: select a subset of columns (by index)
class Project : public Operator {
    std::unique_ptr<Operator> child_;
    std::vector<int>          col_indices_;

public:
    Project(std::unique_ptr<Operator> child, std::vector<int> cols)
        : child_(std::move(child)), col_indices_(std::move(cols)) {}

    void open()  override { child_->open(); }
    void close() override { child_->close(); }

    std::optional<Tuple> next() override {
        auto t = child_->next();
        if (!t) return std::nullopt;

        Tuple projected;
        for (int idx : col_indices_) {
            projected.columns.push_back(t->columns[idx]);
        }
        return projected;
    }
};
```

### Hash Join: Build Phase and Probe Phase

The hash join is the most common join algorithm in OLTP databases for large inputs. It has two phases: build (hash the smaller "inner" relation into a hash table) and probe (scan the larger "outer" relation, probe the hash table for matches).

```cpp
class HashJoin : public Operator {
    std::unique_ptr<Operator> outer_;        // probe side (larger)
    std::unique_ptr<Operator> inner_;        // build side (smaller)
    int                       outer_col_;    // join key column in outer
    int                       inner_col_;    // join key column in inner

    using HashTable = std::unordered_multimap<int64_t, Tuple>;
    HashTable                 hash_table_;
    std::optional<Tuple>      outer_tuple_;
    HashTable::iterator       it_, it_end_;

    void build_phase() {
        hash_table_.clear();
        inner_->open();
        while (auto t = inner_->next()) {
            int64_t key = t->columns[inner_col_];
            hash_table_.emplace(key, *t);
        }
        inner_->close();
    }

public:
    HashJoin(std::unique_ptr<Operator> outer,
             std::unique_ptr<Operator> inner,
             int outer_col, int inner_col)
        : outer_(std::move(outer)), inner_(std::move(inner))
        , outer_col_(outer_col), inner_col_(inner_col) {}

    void open() override {
        inner_->open();
        build_phase();   // hash inner relation into memory
        outer_->open();
        outer_tuple_ = std::nullopt;
    }

    void close() override {
        outer_->close();
        hash_table_.clear();
    }

    std::optional<Tuple> next() override {
        while (true) {
            // Continue probing current outer tuple's bucket
            if (outer_tuple_.has_value()) {
                if (it_ != it_end_) {
                    Tuple joined;
                    joined.columns = outer_tuple_->columns;
                    const Tuple& inner_t = it_->second;
                    for (auto v : inner_t.columns) joined.columns.push_back(v);
                    ++it_;
                    return joined;
                }
            }
            // Fetch next outer tuple
            outer_tuple_ = outer_->next();
            if (!outer_tuple_) return std::nullopt;

            int64_t key = outer_tuple_->columns[outer_col_];
            auto range  = hash_table_.equal_range(key);
            it_         = range.first;
            it_end_     = range.second;
        }
    }
};
```

### Volcano Model in Practice

The Volcano example chains a `SeqScan` reading from an in-memory `employees` table through a `Filter` that keeps only department 10, then a `Projection` that selects name and salary columns. Each operator's `next()` call pulls one tuple at a time through the chain. This pull-based model simplifies operator composition and back-pressure handling but causes excessive virtual dispatch overhead on large datasets, which is the primary motivation for vectorized execution.
```cpp
void volcano_example() {
    // Table: (id, dept_id, salary)
    std::vector<Tuple> employees = {
        {{1, 10, 95000}},
        {{2, 20, 72000}},
        {{3, 10, 110000}},
        {{4, 30, 88000}},
        {{5, 20, 65000}},
    };

    // SELECT id, salary FROM employees WHERE salary > 80000
    auto plan = std::make_unique<Project>(
        std::make_unique<Filter>(
            std::make_unique<SeqScan>(employees),
            [](const Tuple& t) { return t.columns[2] > 80000; }
        ),
        std::vector<int>{0, 2}   // project columns 0 (id) and 2 (salary)
    );

    plan->open();
    while (auto t = plan->next()) {
        std::cout << "id=" << t->columns[0]
                  << " salary=" << t->columns[1] << "\n";
    }
    plan->close();
    // Output: id=1 salary=95000, id=3 salary=110000, id=4 salary=88000
}
```

The Volcano model is simple, composable, and easy to add new operators to. Its weakness: every `next()` call is a virtual function dispatch, and each tuple is processed through the entire operator chain one at a time. With 100 million rows and 10 operators, that is one billion virtual function calls. The per-tuple overhead dominates the actual computation.

### Vectorized Execution

DuckDB, ClickHouse, Vectorwise, and MonetDB/X100 use vectorized execution: `next()` returns a batch of 1024 tuples instead of one. Each operator applies its operation to the whole batch using tight loops over arrays, friendly to SIMD auto-vectorization and CPU pipelining.

```cpp
static constexpr int VECTOR_SIZE = 1024;

struct VectorBatch {
    int64_t columns[8][VECTOR_SIZE];  // up to 8 columns, 1024 rows each
    int     count = 0;                // actual rows in this batch
    int     num_columns = 0;

    bool is_empty() const { return count == 0; }
};

class VectorizedFilter {
    std::function<bool(int64_t)> predicate_;
    int                          col_;

public:
    VectorizedFilter(std::function<bool(int64_t)> pred, int col)
        : predicate_(std::move(pred)), col_(col) {}

    // Filter in-place: compact the batch by removing non-matching rows.
    // Returns number of rows remaining.
    int apply(VectorBatch& batch) {
        int out = 0;
        for (int i = 0; i < batch.count; ++i) {
            if (predicate_(batch.columns[col_][i])) {
                // Compact: move row i to position out
                for (int c = 0; c < batch.num_columns; ++c) {
                    batch.columns[c][out] = batch.columns[c][i];
                }
                ++out;
            }
        }
        batch.count = out;
        return out;
    }
};

// SIMD-style column sum, compiler auto-vectorizes this loop
int64_t vectorized_sum(const VectorBatch& batch, int col) {
    int64_t sum = 0;
    const int64_t* data = batch.columns[col];
    int count = batch.count;
    // This loop compiles to vpaddd/vpaddq with AVX2
    for (int i = 0; i < count; ++i) {
        sum += data[i];
    }
    return sum;
}
```

### Performance Comparison

| Execution model | Throughput (est.) | Overhead source |
|---|---|---|
| Volcano / iterator | ~50M rows/sec | Virtual dispatch per tuple |
| Vectorized (batch) | ~500M rows/sec | Loop over 1024-element array |
| Compiled (JIT/LLVM) | ~5B rows/sec | Zero interpretation overhead |

**Compilation-based execution** (HyPer, Umbra, NoisePage from CMU) takes vectorized further by JIT-compiling query plans to native machine code via LLVM. The query `SELECT sum(salary) FROM employees WHERE dept_id = 10` compiles to a tight loop with no virtual dispatch, no per-tuple overhead, and SIMD-vectorized aggregation. For analytical workloads scanning billions of rows, compiled execution saturates memory bandwidth.

### Go Comparison

Go's `database/sql` package is purely a connection and protocol layer. The actual execution happens inside the database server, not in the Go process. For embedded analytics, `github.com/marcboeker/go-duckdb` exposes DuckDB's vectorized engine via CGO, you get 500M rows/sec execution inside a Go process. For pure Go, `github.com/dolthub/go-mysql-server` implements a volcano-model query executor in Go, used by Dolt (the Git-compatible SQL database).

---
