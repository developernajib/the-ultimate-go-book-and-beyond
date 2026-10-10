## Relational Algebra and Logical Plans

A query optimizer takes a parsed AST and rewrites it into a tree of operators that produce the same result set with the lowest expected cost. Before you can rewrite, you need a representation that the rewriter can manipulate. That representation is the logical plan, and its mathematical foundation is relational algebra.

### The Six Primitive Operators

Codd's original relational algebra had eight operators. In practice, modern engines reduce them to six:

1. **Scan** (R), produces all tuples of a relation R.
2. **Project** (pi(a, b, c)), keeps only the listed columns.
3. **Select** (sigma(predicate)), filters rows.
4. **Join** (R join_p S), pairs rows of R with rows of S where predicate p holds.
5. **GroupBy** (gamma(keys, aggs)), groups by keys and applies aggregate functions.
6. **OrderBy** (tau(keys)), sorts by the listed keys.

Two more compose these: **Union** and **Set Difference**. Most engines also carry **Limit**, **DistinctOn**, and **Window** as first-class operators because they have execution implications that pure algebra hides.

The query `SELECT c.name, SUM(o.total) FROM customers c JOIN orders o ON c.id = o.cid WHERE o.date > '2025-01-01' GROUP BY c.name ORDER BY 2 DESC LIMIT 10` is the algebra:

```
Limit(10,
  OrderBy(sum_total DESC,
    GroupBy([c.name], [SUM(o.total) as sum_total],
      Join(c.id = o.cid,
        Scan(customers c),
        Select(o.date > '2025-01-01', Scan(orders o))))))
```

### Plan Node Hierarchy in C++

The canonical layout uses a base class with a virtual `Accept` for visitors. DuckDB and Calcite both use variants of this. Here is a clean modern C++ version.

```cpp
#include <memory>
#include <string>
#include <vector>
#include <variant>
#include <cstdint>

namespace qe {

class LogicalPlanVisitor;

class LogicalPlan {
public:
    virtual ~LogicalPlan() = default;
    virtual void Accept(LogicalPlanVisitor& v) = 0;

    // Children are owned by the node. Order matters (left, right for joins).
    std::vector<std::unique_ptr<LogicalPlan>> children;

    // Output schema is computed by the planner and cached here.
    std::vector<std::string> output_columns;

    // Statistics are populated by the cardinality estimator.
    struct Stats {
        double row_count = -1.0;       // -1 means not estimated
        double avg_row_bytes = -1.0;
        std::vector<double> ndv;       // distinct values per column
    };
    Stats stats;
};

struct ColumnRef {
    uint32_t table_id;
    uint32_t column_id;
};

struct Expression;  // forward, defined below

class LogicalScan final : public LogicalPlan {
public:
    uint32_t table_id;
    std::vector<uint32_t> projected_columns;
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalFilter final : public LogicalPlan {
public:
    std::unique_ptr<Expression> predicate;
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalProject final : public LogicalPlan {
public:
    std::vector<std::unique_ptr<Expression>> exprs;
    std::vector<std::string> aliases;
    void Accept(LogicalPlanVisitor& v) override;
};

enum class JoinType : uint8_t {
    Inner, Left, Right, Full, Semi, AntiSemi, Cross
};

class LogicalJoin final : public LogicalPlan {
public:
    JoinType join_type;
    std::unique_ptr<Expression> condition;  // nullptr for cross
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalAggregate final : public LogicalPlan {
public:
    std::vector<std::unique_ptr<Expression>> group_keys;
    std::vector<std::unique_ptr<Expression>> aggregates;
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalSort final : public LogicalPlan {
public:
    struct SortKey {
        std::unique_ptr<Expression> expr;
        bool ascending;
        bool nulls_first;
    };
    std::vector<SortKey> keys;
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalLimit final : public LogicalPlan {
public:
    uint64_t limit;
    uint64_t offset;
    void Accept(LogicalPlanVisitor& v) override;
};

class LogicalPlanVisitor {
public:
    virtual ~LogicalPlanVisitor() = default;
    virtual void Visit(LogicalScan&) = 0;
    virtual void Visit(LogicalFilter&) = 0;
    virtual void Visit(LogicalProject&) = 0;
    virtual void Visit(LogicalJoin&) = 0;
    virtual void Visit(LogicalAggregate&) = 0;
    virtual void Visit(LogicalSort&) = 0;
    virtual void Visit(LogicalLimit&) = 0;
};

inline void LogicalScan::Accept(LogicalPlanVisitor& v)      { v.Visit(*this); }
inline void LogicalFilter::Accept(LogicalPlanVisitor& v)    { v.Visit(*this); }
inline void LogicalProject::Accept(LogicalPlanVisitor& v)   { v.Visit(*this); }
inline void LogicalJoin::Accept(LogicalPlanVisitor& v)      { v.Visit(*this); }
inline void LogicalAggregate::Accept(LogicalPlanVisitor& v) { v.Visit(*this); }
inline void LogicalSort::Accept(LogicalPlanVisitor& v)      { v.Visit(*this); }
inline void LogicalLimit::Accept(LogicalPlanVisitor& v)     { v.Visit(*this); }

}  // namespace qe
```

Three design choices in this skeleton are worth defending.

**Children as `vector<unique_ptr>` instead of typed members.** A `LogicalJoin` has exactly two children, so you might write `unique_ptr<LogicalPlan> left, right`. We do not. The reason is that rewrite rules (predicate pushdown, join reordering, subquery unnesting) walk the tree generically. A generic walker that knows every node has a `children` vector is one for-loop. A walker that has to switch on node type to find children is a maintenance burden. DuckDB uses the same pattern.

**Stats embedded in the node.** The optimizer is going to ask "what is the cardinality of this subtree" thousands of times during enumeration. Recomputing on every ask is hot-path waste. Cache it on the node, invalidate only when the subtree is rewritten.

**Visitor returns void.** Visitors that return values are convenient for one-shot transforms but force you to use either `std::any` or a templated CRTP visitor. Both add complexity. Mutating the node or accumulating into the visitor's own state is cleaner.

### Expression Trees

Expressions are a separate hierarchy from plan nodes because they appear in many node types (filter predicates, projection lists, join conditions, group keys, sort keys, aggregate arguments).

```cpp
namespace qe {

enum class TypeId : uint8_t { Bool, Int32, Int64, Float64, Date, String, Decimal };

struct Value {
    TypeId type;
    union {
        bool b;
        int32_t i32;
        int64_t i64;
        double f64;
    };
    std::string s;  // for strings, separate to keep the union trivial
};

enum class ExprKind : uint8_t {
    Constant, ColumnRef, BinaryOp, UnaryOp, FunctionCall, Cast, Aggregate, Case
};

enum class BinaryOpKind : uint8_t {
    Add, Sub, Mul, Div, Mod, Eq, Ne, Lt, Le, Gt, Ge, And, Or, Like
};

struct Expression {
    ExprKind kind;
    TypeId result_type;
    std::vector<std::unique_ptr<Expression>> children;

    // Discriminated payload.
    Value constant_value;
    ColumnRef column_ref;
    BinaryOpKind binary_op;
    std::string function_name;
    std::string aggregate_name;
    bool is_distinct = false;
};

}  // namespace qe
```

Real engines specialize this. DuckDB has 13 expression classes inheriting from `Expression`, with proper RTTI replacement via `ExpressionType`. ClickHouse uses `ActionsDAG`, a directed acyclic graph that allows common subexpression sharing (the same `x + y` computed once even if it appears in three projections). Calcite uses `RexNode` with similar DAG semantics.

For a teaching engine the flat struct above is enough. For a production engine, switch to a DAG once you have measured CSE benefit on your workload.

### Logical vs Physical

The hierarchy above is logical. It says *what* the query computes, not *how*. A `LogicalJoin` becomes a `PhysicalHashJoin`, `PhysicalSortMergeJoin`, `PhysicalNestedLoopJoin`, or `PhysicalIndexNestedLoopJoin` after physical planning. A `LogicalAggregate` becomes a `PhysicalHashAggregate` or `PhysicalSortAggregate`. Cascades treats this transition as another set of rules ("implementation rules") and we will see why in chapter 08.

### Algebraic Equivalences That Drive Rewrites

The optimizer's first job, before cost-based search, is to apply heuristic rewrites that are always-or-almost-always wins. The classic ones:

- **Predicate pushdown.** sigma_p(R join S) becomes sigma_p(R) join S when p references only columns of R. Reduces the size of the join input.
- **Projection pushdown.** pi_a(R join S) pushes column pruning down through joins so that scans only read needed columns. Critical for columnar storage.
- **Constant folding.** `WHERE 1 = 1 AND x > 5` becomes `WHERE x > 5`.
- **Subquery unnesting.** Correlated subqueries become joins. The Neumann/Kemper "Unnesting Arbitrary Queries" paper (2015) is the reference.
- **Outer join reordering.** Inner joins are commutative and associative. Outer joins are not, but they can be reordered under specific null-rejection conditions.
- **Decorrelation.** `WHERE x IN (SELECT y FROM ...)` becomes a semi-join.

Each rewrite is implemented as a visitor that returns a modified plan. DuckDB has 30+ rewrite rules in `src/optimizer/`. ClickHouse has them in `src/Interpreters/ActionsDAG.cpp` and `src/Processors/QueryPlan/Optimizations/`.

### A Worked Rewrite: Predicate Pushdown

```cpp
class PredicatePushdown : public LogicalPlanVisitor {
    std::vector<std::unique_ptr<Expression>> pushable_;

public:
    void Visit(LogicalFilter& node) override {
        // Try to push the filter predicate into children.
        ExtractConjuncts(std::move(node.predicate), pushable_);
        node.children[0]->Accept(*this);
        // Anything we could not push stays here.
        node.predicate = CombineAnd(std::move(pushable_));
        pushable_.clear();
    }

    void Visit(LogicalJoin& node) override {
        std::vector<std::unique_ptr<Expression>> left_only, right_only, both;
        for (auto& p : pushable_) {
            auto refs = CollectColumnRefs(*p);
            if (RefsOnlyLeft(refs, node))       left_only.push_back(std::move(p));
            else if (RefsOnlyRight(refs, node)) right_only.push_back(std::move(p));
            else                                 both.push_back(std::move(p));
        }
        pushable_ = std::move(left_only);
        node.children[0]->Accept(*this);
        pushable_ = std::move(right_only);
        node.children[1]->Accept(*this);
        pushable_ = std::move(both);  // stay above the join
    }

    void Visit(LogicalScan& node) override {
        // Scans accept all remaining predicates as a residual filter,
        // which will later be folded into the storage scan if the
        // storage layer supports predicate pushdown (Parquet, MergeTree).
        if (!pushable_.empty()) {
            // Wrap scan in a filter at the leaf for the planner to consume.
            // Implementation omitted for brevity.
        }
    }

    // ... other Visit overloads
};
```

The body of `RefsOnlyLeft` checks whether the columns referenced by the predicate all come from the join's left subtree's output schema. Real implementations carry a column-to-source map populated during planning.

### What to Take Away

The logical plan is a tree of algebraic operators. The expressions inside it are a separate tree. The visitor pattern is the right tool for traversal in C++ because it gives you exhaustive switch checking through the pure-virtual contract and keeps the rewrite logic in one class per rewrite. Every optimization in the next chapters operates on this representation. Get it right and the rest of the engine is a series of well-bounded problems.

---
