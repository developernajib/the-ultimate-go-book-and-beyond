## Deep Dive: Snippet Generation

Snippets are the short text excerpts shown below each search result that help users decide which link to click. A good snippet contains the user's query terms highlighted in context, drawn from the most relevant sentence in the document. This implementation scores each sentence by how many query terms it contains, with a bias toward sentences appearing earlier in the document, then highlights matching terms with bold tags.

```go
package snippet

import "strings"

// GenerateSnippet picks the best sentence and highlights query terms.
// In production, escape the body HTML before inserting <b> tags so page
// content cannot inject markup into the results page.
func GenerateSnippet(body string, terms []string, maxLen int) string {
	sents := strings.Split(body, ". ")
	bestScore, bestIdx := -1.0, 0
	for i, s := range sents {
		score := 0.0
		for _, t := range terms {
			if strings.Contains(strings.ToLower(s), t) {
				score += 1.0
			}
		}
		score *= 1.0 / (1.0 + float64(i)*0.1)
		if score > bestScore {
			bestScore = score
			bestIdx = i
		}
	}
	snip := sents[bestIdx]
	if len(snip) > maxLen {
		snip = snip[:maxLen] + "..."
	}
	for _, t := range terms {
		snip = highlight(snip, t)
	}
	return snip
}

// highlight wraps every case-insensitive occurrence of term in <b> tags,
// preserving the original casing of the matched text
func highlight(s, term string) string {
	lower := strings.ToLower(s)
	term = strings.ToLower(term)
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(lower[i:], term)
		if j < 0 {
			b.WriteString(s[i:])
			return b.String()
		}
		j += i
		b.WriteString(s[i:j])
		b.WriteString("<b>" + s[j:j+len(term)] + "</b>")
		i = j + len(term)
	}
}
```

---
