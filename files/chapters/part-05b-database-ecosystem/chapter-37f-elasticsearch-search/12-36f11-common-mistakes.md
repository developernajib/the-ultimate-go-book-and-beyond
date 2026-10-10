## 37F.11 Common Mistakes

### 1. Using Script Fields for Filtering

Script queries bypass the inverted index entirely and execute a Painless script against every document in the result set, turning a point-lookup into an O(n) scan. Replacing the script with a `range` or `term` query on an indexed field reduces query time from seconds to milliseconds.

```go
// BAD: script query (no index) - evaluates script on every document
query := map[string]any{
    "query": map[string]any{
        "script": map[string]any{
            "script": map[string]any{
                "source": "doc['price'].value < params.max",
                "params": map[string]any{"max": 100},
            },
        },
    },
}
// O(n) scan across all documents - catastrophic at scale

// GOOD: use indexed field with range query
query := map[string]any{
    "query": map[string]any{
        "range": map[string]any{
            "price": map[string]any{"lt": 100},
        },
    },
}
```

### 2. Mapping Explosion

When `dynamic` mapping is enabled (the default), every new JSON key in an indexed document creates a new field in the mapping. If users submit arbitrary key-value data, the mapping grows unboundedly. 10,000 users each sending 50 custom fields produces 500,000 mapping entries, which exhausts JVM heap and destabilizes the cluster. Use `"dynamic": "strict"` to reject unknown fields, or the `flattened` field type for user-controlled data.

```go
// BAD: dynamic mapping with user-controlled keys
// Users send arbitrary JSON → each new key creates a new mapping field
// After 10K users × 50 custom fields = 500,000 mapping fields → OOM

// GOOD: use flattened type for dynamic user data
const mapping = `{
  "properties": {
    "user_metadata": { "type": "flattened" }
  }
}`
// Stores key-value pairs without dynamic field creation
// Trade-off: limited query capabilities on nested values
```

### 3. Wildcard Queries on Keyword Fields

A leading wildcard like `*@gmail.com` cannot use the B-tree index prefix and forces Elasticsearch to iterate every term in the inverted index. Reversing the string at index time and using a prefix query on the reversed field, or using `edge_ngram` tokenization, restores index access for suffix patterns.

```go
// BAD: leading wildcard forces full index scan
query := map[string]any{
    "query": map[string]any{
        "wildcard": map[string]any{
            "email": map[string]any{"value": "*@gmail.com"},
        },
    },
}
// Every document's email field must be checked

// GOOD: normalize emails, use edge ngram for suffix search
// OR: use keyword with index_prefixes for prefix searches
// OR: reverse the string before indexing for suffix matching
```

### 4. Not Using Filter Context

Boolean clauses placed in `must` contribute to the relevance `_score`, which requires per-document TF-IDF computation even when scoring is irrelevant (e.g., `active == true`). Moving non-scoring predicates to the `filter` context makes them cacheable bit-set filters that Elasticsearch reuses across queries with no scoring overhead.

```go
// BAD: must clause for non-scoring filters (wastes scoring CPU)
query := map[string]any{
    "query": map[string]any{
        "bool": map[string]any{
            "must": []any{  // ← scores each document
                map[string]any{"term": map[string]any{"active": true}},
                map[string]any{"match": map[string]any{"name": "laptop"}},
            },
        },
    },
}

// GOOD: use filter for non-scored, cache-eligible clauses
query := map[string]any{
    "query": map[string]any{
        "bool": map[string]any{
            "must": []any{  // scored
                map[string]any{"match": map[string]any{"name": "laptop"}},
            },
            "filter": []any{  // not scored, cached
                map[string]any{"term": map[string]any{"active": true}},
            },
        },
    },
}
// Filter results are cached → 10-100x faster for repeated queries
```

### 5. Unbounded Aggregations

A `terms` aggregation with a large `size` on a high-cardinality field (like `user_id` or `session_id`) forces each shard to build a priority queue proportional to `size`, then the coordinating node merges all of them. Setting `size` to one million on a field with millions of unique values can consume gigabytes of heap and crash the node. Use `cardinality` for approximate unique counts, or keep `terms` sizes bounded to what the UI actually displays.

```go
// BAD: terms aggregation with high cardinality (user_id, session_id)
query := map[string]any{
    "aggs": map[string]any{
        "unique_users": map[string]any{
            "terms": map[string]any{
                "field": "user_id",
                "size":  1000000,  // catastrophic memory usage
            },
        },
    },
}

// GOOD: use cardinality agg for count, or bounded terms
query := map[string]any{
    "aggs": map[string]any{
        "unique_user_count": map[string]any{
            "cardinality": map[string]any{
                "field": "user_id",
                "precision_threshold": 40000, // accuracy vs memory trade-off
            },
        },
    },
}
```

### 6. Over-Sharding

Each Elasticsearch shard consumes JVM heap, file descriptors, and background threads regardless of its data volume.  Creating a shard per day of logs means 365 shards per year. With the recommended ratio of fewer than 20 shards per GB of heap, this quickly destabilizes the cluster. Use ILM rollover policies based on shard size (10-50 GB) rather than fixed time intervals.

```
BAD: creating too many shards
- One shard per day of logs → after 1 year: 365 shards per index
- Each shard has overhead: JVM heap, file handles, thread pools
- 1000+ shards → "shard explosion" → cluster instability

GOOD: target shard size of 10-50GB
- Use ILM with rollover on size (50GB) not just time
- Shrink shards in warm phase
- Rule of thumb: < 20 shards per GB of JVM heap
```

### Junior to FAANG: Diagnosing Your First Production Incident

The mistakes above look obvious in a book. They are not obvious at 2 AM. Build these diagnostic reflexes before you need them.

Reflex one, never trust "Elasticsearch is slow." That sentence is a prompt, not a diagnosis. Open `GET _nodes/hot_threads`. If you see Painless script frames at the top, someone shipped a script query. If you see geo decoding frames, someone is using `geo_shape` without a bounding prefilter. If you see aggregation reduce frames, someone unbounded a terms bucket.

Reflex two, read `GET _cluster/stats` like a checkup. Shard count divided by data node heap GB should be under 20. Field count per index should be under 1000 (hard default limit at 1000, raising it is a smell, not a fix). If `indices.segments.count` is climbing faster than `indices.docs.count` you have a refresh storm from too small a bulk size.

Reflex three, reproduce with `profile: true`. The `breakdown` per query clause tells you whether cost is in `build_scorer` (index structure wrong), `next_doc` (too many matches), or `score` (scoring complexity). A junior engineer guesses. A good engineer profiles.

Worked example. A teammate opens a PR adding a `wildcard` query on user email. You catch it in review. Rather than just saying "do not use leading wildcard," explain the cost. The inverted index is a sorted term dictionary. A prefix query binary searches to the start of the range and walks. A leading wildcard cannot. It must enumerate every term. With 50M unique emails that is an O(N) cost per query. Offer two fixes, index a reversed field, or add an `analyzer` with `reverse` token filter. The PR author now understands why, not just what.

"Why did this fail" reflex. When a query returns wrong results, the first question is analyzer mismatch between index time and query time. The second is mapping type (`text` vs `keyword`). The third is missing `doc_values`. Check in that order before reaching for complexity.

Interview entry point. "Tell me about a time a query was slow in production." Juniors describe the symptom. The L4 answer describes the diagnostic process, the root cause, the fix, and the guardrail added so it cannot recur.

### Senior at FAANG: Governance That Prevents Each Mistake

Treat common mistakes as governance gaps, not individual errors. Each one deserves a prevention mechanism baked into the platform.

Dynamic mapping explosion. The prevention is an index template registry. Every index pattern in production must match a template that sets `dynamic: strict` or `dynamic: runtime` with a documented field budget. Templates are owned by the search platform team and changes require an ADR. Enforce via a linter in CI that rejects index creation requests outside the registry. Production incidents where a team's logging library started emitting random UUIDs as field names are common enough that this should be non negotiable at L4 and above.

Unbounded terms aggregation. The prevention is a query gateway. All client traffic passes through a proxy (envoy filter, or a thin Go service) that parses aggregations and enforces size limits by API key. Internal analytics keys can request size up to 10K. Public facing keys cap at 100. Rejected queries return a structured error with a remediation link. This is the only scalable control. Asking developers to remember is not.

Deep pagination. Elasticsearch's `from + size` beyond 10K is rejected by default for good reason. The migration path is `search_after` with a stable tiebreaker (typically `_shard_doc` since ES 7.12, or a monotonic ID). Scroll API is deprecated for user facing workflows and should remain only for batch export. At L5, a platform level pagination abstraction hides the choice and enforces a max page depth.

Unbounded kNN queries. Elasticsearch 9 introduced proper cost accounting for HNSW traversal but the default `num_candidates` can still blow up recall vs latency. Governance is a kNN profile registry, each model registered with approved `num_candidates`, `k`, and `ef_search`. Unknown models cannot be queried in production. This closes the door on a common L3 mistake of tuning parameters in notebooks and shipping them unchanged.

Scripts in the hot path. Allowed only for stored scripts registered in a script catalog. Inline scripts are blocked at the gateway. Stored scripts go through review because they run with full cluster privileges and are a known pivot for privilege escalation.

Over sharding. Enforce via an admission controller. Index template creation rejects shard counts that imply less than 10 GB or more than 50 GB steady state shards given the declared retention and ingest rate. The declaration itself is an SLO document.

Not using `doc_values`. Governance is a mapping review ADR template. Every new field declares, is it filtered, sorted, aggregated, retrieved. The matrix determines mapping. Reviewers reject mappings that aggregate on a `text` field without a `.keyword` multifield.

Cluster sizing ADR template. Every production cluster must have a one page ADR covering, data node count and instance type, master node topology (always dedicated at three or five), heap size (never above 31 GB due to compressed oops), shard budget, ingest rate assumption, query rate assumption, failure mode for single AZ loss, failure mode for full region loss, and the revisit trigger (typically 70 percent of any headroom).

Shard rebalance policy. Document `cluster.routing.allocation.awareness.attributes` for zone spread, the disk watermark trio (low 85, high 90, flood 95), and the throttle for concurrent recoveries. Disasters happen when a node dies during a deploy and recovery storms saturate network. The policy prevents this.

Maturity model for mistake prevention. L1, post mortems after incidents. L2, runbooks for common issues. L3, dashboards alert before incidents. L4, guardrails prevent the misuse at admission time. L5, platform abstraction makes the misuse impossible to express.

---
