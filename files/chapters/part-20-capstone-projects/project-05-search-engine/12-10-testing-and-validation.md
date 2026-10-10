## 10. Testing and Validation

Automated tests are essential for a system with this many moving parts. The integration test below exercises the full pipeline end-to-end: it indexes a small set of documents, runs term, phrase, and boolean queries, and asserts that the correct documents appear in the correct ranked order. Running this test after every change gives you confidence that the analyzer, index, parser, executor, and scorer all work together correctly.

### 10.1 Integration Tests
The integration tests index a small document corpus, run term, phrase, and Boolean queries, and assert that the correct documents appear in the expected ranked order.

```go
// tests/integration_test.go
package tests

import (
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/yourorg/gosearch/internal/analyzer"
    "github.com/yourorg/gosearch/internal/index/inverted"
    "github.com/yourorg/gosearch/internal/query/executor"
    "github.com/yourorg/gosearch/internal/query/parser"
    "github.com/yourorg/gosearch/internal/ranking"
)

func TestEndToEndSearch(t *testing.T) {
    // Create index
    index := inverted.NewInvertedIndex(analyzer.NewEnglishAnalyzer())

    // Index documents
    docs := []struct {
        id     uint32
        title  string
        body   string
    }{
        {1, "Go Programming", "Go is a modern programming language designed for building scalable systems"},
        {2, "Elasticsearch Guide", "Elasticsearch is a powerful search engine built on Lucene"},
        {3, "Search Engines", "Modern search engines use inverted indexes for fast retrieval"},
    }

    for _, doc := range docs {
        err := index.IndexDocument(&inverted.Document{
            ID: doc.id,
            Fields: map[string]string{
                "title": doc.title,
                "body":  doc.body,
            },
        })
        require.NoError(t, err)
    }

    // Create executor
    scorer := ranking.NewBM25Scorer(index)
    exec := executor.NewExecutor(index, scorer)
    p := parser.NewParser("body", "OR")

    // Test simple search
    query, err := p.Parse("search")
    require.NoError(t, err)

    results, err := exec.Execute(query, 10)
    require.NoError(t, err)
    assert.Greater(t, results.TotalHits, 0)
    assert.Equal(t, uint32(2), results.Results[0].DocID) // Elasticsearch doc should rank first

    // Test phrase search
    query, err = p.Parse("\"search engines\"")
    require.NoError(t, err)

    results, err = exec.Execute(query, 10)
    require.NoError(t, err)
    assert.Equal(t, 1, results.TotalHits)
    assert.Equal(t, uint32(3), results.Results[0].DocID)

    // Test boolean search
    query, err = p.Parse("search AND engines")
    require.NoError(t, err)

    results, err = exec.Execute(query, 10)
    require.NoError(t, err)
    assert.Greater(t, results.TotalHits, 0)
}
```

### Junior → FAANG: Ranked Result Testing as a Quality Benchmark

Testing a search engine is harder than testing a CRUD API because correct results are subjective: different ranking algorithms produce different orderings, and the "correct" ordering depends on user intent. The integration test in this chapter uses a simple predefined corpus with known expected rankings. This approach is valid for regression testing (ensuring a change does not break known good behavior) but insufficient for evaluating relevance quality.

For interviews, describe your search testing strategy: "I have integration tests that verify specific queries against a known corpus return the expected documents in the expected order. I also have unit tests for the BM25 scoring formula against hand-calculated values to verify correctness. For relevance quality, I would need a labeled test set with human-assigned relevance judgments."

Edge cases for search testing: empty query, query with all stop words (should the system return an error, all documents, or no results?), query with special characters that need escaping, query that matches no documents, and query that matches every document. Each case should have a test.

### Senior @ FAANG: Relevance Testing Infrastructure as a Platform Investment

At senior level, the integration test in this chapter is the foundation, not the complete testing strategy. A production search engine needs three layers of testing: correctness tests (does this query return the right documents?), ranking tests (are the right documents ranked highly?), and performance tests (does this query return results within the latency SLA?).

Relevance testing requires a dataset of queries with human-labeled relevance judgments: for each query, a set of documents labeled as highly relevant, somewhat relevant, or not relevant. Computing NDCG (Normalized Discounted Cumulative Gain) against this dataset measures ranking quality. Automating this evaluation (run NDCG computation in CI and fail if it drops below a threshold) makes ranking quality a release gate.

A/B testing for ranking changes requires careful experimental design. The treatment group (new ranking) and control group (current ranking) must be equally exposed to the same query distribution. Measuring the right metric (not just click-through rate, but downstream conversion or task completion) ensures that optimizing for the metric actually improves user experience. Building the A/B testing infrastructure for search (experiment assignment, metric collection, statistical analysis) is a staff-level platform investment.

---
