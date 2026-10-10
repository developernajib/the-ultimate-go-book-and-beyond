## Core Components

### 1. Web Crawler

The web crawler is the data acquisition layer of the search engine. It discovers new pages by following links, respects robots.txt rules to avoid crawling pages a site owner has disallowed, and enforces polite rate limits so it does not overwhelm any single server. A URL frontier (priority queue) ensures high-value pages are crawled first, while a deduplication check prevents wasting resources on pages already visited recently.

```go
package crawler

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/redis/go-redis/v9"
)

// Crawler fetches and parses web pages
type Crawler struct {
	client      *http.Client
	frontier    *URLFrontier
	mu          sync.Mutex // guards robotsCache across worker goroutines
	robotsCache map[string]*RobotsRules
	rdb         *redis.Client
	output      PageProcessor
}

// Page represents a crawled web page
type Page struct {
	URL         string
	Title       string
	Body        string
	Links       []string
	Canonical   string
	Language    string
	ContentHash string
	CrawledAt   time.Time
	StatusCode  int
}

// URLFrontier is a priority queue of URLs to crawl
type URLFrontier struct {
	rdb *redis.Client
}

// Add adds a URL with priority to the frontier
func (f *URLFrontier) Add(ctx context.Context, rawURL string, priority float64) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	normalized := normalizeURL(u)

	// Check if already crawled recently
	seenKey := fmt.Sprintf("crawled:%s", normalized)
	exists, _ := f.rdb.Exists(ctx, seenKey).Result()
	if exists > 0 {
		return nil
	}

	// Add to sorted set by priority (higher = crawl sooner)
	return f.rdb.ZAdd(ctx, "url:frontier", redis.Z{
		Score:  priority,
		Member: normalized,
	}).Err()
}

// Next pops the highest-priority URL
func (f *URLFrontier) Next(ctx context.Context) (string, error) {
	results, err := f.rdb.ZPopMax(ctx, "url:frontier", 1).Result()
	if err != nil || len(results) == 0 {
		return "", fmt.Errorf("frontier empty")
	}
	return results[0].Member.(string), nil
}

// CrawlPage fetches and processes a single page
func (c *Crawler) CrawlPage(ctx context.Context, rawURL string) (*Page, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}

	// Check robots.txt
	if !c.isAllowed(ctx, u) {
		return nil, fmt.Errorf("disallowed by robots.txt: %s", rawURL)
	}

	// Polite crawl delay
	c.waitCrawlDelay(u.Host)

	req, _ := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	req.Header.Set("User-Agent", "Googlebot/2.1 (+http://www.google.com/bot.html)")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &Page{URL: rawURL, StatusCode: resp.StatusCode, CrawledAt: time.Now()}, nil
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, err
	}

	page := &Page{
		URL:        rawURL,
		StatusCode: resp.StatusCode,
		CrawledAt:  time.Now(),
	}

	// Extract title
	page.Title = strings.TrimSpace(doc.Find("title").First().Text())

	// Extract canonical URL
	if canon, exists := doc.Find("link[rel=canonical]").First().Attr("href"); exists {
		page.Canonical = canon
	}

	// Extract lang
	if lang, exists := doc.Find("html").First().Attr("lang"); exists {
		page.Language = lang
	}

	// Extract body text (exclude nav, footer, scripts)
	doc.Find("script, style, nav, footer, header").Remove()
	page.Body = strings.TrimSpace(doc.Find("body").Text())

	// Extract all links
	doc.Find("a[href]").Each(func(i int, sel *goquery.Selection) {
		href, exists := sel.Attr("href")
		if !exists {
			return
		}
		abs := resolveURL(rawURL, href)
		if abs != "" && isCrawlable(abs) {
			page.Links = append(page.Links, abs)
		}
	})

	// Content fingerprint for deduplication
	page.ContentHash = hashContent(page.Title + page.Body)

	return page, nil
}

// isAllowed checks robots.txt rules
func (c *Crawler) isAllowed(ctx context.Context, u *url.URL) bool {
	c.mu.Lock()
	rules, ok := c.robotsCache[u.Host]
	if !ok {
		rules = fetchRobots(ctx, u.Scheme+"://"+u.Host+"/robots.txt")
		c.robotsCache[u.Host] = rules
	}
	c.mu.Unlock()
	return rules.IsAllowed("Googlebot", u.Path)
}

func (c *Crawler) waitCrawlDelay(host string) {
	// Rate limit: max 1 req/sec per host
	time.Sleep(1 * time.Second)
}

// CrawlWorker continuously pulls URLs and crawls them
func (c *Crawler) CrawlWorker(ctx context.Context) {
	for {
		rawURL, err := c.frontier.Next(ctx)
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}

		page, err := c.CrawlPage(ctx, rawURL)
		if err != nil {
			continue
		}

		// Submit page for indexing
		c.output.Process(ctx, page)

		// Add discovered links to frontier
		for _, link := range page.Links {
			c.frontier.Add(ctx, link, priorityForURL(link))
		}

		// Mark as crawled (TTL = recrawl period)
		seenKey := fmt.Sprintf("crawled:%s", rawURL)
		c.rdb.Set(ctx, seenKey, "1", 14*24*time.Hour)
	}
}

func priorityForURL(u string) float64 {
	// Higher priority for: deeper links from high-PageRank pages,
	// news sites, recently updated pages
	// Simplified: use URL depth as inverse priority
	depth := strings.Count(u, "/")
	return 1.0 / float64(depth+1)
}

func resolveURL(base, href string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	h, err := url.Parse(href)
	if err != nil {
		return ""
	}
	return b.ResolveReference(h).String()
}

func isCrawlable(u string) bool {
	lower := strings.ToLower(u)
	return strings.HasPrefix(lower, "http") &&
		!strings.Contains(lower, ".pdf") &&
		!strings.Contains(lower, ".jpg") &&
		!strings.Contains(lower, ".png")
}
```

### 2. Indexer

The indexer converts raw crawled pages into a searchable inverted index, which is the core data structure that makes fast keyword lookups possible. For each page, it tokenizes the text, computes term frequencies, and stores a posting list that maps every term to the documents containing it. This is analogous to the index at the back of a textbook: instead of reading every page to find a word, you look it up in the index and jump directly to the right pages.

```go
package indexer

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/redis/go-redis/v9"
)

// IndexShard holds an inverted index partition
// In production: each shard runs on a separate machine
// Total: ~1PB index across thousands of shards
type IndexShard struct {
	mu       sync.RWMutex
	index    map[string]PostingList // term → postings
	docStore map[string]DocMeta     // docID → metadata
	rdb      *redis.Client
}

// PostingList is the list of documents containing a term
type PostingList []Posting

// Posting is a (docID, term frequency) pair with position data
type Posting struct {
	DocID      string
	TF         float64   // term frequency in doc
	Positions  []int     // word positions for phrase queries
	FieldFlags uint8     // bit flags: title=1, body=2, url=4, anchor=8
}

// DocMeta is document metadata stored alongside the index
type DocMeta struct {
	URL       string
	Title     string
	Snippet   string // pre-computed snippet
	PageRank  float64
	Language  string
	CrawledAt int64
}

// IndexPage indexes a crawled page
func (s *IndexShard) IndexPage(ctx context.Context, page *Page) error {
	tokens := tokenize(page.Title + " " + page.Body)
	tfMap := computeTF(tokens)

	docID := urlToDocID(page.URL)

	s.mu.Lock()
	defer s.mu.Unlock()

	// Store document metadata
	s.docStore[docID] = DocMeta{
		URL:       page.URL,
		Title:     page.Title,
		Snippet:   extractSnippet(page.Body, 160),
		CrawledAt: page.CrawledAt.Unix(),
	}

	// Update inverted index
	for term, tf := range tfMap {
		postings := s.index[term]
		// Remove old posting for this doc if exists
		postings = removeDoc(postings, docID)
		// Add new posting
		postings = append(postings, Posting{
			DocID:      docID,
			TF:         tf,
			FieldFlags: computeFieldFlags(term, page),
		})
		// Keep sorted by TF descending for fast top-k merge
		sort.Slice(postings, func(i, j int) bool {
			return postings[i].TF > postings[j].TF
		})
		s.index[term] = postings
	}

	return nil
}

// Search returns matching doc IDs for a set of terms
func (s *IndexShard) Search(ctx context.Context, terms []string, limit int) []ScoredDoc {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(terms) == 0 {
		return nil
	}

	// Get posting lists for all terms
	lists := make([]PostingList, 0, len(terms))
	for _, term := range terms {
		if pl, ok := s.index[term]; ok {
			lists = append(lists, pl)
		}
	}
	if len(lists) == 0 {
		return nil
	}

	// Merge: score each doc that appears in any posting list
	scores := make(map[string]float64)
	N := float64(len(s.docStore))

	for _, term := range terms {
		pl, ok := s.index[term]
		if !ok {
			continue
		}
		// IDF = log(N / df)
		idf := math.Log(N / float64(len(pl)+1))

		for _, p := range pl {
			// BM25 score contribution
			k1, b := 1.5, 0.75
			avgDL := 500.0 // avg doc length in tokens
			dl := 300.0    // current doc length (simplified)
			tfNorm := p.TF * (k1 + 1) / (p.TF + k1*(1-b+b*dl/avgDL))
			contrib := idf * tfNorm

			// Boost this term's contribution for title matches
			if p.FieldFlags&1 != 0 {
				contrib *= 1.5
			}
			scores[p.DocID] += contrib
		}
	}

	// Rank by score
	ranked := make([]ScoredDoc, 0, len(scores))
	for docID, score := range scores {
		meta := s.docStore[docID]
		ranked = append(ranked, ScoredDoc{
			DocID:    docID,
			Score:    score,
			PageRank: meta.PageRank,
			Meta:     meta,
		})
	}

	// Final rank: BM25 * PageRank^0.5
	sort.Slice(ranked, func(i, j int) bool {
		si := ranked[i].Score * math.Sqrt(ranked[i].PageRank+1)
		sj := ranked[j].Score * math.Sqrt(ranked[j].PageRank+1)
		return si > sj
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	return ranked
}

type ScoredDoc struct {
	DocID    string
	Score    float64
	PageRank float64
	Meta     DocMeta
}

// tokenize splits text into lowercase tokens
func tokenize(text string) []string {
	var tokens []string
	words := strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, w := range words {
		w = strings.ToLower(w)
		if len(w) > 2 && !isStopWord(w) {
			tokens = append(tokens, stem(w))
		}
	}
	return tokens
}

// computeTF calculates term frequency map
func computeTF(tokens []string) map[string]float64 {
	counts := make(map[string]int)
	for _, t := range tokens {
		counts[t]++
	}
	tf := make(map[string]float64)
	total := float64(len(tokens))
	for term, count := range counts {
		tf[term] = float64(count) / total
	}
	return tf
}

func computeFieldFlags(term string, page *Page) uint8 {
	var flags uint8
	titleTokens := tokenize(page.Title)
	for _, t := range titleTokens {
		if t == term {
			flags |= 1
			break
		}
	}
	bodyTokens := tokenize(page.Body)
	for _, t := range bodyTokens {
		if t == term {
			flags |= 2
			break
		}
	}
	return flags
}

func extractSnippet(body string, maxLen int) string {
	if len(body) <= maxLen {
		return body
	}
	return body[:maxLen] + "..."
}

func removeDoc(pl PostingList, docID string) PostingList {
	result := pl[:0]
	for _, p := range pl {
		if p.DocID != docID {
			result = append(result, p)
		}
	}
	return result
}

func urlToDocID(u string) string {
	return fmt.Sprintf("%x", hashContent(u))
}

var stopWords = map[string]bool{
	"the": true, "a": true, "an": true, "is": true,
	"in": true, "on": true, "at": true, "to": true,
}

func isStopWord(w string) bool { return stopWords[w] }
func stem(w string) string     { return w } // Use a Snowball stemmer (github.com/kljensen/snowball) in production
```

### 3. PageRank

PageRank is the algorithm that differentiated Google from earlier search engines. It treats every hyperlink as a vote of confidence: a page linked by many high-quality pages earns a higher rank. The algorithm iteratively distributes rank across the link graph until scores converge. This implementation also includes TrustRank, a variant that seeds the computation from known trustworthy sites (like Wikipedia or government domains) to combat link spam.

```go
package pagerank

import (
	"context"
	"math"

	"github.com/redis/go-redis/v9"
)

// PageRankEngine computes PageRank scores
// In production: runs as a distributed MapReduce job (Pregel-style)
type PageRankEngine struct {
	rdb *redis.Client
}

// Graph represents the link graph
type Graph struct {
	Nodes    []string            // all page URLs
	OutLinks map[string][]string // url → outbound links
	InLinks  map[string][]string // url → inbound links
}

// ComputePageRank runs PageRank iterations on the link graph
func (e *PageRankEngine) ComputePageRank(ctx context.Context, graph *Graph, iterations int) map[string]float64 {
	N := float64(len(graph.Nodes))
	damping := 0.85
	ranks := make(map[string]float64)

	// Initialize all pages with equal rank
	for _, node := range graph.Nodes {
		ranks[node] = 1.0 / N
	}

	// Power iteration
	for iter := 0; iter < iterations; iter++ {
		newRanks := make(map[string]float64)

		// Collect rank held by dangling nodes (no outlinks) so it can be
		// redistributed uniformly instead of leaking out of the graph
		dangling := 0.0
		for _, node := range graph.Nodes {
			if len(graph.OutLinks[node]) == 0 {
				dangling += ranks[node]
			}
		}

		for _, node := range graph.Nodes {
			// Teleportation term plus the dangling-node share
			sum := (1-damping)/N + damping*dangling/N

			// Sum contributions from pages linking to this node
			for _, inNode := range graph.InLinks[node] {
				outCount := float64(len(graph.OutLinks[inNode]))
				if outCount > 0 {
					sum += damping * ranks[inNode] / outCount
				}
			}

			newRanks[node] = sum
		}

		// Check convergence
		diff := 0.0
		for _, node := range graph.Nodes {
			diff += math.Abs(newRanks[node] - ranks[node])
		}
		ranks = newRanks

		if diff < 1e-6 {
			break
		}
	}

	return ranks
}

// StorePageRanks persists computed ranks to Redis
func (e *PageRankEngine) StorePageRanks(ctx context.Context, ranks map[string]float64) error {
	pipe := e.rdb.Pipeline()
	for url, rank := range ranks {
		docID := urlToDocID(url)
		pipe.ZAdd(ctx, "pagerank", redis.Z{
			Score:  rank,
			Member: docID,
		})
	}
	_, err := pipe.Exec(ctx)
	return err
}

// GetPageRank retrieves the rank for a document
func (e *PageRankEngine) GetPageRank(ctx context.Context, docID string) (float64, error) {
	score, err := e.rdb.ZScore(ctx, "pagerank", docID).Result()
	if err != nil {
		return 0, err
	}
	return score, nil
}

// TrustRank variant: seed with known high-quality pages
func (e *PageRankEngine) ComputeTrustRank(ctx context.Context, graph *Graph, seeds []string, iterations int) map[string]float64 {
	damping := 0.85
	ranks := make(map[string]float64)

	// Initialize seeds with high rank, others with 0
	seedSet := make(map[string]bool)
	for _, s := range seeds {
		seedSet[s] = true
	}
	for _, node := range graph.Nodes {
		if seedSet[node] {
			ranks[node] = 1.0 / float64(len(seeds))
		} else {
			ranks[node] = 0
		}
	}

	// Iterative propagation (same as PageRank)
	for iter := 0; iter < iterations; iter++ {
		newRanks := make(map[string]float64)
		for _, node := range graph.Nodes {
			sum := 0.0
			if seedSet[node] {
				sum = (1 - damping) / float64(len(seeds))
			}
			for _, inNode := range graph.InLinks[node] {
				outCount := float64(len(graph.OutLinks[inNode]))
				if outCount > 0 {
					sum += damping * ranks[inNode] / outCount
				}
			}
			newRanks[node] = sum
		}
		ranks = newRanks
	}

	return ranks
}
```

### 4. Query Processor

The query processor is the brain of the search pipeline. When a user types a query, this component spell-checks it, tokenizes and expands the terms (adding synonyms), then fans out the search to all index shards in parallel using the scatter-gather pattern. After collecting results from every shard, it re-ranks them using a more sophisticated model, paginates the output, and generates highlighted snippets. The entire process must complete within 200ms.

```go
package query

import (
	"context"
	"strings"
	"sync"
	"time"
)

// QueryProcessor handles incoming search queries
type QueryProcessor struct {
	spellChecker *SpellChecker
	indexShards  []*IndexShard
	ranker       *Ranker
	snippetGen   *SnippetGenerator
	numShards    int
}

// SearchRequest is an incoming search query
type SearchRequest struct {
	Query    string
	UserID   string
	Page     int
	PageSize int
	Language string
}

// SearchResult is the processed search response
type SearchResult struct {
	Query       string       `json:"query"`
	Corrected   string       `json:"corrected,omitempty"`
	TotalHits   int64        `json:"total_hits"`
	Hits        []SearchHit  `json:"hits"`
	ElapsedMs   float64      `json:"elapsed_ms"`
}

// SearchHit is a single search result
type SearchHit struct {
	URL      string  `json:"url"`
	Title    string  `json:"title"`
	Snippet  string  `json:"snippet"`
	Score    float64 `json:"score"`
}

// Search processes a search query
func (p *QueryProcessor) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	start := time.Now()

	// 1. Spell correction
	corrected, wasCorrected := p.spellChecker.Correct(req.Query)
	if wasCorrected {
		req.Query = corrected
	}

	// 2. Parse and expand query
	terms := tokenize(req.Query)
	expanded := p.expandQuery(ctx, terms)

	// 3. Scatter to all shards in parallel
	type shardResult struct {
		docs []ScoredDoc
		err  error
	}
	results := make(chan shardResult, p.numShards)
	var wg sync.WaitGroup

	for _, shard := range p.indexShards {
		wg.Add(1)
		go func(s *IndexShard) {
			defer wg.Done()
			docs, err := s.Search(ctx, expanded, 100)
			results <- shardResult{docs, err}
		}(shard)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	// 4. Gather and merge shard results
	var allDocs []ScoredDoc
	for r := range results {
		if r.err == nil {
			allDocs = append(allDocs, r.docs...)
		}
	}

	// 5. Re-rank combined results
	ranked := p.ranker.Rerank(ctx, allDocs, req.Query)

	// 6. Paginate
	offset := req.Page * req.PageSize
	if offset > len(ranked) {
		offset = len(ranked)
	}
	end := offset + req.PageSize
	if end > len(ranked) {
		end = len(ranked)
	}
	pageResults := ranked[offset:end]

	// 7. Generate snippets
	hits := make([]SearchHit, len(pageResults))
	for i, doc := range pageResults {
		hits[i] = SearchHit{
			URL:     doc.Meta.URL,
			Title:   doc.Meta.Title,
			Snippet: p.snippetGen.Generate(doc.Meta.Snippet, terms),
			Score:   doc.Score,
		}
	}

	result := &SearchResult{
		Query:     req.Query,
		TotalHits: int64(len(ranked)),
		Hits:      hits,
		ElapsedMs: float64(time.Since(start).Microseconds()) / 1000,
	}
	if wasCorrected {
		result.Corrected = corrected
	}

	return result, nil
}

// expandQuery adds synonyms and related terms
func (p *QueryProcessor) expandQuery(ctx context.Context, terms []string) []string {
	expanded := make([]string, len(terms))
	copy(expanded, terms)
	// In production: use Word2Vec/BERT embeddings to find similar terms
	// Simplified: just return original terms
	return expanded
}

// SpellChecker corrects query spelling
type SpellChecker struct {
	wordFreq map[string]int // from web crawl corpus
}

// Correct returns the spell-corrected query
func (s *SpellChecker) Correct(query string) (string, bool) {
	words := strings.Fields(query)
	corrected := make([]string, len(words))
	changed := false
	for i, word := range words {
		fix := s.correctWord(word)
		corrected[i] = fix
		if fix != word {
			changed = true
		}
	}
	return strings.Join(corrected, " "), changed
}

func (s *SpellChecker) correctWord(word string) string {
	if _, ok := s.wordFreq[word]; ok {
		return word // known word
	}
	// Generate edit distance 1 candidates
	candidates := edits1(word)
	best := word
	bestFreq := 0
	for _, c := range candidates {
		if f := s.wordFreq[c]; f > bestFreq {
			bestFreq = f
			best = c
		}
	}
	return best
}

// edits1 generates all strings at edit distance 1
func edits1(word string) []string {
	alphabet := "abcdefghijklmnopqrstuvwxyz"
	var results []string
	n := len(word)

	// Deletions
	for i := 0; i < n; i++ {
		results = append(results, word[:i]+word[i+1:])
	}
	// Transpositions
	for i := 0; i < n-1; i++ {
		results = append(results, word[:i]+string(word[i+1])+string(word[i])+word[i+2:])
	}
	// Replacements
	for i := 0; i < n; i++ {
		for _, c := range alphabet {
			results = append(results, word[:i]+string(c)+word[i+1:])
		}
	}
	// Insertions
	for i := 0; i <= n; i++ {
		for _, c := range alphabet {
			results = append(results, word[:i]+string(c)+word[i:])
		}
	}
	return results
}
```

---
