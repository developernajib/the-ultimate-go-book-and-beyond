## Deep Dive: Crawler Trap Detection

Spider traps are URLs that generate an infinite number of pages, causing your crawler to waste resources crawling content that has no real value. Common examples include calendar pages that let you click endlessly into future dates, session IDs embedded in URLs that create a unique URL for every visit, and content management systems with deeply nested category pages. The trap detector uses several heuristics: URL length limits, path depth limits, repeating path pattern detection, and session parameter detection.

Every one of these is a heuristic, which is a polite way of saying every one of them is sometimes wrong. Design the code so that the cost of being wrong is visible.

Two decisions in the implementation follow from that. First, `IsTrap` is a **pure predicate**. An earlier shape of this code incremented a per-domain URL counter inside `IsTrap`, which meant that asking the question changed the answer: checking the same URL five times counted it five times, so a retry, a log line, or a unit test could push a domain toward its limit. A predicate that mutates the state it judges is a bug waiting for a caller. Counting is now the caller's explicit job through `Observe`.

Second, a per-domain URL count is deliberately **not** a trap signal. It is tempting, because traps emit unbounded URLs. So does Wikipedia. English Wikipedia is roughly seven million articles, so a rule like "over 500K URLs from this domain means trap" does not detect a trap, it deletes the best reference site on the web from your index, and it keeps deleting it because the counter only ever goes up. URL volume cannot separate a trap from a large legitimate site. Yield can: a trap's pages are near-duplicate, empty, or junk, which is what the SimHash duplicate rate and the page quality scorer measure. So `Budget` here is a crawl-budget accountant, not a trap oracle. It reports when a domain has consumed its allocation so the frontier can *deprioritize* further URLs from it, and blacklisting stays a decision driven by quality signals and human review.

```go
package traps

import (
	"net/url"
	"strings"
	"sync"
)

// domainBudget is how many URLs we will queue from one domain before new URLs
// from it are deprioritized. It is an allocation, not a verdict: exceeding it
// means "we have enough from here for now", never "this domain is a trap".
const domainBudget = 500000

type TrapDetector struct {
	domainURLCounts map[string]int64
	mu              sync.Mutex
}

func NewTrapDetector() *TrapDetector {
	return &TrapDetector{domainURLCounts: make(map[string]int64)}
}

// IsTrap reports whether a URL looks machine-generated. It is pure: calling it
// twice gives the same answer and changes nothing. Counting lives in Observe.
func (d *TrapDetector) IsTrap(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return true
	}

	// 1. URL too long
	if len(rawURL) > 500 {
		return true
	}

	// 2. Too many path segments
	segments := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(segments) > 10 {
		return true
	}

	// 3. Repeating path pattern (e.g., /a/b/a/b/a/b)
	if hasRepeatingPattern(segments) {
		return true
	}

	// 4. Session IDs in URL (infinite space). Parse the query once, not once
	// per pattern, and match whole keys: a substring test on "sid" would also
	// reject a legitimate "?considerations=" parameter.
	for key := range u.Query() {
		if isSessionParam(strings.ToLower(key)) {
			return true
		}
	}

	return false
}

func isSessionParam(key string) bool {
	switch key {
	case "session", "sessionid", "session_id", "sid", "jsessionid", "phpsessid", "aspsessionid":
		return true
	}
	return strings.HasPrefix(key, "jsessionid") || strings.HasPrefix(key, "phpsessid")
}

// Observe records that one URL was queued for a domain and reports whether the
// domain is now over budget. Call it exactly once per queued URL. The caller
// deprioritizes over-budget domains, it does not blacklist them.
func (d *TrapDetector) Observe(domain string) (overBudget bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.domainURLCounts[domain]++
	return d.domainURLCounts[domain] > domainBudget
}

// ResetBudgets clears the counters at the start of a crawl pass. Without this
// the map grows for the life of the process and every large domain eventually
// sits permanently over budget, which is the blacklist we said we would avoid.
func (d *TrapDetector) ResetBudgets() {
	d.mu.Lock()
	defer d.mu.Unlock()
	clear(d.domainURLCounts)
}

func hasRepeatingPattern(segments []string) bool {
	if len(segments) < 4 {
		return false
	}
	for patLen := 1; patLen <= 3; patLen++ {
		if len(segments) >= patLen*3 {
			repeating := true
			for i := patLen; i < len(segments); i++ {
				if segments[i] != segments[i%patLen] {
					repeating = false
					break
				}
			}
			if repeating {
				return true
			}
		}
	}
	return false
}
```

---
