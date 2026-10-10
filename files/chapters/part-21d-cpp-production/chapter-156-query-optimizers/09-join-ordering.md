## Join Ordering

A query with N joins has N! left-deep orderings and a Catalan number of bushy orderings. For 12 tables, that is 479 million left-deep and 28 trillion bushy. Brute force is impossible. Join ordering is the single most consequential decision the optimizer makes: a bad order can produce intermediate results 1000x larger than necessary.

This chapter covers the algorithms that work in practice.

### The Problem Statement

Given a set of relations R1, R2, ..., RN and a set of join predicates, find a binary tree of joins that:

1. Produces the correct answer (every join predicate is applied somewhere).
2. Minimizes total cost (typically dominated by the size of the largest intermediate result).

The structure of the join graph (which relations connect to which) drives algorithm choice. Common shapes:

- **Chain**: R1 - R2 - R3 - R4 (each table joins only with neighbors)
- **Star**: F joined with D1, D2, D3 (one fact, many dimensions)
- **Snowflake**: star with dimension tables that further join (D1 - D1a)
- **Clique**: every relation joins with every other relation
- **Cyclic**: a cycle in the join graph

Star and chain queries are easy. Cyclic clique queries on 15 tables are where optimizers earn their salary.

### Dynamic Programming: DPsize

Selinger's System R algorithm (1979) considered only left-deep trees and used dynamic programming over relation subsets. DPsize generalizes this to bushy plans.

DPsize iterates over subset sizes from 2 to N. For each subset of size k, it tries every split into two non-empty subsets that have already been costed. The best split becomes the optimal plan for that subset.

```cpp
#include <bitset>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace jo {

constexpr size_t kMaxRelations = 32;
using RelSet = uint32_t;  // bitset over up to 32 relations

struct PlanInfo {
    double cost;
    double cardinality;
    RelSet left;
    RelSet right;
};

class JoinGraph {
public:
    size_t num_relations;
    std::vector<double> base_cardinality;  // size = num_relations
    // edges[(a,b)] = predicate selectivity (or 1.0 if no edge)
    std::unordered_map<uint64_t, double> selectivity;

    bool Connected(RelSet a, RelSet b) const {
        for (size_t i = 0; i < num_relations; ++i) {
            if (!(a & (1u << i))) continue;
            for (size_t j = 0; j < num_relations; ++j) {
                if (!(b & (1u << j))) continue;
                uint64_t k = (uint64_t(std::min(i, j)) << 32) | std::max(i, j);
                if (selectivity.count(k)) return true;
            }
        }
        return false;
    }

    double JoinSelectivity(RelSet a, RelSet b) const {
        double s = 1.0;
        for (size_t i = 0; i < num_relations; ++i) {
            if (!(a & (1u << i))) continue;
            for (size_t j = 0; j < num_relations; ++j) {
                if (!(b & (1u << j))) continue;
                uint64_t k = (uint64_t(std::min(i, j)) << 32) | std::max(i, j);
                auto it = selectivity.find(k);
                if (it != selectivity.end()) s *= it->second;
            }
        }
        return s;
    }
};

class DPsize {
    const JoinGraph& g_;
    std::unordered_map<RelSet, PlanInfo> dp_;

public:
    explicit DPsize(const JoinGraph& g) : g_(g) {}

    PlanInfo Solve() {
        // Base: singletons.
        for (size_t i = 0; i < g_.num_relations; ++i) {
            RelSet s = 1u << i;
            dp_[s] = {0.0, g_.base_cardinality[i], 0, 0};
        }
        // Iterate over subset sizes.
        for (size_t size = 2; size <= g_.num_relations; ++size) {
            EnumerateSubsets(size);
        }
        RelSet all = (1u << g_.num_relations) - 1;
        return dp_[all];
    }

private:
    void EnumerateSubsets(size_t size) {
        for (RelSet s = 0; s < (1u << g_.num_relations); ++s) {
            if (std::popcount(s) != size) continue;
            TryAllSplits(s);
        }
    }

    void TryAllSplits(RelSet s) {
        PlanInfo best{std::numeric_limits<double>::infinity(), 0, 0, 0};
        // Iterate over non-empty proper subsets of s.
        for (RelSet l = (s - 1) & s; l > 0; l = (l - 1) & s) {
            RelSet r = s ^ l;
            if (!g_.Connected(l, r)) continue;
            auto itl = dp_.find(l);
            auto itr = dp_.find(r);
            if (itl == dp_.end() || itr == dp_.end()) continue;
            double sel = g_.JoinSelectivity(l, r);
            double card = itl->second.cardinality * itr->second.cardinality * sel;
            double cost = itl->second.cost + itr->second.cost
                        + itl->second.cardinality + itr->second.cardinality;
            if (cost < best.cost) best = {cost, card, l, r};
        }
        dp_[s] = best;
    }
};

}  // namespace jo
```

The trick `for (l = (s-1) & s; l > 0; l = (l-1) & s)` iterates over all non-empty proper subsets of `s`. It runs in O(3^n) total across all subsets, which is the lower bound for bushy DP.

DPsize is exact and finds the global optimum. It is feasible up to N around 12. Above that, the 3^n term dominates: 12 = 530K, 14 = 4.8M, 16 = 43M, 18 = 387M.

### DPsub and DPccp: Smarter Enumeration

DPsub enumerates connected subgraphs only, skipping disconnected subsets. For a chain query (sparse graph), this is dramatically smaller than DPsize.

DPccp (Moerkotte and Neumann, 2006) enumerates connected complement pairs. It is the asymptotically fastest exact algorithm and is what Postgres `geqo_threshold` actually triggers. The key idea: iterate over connected subgraphs in inverse-BFS order, and for each, iterate over connected complements that are reachable through the predicate graph.

DPccp on a chain query is O(n^3). On a clique it is O(3^n) like DPsize. For typical OLAP queries (mostly chain or snowflake structure), DPccp is the right choice. For up to 20 tables it is tractable.

```cpp
// DPccp skeleton (full implementation is 200+ lines, here is the outline).
class DPccp {
    const JoinGraph& g_;
    std::unordered_map<RelSet, PlanInfo> dp_;

public:
    void Solve() {
        // 1. Initialize singletons.
        // 2. EmitCsg: enumerate connected subgraphs in BFS order.
        // 3. For each csg S, EnumerateComplementsCmp(S) finds all
        //    connected complements C such that the predicate graph
        //    has an edge between S and C.
        // 4. Combine S and C to form S union C, update DP table.
    }
};
```

### Heuristic Algorithms for Large N

Above 16 tables, exact DP is too slow. Heuristics take over.

**IKKBP (Ibaraki and Kameda)** is a polynomial algorithm for left-deep trees with a tree-shaped query graph. It runs in O(n^2) and is provably optimal under those constraints. Real queries rarely satisfy the constraints, but IKKBP is a good seed for randomized search.

**Greedy join enumeration.** Pick the cheapest 2-way join, treat it as a relation, repeat. O(n^3) and easy to implement. CockroachDB's fallback above 12 tables is essentially this.

**Genetic algorithms (GeQO).** Encode each join order as a chromosome, run mutation and crossover, evaluate fitness as inverse cost. Postgres's `geqo` kicks in above 12 tables by default. Quality is workload-dependent.

**Simulated annealing.** Start with a random order, perturb by swapping subtrees, accept perturbations probabilistically. Converges to local optima. SAP HANA uses this as a fallback.

```cpp
namespace jo {

class GreedyOrdering {
    const JoinGraph& g_;
public:
    explicit GreedyOrdering(const JoinGraph& g) : g_(g) {}

    PlanInfo Solve() {
        // Each item is a built subplan with cardinality and cost.
        std::vector<PlanInfo> active;
        std::vector<RelSet> tags;
        for (size_t i = 0; i < g_.num_relations; ++i) {
            active.push_back({0.0, g_.base_cardinality[i], 0, 0});
            tags.push_back(1u << i);
        }
        while (active.size() > 1) {
            double best_cost = std::numeric_limits<double>::infinity();
            size_t bi = 0, bj = 0;
            for (size_t i = 0; i < active.size(); ++i) {
                for (size_t j = i + 1; j < active.size(); ++j) {
                    if (!g_.Connected(tags[i], tags[j])) continue;
                    double sel = g_.JoinSelectivity(tags[i], tags[j]);
                    double card = active[i].cardinality * active[j].cardinality * sel;
                    if (card < best_cost) { best_cost = card; bi = i; bj = j; }
                }
            }
            // Merge bi and bj.
            double sel = g_.JoinSelectivity(tags[bi], tags[bj]);
            PlanInfo merged{
                active[bi].cost + active[bj].cost + active[bi].cardinality + active[bj].cardinality,
                active[bi].cardinality * active[bj].cardinality * sel,
                tags[bi], tags[bj]
            };
            active[bi] = merged;
            tags[bi] = tags[bi] | tags[bj];
            active.erase(active.begin() + bj);
            tags.erase(tags.begin() + bj);
        }
        return active[0];
    }
};

}  // namespace jo
```

Greedy is fast (O(n^3)) and produces good plans on chain and star queries. On clique queries it can produce plans 10x worse than optimal. Always use it as a fallback, never as the primary.

### ML-Driven Join Ordering

The last few years brought reinforcement learning approaches.

**Bao** (Marcus et al., 2021) is a learned arm bandit over a fixed set of optimizer hint sets. It does not order joins from scratch, it learns which hint configurations work well for which query shapes. Used in production at Microsoft for SCOPE.

**Neo** (Marcus et al., 2019) trains a deep neural network to predict cost given a query and a partial plan. Uses tree LSTM encoders. Beats Postgres on join ordering by 20% on average. Cost: training data and infrastructure overhead.

**Rejoin / DeepRM** (Marcus and Papaemmanouil, 2018) treats join ordering as a Markov decision process. RL agent learns a policy.

Production adoption: Bao has the most. Neo and Rejoin remain mostly research. The CockroachDB team has experimented with Bao-style hint learning but has not shipped it as of 2026.

### Cardinality Errors Make Order Selection Brittle

The dirty secret of join ordering is that the optimizer's choice is only as good as its cardinality estimates. The "How Good Are Query Optimizers, Really?" paper (Leis et al., 2015) showed:

- Optimal join order under perfect cardinality is nearly always the best plan.
- Optimal join order under estimated cardinality is sometimes orders of magnitude worse than the best plan.
- The dominant cause of bad plans is cardinality, not the algorithm.

This is why adaptive execution (chapter 18) matters: a runtime check can revisit join order when actual cardinalities diverge from estimates.

### What Each Engine Uses

- **Postgres**: DPsize up to `from_collapse_limit` and `join_collapse_limit` (default 8), GeQO above. The `from_collapse_limit` GUC is per-FROM clause, `join_collapse_limit` is per query.
- **CockroachDB**: Cascades-style with bounded exploration, falls back to greedy above 12 tables.
- **DuckDB**: DPccp up to 12 tables, greedy above.
- **SQL Server**: Cascades with multi-phase optimization (Phase 0 transaction processing, Phase 1 quick plan, Phase 2 full optimization).
- **Snowflake**: Cascades-derived, proprietary.
- **BigQuery**: distributed bottom-up enumeration with cost broadcasting across workers.

### Putting It All Together

The decision tree for a production join orderer in 2026:

1. N <= 8 tables: full DPccp or DPsize.
2. 8 < N <= 16: DPccp with timeout, fall back to greedy if budget exceeded.
3. N > 16: greedy seed, then iterative improvement (simulated annealing or 2-opt) under time budget.
4. Repeat queries: cache the chosen plan keyed by query template, use the cached choice.
5. Adaptive: monitor actual cardinalities, replan mid-query if estimates were 10x or worse off.

The next chapter goes into the join operators themselves: hash, sort-merge, nested-loop, and their parallel and out-of-core variants.

---
