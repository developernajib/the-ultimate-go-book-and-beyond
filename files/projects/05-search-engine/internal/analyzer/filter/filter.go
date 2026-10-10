// internal/analyzer/filter/filter.go
package filter

import (
	"strings"
	"unicode"

	"github.com/example/search-engine/internal/analyzer/tokenizer"
	"golang.org/x/text/unicode/norm"
)

// TokenFilter transforms tokens
type TokenFilter interface {
	Filter(tokens []tokenizer.Token) []tokenizer.Token
}

// LowercaseFilter - converts tokens to lowercase
type LowercaseFilter struct{}

func NewLowercaseFilter() *LowercaseFilter {
	return &LowercaseFilter{}
}

func (f *LowercaseFilter) Filter(tokens []tokenizer.Token) []tokenizer.Token {
	result := make([]tokenizer.Token, len(tokens))
	for i, token := range tokens {
		result[i] = token
		result[i].Text = strings.ToLower(token.Text)
	}
	return result
}

// ASCIIFoldingFilter - converts unicode to ASCII equivalents
type ASCIIFoldingFilter struct {
	normalizer norm.Form
}

func NewASCIIFoldingFilter() *ASCIIFoldingFilter {
	return &ASCIIFoldingFilter{
		normalizer: norm.NFD,
	}
}

func (f *ASCIIFoldingFilter) Filter(tokens []tokenizer.Token) []tokenizer.Token {
	result := make([]tokenizer.Token, len(tokens))
	for i, token := range tokens {
		result[i] = token
		result[i].Text = f.fold(token.Text)
	}
	return result
}

func (f *ASCIIFoldingFilter) fold(s string) string {
	normalized := f.normalizer.String(s)
	var builder strings.Builder
	builder.Grow(len(normalized))

	for _, r := range normalized {
		if r < 128 { // ASCII range
			builder.WriteRune(r)
		} else if unicode.In(r, unicode.Mn) {
			// Skip combining marks
			continue
		}
	}

	return builder.String()
}

// StopWordFilter - removes common words
type StopWordFilter struct {
	stopWords map[string]struct{}
}

func NewStopWordFilter(stopWords []string) *StopWordFilter {
	m := make(map[string]struct{}, len(stopWords))
	for _, word := range stopWords {
		m[strings.ToLower(word)] = struct{}{}
	}
	return &StopWordFilter{stopWords: m}
}

var EnglishStopWords = []string{
	"a", "an", "and", "are", "as", "at", "be", "but", "by",
	"for", "if", "in", "into", "is", "it", "no", "not", "of",
	"on", "or", "such", "that", "the", "their", "then", "there",
	"these", "they", "this", "to", "was", "will", "with",
}

func (f *StopWordFilter) Filter(tokens []tokenizer.Token) []tokenizer.Token {
	var result []tokenizer.Token
	for _, token := range tokens {
		if _, isStop := f.stopWords[strings.ToLower(token.Text)]; !isStop {
			result = append(result, token)
		}
	}
	return result
}

// StemmerFilter - reduces words to root form (Porter Stemmer)
type StemmerFilter struct{}

func NewStemmerFilter() *StemmerFilter {
	return &StemmerFilter{}
}

func (f *StemmerFilter) Filter(tokens []tokenizer.Token) []tokenizer.Token {
	result := make([]tokenizer.Token, len(tokens))
	for i, token := range tokens {
		result[i] = token
		result[i].Text = f.stem(token.Text)
	}
	return result
}

// Simplified Porter Stemmer implementation
func (f *StemmerFilter) stem(word string) string {
	word = strings.ToLower(word)

	// Step 1: Handle plurals and -ed/-ing
	if strings.HasSuffix(word, "sses") {
		word = word[:len(word)-2]
	} else if strings.HasSuffix(word, "ies") {
		word = word[:len(word)-2]
	} else if strings.HasSuffix(word, "ss") {
		// Keep as is
	} else if strings.HasSuffix(word, "s") {
		word = word[:len(word)-1]
	}

	// Step 2: Handle -ed, -ing
	if strings.HasSuffix(word, "eed") {
		if len(word) > 4 {
			word = word[:len(word)-1]
		}
	} else if strings.HasSuffix(word, "ed") {
		if len(word) > 3 {
			word = word[:len(word)-2]
		}
	} else if strings.HasSuffix(word, "ing") {
		if len(word) > 4 {
			word = word[:len(word)-3]
		}
	}

	return word
}

// LengthFilter - removes tokens outside length range
type LengthFilter struct {
	min int
	max int
}

func NewLengthFilter(min, max int) *LengthFilter {
	return &LengthFilter{min: min, max: max}
}

func (f *LengthFilter) Filter(tokens []tokenizer.Token) []tokenizer.Token {
	var result []tokenizer.Token
	for _, token := range tokens {
		length := len([]rune(token.Text))
		if length >= f.min && length <= f.max {
			result = append(result, token)
		}
	}
	return result
}
