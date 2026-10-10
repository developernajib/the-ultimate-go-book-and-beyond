## Production Go Implementation: Robots.txt Parser

The Robots Exclusion Protocol (`robots.txt`) is a legal and ethical hard requirement, ignoring it exposes the operator to copyright liability and can overwhelm target servers. Because a large-scale crawler contacts millions of distinct hosts, fetching `robots.txt` on every URL request would double crawl traffic and add per-request latency. This implementation solves that by caching parsed rules per host with a 24-hour TTL and protecting the cache with a `sync.RWMutex` so many goroutines can check rules concurrently while a single writer refreshes stale entries. Rule precedence follows RFC 9309: the longest (most specific) matching rule wins, and Allow wins ties, so a specific Allow overrides a broader Disallow and vice versa.

```go
package crawler

import (
	"bufio"
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RobotsChecker caches and evaluates robots.txt rules
type RobotsChecker struct {
	mu     sync.RWMutex
	cache  map[string]*RobotsRules
	client *http.Client
}

type RobotsRules struct {
	DisallowPaths []string
	AllowPaths    []string
	CrawlDelay    time.Duration
	Sitemaps      []string
	FetchedAt     time.Time
}

// IsAllowed checks if a URL is allowed to be crawled.
// RFC 9309 precedence: the longest matching rule wins, Allow wins ties.
// Empty rule values ("Disallow:" with no path) match nothing.
func (r *RobotsChecker) IsAllowed(ctx context.Context, host, path, userAgent string) bool {
	rules := r.getRules(ctx, host)
	if rules == nil {
		return true // no robots.txt = allow all
	}

	allowLen, disallowLen := -1, -1
	for _, a := range rules.AllowPaths {
		if a != "" && strings.HasPrefix(path, a) && len(a) > allowLen {
			allowLen = len(a)
		}
	}
	for _, d := range rules.DisallowPaths {
		if d != "" && strings.HasPrefix(path, d) && len(d) > disallowLen {
			disallowLen = len(d)
		}
	}

	// No matching Disallow, or an equally or more specific Allow: crawl it
	return disallowLen == -1 || allowLen >= disallowLen
}

func (r *RobotsChecker) getRules(ctx context.Context, host string) *RobotsRules {
	r.mu.RLock()
	rules, ok := r.cache[host]
	r.mu.RUnlock()

	if ok && time.Since(rules.FetchedAt) < 24*time.Hour {
		return rules
	}

	// Fetch robots.txt
	resp, err := r.client.Get("https://" + host + "/robots.txt")
	if err != nil || resp.StatusCode != 200 {
		return nil
	}
	defer resp.Body.Close()

	rules = &RobotsRules{FetchedAt: time.Now()}
	scanner := bufio.NewScanner(resp.Body)
	currentAgent := ""

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(strings.ToLower(parts[0]))
		value := strings.TrimSpace(parts[1])

		switch key {
		case "user-agent":
			currentAgent = value
		case "disallow":
			if currentAgent == "*" || strings.Contains(strings.ToLower(currentAgent), "googlebot") {
				rules.DisallowPaths = append(rules.DisallowPaths, value)
			}
		case "allow":
			if currentAgent == "*" || strings.Contains(strings.ToLower(currentAgent), "googlebot") {
				rules.AllowPaths = append(rules.AllowPaths, value)
			}
		case "crawl-delay":
			if currentAgent == "*" || strings.Contains(strings.ToLower(currentAgent), "googlebot") {
				if secs, err := strconv.ParseFloat(value, 64); err == nil && secs > 0 {
					rules.CrawlDelay = time.Duration(secs * float64(time.Second))
				}
			}
		case "sitemap":
			rules.Sitemaps = append(rules.Sitemaps, value)
		}
	}

	r.mu.Lock()
	r.cache[host] = rules
	r.mu.Unlock()

	return rules
}
```

---
