## Production Go Implementation: URL Normalization

URL normalization is critical for preventing the crawler from treating the same page as multiple different URLs. Without it, variations like `HTTP://EXAMPLE.COM/page?b=2&a=1#section` and `http://example.com/page?a=1&b=2` would be crawled and indexed separately, wasting resources and polluting search results with duplicates. This function lowercases the scheme and host, removes default ports and fragments, sorts query parameters, and strips tracking parameters like UTM tags.

```go
package crawler

import (
	"net/url"
	"strings"
)

// NormalizeURL canonicalizes a URL to prevent duplicate crawling
// Example: "HTTP://EXAMPLE.COM/page?b=2&a=1#section" -> "http://example.com/page?a=1&b=2"
func NormalizeURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	// Lowercase scheme and host
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)

	// Remove default ports
	if (u.Scheme == "http" && u.Port() == "80") ||
		(u.Scheme == "https" && u.Port() == "443") {
		u.Host = u.Hostname()
	}

	// Remove fragment (not sent to server)
	u.Fragment = ""

	// Remove trailing slash (except root)
	if u.Path != "/" {
		u.Path = strings.TrimRight(u.Path, "/")
	}

	// Remove tracking parameters, then re-encode.
	// url.Values.Encode sorts keys, which canonicalizes parameter order.
	params := u.Query()
	for _, param := range []string{"utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"} {
		params.Del(param)
	}
	u.RawQuery = params.Encode()

	return u.String()
}
```

---
