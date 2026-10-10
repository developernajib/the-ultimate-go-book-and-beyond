## Exercises

### Exercise: Implement NDCG@10 Metric Calculation in Go

Build a complete NDCG@10 evaluator that reads a judgment file and ranked results file, computes per-query NDCG@10, and prints a summary report.

**Requirements:**
1. Define a `JudgmentFile` JSON format: array of `{query, judgments: [{docID, grade}]}`.
2. Define a `ResultsFile` JSON format: array of `{query, rankedDocIDs: [string]}`.
3. Implement `DCG(relevances []float64, k int) float64` using the gain formula `(2^rel - 1) / log2(rank+1)`.
4. Implement `NDCG(relevances, ideal []float64, k int) float64`.
5. Load both files, match queries, build relevance vectors, compute NDCG@10 per query.
6. Print: per-query NDCG@10, overall mean NDCG@10, lowest 5 queries (regression candidates).

**Starter structure:**

```go
package main

import (
    "encoding/json"
    "fmt"
    "math"
    "os"
    "sort"
)

type Judgment struct {
    Query     string            `json:"query"`
    Judgments map[string]float64 `json:"judgments"` // docID -> grade (0-3)
}

type QueryResult struct {
    Query        string   `json:"query"`
    RankedDocIDs []string `json:"rankedDocIDs"`
}

func DCGAtK(relevances []float64, k int) float64 {
    limit := k
    if limit > len(relevances) {
        limit = len(relevances)
    }
    var dcg float64
    for i := 0; i < limit; i++ {
        dcg += (math.Pow(2, relevances[i]) - 1) / math.Log2(float64(i+2))
    }
    return dcg
}

func NDCGAtK(relevances, ideal []float64, k int) float64 {
    idcg := DCGAtK(ideal, k)
    if idcg == 0 {
        return 0
    }
    return DCGAtK(relevances, k) / idcg
}

func main() {
    // TODO: load judgments from os.Args[1], results from os.Args[2]
    // TODO: for each query, build relevance vector from judgment grades
    // TODO: build ideal vector (sort grades descending)
    // TODO: compute NDCG@10, accumulate, print report
    fmt.Println("NDCG@10 Evaluator - implement me")
    _ = sort.Float64Slice{}
    _ = json.Marshal
    _ = os.ReadFile
}
```

**Expected output format:**

```
Query                          NDCG@10
-------------------------------  -------
golang goroutines                0.8821
best coffee maker                0.7340
...
-------------------------------  -------
Mean NDCG@10                     0.7942

Lowest 5 queries (investigate):
  "buy cheap laptop"             0.3120
  ...
```

---

### Exercise: Build a Go Search Result Reranker Using Precomputed Feature Vectors

Implement a reranker that loads precomputed feature vectors from a file and reorders search results using a simple linear scoring model. **Requirements:** 1. Define `FeatureVector` struct with fields: `DocID`, `BM25Score`, `CTR`, `RecencyDays`, `ExactTitleMatch`, `DomainAuthority`.
2. Define `LinearRanker` with a `Weights` map and a `Score(fv FeatureVector) float64` method.
3. Load feature vectors from a JSON file (array of feature objects).
4. Load model weights from a JSON file `{field: weight}`.
5. For each document, compute `score = Σ(weight_i × feature_i)`.
6. Sort results by descending score and print ranked doc IDs with scores.
7. Validate: if all weights are zero, return original order (safety guard). **Feature vector JSON format:** ```json
[
  {
    "docID": "doc-001",
    "bm25Score": 12.4,
    "ctr": 0.082,
    "recencyDays": 3,
    "exactTitleMatch": 1,
    "domainAuthority": 78
  }
]
```

**Weights JSON format:**

```

```json
{
  "bm25Score": 0.4,
  "ctr": 15.0,
  "recencyDays": -0.01,
  "exactTitleMatch": 2.0,
  "domainAuthority": 0.02
}
```

**Starter structure:**

```go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "slices"
)

type FeatureVector struct {
    DocID           string  `json:"docID"`
    BM25Score       float64 `json:"bm25Score"`
    CTR             float64 `json:"ctr"`
    RecencyDays     float64 `json:"recencyDays"`
    ExactTitleMatch float64 `json:"exactTitleMatch"`
    DomainAuthority float64 `json:"domainAuthority"`
}

type LinearRanker struct {
    Weights map[string]float64
}

func (r *LinearRanker) Score(fv FeatureVector) float64 {
    return r.Weights["bm25Score"]*fv.BM25Score +
        r.Weights["ctr"]*fv.CTR +
        r.Weights["recencyDays"]*fv.RecencyDays +
        r.Weights["exactTitleMatch"]*fv.ExactTitleMatch +
        r.Weights["domainAuthority"]*fv.DomainAuthority
}

func main() {
    // TODO: load feature vectors from os.Args[1]
    // TODO: load weights from os.Args[2]
    // TODO: score each document, sort descending, print results
    // Safety guard: if all weights zero, print original order
    fmt.Println("Linear Reranker - implement me")
    _ = slices.SortFunc
    _ = json.Marshal
    _ = os.ReadFile
}
```

**Extension challenges:**
- Add a `MinScoreThreshold` to filter out results below a relevance floor.
- Implement feature normalization (z-score per feature) before scoring.
- Add a `BoostRules` map: if `exactTitleMatch == 1`, multiply final score by 1.5.
- Compare output order to BM25-only order and compute rank correlation (Spearman's ρ).

## FAANG Interview Questions

**Q: How would you design a vertical search (e.g., flights) versus general web search?**

A: Vertical search benefits from a known, structured schema (origin, destination, date, price). Use a relational or document store with purpose-built indexes rather than a general inverted index. Ranking is multi-objective: price, duration, layovers, airline preference, user history. Expose faceted filters natively. General web search must handle arbitrary queries over unstructured text, requiring broad NLP, entity recognition, and multi-signal ranking. Vertical search can achieve much higher precision because the problem is narrower.

**Q: How do you handle personalization in search without overfitting to noisy signals?**

A: Three principles:
1. Only personalize when confident: compute user embedding from at least 20 past interactions, otherwise fall back to global ranking.
2. Blend personal and global signals: a common formula is `final = 0.7 × global + 0.3 × personal` with the blend tuned via A/B test.
3. Add exploration: with 10% probability, insert a non-personalized result to avoid filter bubbles and collect diverse signals. Evaluate on session-level metrics (task success), not per-query CTR, since CTR rewards clickbait.

**Q: How would you build a query autocomplete system?**

A: Front a trie or FST with frequency weights built from the query log. On each keystroke, prefix-match and return the top 10 highest-weighted completions. Serve from an in-memory index (Elasticsearch completion suggester or a custom Go service with a marisa-trie). Personalize by blending a global trie with a per-user trie of recent queries. Filter abusive or trending-offensive queries via a denylist refreshed hourly. Budget p95 under 30ms since autocomplete runs on every keystroke.

**Q: How do you prevent search result manipulation (spam, SEO)?**

A: Multi-layer defenses:
1. Link spam: PageRank with trust penalties for sites that receive many links from known spam farms (TrustRank).
2. Content spam: classifier detecting keyword stuffing, cloaking, thin content.
3. Click fraud: detect bot patterns in click logs (CTR far above or below expected given rank position), downweight.
4. Query log hygiene: filter bot queries before they pollute ranking models.
5. Manual curation for head queries where stakes are highest. Update adversarially, every defense you publish is a target for attackers.

**Q: How would you migrate from Elasticsearch to a custom Go search engine?**

A: Phased, data-first migration:
1. Shadow index: write to both systems, compare result sets offline via judgment set NDCG. Tune until parity.
2. Dark launch: route 1% of queries to the new system, discard results, measure latency and error rates.
3. Canary: serve 1% of real traffic, compare session success rate against control.
4. Ramp: 5%, 25%, 50%, 100% with rollback thresholds.
5. Decommission ES only after 30 days at 100% with zero regressions. Never do a flag-day cutover for a ranking system, subtle regressions take weeks to detect.

## Engineering Perspectives

### Junior Engineer to FAANG Perspective

When starting out in search engineering, it is easy to assume that search is just `SELECT * WHERE text LIKE '%query%'` or spinning up an out-of-the-box Elasticsearch cluster. At FAANG scale, search is an intricate distributed system with two deeply intertwined pipelines: the offline ingestion/indexing pipeline and the ultra-low-latency online retrieval and scoring pipeline. As a junior engineer, focus first on mastering core information retrieval fundamentals: inverted indices, tokenization, posting list compression, and BM25 ranking mechanics. Understand why term saturation and length normalization matter. When writing search microservices in Go, pay close attention to memory allocations in inner loops - avoid allocating new slices or strings per token during query execution, preallocate posting buffers, and leverage `sync.Pool` for reusable tokenizers. Most importantly, learn early that relevance changes cannot be judged by eye: always evaluate changes using quantitative metrics like NDCG@10 and MRR over standardized judgment sets before suggesting ranking adjustments.

### Senior @ FAANG Perspective

Staff and Principal search engineers at companies like Google, Meta, and Amazon view search as an end-to-end optimization system balancing relevance, latency SLAs, infrastructure cost, and business objectives. A multi-stage retrieval architecture is standard: Stage 1 (candidate generation) uses BM25 and vector ANN to retrieve the top 1,000 candidates in under 15ms; Stage 2 applies a lightweight linear or shallow tree reranker to narrow to 100; and Stage 3 executes a deep Learning to Rank (LTR) LambdaMART or transformer model to produce the final top 10 SERP with feature extraction for personalization, freshness, and anti-spam signals. In Go-based search services, seniors architect for graceful degradation: circuit breaking slow shard fans, using hedged requests to conquer p99 tail latency, employing consistent hashing with virtual nodes to distribute index partitions evenly, and separating real-time indexing workloads from search serving to prevent GC and I/O starvation. Never accept subjective "looks better to me" feedback for ranking models - insist on offline regression gates in CI, team-draft interleaving for high-sensitivity online evaluation, and guardrail metrics on CTR, abandonment, and revenue before rolling out to 100% of production traffic.

---

| [◀ Project 14: SaaS Platform](../project-14-saas-platform/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Part XXI: Systems Programming with C++](../../part-21a-cpp/chapter-124-why-cpp/00-introduction.md) ▶ |
