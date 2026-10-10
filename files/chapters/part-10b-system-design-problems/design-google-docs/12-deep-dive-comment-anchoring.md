## Deep Dive: Comment Anchoring

Comments in Google Docs are anchored to specific text ranges, but those ranges shift as users insert or delete text elsewhere in the document. If someone adds a paragraph above your commented section, the comment's start and end positions must shift down accordingly. The anchor manager listens to every applied operation and adjusts all comment positions in real time. This ensures comments remain attached to the correct text even as the document changes around them.

```go
package comments

type CommentAnchor struct { CommentID string; Start int; End int }
type AnchorManager struct { anchors map[string]*CommentAnchor }

func (m *AnchorManager) AdjustAnchors(ops []Op) {
	for _, a := range m.anchors { m.adjust(a, ops) }
}

func (m *AnchorManager) adjust(a *CommentAnchor, ops []Op) {
	pos := 0
	for _, op := range ops {
		if op.Retain > 0 { pos += op.Retain }
		if op.Insert != "" {
			n := len(op.Insert)
			if pos <= a.Start { a.Start += n; a.End += n } else if pos < a.End { a.End += n }
			pos += n
		}
		if op.Delete > 0 {
			de := pos + op.Delete
			if de <= a.Start { a.Start -= op.Delete; a.End -= op.Delete } else if pos < a.End {
				os := pos; if pos < a.Start { os = a.Start }
				oe := de; if de > a.End { oe = a.End }
				if pos < a.Start {
					// Chars deleted before the anchor shift both ends left
					before := a.Start - pos
					a.Start = pos
					a.End -= before
				}
				a.End -= (oe - os)
			}
		}
	}
	if a.Start < 0 { a.Start = 0 }
	if a.End < a.Start { a.End = a.Start }
}
```

---
