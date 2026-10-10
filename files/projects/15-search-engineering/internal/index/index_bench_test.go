package index_test

import (
	"fmt"
	"testing"

	"github.com/example/search-engineering/internal/index"
)

// sampleDocs returns a slice of documents for benchmarking.
func sampleDocs(n int) []index.Document {
	docs := make([]index.Document, n)
	for i := range docs {
		docs[i] = index.Document{
			ID: index.DocID(i + 1),
			Fields: map[string]string{
				"title": fmt.Sprintf("Document title number %d about golang search", i),
				"body":  fmt.Sprintf("This is the body of document %d. It discusses topics like search, indexing, BM25 ranking, and information retrieval in Go.", i),
				"tags":  "golang search indexing bm25",
			},
		}
	}
	return docs
}

func BenchmarkIndexDocument(b *testing.B) {
	// Pre-generate a corpus large enough that iterations rarely repeat.
	// b.Loop() (Go 1.24+) excludes this setup from the measurement.
	docs := sampleDocs(100_000)
	idx := index.NewInvertedIndex()

	for i := 0; b.Loop(); i++ {
		idx.IndexDocument(docs[i%len(docs)])
	}
}

func BenchmarkIndexDocument100(b *testing.B) {
	docs := sampleDocs(100)

	for b.Loop() {
		idx := index.NewInvertedIndex()
		for _, d := range docs {
			idx.IndexDocument(d)
		}
	}
}

func BenchmarkIndexLookup(b *testing.B) {
	idx := index.NewInvertedIndex()
	for _, d := range sampleDocs(1000) {
		idx.IndexDocument(d)
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			idx.RLock()
			_ = idx.GetIndex()[index.Term("golang")]
			idx.RUnlock()
		}
	})
}
