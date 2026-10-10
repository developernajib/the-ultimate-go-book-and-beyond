## Deep Dive: Multi-Language and CJK Support

Autocomplete systems must handle more than just Latin-script languages. Chinese and Japanese text has no spaces between words, and Korean spacing does not line up cleanly with search units, so traditional word-boundary tokenization does not work for CJK. Instead, character-level n-grams let the trie treat each character as a valid prefix. For right-to-left scripts like Arabic and Hebrew, Unicode normalization and diacritic stripping ensure consistent prefix matching.

```go
package autocomplete

import "unicode"

// DetectScript determines the primary script of a query
func DetectScript(query string) string {
	for _, r := range query {
		switch {
		case unicode.Is(unicode.Han, r):
			return "cjk"
		case unicode.Is(unicode.Hangul, r):
			return "korean"
		case unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r):
			return "japanese"
		case unicode.Is(unicode.Arabic, r):
			return "arabic"
		case unicode.Is(unicode.Cyrillic, r):
			return "cyrillic"
		}
	}
	return "latin"
}

// CJK lacks reliable word boundaries, use character-level n-grams
func CJKTokenize(text string) []string {
	runes := []rune(text)
	var tokens []string
	for i := 0; i < len(runes); i++ {
		tokens = append(tokens, string(runes[i:i+1]))
		if i+1 < len(runes) {
			tokens = append(tokens, string(runes[i:i+2]))
		}
	}
	return tokens
}

// For CJK: each character is a valid prefix, works naturally with trie
// For Arabic/Hebrew (RTL): normalize Unicode, strip diacritics
```

---
