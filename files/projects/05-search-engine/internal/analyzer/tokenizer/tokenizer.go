// internal/analyzer/tokenizer/tokenizer.go
package tokenizer

import (
	"unicode"
	"unicode/utf8"
)

// Token represents a single token with position information
type Token struct {
	Text     string
	Start    int // Character offset
	End      int
	Position int // Token position in sequence
	Type     TokenType
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

	for i := range runes {
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
