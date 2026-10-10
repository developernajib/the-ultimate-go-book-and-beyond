## 2. Text Analysis Pipeline

Text analysis is the very first step that runs whenever a document is indexed or a user submits a search query. The pipeline breaks raw text into individual tokens, normalizes them (for example, lowercasing or removing accents), filters out noise words like "the" and "is," and reduces words to their root forms through stemming. Without this preprocessing, a search for "running" would never match a document containing "ran," and uppercase letters would prevent obvious matches.

### 2.1 Tokenizer Implementation
The tokenizer scans raw text byte-by-byte, identifies word boundaries, and emits `Token` structs carrying the term text, byte offset, and position index.

```go
// internal/analyzer/tokenizer/tokenizer.go
package tokenizer

import (
    "unicode"
    "unicode/utf8"
)

// Token represents a single token with position information
type Token struct {
    Text       string
    Start      int  // Character offset
    End        int
    Position   int  // Token position in sequence
    Type       TokenType
}

type TokenType int

const (
    TokenWord TokenType = iota
    TokenNumber
    TokenEmail
    TokenURL
    TokenAcronym
)

// Tokenizer interface
type Tokenizer interface {
    Tokenize(text string) []Token
}

// StandardTokenizer - splits on whitespace and punctuation
type StandardTokenizer struct {
    maxTokenLength int
}

func NewStandardTokenizer() *StandardTokenizer {
    return &StandardTokenizer{
        maxTokenLength: 255,
    }
}

func (t *StandardTokenizer) Tokenize(text string) []Token {
    var tokens []Token
    var current []rune
    start := 0
    position := 0
    offset := 0

    for _, r := range text {
        if t.isTokenChar(r) {
            if len(current) == 0 {
                start = offset
            }
            current = append(current, r)

            if len(current) >= t.maxTokenLength {
                tokens = append(tokens, Token{
                    Text:     string(current),
                    Start:    start,
                    End:      offset + utf8.RuneLen(r),
                    Position: position,
                    Type:     t.detectType(current),
                })
                position++
                current = current[:0]
            }
        } else if len(current) > 0 {
            tokens = append(tokens, Token{
                Text:     string(current),
                Start:    start,
                End:      offset,
                Position: position,
                Type:     t.detectType(current),
            })
            position++
            current = current[:0]
        }
        offset += utf8.RuneLen(r)
    }

    // Handle remaining token
    if len(current) > 0 {
        tokens = append(tokens, Token{
            Text:     string(current),
            Start:    start,
            End:      offset,
            Position: position,
            Type:     t.detectType(current),
        })
    }

    return tokens
}

func (t *StandardTokenizer) isTokenChar(r rune) bool {
    return unicode.IsLetter(r) || unicode.IsNumber(r)
}

func (t *StandardTokenizer) detectType(runes []rune) TokenType {
    hasLetter := false
    hasDigit := false

    for _, r := range runes {
        if unicode.IsLetter(r) {
            hasLetter = true
        }
        if unicode.IsDigit(r) {
            hasDigit = true
        }
    }

    if hasDigit && !hasLetter {
        return TokenNumber
    }
    return TokenWord
}

// WhitespaceTokenizer - splits only on whitespace
type WhitespaceTokenizer struct{}

func NewWhitespaceTokenizer() *WhitespaceTokenizer {
    return &WhitespaceTokenizer{}
}

func (t *WhitespaceTokenizer) Tokenize(text string) []Token {
    var tokens []Token
    var current []rune
    start := 0
    position := 0
    offset := 0

    for _, r := range text {
        if !unicode.IsSpace(r) {
            if len(current) == 0 {
                start = offset
            }
            current = append(current, r)
        } else if len(current) > 0 {
            tokens = append(tokens, Token{
                Text:     string(current),
                Start:    start,
                End:      offset,
                Position: position,
                Type:     TokenWord,
            })
            position++
            current = current[:0]
        }
        offset += utf8.RuneLen(r)
    }

    if len(current) > 0 {
        tokens = append(tokens, Token{
            Text:     string(current),
            Start:    start,
            End:      offset,
            Position: position,
            Type:     TokenWord,
        })
    }

    return tokens
}

// NGramTokenizer - generates character n-grams
type NGramTokenizer struct {
    minGram int
    maxGram int
}

func NewNGramTokenizer(minGram, maxGram int) *NGramTokenizer {
    return &NGramTokenizer{
        minGram: minGram,
        maxGram: maxGram,
    }
}

func (t *NGramTokenizer) Tokenize(text string) []Token {
    runes := []rune(text)
    var tokens []Token
    position := 0

    for i := 0; i < len(runes); i++ {
        for n := t.minGram; n <= t.maxGram && i+n <= len(runes); n++ {
            gram := string(runes[i : i+n])
            tokens = append(tokens, Token{
                Text:     gram,
                Start:    i,
                End:      i + n,
                Position: position,
                Type:     TokenWord,
            })
            position++
        }
    }

    return tokens
}
```

### 2.2 Token Filters

Token filters transform the raw token stream through lowercasing, stop word removal, and stemming so that morphological variants of the same word map to a single index entry.

```go
// internal/analyzer/filter/filter.go
package filter

import (
    "strings"
    "unicode"

    "golang.org/x/text/unicode/norm"
    "github.com/yourorg/gosearch/internal/analyzer/tokenizer"
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
```

### 2.3 Analyzer

The analyzer chains the tokenizer with an ordered sequence of filters. Both indexing and querying use the same analyzer instance to ensure term consistency.

```go
// internal/analyzer/analyzer.go
package analyzer

import (
    "github.com/yourorg/gosearch/internal/analyzer/filter"
    "github.com/yourorg/gosearch/internal/analyzer/tokenizer"
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
```

### Junior → FAANG: Text Analysis as the Quality Foundation

The text analysis pipeline determines search quality more than any other component. If "running" and "ran" are not reduced to the same stem, queries for one will miss documents containing the other. If stop words ("the", "is", "a") are not filtered, they dominate the inverted index with posting lists that span almost every document, adding noise to search results.

For interviews, describe the analysis pipeline as a series of stages: tokenization (split text on word boundaries), normalization (lowercase, unicode normalization, accent removal), stop word removal, and stemming (reduce words to root form). Each stage can be independently configured or replaced. This is the analyzer abstraction that Elasticsearch uses: built-in analyzers (standard, english, french) compose standard stages, and custom analyzers allow mixing and matching.

Language-specific analysis is worth mentioning: English stemming (Porter stemmer reduces "running" to "run") does not work for German or Chinese. Japanese text requires a different tokenizer (character-based, not whitespace-based). Multilingual search requires either language detection and per-language analysis, or a more sophisticated cross-lingual approach.

### Senior @ FAANG: Text Analysis as a Relevance Quality Driver

At senior level, the text analysis pipeline is the primary lever for improving search relevance without changing the ranking algorithm. Common analysis improvements in production: synonym expansion (indexing "laptop" with "notebook" and "computer" to match broader queries), entity recognition (recognizing "New York" as a multi-word entity rather than separate terms "New" and "York"), and domain-specific normalization (standardizing product codes or SKUs to a canonical form).

Analysis pipeline changes have retroactive effects: if you change the stemmer, existing indexed documents are analyzed with the old stemmer while new documents are analyzed with the new stemmer, producing inconsistent results. Full reindexing (applying the new analyzer to all documents and building a new index) is required to ensure consistency. The index alias pattern (build new index, swap alias) makes this reindexing zero-downtime.

Analysis pipeline testing is critical: the output of your analyzer for a given input must be deterministic and must match the output for the same input in query time analysis. An asymmetric analyzer (indexes "run" but queries on "running") will find no matches even though the word is the same. Testing that index-time and query-time analysis produce the same tokens for equivalent text is a required correctness check.

---
