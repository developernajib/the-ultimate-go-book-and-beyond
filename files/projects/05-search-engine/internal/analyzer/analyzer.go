// internal/analyzer/analyzer.go
package analyzer

import (
	"github.com/example/search-engine/internal/analyzer/filter"
	"github.com/example/search-engine/internal/analyzer/tokenizer"
)

// Analyzer combines tokenizer and filters
type Analyzer struct {
	tokenizer tokenizer.Tokenizer
	filters   []filter.TokenFilter
}

func NewAnalyzer(tok tokenizer.Tokenizer, filters ...filter.TokenFilter) *Analyzer {
	return &Analyzer{
		tokenizer: tok,
		filters:   filters,
	}
}

func (a *Analyzer) Analyze(text string) []tokenizer.Token {
	tokens := a.tokenizer.Tokenize(text)

	for _, f := range a.filters {
		tokens = f.Filter(tokens)
	}

	return tokens
}

// Extract just the text from tokens
func (a *Analyzer) AnalyzeText(text string) []string {
	tokens := a.Analyze(text)
	result := make([]string, len(tokens))
	for i, token := range tokens {
		result[i] = token.Text
	}
	return result
}

// Pre-configured analyzers

func NewStandardAnalyzer() *Analyzer {
	return NewAnalyzer(
		tokenizer.NewStandardTokenizer(),
		filter.NewLowercaseFilter(),
		filter.NewASCIIFoldingFilter(),
		filter.NewLengthFilter(2, 40),
	)
}

func NewEnglishAnalyzer() *Analyzer {
	return NewAnalyzer(
		tokenizer.NewStandardTokenizer(),
		filter.NewLowercaseFilter(),
		filter.NewASCIIFoldingFilter(),
		filter.NewStopWordFilter(filter.EnglishStopWords),
		filter.NewStemmerFilter(),
		filter.NewLengthFilter(2, 40),
	)
}

func NewNGramAnalyzer(minGram, maxGram int) *Analyzer {
	return NewAnalyzer(
		tokenizer.NewNGramTokenizer(minGram, maxGram),
		filter.NewLowercaseFilter(),
	)
}

func NewWhitespaceAnalyzer() *Analyzer {
	return NewAnalyzer(
		tokenizer.NewWhitespaceTokenizer(),
		filter.NewLowercaseFilter(),
	)
}

// AnalyzerRegistry manages available analyzers
type AnalyzerRegistry struct {
	analyzers map[string]*Analyzer
}

func NewAnalyzerRegistry() *AnalyzerRegistry {
	registry := &AnalyzerRegistry{
		analyzers: make(map[string]*Analyzer),
	}

	// Register default analyzers
	registry.Register("standard", NewStandardAnalyzer())
	registry.Register("english", NewEnglishAnalyzer())
	registry.Register("whitespace", NewWhitespaceAnalyzer())
	registry.Register("ngram", NewNGramAnalyzer(2, 3))

	return registry
}

func (r *AnalyzerRegistry) Register(name string, analyzer *Analyzer) {
	r.analyzers[name] = analyzer
}

func (r *AnalyzerRegistry) Get(name string) (*Analyzer, bool) {
	analyzer, ok := r.analyzers[name]
	return analyzer, ok
}
