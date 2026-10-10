package highlight

import (
	"html"
	"strings"
)

// Highlighter marks query terms in document excerpts
type Highlighter struct {
	PreTag  string // HTML tag before match (default: <mark>)
	PostTag string // HTML tag after match (default: </mark>)
	FragLen int    // fragment length in characters (default: 150)
}

func NewHighlighter() *Highlighter {
	return &Highlighter{
		PreTag:  "<mark>",
		PostTag: "</mark>",
		FragLen: 150,
	}
}

// Highlight returns a highlighted fragment of text
func (h *Highlighter) Highlight(text string, terms []string) string {
	if text == "" || len(terms) == 0 {
		return text
	}

	// Find best fragment (highest term density)
	fragment := h.bestFragment(text, terms)

	// Apply highlighting
	result := h.markTerms(fragment, terms)
	return "..." + result + "..."
}

func (h *Highlighter) bestFragment(text string, terms []string) string {
	if len(text) <= h.FragLen {
		return text
	}

	// Find positions of all term matches
	positions := h.findPositions(text, terms)
	if len(positions) == 0 {
		return text[:h.FragLen]
	}

	// Sliding window: find window with most matches
	bestStart := 0
	bestCount := 0
	currentCount := 0
	j := 0

	for i, pos := range positions {
		// Count terms within fragment window starting at pos
		currentCount = 0
		for j < len(positions) && positions[j]-pos <= h.FragLen {
			currentCount++
			j++
		}
		_ = i
		if currentCount > bestCount {
			bestCount = currentCount
			// Center the window on the first match
			start := max(pos-h.FragLen/4, 0)
			bestStart = start
		}
	}

	end := min(bestStart+h.FragLen, len(text))
	return text[bestStart:end]
}

func (h *Highlighter) findPositions(text string, terms []string) []int {
	lower := strings.ToLower(text)
	var positions []int

	for _, term := range terms {
		term = strings.ToLower(term)
		idx := 0
		for {
			pos := strings.Index(lower[idx:], term)
			if pos < 0 {
				break
			}
			positions = append(positions, idx+pos)
			idx += pos + len(term)
		}
	}

	// Sort positions
	for i := 1; i < len(positions); i++ {
		for j := i; j > 0 && positions[j] < positions[j-1]; j-- {
			positions[j], positions[j-1] = positions[j-1], positions[j]
		}
	}

	return positions
}

func (h *Highlighter) markTerms(text string, terms []string) string {
	// Build a sorted list of (start, end) ranges to highlight
	lower := strings.ToLower(text)
	type span struct{ start, end int }
	var spans []span

	for _, term := range terms {
		t := strings.ToLower(term)
		idx := 0
		for {
			pos := strings.Index(lower[idx:], t)
			if pos < 0 {
				break
			}
			spans = append(spans, span{idx + pos, idx + pos + len(t)})
			idx += pos + len(t)
		}
	}

	if len(spans) == 0 {
		return html.EscapeString(text)
	}

	// Sort and merge overlapping spans
	for i := 1; i < len(spans); i++ {
		for j := i; j > 0 && spans[j].start < spans[j-1].start; j-- {
			spans[j], spans[j-1] = spans[j-1], spans[j]
		}
	}

	var merged []span
	for _, s := range spans {
		if len(merged) == 0 || s.start > merged[len(merged)-1].end {
			merged = append(merged, s)
		} else if s.end > merged[len(merged)-1].end {
			merged[len(merged)-1].end = s.end
		}
	}

	// Build highlighted string
	var sb strings.Builder
	prev := 0
	for _, s := range merged {
		sb.WriteString(html.EscapeString(text[prev:s.start]))
		sb.WriteString(h.PreTag)
		sb.WriteString(html.EscapeString(text[s.start:s.end]))
		sb.WriteString(h.PostTag)
		prev = s.end
	}
	sb.WriteString(html.EscapeString(text[prev:]))
	return sb.String()
}
