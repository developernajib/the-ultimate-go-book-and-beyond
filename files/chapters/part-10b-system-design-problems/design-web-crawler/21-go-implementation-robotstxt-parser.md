## Go Implementation: Robots.txt Parser

Every responsible crawler must respect the robots exclusion protocol, standardized as RFC 9309 in 2022. The robots.txt file, served at the root of every website, tells crawlers which paths they are allowed or forbidden to visit. This is not a formality you can skip: ignoring it earns IP bans, and in some jurisdictions it is evidence in a trespass-to-chattels or terms-of-service claim. Treat the parser as production code and test it.

Four rules from RFC 9309 catch almost everyone who writes this parser from memory, and each one fails in the dangerous direction, that is, toward crawling something the site forbade.

- **An empty `Disallow:` value means allow everything**, not disallow everything. `Disallow:` with no path is how a site opts a crawler in. If you store the empty string as a rule and then prefix-match with it, every path matches the zero-length prefix and your crawler silently crawls nothing.
- **Longest match wins, and `Allow` breaks ties.** A rule is not "allow overrides disallow". Given `Allow: /` and `Disallow: /private/`, the path `/private/secret` is *disallowed*, because the 9-character disallow pattern is more specific than the 1-character allow. Only when two matching patterns are the same length does `Allow` win.
- **Exactly one group applies.** You select the group whose user-agent token matches yours (case-insensitively), and you fall back to the `*` group only when no specific group matches. You never apply both. A site that grants your bot access with a specific empty `Disallow:` and blocks everyone else with `User-agent: *` / `Disallow: /` must not have the wildcard group applied to you.
- **Pattern matching has two metacharacters.** `*` matches any sequence of characters *anywhere* in the pattern, and a trailing `$` anchors the match to the end of the path. `/*.php$` matches `/dir/index.php` but not `/dir/index.php?q=1`.

`Crawl-delay` is not in RFC 9309. It is a de facto extension: Bing and Yandex honor it, and Google ignores it entirely in favor of its own crawl-rate controls. Parse it if present, but do not rely on it being there, and default to your own politeness interval when it is absent. Note also that it is frequently written as a fractional value such as `0.5`, so parse it as a float. Parsing it as an integer yields zero, and a zero delay disables politeness altogether.

The status code handling is equally load-bearing and asymmetric. A 4xx on robots.txt means the file is *unavailable*, and the crawler may access everything. A 5xx means the file is *unreachable*, and the crawler must assume complete disallow until the server recovers. Getting this backwards means hammering a site precisely when it is already failing.

The implementation below fetches the file, caches it per domain, and evaluates rules with the precedence above. It also extracts sitemap URLs, which feed the sitemap parser.

```go
package robots

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxRobotsSize caps the robots.txt body we will read.
// RFC 9309 requires parsers to process at least 500 KiB and permits
// discarding the rest, which also defends against a decompression bomb.
const maxRobotsSize = 512 * 1024

// Rule is a single Allow or Disallow directive within a group.
// Rules are kept in one ordered slice rather than split into two maps
// because precedence depends on pattern length across both kinds.
type Rule struct {
	Pattern string
	Allow   bool
}

// RobotsRules represents parsed robots.txt rules for a domain
type RobotsRules struct {
	Groups     map[string][]Rule        // lowercased user-agent token -> rules
	CrawlDelay map[string]time.Duration // lowercased user-agent token -> delay
	Sitemaps   []string
	FetchedAt  time.Time
	DenyAll    bool // set when robots.txt was unreachable (5xx)
}

// RobotsService fetches and caches robots.txt files
type RobotsService struct {
	cache      map[string]*RobotsRules
	mu         sync.RWMutex
	httpClient *http.Client
	cacheTTL   time.Duration
	errTTL     time.Duration
	userAgent  string
}

func NewRobotsService(httpClient *http.Client, userAgent string) *RobotsService {
	return &RobotsService{
		cache:      make(map[string]*RobotsRules),
		httpClient: httpClient,
		cacheTTL:   24 * time.Hour,
		errTTL:     5 * time.Minute, // retry an unreachable host sooner
		userAgent:  userAgent,
	}
}

// IsAllowed checks if a path can be crawled
func (s *RobotsService) IsAllowed(ctx context.Context, baseURL, path, userAgent string) bool {
	return s.getRules(ctx, baseURL).IsAllowed(userAgent, path)
}

// IsAllowed applies RFC 9309 precedence: select exactly one group, then take
// the longest matching pattern, with Allow winning a tie.
func (r *RobotsRules) IsAllowed(userAgent, path string) bool {
	if r == nil {
		return true // no rules fetched yet, fail open
	}
	if r.DenyAll {
		return false // robots.txt unreachable (5xx), assume complete disallow
	}
	if path == "" {
		path = "/"
	}

	group, ok := r.group(userAgent)
	if !ok {
		return true // no group applies to us
	}

	// An empty group (for example a bare "Disallow:") matches nothing here and
	// falls through to allow, which is exactly what RFC 9309 requires.
	best := -1
	allowed := true
	for _, rule := range group {
		if !matchesPath(path, rule.Pattern) {
			continue
		}
		// Longest pattern wins. On equal length, Allow wins.
		if n := len(rule.Pattern); n > best || (n == best && rule.Allow) {
			best = n
			allowed = rule.Allow
		}
	}
	return allowed
}

// group selects the single applicable group: an exact case-insensitive match on
// the product token, otherwise the "*" fallback. Never both.
func (r *RobotsRules) group(userAgent string) ([]Rule, bool) {
	if g, ok := r.Groups[strings.ToLower(userAgent)]; ok {
		return g, true
	}
	g, ok := r.Groups["*"]
	return g, ok
}

// GetCrawlDelay returns the crawl-delay for a user-agent, or def if the site
// did not specify one. Crawl-delay is a non-standard extension, absent from
// RFC 9309, so def carries the load on most sites.
func (s *RobotsService) GetCrawlDelay(ctx context.Context, baseURL, userAgent string, def time.Duration) time.Duration {
	return s.getRules(ctx, baseURL).Delay(userAgent, def)
}

func (r *RobotsRules) Delay(userAgent string, def time.Duration) time.Duration {
	if r == nil {
		return def
	}
	if d, ok := r.CrawlDelay[strings.ToLower(userAgent)]; ok {
		return d
	}
	if d, ok := r.CrawlDelay["*"]; ok {
		return d
	}
	return def
}

func (s *RobotsService) getRules(ctx context.Context, baseURL string) *RobotsRules {
	s.mu.RLock()
	rules, ok := s.cache[baseURL]
	s.mu.RUnlock()
	if ok && !s.expired(rules) {
		return rules
	}

	// Fetch robots.txt. fetchAndParse never returns nil, so the cache never
	// holds a nil that a later lookup would dereference.
	rules = s.fetchAndParse(ctx, baseURL+"/robots.txt")

	s.mu.Lock()
	s.cache[baseURL] = rules
	s.mu.Unlock()

	return rules
}

func (s *RobotsService) expired(r *RobotsRules) bool {
	ttl := s.cacheTTL
	if r.DenyAll {
		ttl = s.errTTL
	}
	return time.Since(r.FetchedAt) >= ttl
}

// fetchAndParse maps HTTP status to robots semantics per RFC 9309 section 2.3.1:
// 2xx parses the body, 4xx means "unavailable" and allows everything, and
// 5xx or a transport error means "unreachable" and disallows everything.
func (s *RobotsService) fetchAndParse(ctx context.Context, robotsURL string) *RobotsRules {
	denyAll := &RobotsRules{FetchedAt: time.Now(), DenyAll: true}
	allowAll := &RobotsRules{
		Groups:     map[string][]Rule{},
		CrawlDelay: map[string]time.Duration{},
		FetchedAt:  time.Now(),
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, robotsURL, nil)
	if err != nil {
		return denyAll
	}
	req.Header.Set("User-Agent", s.userAgent)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return denyAll // unreachable, be conservative
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return parseRobotsTxt(io.LimitReader(resp.Body, maxRobotsSize))
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		return allowAll // 404 and friends: no restrictions published
	default:
		return denyAll // 5xx, and anything else we do not understand
	}
}

func parseRobotsTxt(r io.Reader) *RobotsRules {
	rules := &RobotsRules{
		Groups:     make(map[string][]Rule),
		CrawlDelay: make(map[string]time.Duration),
		FetchedAt:  time.Now(),
	}

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRobotsSize)

	// agents accumulates the consecutive User-agent lines that share one group.
	// sawRule tells us the next User-agent line starts a fresh group.
	var agents []string
	sawRule := false

	for scanner.Scan() {
		line := scanner.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i] // comments run to end of line, including inline
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(strings.ToLower(key))
		value = strings.TrimSpace(value)

		switch key {
		case "user-agent":
			if sawRule {
				agents, sawRule = nil, false
			}
			ua := strings.ToLower(value)
			agents = append(agents, ua)
			// Register the group even if it turns out to be empty, so that an
			// opt-in group ("User-agent: MyBot" + "Disallow:") is selected and
			// suppresses the "*" fallback.
			if _, exists := rules.Groups[ua]; !exists {
				rules.Groups[ua] = nil
			}
		case "disallow", "allow":
			sawRule = true
			// An empty value is not a rule. "Disallow:" means allow all.
			// Storing "" here would prefix-match every path and block the site.
			if value == "" {
				continue
			}
			for _, ua := range agents {
				rules.Groups[ua] = append(rules.Groups[ua], Rule{Pattern: value, Allow: key == "allow"})
			}
		case "crawl-delay":
			sawRule = true
			// Fractional delays such as "0.5" are common in the wild.
			secs, err := strconv.ParseFloat(value, 64)
			if err != nil || secs <= 0 {
				continue
			}
			for _, ua := range agents {
				rules.CrawlDelay[ua] = time.Duration(secs * float64(time.Second))
			}
		case "sitemap":
			// Sitemap is global, not scoped to a group.
			if value != "" {
				rules.Sitemaps = append(rules.Sitemaps, value)
			}
		}
	}

	return rules
}

// matchesPath implements the RFC 9309 pattern language: "*" matches any
// sequence of characters anywhere, and a trailing "$" anchors to end of path.
// Everything else is a literal prefix match.
func matchesPath(path, pattern string) bool {
	if pattern == "" {
		return false
	}

	anchored := strings.HasSuffix(pattern, "$")
	if anchored {
		pattern = pattern[:len(pattern)-1]
	}

	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		if anchored {
			return path == parts[0]
		}
		return strings.HasPrefix(path, parts[0])
	}

	if !strings.HasPrefix(path, parts[0]) {
		return false
	}
	pos := len(parts[0])

	// Leftmost match for each interior literal is optimal here: consuming as
	// little as possible leaves the most room for the segments that follow.
	for _, seg := range parts[1 : len(parts)-1] {
		if seg == "" {
			continue
		}
		i := strings.Index(path[pos:], seg)
		if i < 0 {
			return false
		}
		pos += i + len(seg)
	}

	last := parts[len(parts)-1]
	if last == "" {
		return true // pattern ended in "*", the rest is unconstrained
	}
	if anchored {
		return len(path)-len(last) >= pos && strings.HasSuffix(path, last)
	}
	return strings.Contains(path[pos:], last)
}
```

---
