## Go Implementation: Sitemap Parser

Sitemaps are a shortcut for URL discovery. Instead of relying solely on link extraction (which requires crawling pages to find new URLs), sitemaps let websites declare their full URL inventory upfront in a structured XML format. Many large sites provide sitemap index files that reference hundreds of individual sitemaps, each containing up to 50,000 URLs. The parser handles both sitemap indexes (recursive fetching) and individual URL sets, extracting priority and change frequency hints that help the frontier prioritize which URLs to crawl first.

The sitemap fetcher is a crawler inside your crawler, and it follows URLs supplied by a stranger, so it needs the same defenses as the outer one. **A sitemap index is a recursion bomb waiting to happen.** An index can reference another index, and nothing stops a site from publishing an index that references itself, or two that reference each other. Recursing without a depth cap and a visited set means unbounded recursion on hostile or merely broken input, and this failure needs no malice: a copy-paste error in a CMS template is enough. The `maxSitemapDepth` cap and the `seen` set below are the fix, and they are not optional hardening.

The other hazards are quieter. Sitemaps are commonly served gzipped as `.xml.gz`, and Go's HTTP client transparently decompresses `Content-Encoding: gzip` but not a body that is simply a gzip file, so the parser must handle that itself, with a decompression limit, since a gzip bomb expands to gigabytes from a few kilobytes. The protocol caps an uncompressed sitemap at 50MB and 50,000 URLs, which gives you a sane place to stop reading. And URLs from a sitemap are still just claims: a site can list any URL it likes, including URLs on other hosts, so the parser rejects cross-host entries and hands the rest to the frontier, which applies robots.txt and politeness exactly as it would for a discovered link. A sitemap is a hint about what exists, never a grant of permission to fetch it.

```go
package sitemap

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	maxSitemapSize  = 50 * 1024 * 1024 // protocol cap on an uncompressed sitemap
	maxSitemapURLs  = 50000            // protocol cap on entries per sitemap
	maxSitemapDepth = 5                // index -> index nesting limit
)

type URLFrontier interface {
	AddWithPriority(ctx context.Context, rawURL string, depth int, discoveredFrom string, hint float64) error
}

type RobotsRules struct {
	Sitemaps []string
}

// SitemapParser discovers URLs efficiently via sitemap.xml
type SitemapParser struct {
	httpClient *http.Client
	frontier   URLFrontier
}

type SitemapIndex struct {
	XMLName  xml.Name       `xml:"sitemapindex"`
	Sitemaps []SitemapEntry `xml:"sitemap"`
}

type SitemapEntry struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod"`
}

type URLSet struct {
	XMLName xml.Name     `xml:"urlset"`
	URLs    []SitemapURL `xml:"url"`
}

type SitemapURL struct {
	Loc        string `xml:"loc"`
	LastMod    string `xml:"lastmod"`
	ChangeFreq string `xml:"changefreq"` // always, hourly, daily, weekly, monthly
	Priority   string `xml:"priority"`   // 0.0-1.0
}

// FetchAndParseSitemap processes a sitemap and adds URLs to frontier.
// seen guards against an index that references itself or forms a cycle.
func (p *SitemapParser) FetchAndParseSitemap(ctx context.Context, sitemapURL string) (int, error) {
	return p.fetchAndParse(ctx, sitemapURL, 0, make(map[string]bool))
}

func (p *SitemapParser) fetchAndParse(ctx context.Context, sitemapURL string, depth int, seen map[string]bool) (int, error) {
	if depth > maxSitemapDepth {
		return 0, fmt.Errorf("sitemap nesting exceeds %d at %s", maxSitemapDepth, sitemapURL)
	}
	if seen[sitemapURL] {
		return 0, nil // already processed: a cycle, not new work
	}
	seen[sitemapURL] = true

	body, err := p.fetchBody(ctx, sitemapURL)
	if err != nil {
		return 0, err
	}

	// Try parsing as sitemap index first
	var index SitemapIndex
	if xml.Unmarshal(body, &index) == nil && len(index.Sitemaps) > 0 {
		total := 0
		for _, sm := range index.Sitemaps {
			count, err := p.fetchAndParse(ctx, sm.Loc, depth+1, seen)
			if err != nil {
				continue // one bad child sitemap must not abandon its siblings
			}
			total += count
		}
		return total, nil
	}

	// Parse as URL set
	var urlSet URLSet
	if err := xml.Unmarshal(body, &urlSet); err != nil {
		return 0, fmt.Errorf("parse sitemap: %w", err)
	}

	base, err := url.Parse(sitemapURL)
	if err != nil {
		return 0, err
	}

	added := 0
	for i, u := range urlSet.URLs {
		if i >= maxSitemapURLs {
			break // protocol cap: ignore a sitemap that oversteps it
		}
		// A sitemap may only speak for its own host. Anything else is a site
		// nominating someone else's URLs for our crawl budget.
		loc, err := url.Parse(strings.TrimSpace(u.Loc))
		if err != nil || !strings.EqualFold(loc.Hostname(), base.Hostname()) {
			continue
		}
		if err := p.frontier.AddWithPriority(ctx, loc.String(), 0, sitemapURL, parsePriority(u.Priority)); err != nil {
			continue
		}
		added++
	}

	return added, nil
}

// fetchBody retrieves a sitemap, transparently handling a gzipped body.
func (p *SitemapParser) fetchBody(ctx context.Context, sitemapURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sitemapURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "MyCrawler/1.0")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch sitemap %s: %w", sitemapURL, err) // resp is nil here
	}
	defer resp.Body.Close() // before any status check, or non-200s leak the body
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch sitemap %s: status %d", sitemapURL, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSitemapSize))
	if err != nil {
		return nil, err
	}

	// ".xml.gz" arrives as a gzip file rather than Content-Encoding: gzip, so
	// net/http does not unwrap it for us. Limit the decompressed size too: a
	// few KB of gzip can expand to gigabytes.
	if isGzip(body) {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		if body, err = io.ReadAll(io.LimitReader(zr, maxSitemapSize)); err != nil {
			return nil, err
		}
	}
	return body, nil
}

func isGzip(b []byte) bool {
	return len(b) > 2 && b[0] == 0x1f && b[1] == 0x8b
}

// parsePriority reads the <priority> hint, defaulting to the spec's 0.5 and
// clamping to the valid range. This value is passed to the frontier: parsing it
// and dropping it on the floor would make the whole <priority> element theatre.
func parsePriority(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0.5 // sitemaps.org default
	}
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// DiscoverSitemaps finds sitemap URLs from robots.txt, falling back to the
// well-known location. rules comes from the robots.txt parser, which already
// collects Sitemap: directives while parsing the file we had to fetch anyway.
func (p *SitemapParser) DiscoverSitemaps(ctx context.Context, domain string, rules *RobotsRules) []string {
	if rules != nil && len(rules.Sitemaps) > 0 {
		return rules.Sitemaps
	}
	return []string{fmt.Sprintf("https://%s/sitemap.xml", domain)}
}
```

---
