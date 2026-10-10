package index

import (
	"testing"
)

func TestTokenizeAndStem(t *testing.T) {
	tokens := tokenize("Go is a statically typed programming language!")
	// Stop words like "is", "a" should be stripped. "statically" -> "statical", "programming" -> "programm".
	expectedContains := []string{"statical", "typed", "programm", "language"}
	tokenMap := make(map[string]bool)
	for _, tok := range tokens {
		tokenMap[tok] = true
	}

	for _, exp := range expectedContains {
		if !tokenMap[exp] {
			t.Errorf("expected token %q in %v", exp, tokens)
		}
	}

	if tokenMap["is"] || tokenMap["a"] {
		t.Errorf("stop words should have been filtered out")
	}
}

func TestIndexDocument(t *testing.T) {
	idx := NewInvertedIndex()
	doc1 := Document{
		ID: 1,
		Fields: map[string]string{
			"title": "Go Concurrency",
			"body":  "Goroutines and channels in Go make concurrent programming simple.",
		},
	}
	doc2 := Document{
		ID: 2,
		Fields: map[string]string{
			"title": "Python Programming",
			"body":  "Python is dynamically typed and simple.",
		},
	}

	idx.IndexDocument(doc1)
	idx.IndexDocument(doc2)

	if idx.DocCount() != 2 {
		t.Fatalf("expected doc count 2, got %d", idx.DocCount())
	}

	if idx.AvgDocLen() <= 0 {
		t.Fatalf("expected positive avg doc len, got %f", idx.AvgDocLen())
	}

	if idx.DocLen(1) <= 0 || idx.DocLen(2) <= 0 {
		t.Errorf("expected positive doc length for doc 1 and 2")
	}

	rawIndex := idx.GetIndex()
	if rawIndex[Term("concurrency")] == nil {
		t.Errorf("expected posting for 'concurrency'")
	}
}

func TestSortResults(t *testing.T) {
	results := []SearchResult{
		{DocID: 1, Score: 1.5},
		{DocID: 2, Score: 3.2},
		{DocID: 3, Score: 0.8},
	}

	SortResults(results)

	if results[0].DocID != 2 || results[1].DocID != 1 || results[2].DocID != 3 {
		t.Errorf("expected sorted by score descending, got %+v", results)
	}
}
