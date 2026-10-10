## Cascades and the Volcano Optimizer

The optimizer's job is to enumerate plans and pick the cheapest. Naive enumeration is exponential in the number of operators. The Volcano optimizer (Graefe, 1993) and its successor Cascades (Graefe, 1995) are the two frameworks that almost every modern cost-based optimizer derives from. SQL Server uses Cascades. Apache Calcite uses Cascades (Volcano-based variant). Greenplum's ORCA is Cascades. CockroachDB's optimizer is Cascades-inspired. Snowflake's optimizer is Cascades-derived.

This chapter is the implementation guide.

### The Memo Structure

Cascades stores the explored plan space in a memo. The memo is a graph where:

- A **group** is an equivalence class of expressions producing the same logical output.
- A **group expression** is one expression node (operator + child group references).
- A group's **winner** is the lowest-cost implementation given physical properties.

If the query has 4 join orderings of the same 3 tables, all 4 orderings live in different groups (they have different output orders or different physical properties), but their logical equivalents share child groups.

```cpp
#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

namespace cascades {

using GroupId = uint32_t;
constexpr GroupId kInvalidGroup = ~GroupId{0};

enum class OpKind : uint8_t {
    LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalAggregate,
    PhysicalScan, PhysicalFilter, PhysicalProject,
    PhysicalHashJoin, PhysicalSortMergeJoin, PhysicalIndexJoin,
    PhysicalHashAgg, PhysicalSortAgg
};

struct GroupExpr {
    OpKind op;
    std::vector<GroupId> inputs;
    // Operator-specific payload (predicate, join keys, table id) lives here.
    // Use a tagged union or polymorphic node.
    void* payload = nullptr;

    bool operator==(const GroupExpr& o) const {
        return op == o.op && inputs == o.inputs && payload == o.payload;
    }
};

struct GroupExprHash {
    size_t operator()(const GroupExpr& g) const noexcept {
        size_t h = std::hash<int>{}(int(g.op));
        for (auto i : g.inputs) h = h * 31 + i;
        return h ^ std::hash<void*>{}(g.payload);
    }
};

struct PhysicalProperties {
    enum class Distribution { Any, Singleton, Hashed, Replicated };
    Distribution dist = Distribution::Any;
    std::vector<uint32_t> hash_columns;
    std::vector<uint32_t> sort_columns;

    bool Satisfies(const PhysicalProperties& required) const;
};

struct Winner {
    const GroupExpr* expr;
    double cost;
    PhysicalProperties props;
};

struct Group {
    GroupId id;
    std::vector<GroupExpr> exprs;
    // Winners keyed by required physical properties.
    std::vector<Winner> winners;
    // Cached logical statistics.
    double row_count = -1.0;
    bool explored = false;
};

class Memo {
    std::vector<std::unique_ptr<Group>> groups_;
    std::unordered_map<GroupExpr, GroupId, GroupExprHash> dedup_;

public:
    GroupId AddExpr(GroupExpr expr) {
        auto it = dedup_.find(expr);
        if (it != dedup_.end()) {
            // Existing expression. Add to its existing group.
            return it->second;
        }
        auto g = std::make_unique<Group>();
        g->id = static_cast<GroupId>(groups_.size());
        g->exprs.push_back(expr);
        GroupId id = g->id;
        dedup_[expr] = id;
        groups_.push_back(std::move(g));
        return id;
    }

    Group* Get(GroupId id) { return groups_[id].get(); }
    size_t Size() const { return groups_.size(); }
};

}  // namespace cascades
```

The memo deduplicates structurally equal expressions. When a transformation rule rewrites `Join(A, B)` to `Join(B, A)` (commutativity), the new expression is added to the same group. When a different rule rewrites it to `Join(Join(A, X), B)` (associativity producing a different output), the result lives in a different group because its expression structure differs.

### Transformation Rules vs Implementation Rules

Cascades distinguishes two rule kinds.

**Transformation rules** rewrite logical to logical. Examples: join commutativity, join associativity, predicate pushdown, decorrelation.

**Implementation rules** rewrite logical to physical. Examples: `LogicalJoin` becomes `PhysicalHashJoin` or `PhysicalSortMergeJoin`. `LogicalAggregate` becomes `PhysicalHashAgg` or `PhysicalSortAgg`.

A rule has three parts: a pattern (what shape of expression triggers the rule), a check (additional conditions), and a transform (what to produce).

```cpp
namespace cascades {

class Rule {
public:
    virtual ~Rule() = default;
    virtual bool Match(const GroupExpr& e, const Memo& m) const = 0;
    virtual std::vector<GroupExpr> Apply(const GroupExpr& e, Memo& m) const = 0;
    virtual bool IsTransformation() const = 0;
};

// Inner join commutativity: Join(A, B) -> Join(B, A).
class JoinCommutativity final : public Rule {
public:
    bool Match(const GroupExpr& e, const Memo&) const override {
        return e.op == OpKind::LogicalJoin;
    }
    std::vector<GroupExpr> Apply(const GroupExpr& e, Memo&) const override {
        GroupExpr swapped = e;
        std::swap(swapped.inputs[0], swapped.inputs[1]);
        return {swapped};
    }
    bool IsTransformation() const override { return true; }
};

// Implement LogicalJoin as PhysicalHashJoin.
class HashJoinImpl final : public Rule {
public:
    bool Match(const GroupExpr& e, const Memo&) const override {
        return e.op == OpKind::LogicalJoin;
        // Additional check: equi-join predicate exists.
    }
    std::vector<GroupExpr> Apply(const GroupExpr& e, Memo&) const override {
        GroupExpr p = e;
        p.op = OpKind::PhysicalHashJoin;
        return {p};
    }
    bool IsTransformation() const override { return false; }
};

// Implement LogicalJoin as PhysicalSortMergeJoin.
class SortMergeJoinImpl final : public Rule {
public:
    bool Match(const GroupExpr& e, const Memo&) const override {
        return e.op == OpKind::LogicalJoin;
    }
    std::vector<GroupExpr> Apply(const GroupExpr& e, Memo&) const override {
        GroupExpr p = e;
        p.op = OpKind::PhysicalSortMergeJoin;
        return {p};
    }
    bool IsTransformation() const override { return false; }
};

}  // namespace cascades
```

### The Search Algorithm: Top-Down with Branch-and-Bound

Cascades uses top-down memoization with branch-and-bound pruning. The high-level entry point is `Optimize(group, required_props, upper_bound)`.

```cpp
namespace cascades {

class Optimizer {
    Memo& memo_;
    std::vector<std::unique_ptr<Rule>> rules_;
    double bound_ = std::numeric_limits<double>::infinity();

public:
    explicit Optimizer(Memo& m) : memo_(m) {}

    void AddRule(std::unique_ptr<Rule> r) { rules_.push_back(std::move(r)); }

    // Returns the best plan cost for this group satisfying required properties.
    double Optimize(GroupId g, const PhysicalProperties& required, double upper) {
        Group* group = memo_.Get(g);

        // Cache hit?
        for (auto& w : group->winners) {
            if (w.props.Satisfies(required)) return w.cost;
        }

        // Explore: apply transformation rules to expand the group.
        if (!group->explored) {
            ExploreGroup(group);
            group->explored = true;
        }

        // For each expression in the group, apply implementation rules and
        // optimize children, computing total cost.
        double best_cost = upper;
        const GroupExpr* best_expr = nullptr;
        for (auto& expr : group->exprs) {
            if (IsLogical(expr.op)) continue;  // Implementation only.
            double child_cost_sum = 0.0;
            bool prune = false;
            for (auto child : expr.inputs) {
                PhysicalProperties child_required = DeriveChildProps(expr, required);
                double child_cost = Optimize(child, child_required, best_cost - child_cost_sum);
                if (child_cost == std::numeric_limits<double>::infinity()) {
                    prune = true; break;
                }
                child_cost_sum += child_cost;
                if (child_cost_sum >= best_cost) { prune = true; break; }
            }
            if (prune) continue;
            double total = child_cost_sum + LocalCost(expr, group);
            if (total < best_cost) {
                best_cost = total;
                best_expr = &expr;
            }
        }

        if (best_expr) {
            group->winners.push_back({best_expr, best_cost, required});
        }
        return best_cost;
    }

private:
    void ExploreGroup(Group* group) {
        std::vector<GroupExpr> new_exprs;
        for (auto& e : group->exprs) {
            for (auto& r : rules_) {
                if (r->IsTransformation() && r->Match(e, memo_)) {
                    auto produced = r->Apply(e, memo_);
                    for (auto& p : produced) new_exprs.push_back(std::move(p));
                }
            }
        }
        for (auto& e : new_exprs) memo_.AddExpr(e);
        // Recursively explore child groups.
        for (auto& e : group->exprs) {
            for (auto c : e.inputs) {
                Group* child = memo_.Get(c);
                if (!child->explored) { ExploreGroup(child); child->explored = true; }
            }
        }
    }

    static bool IsLogical(OpKind op) {
        return int(op) < int(OpKind::PhysicalScan);
    }
    PhysicalProperties DeriveChildProps(const GroupExpr&, const PhysicalProperties&) {
        return {};  // Real implementation propagates sort, distribution requirements.
    }
    double LocalCost(const GroupExpr&, const Group*) {
        return 1.0;  // Real implementation calls the cost model from chapter 07.
    }
};

}  // namespace cascades
```

The `upper_bound` parameter is the branch-and-bound trick. The optimizer says "I do not need to know exact costs above X." Any subtree whose partial cost already exceeds X is pruned without further exploration. This is what makes Cascades tractable on real query plans.

### Properties: The Reason Cascades Beats Volcano

The Volcano optimizer treated all plans as equivalent if they produce the same rows. Cascades distinguishes plans by **physical properties**: output order, partitioning, replication. A `PhysicalSortMergeJoin` requires its inputs to be sorted on the join keys. If a child happens to provide that order (because it is on top of an index scan), no extra sort is needed. If not, an enforcer (sort) is inserted.

This is the property propagation system. The optimizer, when asking child groups for their cost, also passes "required properties" (what the parent operator wants). The child group returns the cheapest plan that satisfies those properties, which may include enforcer operators (Sort, Exchange).

In the code above, `DeriveChildProps` is the function that, given the parent operator and the required output properties, computes what each child must satisfy. For `PhysicalSortMergeJoin`, both children must be sorted. For `PhysicalHashJoin`, the build child has no order requirement and the probe child must be co-partitioned with the build (in distributed plans).

### Apache Calcite Parallels

Calcite implements Cascades in Java. The mapping is:

- `RelNode` is the operator (group expression).
- `RelSet` is the group.
- `RelSubset` is `(RelSet, traits)`, where traits are physical properties.
- `RelOptRule` is the transformation or implementation rule.
- `RelOptPlanner` (specifically `VolcanoPlanner`) is the search engine.

If you read Calcite source, the names are different but the structure is the same as the C++ above.

### Practical Tips From Production Cascades Optimizers

1. **Rule ordering matters for pruning quality.** Apply cheap pruning rules (constant folding, predicate pushdown) before expensive ones (join reordering). Lower bounds get tighter earlier and prune more.
2. **Limit search depth.** A 20-table join cannot explore exhaustively. Cap exploration at a depth (CockroachDB caps at 12 tables, beyond which it falls back to greedy ordering).
3. **Memoize cardinality computations.** A given group's row count does not depend on which physical plan was chosen. Compute once, cache on the group.
4. **Track rule application history.** A rule that has already produced a result for an expression should not run again on the same expression. Stash a bitset on each `GroupExpr`.
5. **Memory budget for the memo.** Pathological queries can produce millions of group expressions. Bound the memo and switch to greedy fallback when it overflows.

### When Not to Use Cascades

For simple queries (single table, no joins), the search overhead exceeds query execution. Postgres has a "join_collapse_limit" GUC: above 8 tables, it switches to genetic optimization. CockroachDB switches to a greedy enumerator above a threshold. SQL Server switches to "transaction processing optimization" mode for short OLTP queries. Always have a fallback.

### What to Read

- Graefe, "The Cascades Framework for Query Optimization," IEEE Data Eng. Bull. 1995.
- Soliman et al., "Orca: A Modular Query Optimizer Architecture for Big Data," SIGMOD 2014 (Greenplum's open-source Cascades).
- Apache Calcite source under `core/src/main/java/org/apache/calcite/plan/volcano/`.
- CockroachDB's optimizer documentation in `docs/RFCS/20170908_sql_optimizer_statistics.md` and the `pkg/sql/opt` source.

The next chapter zooms into the most expensive subproblem inside Cascades: join ordering.

---
