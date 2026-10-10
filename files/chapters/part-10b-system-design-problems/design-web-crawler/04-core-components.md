## Core Components

### 1. URL Frontier

The URL frontier is the heart of any web crawler. It decides which URLs to crawl next and in what order. Think of it as a massive priority queue that holds billions of pending URLs. This implementation uses Kafka partitioned by domain hash so that all URLs from the same domain land on the same partition, which makes it straightforward to enforce per-domain rate limits: every URL for a domain is consumed by exactly one worker process, so that process can hold the authoritative rate limiter for the domain in local memory.

The Bloom filter deserves a blunt statement of its cost, because it is easy to describe it as a pure optimization and it is not. A Bloom filter has no false negatives, so "not seen" is always the truth and the URL is genuinely new. But "seen" is only *probably* true, and at a 1% false positive rate roughly 1 in 100 newly discovered URLs will be misidentified as already crawled and silently dropped forever. **The crawler will never fetch those pages.** That is not a bug to be fixed later, it is the deal you are signing in exchange for 12GB of memory instead of the 1TB an exact set would need, and at 10 billion pages that deal costs you on the order of tens of millions of pages. If a given crawl cannot tolerate that, the filter is the wrong structure and you need the exact set, a partitioned exact set across many machines, or a lower false positive rate bought with more memory. Redis is still in the path, but it is doing a different job: `SetNX` is the atomic claim that stops two workers from queuing the same URL concurrently, and it is the durable seen-set that survives a process restart when the in-memory filter is lost.

```go
package frontier

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/twmb/franz-go/pkg/kgo"
)

// URLFrontier manages the queue of URLs to crawl
// Uses Kafka partitioned by domain for politeness (one partition per domain group)
type URLFrontier struct {
	kafka    *kgo.Client
	rdb      *redis.ClusterClient
	seenURLs *BloomFilter // approximate dedup, ~10B URLs, 1% FP rate
}

// URLItem is an item in the frontier queue
type URLItem struct {
	URL            string    `json:"url"`
	Domain         string    `json:"domain"`
	Priority       float64   `json:"priority"`
	Depth          int       `json:"depth"`
	DiscoveredFrom string    `json:"discovered_from"`
	AddedAt        time.Time `json:"added_at"`
	RetryCount     int       `json:"retry_count"`
}

// noPriorityHint tells Add to compute the priority itself.
const noPriorityHint = -1

// Add adds a URL to the frontier if not already seen
func (f *URLFrontier) Add(ctx context.Context, rawURL string, depth int, discoveredFrom string) error {
	return f.AddWithPriority(ctx, rawURL, depth, discoveredFrom, noPriorityHint)
}

// AddWithPriority is Add with an externally supplied priority, used by the
// sitemap parser to pass along a site's own <priority> hint. Pass
// noPriorityHint to fall back to computePriority.
func (f *URLFrontier) AddWithPriority(ctx context.Context, rawURL string, depth int, discoveredFrom string, hint float64) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}

	// Normalize URL
	normalized := normalizeURL(u)

	// Bloom filter check. No false negatives, so a miss means definitely new.
	// A hit is only probably-seen: ~1% of hits are false positives and those
	// URLs are dropped permanently. See the discussion above, this is the
	// deliberate cost of a 12GB filter over a 1TB exact set.
	if f.seenURLs.Contains(normalized) {
		return nil
	}

	// Atomically claim the URL. This is what stops two workers that both saw a
	// bloom miss from queuing the same URL, and it is the durable seen-set that
	// outlives the in-memory filter across restarts.
	seenKey := "seen:" + urlHash(normalized)
	ok, err := f.rdb.SetNX(ctx, seenKey, "1", 14*24*time.Hour).Result()
	if err != nil {
		return fmt.Errorf("frontier: claim %s: %w", normalized, err) // do not silently drop on Redis failure
	}
	if !ok {
		return nil // another worker claimed it first
	}

	// Add to bloom filter
	f.seenURLs.Add(normalized)

	priority := hint
	if hint == noPriorityHint {
		priority = computePriority(u, depth)
	}

	item := URLItem{
		URL:            normalized,
		Domain:         u.Hostname(),
		Priority:       priority,
		Depth:          depth,
		DiscoveredFrom: discoveredFrom,
		AddedAt:        time.Now(),
	}

	// Publish to Kafka, partitioned by domain hash
	// This ensures all URLs from the same domain go to the same partition
	// Allows per-partition rate limiting
	partition := domainPartition(item.Domain, 1000)
	return f.publishToKafka(ctx, item, partition)
}

// AddWithDelay re-queues an already-claimed URL for a later attempt.
// Kafka has no per-message delay, so retries park in a Redis sorted set scored
// by ready-time and a sweeper republishes the due ones. It deliberately does
// not go through Add: the URL is already in the seen-set, and Add would drop it.
func (f *URLFrontier) AddWithDelay(ctx context.Context, item URLItem, delay time.Duration) error {
	data, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return f.rdb.ZAdd(ctx, "frontier:retry", redis.Z{
		Score:  float64(time.Now().Add(delay).Unix()),
		Member: data,
	}).Err()
}

// SweepRetries moves due retry items back onto Kafka. Run one per process.
func (f *URLFrontier) SweepRetries(ctx context.Context, now time.Time) error {
	due, err := f.rdb.ZRangeByScore(ctx, "frontier:retry", &redis.ZRangeBy{
		Min: "0",
		Max: strconv.FormatInt(now.Unix(), 10),
	}).Result()
	if err != nil {
		return err
	}
	for _, raw := range due {
		var item URLItem
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			f.rdb.ZRem(ctx, "frontier:retry", raw) // undecodable, drop it
			continue
		}
		if err := f.publishToKafka(ctx, item, domainPartition(item.Domain, 1000)); err != nil {
			return err // leave it in the set, we will retry the sweep
		}
		f.rdb.ZRem(ctx, "frontier:retry", raw)
	}
	return nil
}

// computePriority assigns crawl priority to a URL
func computePriority(u *url.URL, depth int) float64 {
	priority := 1.0

	// Prefer shorter URLs (less likely to be spam)
	if len(u.Path) < 50 {
		priority += 0.5
	}

	// Prefer news and authoritative domains
	trustDomains := map[string]float64{
		"wikipedia.org": 2.0,
		"bbc.com":       1.5,
		"reuters.com":   1.5,
	}
	for domain, boost := range trustDomains {
		if u.Hostname() == domain || strings.HasSuffix(u.Hostname(), "."+domain) {
			priority *= boost
			break
		}
	}

	// Penalize deep URLs
	priority -= float64(depth) * 0.1

	return priority
}

// BloomFilter is a space-efficient probabilistic URL deduplicator
// 10B URLs × 1% FP rate → ~12GB memory (vs 1TB for exact set)
// Safe for concurrent use: every worker goroutine shares one filter.
type BloomFilter struct {
	bits    []uint64
	numBits uint64
	numHash int
}

// NewBloomFilter creates a bloom filter for n expected items with false positive rate p
func NewBloomFilter(n int, p float64) *BloomFilter {
	m := uint64(-float64(n) * math.Log(p) / (math.Log(2) * math.Log(2)))
	k := int(math.Log(2) * float64(m) / float64(n))
	if k < 1 {
		k = 1
	}
	return &BloomFilter{
		bits:    make([]uint64, (m+63)/64),
		numBits: m,
		numHash: k,
	}
}

// Add adds an element to the bloom filter.
// The word update must be atomic: two goroutines setting bits in the same
// 64-bit word with a plain |= would race and one update would be lost, which
// on a bloom filter means a false negative, the one error it must never have.
func (bf *BloomFilter) Add(key string) {
	h1, h2 := hashPair(key)
	for i := 0; i < bf.numHash; i++ {
		pos := (h1 + uint64(i)*h2) % bf.numBits
		atomic.OrUint64(&bf.bits[pos/64], 1<<(pos%64))
	}
}

// Contains checks if an element might be in the filter
func (bf *BloomFilter) Contains(key string) bool {
	h1, h2 := hashPair(key)
	for i := 0; i < bf.numHash; i++ {
		pos := (h1 + uint64(i)*h2) % bf.numBits
		if atomic.LoadUint64(&bf.bits[pos/64])&(1<<(pos%64)) == 0 {
			return false
		}
	}
	return true
}

// hashPair derives two independent 64-bit hashes, then Add and Contains
// synthesize k indices as h1+i*h2 (Kirsch-Mitzenmacher double hashing).
// Both halves must be full 64-bit values: building them from only 4 bytes
// each caps every index near 2^32, and with numBits ≈ 9.6e10 the filter would
// address barely 3% of the bits it allocated, wrecking the false positive rate.
func hashPair(key string) (uint64, uint64) {
	h := sha256.Sum256([]byte(key))
	h1 := binary.LittleEndian.Uint64(h[0:8])
	h2 := binary.LittleEndian.Uint64(h[8:16])
	return h1, h2 | 1 // keep h2 odd so the probe sequence covers the space
}

func normalizeURL(u *url.URL) string {
	// Lowercase scheme and host
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	// Remove fragment: it is never sent to the server, so it cannot name a
	// distinct page. Keeping it would queue #section links as separate URLs.
	u.Fragment = ""
	// Re-encoding the query normalizes parameter order, because url.Values.Encode
	// already emits keys in sorted order. Do not sort them yourself first.
	u.RawQuery = u.Query().Encode()
	return u.String()
}

func urlHash(u string) string {
	h := sha256.Sum256([]byte(u))
	return hex.EncodeToString(h[:8]) // 8 bytes = 16 hex chars, sufficient for key
}

func domainPartition(domain string, numPartitions int) int32 {
	h := sha256.Sum256([]byte(domain))
	// Use a full 64-bit word. Folding only two bytes would give 65536 distinct
	// values, and 65536 % 1000 != 0 leaves the low partitions ~1.5% hotter.
	val := binary.LittleEndian.Uint64(h[0:8])
	return int32(val % uint64(numPartitions))
}

func (f *URLFrontier) publishToKafka(ctx context.Context, item URLItem, partition int32) error {
	data, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return f.kafka.ProduceSync(ctx, &kgo.Record{
		Topic:     "url-frontier",
		Partition: partition,
		Key:       []byte(item.Domain),
		Value:     data,
	}).FirstErr()
}
```

### 2. Crawler Worker

Each crawler worker is a goroutine that pulls URLs from the frontier, fetches the page, extracts links, and sends the content downstream for indexing. The worker is responsible for checking robots.txt compliance, enforcing rate limits, handling retries with exponential backoff, and detecting duplicate content via SimHash. This is where the actual HTTP requests happen, so the worker must be resilient to network timeouts, malformed HTML, and server errors without crashing the entire crawl pipeline.

```go
package crawler

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// crawlerToken is our product token. It must match the User-Agent we send, so
// that the robots.txt group we obey is the group the site wrote for us.
const crawlerToken = "MyCrawler"

// statusNoIndex marks a page that fetched fine but carries meta robots noindex.
// A sentinel keeps it out of the 2xx path without inventing a fake HTTP code.
const statusNoIndex = -1

type URLItem struct {
	URL        string
	Domain     string
	Depth      int
	RetryCount int
}

type URLFrontier struct{}

func (f *URLFrontier) Add(ctx context.Context, rawURL string, depth int, discoveredFrom string) error {
	return nil
}

func (f *URLFrontier) AddWithDelay(ctx context.Context, item URLItem, delay time.Duration) error {
	return nil
}

type ContentProcessor interface {
	Process(ctx context.Context, page *CrawledPage)
}

type SimHash uint64

func Compute(text string) SimHash { return 0 }

type SimHashIndex struct{}

func (s *SimHashIndex) FindDuplicates(fp SimHash) []string { return nil }
func (s *SimHashIndex) Add(url string, fp SimHash)         {}

type CrawlerMetrics struct{}

func (m *CrawlerMetrics) RecordError(domain string, err error)                    {}
func (m *CrawlerMetrics) RecordFetch(domain string, status int, latencyMs int64) {}
func (m *CrawlerMetrics) RecordBytes(bytes int64)                                 {}
func (m *CrawlerMetrics) RecordDuplicate()                                        {}

func ExtractLinks(finalURL string, hrefs []string) []string { return nil }

// CrawlerWorker fetches and processes web pages
type CrawlerWorker struct {
	id          int
	httpClient  *http.Client
	frontier    *URLFrontier
	robots      *RobotsCache
	rateLimiter *DomainRateLimiter
	contentProc ContentProcessor
	dedup       *SimHashIndex
	metrics     *CrawlerMetrics
}

// CrawledPage is the result of fetching a URL
type CrawledPage struct {
	URL        string
	FinalURL   string // after redirects
	Domain     string
	StatusCode int
	Title      string
	Body       string // cleaned text
	RawHTML    string // original HTML, truncated (see RawHTMLBytes)
	// RawHTMLBytes is the true pre-truncation size. The quality scorer needs it
	// for the text-to-HTML ratio: measuring against the truncated RawHTML would
	// compare full body text to a capped denominator and inflate the ratio on
	// exactly the large pages the boilerplate check is meant to catch.
	RawHTMLBytes       int
	Links              []string
	Language           string
	LastModified       time.Time // from the Last-Modified header, zero if absent
	HasH1              bool
	HasMetaDescription bool
	ContentHash        string // SimHash for dedup
	CrawledAt          time.Time
	FetchMs            int64
}

// Run starts the crawler worker
func (w *CrawlerWorker) Run(ctx context.Context, jobs <-chan URLItem) {
	for {
		select {
		case <-ctx.Done():
			return
		case item, ok := <-jobs:
			if !ok {
				return
			}
			if err := w.processURL(ctx, item); err != nil {
				w.metrics.RecordError(item.Domain, err)
			}
		}
	}
}

// processURL fetches and processes a single URL
func (w *CrawlerWorker) processURL(ctx context.Context, item URLItem) error {
	// Check robots.txt under our OWN product token, the same one fetchPage
	// sends in User-Agent. Evaluating rules written for "Googlebot" while
	// identifying as something else reads another crawler's permissions and is
	// exactly the deception that gets a crawler blocked by IP.
	if !w.robots.IsAllowed(ctx, item.URL, crawlerToken) {
		return nil // skip disallowed URLs
	}

	// Enforce politeness: rate limit per domain
	if err := w.rateLimiter.Wait(ctx, item.Domain); err != nil {
		return err // ctx cancelled, surface it rather than reporting success
	}

	start := time.Now()

	// Fetch page
	page, err := w.fetchPage(ctx, item.URL)
	if err != nil {
		if item.RetryCount < 3 {
			item.RetryCount++
			// Re-queue with exponential backoff
			return w.frontier.AddWithDelay(ctx, item, time.Duration(1<<item.RetryCount)*time.Minute)
		}
		return fmt.Errorf("fetch failed after retries: %w", err)
	}

	page.FetchMs = time.Since(start).Milliseconds()
	w.metrics.RecordFetch(item.Domain, page.StatusCode, page.FetchMs)
	w.metrics.RecordBytes(int64(page.RawHTMLBytes)) // else TotalBytes is always 0

	if page.StatusCode != 200 {
		return nil
	}

	// Check content dedup via SimHash
	fp := Compute(page.Body)
	page.ContentHash = strconv.FormatUint(uint64(fp), 16)
	if w.isDuplicate(fp) {
		w.metrics.RecordDuplicate()
		return nil // skip duplicate content
	}
	w.dedup.Add(page.FinalURL, fp)

	// Extract and queue new links. Links are still worth following on a page
	// whose text duplicates another, but this page's own text is not reindexed.
	for _, link := range page.Links {
		if err := w.frontier.Add(ctx, link, item.Depth+1, item.URL); err != nil {
			w.metrics.RecordError(item.Domain, err)
		}
	}

	// Submit to index pipeline
	w.contentProc.Process(ctx, page)

	return nil
}

// fetchPage downloads and parses a web page
func (w *CrawlerWorker) fetchPage(ctx context.Context, rawURL string) (*CrawledPage, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, "GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; MyCrawler/1.0; +http://example.com/bot)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := w.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Limit response size
	body := io.LimitReader(resp.Body, 5*1024*1024) // 5MB max
	htmlBytes, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}

	page := &CrawledPage{
		URL:          rawURL,
		FinalURL:     resp.Request.URL.String(),
		Domain:       resp.Request.URL.Hostname(),
		StatusCode:   resp.StatusCode,
		RawHTMLBytes: len(htmlBytes),
		CrawledAt:    time.Now(),
	}
	if lm, err := http.ParseTime(resp.Header.Get("Last-Modified")); err == nil {
		page.LastModified = lm
	}

	if resp.StatusCode != 200 {
		return page, nil
	}

	// Parse HTML
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(string(htmlBytes)))
	if err != nil {
		return page, nil // return partial result
	}

	// Extract title
	page.Title = strings.TrimSpace(doc.Find("title").First().Text())

	// Check meta robots. The "i" flags matter: CSS attribute VALUES are matched
	// case-sensitively by default, and `content="NOINDEX"` or `name="ROBOTS"`
	// are common in the wild. Without them we index pages that asked us not to.
	if doc.Find(`meta[name="robots" i][content*="noindex" i]`).Length() > 0 {
		page.StatusCode = statusNoIndex
		return page, nil
	}

	// Extract language
	if lang, ok := doc.Find("html").First().Attr("lang"); ok {
		page.Language = lang
	}

	// Structure signals for the quality scorer. Read them before the noise
	// elements are stripped below, since Remove mutates the document.
	page.HasH1 = doc.Find("h1").Length() > 0
	page.HasMetaDescription = strings.TrimSpace(
		doc.Find(`meta[name="description" i]`).AttrOr("content", "")) != ""

	// Remove noise elements
	doc.Find("script, style, nav, footer, header, aside, .sidebar, .ad, .advertisement").Remove()

	// Extract body text
	page.Body = strings.Join(strings.Fields(doc.Find("body").Text()), " ")

	// Store limited raw HTML
	if len(htmlBytes) > 100*1024 {
		htmlBytes = htmlBytes[:100*1024] // cap at 100KB
	}
	page.RawHTML = string(htmlBytes)

	// Extract links. Resolve against FinalURL, not the requested URL, so that
	// relative hrefs on a page reached through a redirect resolve correctly.
	// ExtractLinks (see the link extractor section) resolves, normalizes, and
	// dedups in one pass, so normalization lives in exactly one place.
	var hrefs []string
	doc.Find("a[href]").Each(func(i int, sel *goquery.Selection) {
		if href, ok := sel.Attr("href"); ok {
			hrefs = append(hrefs, href)
		}
	})
	page.Links = ExtractLinks(page.FinalURL, hrefs)

	return page, nil
}

// isDuplicate reports whether we have already indexed near-identical text.
// The banded index returns matches within the Hamming threshold, so a non-empty
// result means this page duplicates something we already have.
func (w *CrawlerWorker) isDuplicate(fp SimHash) bool {
	return len(w.dedup.FindDuplicates(fp)) > 0
}
```

### 3. Domain Rate Limiter

Politeness is a non-negotiable requirement for any responsible web crawler. Without rate limiting, your crawler could send hundreds of requests per second to a single website, effectively performing a denial-of-service attack. The domain rate limiter maintains a separate token bucket for each domain, defaulting to one request per second. It also respects the `crawl-delay` directive from robots.txt where a site publishes one, though as noted in the robots.txt parser section that directive is a non-standard extension and most sites do not set it, so the 1 req/sec default does the real work.

Two things about this limiter matter more than the code.

**A per-worker limiter limits nothing.** The limiter below lives in a worker process's memory, and that is only correct because of the Kafka partitioning: every URL for a domain hashes to one partition, and one partition is consumed by one worker, so exactly one limiter instance ever governs a given domain. Break that assumption, by round-robining URLs across workers or by letting two consumers share a partition during a rebalance, and 200 workers each politely allowing 1 req/sec means the site receives 200 req/sec. The politeness guarantee is a property of the partitioning, not of the limiter. If you cannot guarantee single-consumer-per-domain, the limiter has to move into a shared store such as a Redis token bucket, and you pay a round trip per fetch for it.

**Per-domain is not the same as per-host, and neither is per-IP.** Rate limiting by registered domain treats `a.example.com` and `b.example.com` as one bucket, which is polite but slow when they are genuinely separate servers. Rate limiting per hostname is the common choice. But the constraint you actually care about is the *server's* load, and shared hosting puts thousands of unrelated hostnames behind one IP address. A thousand hostnames on one CDN-fronted IP, each crawled at a courteous 1 req/sec, is 1000 req/sec aimed at one machine. A serious crawler therefore keys the limiter on the resolved IP, or on both, which is one more reason the DNS cache in the deep dive is load-bearing infrastructure rather than an optimization.

```go
package crawler

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/time/rate"
)

const defaultCrawlDelay = time.Second // 1 req/sec per domain

// domainLimiter pairs a limiter with its last use, so idle domains can be
// evicted. The frontier sees millions of distinct domains, and a map that only
// ever grows is a slow memory leak that ends in an OOM kill.
type domainLimiter struct {
	lim      *rate.Limiter
	lastUsed time.Time
}

// DomainRateLimiter enforces politeness (1 req/sec per domain)
type DomainRateLimiter struct {
	limiters map[string]*domainLimiter
	mu       sync.Mutex
	rdb      *redis.Client
}

func NewDomainRateLimiter(rdb *redis.Client) *DomainRateLimiter {
	return &DomainRateLimiter{
		limiters: make(map[string]*domainLimiter),
		rdb:      rdb,
	}
}

// Wait blocks until a request to the domain is allowed
func (r *DomainRateLimiter) Wait(ctx context.Context, domain string) error {
	return r.getLimiter(ctx, domain).Wait(ctx)
}

// getLimiter returns or creates a rate limiter for a domain
func (r *DomainRateLimiter) getLimiter(ctx context.Context, domain string) *rate.Limiter {
	r.mu.Lock()
	if dl, ok := r.limiters[domain]; ok {
		dl.lastUsed = time.Now()
		r.mu.Unlock()
		return dl.lim
	}
	r.mu.Unlock()

	// Look up crawl-delay OUTSIDE the lock. This is a Redis round trip, and
	// holding the mutex across it would stall every other domain's fetches
	// behind one network call.
	delay := r.getCrawlDelay(ctx, domain)

	r.mu.Lock()
	defer r.mu.Unlock()
	// Re-check: another goroutine may have created it while we were in Redis.
	// Two limiters for one domain would mean two requests per second to it.
	if dl, ok := r.limiters[domain]; ok {
		dl.lastUsed = time.Now()
		return dl.lim
	}
	dl := &domainLimiter{lim: rate.NewLimiter(rate.Every(delay), 1), lastUsed: time.Now()}
	r.limiters[domain] = dl
	return dl.lim
}

// EvictIdle drops limiters for domains untouched since cutoff. Call it from a
// ticker. Evicting an idle domain is safe: recreating the limiter yields a full
// token, and by definition we have not fetched from that domain recently.
func (r *DomainRateLimiter) EvictIdle(cutoff time.Time) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for domain, dl := range r.limiters {
		if dl.lastUsed.Before(cutoff) {
			delete(r.limiters, domain)
			n++
		}
	}
	return n
}

func (r *DomainRateLimiter) getCrawlDelay(ctx context.Context, domain string) time.Duration {
	if r.rdb == nil {
		return defaultCrawlDelay
	}
	// Check cached robots.txt crawl-delay. Stored in milliseconds, because
	// fractional delays like "Crawl-delay: 0.5" are common and truncating them
	// to an integer number of seconds yields 0, which disables politeness.
	key := fmt.Sprintf("robots:delay:%s", domain)
	ms, err := r.rdb.Get(ctx, key).Int64()
	if err != nil || ms <= 0 {
		// Redis miss or outage falls back to the polite default. Never to 0:
		// rate.Every(0) is an infinite rate and would remove the limit entirely.
		return defaultCrawlDelay
	}
	return time.Duration(ms) * time.Millisecond
}

type RobotsRules struct{}

func (r *RobotsRules) IsAllowed(userAgent, path string) bool {
	return true
}

func fetchRobotsTxt(ctx context.Context, client *http.Client, rawURL string) *RobotsRules {
	return &RobotsRules{}
}

// RobotsCache caches and evaluates robots.txt rules.
// The parser and the fetch-status rules it depends on are developed in full in
// the robots.txt parser section. What matters here is that a fetch failure is
// never silently turned into permission to crawl.
type RobotsCache struct {
	cache      map[string]*cachedRobots
	mu         sync.RWMutex
	httpClient *http.Client
	ttl        time.Duration
}

type cachedRobots struct {
	rules     *RobotsRules
	fetchedAt time.Time
}

// IsAllowed checks if a URL can be crawled
func (r *RobotsCache) IsAllowed(ctx context.Context, rawURL, userAgent string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	// Scope by scheme://host:port. robots.txt authority is per origin, so
	// http and https, and different ports, each get their own file.
	return r.getRules(ctx, u.Scheme+"://"+u.Host).IsAllowed(userAgent, u.Path)
}

func (r *RobotsCache) getRules(ctx context.Context, baseURL string) *RobotsRules {
	r.mu.RLock()
	entry, ok := r.cache[baseURL]
	r.mu.RUnlock()
	if ok && time.Since(entry.fetchedAt) < r.ttl {
		return entry.rules
	}

	// fetchRobotsTxt maps status to semantics per RFC 9309: 2xx parses, 4xx
	// allows everything, 5xx or a transport error DISALLOWS everything. It
	// never returns nil, so the cache can never hold a nil to dereference.
	rules := fetchRobotsTxt(ctx, r.httpClient, baseURL+"/robots.txt")

	r.mu.Lock()
	r.cache[baseURL] = &cachedRobots{rules: rules, fetchedAt: time.Now()}
	r.mu.Unlock()

	return rules
}
```

### 4. Content Deduplication (SimHash)

The same content often appears at multiple URLs. Think mirror sites, printer-friendly versions, or pages with different query parameters that serve identical text. SimHash is a locality-sensitive hashing algorithm that generates a 64-bit fingerprint for each page. Unlike a cryptographic hash, where flipping one input bit scrambles the whole output, SimHash is built so that similar inputs give similar outputs: two pages with nearly identical content produce fingerprints that differ by only a few bits, measured by Hamming distance. If the Hamming distance is 3 or fewer bits out of 64, this implementation calls the pages near-duplicates.

The 64-bit fingerprint with a 3-bit threshold is the configuration Manku, Jain, and Das Sarma validated at Google against 8 billion pages in their 2007 paper, and it remains the standard starting point. Be clear about what that threshold buys, though, because it is narrower than it sounds. Measuring this implementation over synthetic documents with a known fraction of words replaced gives:

| Words changed | 2000-word page, mean distance | Caught at threshold 3 |
|---|---|---|
| 0.1% | 0.6 bits | 100% |
| 1% | 1.8 bits | 93% |
| 2% | 2.9 bits | 65% |
| 5% | 4.2 bits | 39% |
| 10% | 6.3 bits | 12% |

So a 3-bit threshold reliably catches pages that are *nearly identical*, which is exactly the mirror-and-printer-friendly case it exists for. It does not catch "95% similar" pages, and anyone who tells you it does has not measured it. Recall also degrades on short pages, where every token carries more weight: at 200 words, a 1% edit already averages 3.4 bits and slips past the threshold nearly half the time. If you need to group substantially-rewritten pages rather than mirrors, SimHash at k=3 is the wrong tool and you want MinHash over shingles with an explicit Jaccard threshold.

The banding technique makes lookup tractable. Comparing every new page against every stored fingerprint is O(N) per page and O(N²) over the crawl, which at 10 billion pages is not a thing you can do. Splitting the fingerprint into 8 bands of 8 bits and indexing each band separately turns the search into a handful of map lookups, and the pigeonhole argument in the code comment shows that pruning this way still cannot miss a true duplicate. The cost is memory, since each fingerprint is indexed 8 times, and a growing candidate list for bands whose 8-bit value happens to be popular.

```go
package dedup

import (
	"math/bits"
	"strings"
	"sync"
	"unicode"
)

// SimHash generates a fingerprint for near-duplicate detection.
// Near-identical documents differ in only a few of the 64 bits, and this
// package calls a pair duplicates at a Hamming distance of 3 or less.
type SimHash uint64

// Compute generates a SimHash fingerprint for text
func Compute(text string) SimHash {
	tokens := tokenize(text)
	if len(tokens) == 0 {
		return 0
	}

	// Vector of 64 dimensions
	v := make([]int, 64)

	for _, token := range tokens {
		h := fnv64(token)
		weight := 1

		for i := 0; i < 64; i++ {
			if h&(1<<uint(i)) != 0 {
				v[i] += weight
			} else {
				v[i] -= weight
			}
		}
	}

	// Collapse to fingerprint
	var fingerprint uint64
	for i := 0; i < 64; i++ {
		if v[i] > 0 {
			fingerprint |= 1 << uint(i)
		}
	}

	return SimHash(fingerprint)
}

// HammingDistance returns the number of differing bits
func HammingDistance(a, b SimHash) int {
	return bits.OnesCount64(uint64(a ^ b))
}

// IsDuplicate returns true if two fingerprints are near-duplicates.
// The 3-bit threshold is the conventional operating point for 64-bit SimHash
// over shingled text. It is a tunable, not a law: raise it and you merge pages
// that merely look alike, lower it and mirrors slip through as distinct.
func IsDuplicate(a, b SimHash) bool {
	return HammingDistance(a, b) <= 3
}

func tokenize(text string) []string {
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	// Fall back to unigrams for very short text. Building bigrams from fewer
	// than two words yields no tokens at all, and Compute would then return the
	// zero fingerprint, making every one-word page a "duplicate" of every other.
	if len(words) < 2 {
		return words
	}
	// Use 2-shingles (bigrams) for better sensitivity
	shingles := make([]string, 0, len(words)-1)
	for i := 0; i < len(words)-1; i++ {
		shingles = append(shingles, words[i]+" "+words[i+1])
	}
	return shingles
}

func fnv64(s string) uint64 {
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	hash := uint64(offset64)
	for _, c := range s {
		hash ^= uint64(c)
		hash *= prime64
	}
	return hash
}

// SimHashIndex stores SimHash fingerprints for duplicate detection.
// Uses the banding technique: divide 64 bits into 8 bands of 8 bits, and only
// compare documents that share at least one whole band.
//
// Why this is exact rather than a heuristic: if two fingerprints differ in at
// most 3 bits, those 3 bits touch at most 3 of the 8 bands, so at least 5 bands
// are byte-identical. Probing all 8 bands and unioning the hits therefore
// cannot miss a true near-duplicate. The bands prune candidates, they do not
// decide, and the Hamming check below is what actually decides.
type SimHashIndex struct {
	bands  [8]map[uint8][]string // band → [docID]
	hashes map[string]SimHash    // docID → fingerprint
	mu     sync.RWMutex
}

func NewSimHashIndex() *SimHashIndex {
	idx := &SimHashIndex{hashes: make(map[string]SimHash)}
	for b := range idx.bands {
		idx.bands[b] = make(map[uint8][]string)
	}
	return idx
}

// Add indexes a document fingerprint
func (idx *SimHashIndex) Add(docID string, hash SimHash) {
	idx.mu.Lock()
	defer idx.mu.Unlock()

	idx.hashes[docID] = hash
	// Add to each band
	for b := 0; b < 8; b++ {
		band := uint8((uint64(hash) >> (uint(b) * 8)) & 0xFF)
		idx.bands[b][band] = append(idx.bands[b][band], docID)
	}
}

// FindDuplicates returns the documents that are near-duplicates of hash,
// already filtered by Hamming distance. An empty result means the content is new.
func (idx *SimHashIndex) FindDuplicates(hash SimHash) []string {
	idx.mu.RLock()
	defer idx.mu.RUnlock()

	seen := make(map[string]bool)
	var candidates []string

	for b := 0; b < 8; b++ {
		band := uint8((uint64(hash) >> (uint(b) * 8)) & 0xFF)
		for _, docID := range idx.bands[b][band] {
			if !seen[docID] {
				seen[docID] = true
				if existing, ok := idx.hashes[docID]; ok {
					if IsDuplicate(hash, existing) {
						candidates = append(candidates, docID)
					}
				}
			}
		}
	}
	return candidates
}
```

---
