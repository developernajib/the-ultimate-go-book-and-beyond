// benchmarks/search_bench_test.go
package benchmarks

import (
	"testing"

	"github.com/example/search-engine/internal/analyzer"
	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/query/executor"
	"github.com/example/search-engine/internal/query/parser"
	"github.com/example/search-engine/internal/ranking"
)

func BenchmarkIndexing(b *testing.B) {
	index := inverted.NewInvertedIndex(analyzer.NewStandardAnalyzer())

	for i := 0; b.Loop(); i++ {
		doc := &inverted.Document{
			ID: uint32(i + 1),
			Fields: map[string]string{
				"title": "Benchmark Document",
				"body":  "This is a test document for benchmarking indexing performance",
			},
		}
		index.IndexDocument(doc)
	}
}

func BenchmarkSearch(b *testing.B) {
	// Setup
	index := inverted.NewInvertedIndex(analyzer.NewStandardAnalyzer())
	for i := range 10000 {
		doc := &inverted.Document{
			ID: uint32(i + 1),
			Fields: map[string]string{
				"title": "Document Title",
				"body":  "This is document body with some searchable content",
			},
		}
		index.IndexDocument(doc)
	}

	scorer := ranking.NewBM25Scorer(index)
	exec := executor.NewExecutor(index, scorer)
	p := parser.NewParser("body", "OR")

	query, _ := p.Parse("searchable content")

	for b.Loop() {
		exec.Execute(query, 10)
	}
}
