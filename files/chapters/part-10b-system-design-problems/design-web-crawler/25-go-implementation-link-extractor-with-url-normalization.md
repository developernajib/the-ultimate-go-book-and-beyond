## Go Implementation: Link Extractor with URL Normalization

Link extraction seems simple, but getting it right is critical for crawl efficiency. Raw `href` attributes from HTML can be relative paths, have mixed casing, contain fragments, include default ports, or end with trailing slashes, all of which create the illusion of different URLs that actually point to the same page. The normalizer resolves relative URLs against the page's base URL, lowercases the scheme and host, strips fragments, removes default ports, cleans the path, and sorts query parameters. The `shouldSkip` function filters out non-HTML resources like images, PDFs, and videos that a text-focused crawler should not fetch.

Two cautions before you copy this. First, normalization is *lossy by choice*, and each rule is a bet. Lowercasing the host is always safe, since DNS is case-insensitive. Lowercasing the path would not be, because most origin servers treat paths case-sensitively. Stripping the trailing slash is the aggressive one: `/a/b` and `/a/b/` are formally distinct resources and some servers serve different content or redirect between them, so this normalizer is trading a small risk of conflating two pages for a large reduction in near-duplicate URLs. That is usually the right trade for a search crawler, but it is a trade, not a free win.

Second, whatever rules you pick, exactly one function must implement them. The moment the link extractor and the frontier normalize differently, the same page enters the seen-set under two spellings and your dedup quietly stops working. Treat the normalizer as a single shared library, not a snippet to reimplement per package.

```go
package extractor

import (
	"net/url"
	"path"
	"strings"
)

// ExtractLinks finds and normalizes all links from a crawled page
func ExtractLinks(pageURL string, hrefs []string) []string {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}

	var normalized []string
	seen := make(map[string]bool)

	for _, href := range hrefs {
		abs := resolveURL(base, href)
		if abs == "" {
			continue
		}

		// Normalize
		norm := normalizeURL(abs)
		if norm == "" || seen[norm] {
			continue
		}

		// Filter unwanted URLs
		if shouldSkip(norm) {
			continue
		}

		seen[norm] = true
		normalized = append(normalized, norm)
	}

	return normalized
}

func resolveURL(base *url.URL, href string) string {
	// Skip non-HTTP
	if strings.HasPrefix(href, "javascript:") ||
		strings.HasPrefix(href, "mailto:") ||
		strings.HasPrefix(href, "tel:") ||
		strings.HasPrefix(href, "#") {
		return ""
	}

	ref, err := url.Parse(href)
	if err != nil {
		return ""
	}

	resolved := base.ResolveReference(ref)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return ""
	}

	return resolved.String()
}

func normalizeURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}

	// Lowercase scheme and host
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)

	// Remove fragment
	u.Fragment = ""

	// Clean the path: collapse "//", resolve "." and "..", and drop the
	// trailing slash. path.Clean does all of that, including the trailing
	// slash, so do not "also" TrimRight afterwards. That branch can never fire.
	//
	// Skip cleaning when RawPath is set. RawPath is non-empty exactly when the
	// decoded Path does not round-trip, which is the %2F case: "/a%2Fb" decodes
	// to "/a/b", and cleaning it would silently point at a different resource.
	if u.RawPath == "" {
		u.Path = path.Clean(u.Path)
		if u.Path == "." {
			u.Path = "/"
		}
	}

	// Remove default ports
	if (u.Scheme == "http" && u.Port() == "80") ||
		(u.Scheme == "https" && u.Port() == "443") {
		u.Host = u.Hostname()
	}

	// Re-encoding the query sorts parameters by key, because url.Values.Encode
	// emits them in sorted order already. There is nothing to sort by hand.
	u.RawQuery = u.Query().Encode()

	return u.String()
}

func shouldSkip(u string) bool {
	// Skip common non-content URLs
	skipSuffixes := []string{
		".pdf", ".jpg", ".png", ".gif", ".svg", ".css", ".js",
		".zip", ".tar", ".gz", ".mp3", ".mp4", ".avi",
		".doc", ".docx", ".xls", ".xlsx", ".ppt",
	}
	lower := strings.ToLower(u)
	for _, suffix := range skipSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}

	// Skip URLs with too many query parameters
	parsed, _ := url.Parse(u)
	if parsed != nil && len(parsed.Query()) > 5 {
		return true
	}

	return false
}
```

---
