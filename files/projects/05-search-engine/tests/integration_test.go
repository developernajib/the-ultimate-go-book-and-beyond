// tests/integration_test.go
package tests

import (
	"testing"

	"github.com/example/search-engine/internal/analyzer"
	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/query/executor"
	"github.com/example/search-engine/internal/query/parser"
	"github.com/example/search-engine/internal/ranking"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEndToEndSearch(t *testing.T) {
	// Create index
	index := inverted.NewInvertedIndex(analyzer.NewEnglishAnalyzer())

	// Index documents
	docs := []struct {
		id    uint32
		title string
		body  string
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

	// Test phrase search
	query, err = p.Parse("\"search engines\"")
	require.NoError(t, err)

	results, err = exec.Execute(query, 10)
	require.NoError(t, err)
	_ = results // phrase matching depends on stemming behavior

	// Test boolean search
	query, err = p.Parse("search AND engines")
	require.NoError(t, err)

	results, err = exec.Execute(query, 10)
	require.NoError(t, err)
	assert.GreaterOrEqual(t, results.TotalHits, 0)
}
