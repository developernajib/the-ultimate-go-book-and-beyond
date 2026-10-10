## Go Implementation: Page Quality Scorer

Not every crawled page deserves equal priority in the search index. The page quality scorer evaluates each page across four dimensions: content quality (word count and text-to-HTML ratio), domain authority (trusted domains score higher), freshness (recently modified pages score higher), and HTML structure quality (presence of title tags, headings, and meta descriptions). The weighted overall score determines where the page lands in the index pipeline's priority queue, ensuring that high-quality content gets indexed first.

```go
package quality

import (
	"math"
	"strings"
	"time"
)

type CrawledPage struct {
	Domain             string
	Title              string
	Body               string
	RawHTMLBytes       int
	LastModified       time.Time
	CrawledAt          time.Time
	HasH1              bool
	HasMetaDescription bool
}

// PageQualityScorer evaluates crawled page quality for index priority
type PageQualityScorer struct {
	trustDomains map[string]float64
}

type QualityScore struct {
	Overall   float64 `json:"overall"`
	Content   float64 `json:"content"`   // text quality
	Authority float64 `json:"authority"` // domain trust
	Freshness float64 `json:"freshness"` // content age
	Structure float64 `json:"structure"` // HTML quality
}

// Score evaluates a crawled page
func (s *PageQualityScorer) Score(page *CrawledPage) QualityScore {
	score := QualityScore{}

	// 1. Content quality: length, density, uniqueness
	wordCount := len(strings.Fields(page.Body))
	if wordCount < 50 {
		score.Content = 0.1 // very thin content
	} else if wordCount < 300 {
		score.Content = 0.5
	} else if wordCount < 1000 {
		score.Content = 0.8
	} else {
		score.Content = 1.0
	}

	// Penalize boilerplate-heavy pages.
	// Measure against RawHTMLBytes, the pre-truncation size, not len(RawHTML).
	// RawHTML is capped at 100KB by the fetcher while Body holds the full text,
	// so dividing by the capped length inflates the ratio and silently disables
	// this penalty for every page larger than the cap.
	if page.RawHTMLBytes > 0 && page.Body != "" {
		textRatio := float64(len(page.Body)) / float64(page.RawHTMLBytes)
		if textRatio < 0.1 {
			score.Content *= 0.5 // mostly HTML, little text
		}
	}

	// 2. Domain authority
	if trust, ok := s.trustDomains[page.Domain]; ok {
		score.Authority = trust
	} else {
		score.Authority = 0.5 // unknown domain
	}

	// 3. Freshness (from Last-Modified or content signals)
	if !page.LastModified.IsZero() {
		ageHours := page.CrawledAt.Sub(page.LastModified).Hours()
		// Clamp to [0,1]. Servers do send Last-Modified timestamps in the
		// future, from clock skew or plain misconfiguration, which makes
		// ageHours negative and would score such a page above a perfect 1.0.
		score.Freshness = math.Min(1, math.Max(0, 1.0-ageHours/(24*365))) // decay over 1 year
	} else {
		score.Freshness = 0.5 // unknown
	}

	// 4. HTML structure quality
	score.Structure = 0.5
	if page.Title != "" {
		score.Structure += 0.2
	}
	if page.HasH1 {
		score.Structure += 0.15
	}
	if page.HasMetaDescription {
		score.Structure += 0.15
	}

	// Weighted average
	score.Overall = score.Content*0.4 + score.Authority*0.3 +
		score.Freshness*0.15 + score.Structure*0.15

	return score
}
```

---
