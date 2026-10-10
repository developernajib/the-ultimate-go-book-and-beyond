## 83B.18 Twitter/X Deep Dive

### Overview for Go Engineers

Twitter/X is one of the most technically challenging real-time social platforms in the world. Their systems must handle 500M+ tweets per day, real-time fanout to hundreds of millions of followers, trending topic computation, and sub-second timeline delivery. Go is widely used across Twitter/X's infrastructure - in the API tier, Finagle-adjacent services, data pipeline workers, and internal tooling. Since Elon Musk's acquisition in 2022 and subsequent massive staff reductions (from ~8,000 to ~1,500 engineers), Twitter/X has been operating in extreme leanness: a tiny team maintaining systems built for a much larger engineering organization. This context changes the interview: they now value engineers who can own broad surface area, optimize relentlessly, and maintain complex systems without extensive support. The interview emphasizes real-time systems, distributed fanout, and the specific architectural problems Twitter/X has written extensively about (timeline ranking, the Fanout Problem, trending topics via Count-Min Sketch, and the distinction between push vs. pull timeline models).

### Interview Process

The X (Twitter) loop has shifted toward hands-on shipping ability and hard-core systems questions:

```
┌──────────────────────────────────────────────────────────────────┐
│                  TWITTER/X INTERVIEW PIPELINE                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │                                                          │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - 1-2 coding problems + brief system discussion         │
│       ▼                                                          │
│  Virtual Onsite (3-4 rounds, 60 min each)                        │
│       │  - 1-2 Coding rounds                                     │
│       │  - 1 System Design round                                 │
│       │  - 1 Behavioral/Culture round                            │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 2-4 weeks (faster than pre-2022)                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Post-acquisition Twitter/X moves faster and with fewer rounds than pre-2022. System design questions heavily favor Twitter's own architecture challenges - the "Fanout Problem" for high-follower accounts, timeline ranking, and real-time trending. Reading Twitter's engineering blog and their OSDI 2013 paper on Manhattan (their distributed key-value store) is excellent preparation.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| L4 | Software Engineer | 0-3 | $155K-$190K | $220K-$360K | Coding + basic systems |
| L5 | Senior Engineer | 3-7 | $195K-$245K | $360K-$520K | System design + real-time systems |
| L6 | Staff Engineer | 7-12 | $240K-$310K | $520K-$720K | Architecture + broad ownership |
| L7 | Principal Engineer | 12+ | $300K-$390K | $720K-$1M+ | Cross-platform technical strategy |

### Representative Interview Problems

#### Problem 1: Tweet ID Generation - Snowflake-Style (Easy)

*Generate globally unique, time-sortable tweet IDs - similar to Twitter's Snowflake algorithm.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// SnowflakeGenerator generates 64-bit IDs composed of:
// [timestamp 41 bits][datacenter 5 bits][worker 5 bits][sequence 12 bits]
type SnowflakeGenerator struct {
	mu          sync.Mutex
	datacenterID int64
	workerID    int64
	sequence    int64
	lastTime    int64
	epoch       int64 // custom epoch (Twitter: Nov 4 2010 01:42:54 UTC)
}

const (
	workerBits     = 5
	datacenterBits = 5
	sequenceBits   = 12
	maxSequence    = (1 << sequenceBits) - 1
	workerShift    = sequenceBits
	datacenterShift = sequenceBits + workerBits
	timestampShift = sequenceBits + workerBits + datacenterBits
)

func NewSnowflake(datacenterID, workerID int64) *SnowflakeGenerator {
	epoch := time.Date(2010, 11, 4, 1, 42, 54, 0, time.UTC).UnixMilli()
	return &SnowflakeGenerator{
		datacenterID: datacenterID,
		workerID:     workerID,
		epoch:        epoch,
	}
}

func (sg *SnowflakeGenerator) NextID() int64 {
	sg.mu.Lock()
	defer sg.mu.Unlock()

	now := time.Now().UnixMilli() - sg.epoch
	if now == sg.lastTime {
		sg.sequence = (sg.sequence + 1) & maxSequence
		if sg.sequence == 0 {
			// Sequence exhausted - wait for next millisecond
			for now <= sg.lastTime {
				now = time.Now().UnixMilli() - sg.epoch
			}
		}
	} else {
		sg.sequence = 0
	}
	sg.lastTime = now

	return now<<timestampShift |
		sg.datacenterID<<datacenterShift |
		sg.workerID<<workerShift |
		sg.sequence
}

func (sg *SnowflakeGenerator) DecodeID(id int64) (ts time.Time, dc, worker, seq int64) {
	seq = id & maxSequence
	worker = (id >> workerShift) & ((1 << workerBits) - 1)
	dc = (id >> datacenterShift) & ((1 << datacenterBits) - 1)
	msec := (id >> timestampShift) + sg.epoch
	ts = time.UnixMilli(msec)
	return ts, dc, worker, seq
}

func main() {
	gen := NewSnowflake(1, 1)

	ids := make([]int64, 5)
	for i := range ids {
		ids[i] = gen.NextID()
	}

	fmt.Println("Generated tweet IDs:")
	for _, id := range ids {
		ts, dc, worker, seq := gen.DecodeID(id)
		fmt.Printf("  ID=%-20d time=%s dc=%d worker=%d seq=%d\n",
			id, ts.Format("15:04:05.000"), dc, worker, seq)
	}

	// Verify time-sortability
	fmt.Printf("\nTime-sortable: %v\n", ids[0] < ids[len(ids)-1])
}
```

#### Problem 2: Timeline Fanout - Push Model (Easy)

*Implement timeline fanout: when a user tweets, push it to all followers' home timelines.*

```go
package main

import (
	"fmt"
	"sync"
)

type Tweet struct {
	ID       int64
	AuthorID string
	Text     string
}

type TimelineStore struct {
	mu        sync.RWMutex
	timelines map[string][]Tweet // userID → timeline (newest first)
	maxSize   int
}

func NewTimelineStore(maxSize int) *TimelineStore {
	return &TimelineStore{
		timelines: make(map[string][]Tweet),
		maxSize:   maxSize,
	}
}

func (ts *TimelineStore) PushTweet(userID string, tweet Tweet) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	tl := ts.timelines[userID]
	tl = append([]Tweet{tweet}, tl...) // prepend (newest first)
	if len(tl) > ts.maxSize {
		tl = tl[:ts.maxSize]
	}
	ts.timelines[userID] = tl
}

func (ts *TimelineStore) GetTimeline(userID string, limit int) []Tweet {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	tl := ts.timelines[userID]
	return tl[:min(limit, len(tl))]
}

type FanoutService struct {
	store     *TimelineStore
	followers map[string][]string // authorID → follower IDs
}

func NewFanoutService(store *TimelineStore) *FanoutService {
	return &FanoutService{
		store:     store,
		followers: make(map[string][]string),
	}
}

func (fs *FanoutService) AddFollower(authorID, followerID string) {
	fs.followers[authorID] = append(fs.followers[authorID], followerID)
}

// FanoutTweet distributes a tweet to all follower timelines concurrently.
func (fs *FanoutService) FanoutTweet(tweet Tweet) (written int) {
	followers := fs.followers[tweet.AuthorID]
	if len(followers) == 0 {
		return 0
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, followerID := range followers {
		wg.Add(1)
		go func(fid string) {
			defer wg.Done()
			fs.store.PushTweet(fid, tweet)
			mu.Lock()
			written++
			mu.Unlock()
		}(followerID)
	}
	wg.Wait()
	return written
}

func main() {
	store := NewTimelineStore(800) // Twitter keeps ~800 tweets per timeline in cache
	fanout := NewFanoutService(store)

	// @elonmusk has 3 followers (simplified)
	for _, follower := range []string{"alice", "bob", "carol"} {
		fanout.AddFollower("elonmusk", follower)
	}

	tweet := Tweet{ID: 1234567890, AuthorID: "elonmusk", Text: "The bird is freed."}
	written := fanout.FanoutTweet(tweet)
	fmt.Printf("Fanned out to %d timelines\n", written)

	// Check alice's timeline
	tl := store.GetTimeline("alice", 3)
	for _, t := range tl {
		fmt.Printf("Alice's timeline: [%d] @%s: %s\n", t.ID, t.AuthorID, t.Text)
	}
}
```

#### Problem 3: Trending Topics with Decay (Easy)

*Track trending hashtags using a sliding window counter with time-based decay.*

```go
package main

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

type TagCounter struct {
	mu      sync.Mutex
	counts  map[string][]time.Time
	window  time.Duration
}

func NewTagCounter(window time.Duration) *TagCounter {
	return &TagCounter{counts: make(map[string][]time.Time), window: window}
}

func (tc *TagCounter) Record(tag string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.counts[tag] = append(tc.counts[tag], time.Now())
}

func (tc *TagCounter) Count(tag string) int {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	cutoff := time.Now().Add(-tc.window)
	ts := tc.counts[tag]
	start := 0
	for start < len(ts) && ts[start].Before(cutoff) {
		start++
	}
	tc.counts[tag] = ts[start:]
	return len(tc.counts[tag])
}

type TrendingResult struct {
	Tag   string
	Count int
}

func (tc *TagCounter) Trending(topK int) []TrendingResult {
	tc.mu.Lock()
	tags := make([]string, 0, len(tc.counts))
	for tag := range tc.counts {
		tags = append(tags, tag)
	}
	tc.mu.Unlock()

	results := make([]TrendingResult, len(tags))
	for i, tag := range tags {
		results[i] = TrendingResult{tag, tc.Count(tag)}
	}
	slices.SortFunc(results, func(a, b TrendingResult) int {
		return b.Count - a.Count
	})
	return results[:min(topK, len(results))]
}

func main() {
	counter := NewTagCounter(time.Hour)

	// Simulate tweet stream with hashtags
	tweets := []string{
		"Just saw #AI take over #tech",
		"#AI is amazing! #go programming",
		"Love #go for backend systems #tech",
		"#AI #AI #AI trending hard today",
		"The #go community is great",
		"#tech conference highlights #AI",
	}

	for _, tweet := range tweets {
		for _, word := range strings.Fields(tweet) {
			if strings.HasPrefix(word, "#") {
				counter.Record(strings.ToLower(strings.Trim(word, "#,.")))
			}
		}
	}

	fmt.Println("Trending hashtags (last hour):")
	for i, t := range counter.Trending(5) {
		fmt.Printf("  #%d #%s - %d mentions\n", i+1, t.Tag, t.Count)
	}
}
```

#### Problem 4: Celebrity Fanout - Hybrid Push/Pull Model (Medium)

*Handle the "celebrity problem" where accounts with millions of followers need a hybrid fanout strategy.*

```go
package main

import (
	"fmt"
	"sync"
)

const celebrityThreshold = 1_000_000 // accounts with >1M followers get pull model

type Tweet struct {
	ID       int64
	AuthorID string
	Text     string
}

type UserInfo struct {
	ID            string
	FollowerCount int
}

type HybridFanoutService struct {
	mu            sync.RWMutex
	timelineStore map[string][]Tweet  // userID → cached timeline (push model)
	recentTweets  map[string][]Tweet  // authorID → recent tweets (pull model)
	followers     map[string][]string
	users         map[string]UserInfo
}

func NewHybridFanout() *HybridFanoutService {
	return &HybridFanoutService{
		timelineStore: make(map[string][]Tweet),
		recentTweets:  make(map[string][]Tweet),
		followers:     make(map[string][]string),
		users:         make(map[string]UserInfo),
	}
}

func (h *HybridFanoutService) RegisterUser(u UserInfo) {
	h.mu.Lock()
	h.users[u.ID] = u
	h.mu.Unlock()
}

func (h *HybridFanoutService) AddFollower(authorID, followerID string) {
	h.mu.Lock()
	h.followers[authorID] = append(h.followers[authorID], followerID)
	h.mu.Unlock()
}

func (h *HybridFanoutService) PostTweet(tweet Tweet) string {
	h.mu.Lock()
	author := h.users[tweet.AuthorID]
	followers := append([]string{}, h.followers[tweet.AuthorID]...)
	h.mu.Unlock()

	if author.FollowerCount >= celebrityThreshold {
		// Pull model: store tweet for on-demand retrieval, skip push fanout
		h.mu.Lock()
		recent := h.recentTweets[tweet.AuthorID]
		h.recentTweets[tweet.AuthorID] = append([]Tweet{tweet}, recent[:min(99, len(recent))]...)
		h.mu.Unlock()
		return fmt.Sprintf("celebrity push-skip: stored for pull (fanout would hit %d followers)", author.FollowerCount)
	}

	// Push model: fanout to all follower timelines
	var wg sync.WaitGroup
	for _, followerID := range followers {
		wg.Add(1)
		go func(fid string) {
			defer wg.Done()
			h.mu.Lock()
			tl := h.timelineStore[fid]
			h.timelineStore[fid] = append([]Tweet{tweet}, tl[:min(799, len(tl))]...)
			h.mu.Unlock()
		}(followerID)
	}
	wg.Wait()
	return fmt.Sprintf("push fanout completed to %d followers", len(followers))
}

func (h *HybridFanoutService) GetTimeline(userID string, followedAuthors []string, limit int) []Tweet {
	h.mu.RLock()
	pushed := append([]Tweet{}, h.timelineStore[userID]...)
	h.mu.RUnlock()

	// Merge in celebrity tweets (pull model)
	for _, authorID := range followedAuthors {
		h.mu.RLock()
		u := h.users[authorID]
		h.mu.RUnlock()
		if u.FollowerCount >= celebrityThreshold {
			h.mu.RLock()
			celeb := h.recentTweets[authorID]
			h.mu.RUnlock()
			pushed = append(pushed, celeb...)
		}
	}

	// Sort by ID desc (Snowflake IDs are time-sortable)
	for i := 1; i < len(pushed); i++ {
		for j := i; j > 0 && pushed[j].ID > pushed[j-1].ID; j-- {
			pushed[j], pushed[j-1] = pushed[j-1], pushed[j]
		}
	}
	return pushed[:min(limit, len(pushed))]
}

func main() {
	svc := NewHybridFanout()
	svc.RegisterUser(UserInfo{"regular_user", 500})
	svc.RegisterUser(UserInfo{"celebrity", 50_000_000}) // 50M followers
	svc.AddFollower("regular_user", "alice")
	svc.AddFollower("celebrity", "alice")

	result1 := svc.PostTweet(Tweet{ID: 100, AuthorID: "regular_user", Text: "Just a regular tweet"})
	fmt.Printf("Regular user tweet: %s\n", result1)

	result2 := svc.PostTweet(Tweet{ID: 200, AuthorID: "celebrity", Text: "Big announcement!"})
	fmt.Printf("Celebrity tweet: %s\n", result2)

	tl := svc.GetTimeline("alice", []string{"celebrity"}, 10)
	fmt.Printf("\nAlice's timeline (%d tweets):\n", len(tl))
	for _, t := range tl {
		fmt.Printf("  [%d] @%s: %s\n", t.ID, t.AuthorID, t.Text)
	}
}
```

#### Problem 5: Timeline Ranking - Engagement Score (Medium)

*Rank timeline tweets by predicted engagement rather than pure chronological order.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
	"time"
)

type Tweet struct {
	ID       int64
	AuthorID string
	Text     string
}

type TweetWithMeta struct {
	Tweet
	Likes     int
	Retweets  int
	Replies   int
	CreatedAt time.Time
	AuthorFollowers int
	IsFollowed bool // does viewer follow author?
}

func EngagementScore(t TweetWithMeta, viewerAt time.Time) float64 {
	// Recency decay (half-life 2 hours)
	ageHours := viewerAt.Sub(t.CreatedAt).Hours()
	recency := math.Exp(-0.693 * ageHours / 2)

	// Engagement signal
	engagement := float64(t.Likes) + float64(t.Retweets)*2 + float64(t.Replies)*1.5

	// Social graph boost: tweets from directly followed accounts
	socialBoost := 1.0
	if t.IsFollowed {
		socialBoost = 2.0
	}

	// Normalize by author popularity (avoid celebrity bias)
	popularity := math.Log1p(float64(t.AuthorFollowers)/1000) + 1
	normalized := engagement / popularity

	return recency * (1 + math.Log1p(normalized)) * socialBoost
}

func RankTimeline(tweets []TweetWithMeta) []TweetWithMeta {
	ranked := make([]TweetWithMeta, len(tweets))
	copy(ranked, tweets)
	now := time.Now()

	slices.SortFunc(ranked, func(a, b TweetWithMeta) int {
		sa, sb := EngagementScore(a, now), EngagementScore(b, now)
		if sa > sb {
			return -1
		} else if sa < sb {
			return 1
		}
		return 0
	})
	return ranked
}

func main() {
	now := time.Now()
	tweets := []TweetWithMeta{
		{Tweet: Tweet{ID: 1, Text: "Old viral tweet"}, Likes: 50000, Retweets: 10000, CreatedAt: now.Add(-24 * time.Hour), AuthorFollowers: 5_000_000, IsFollowed: false},
		{Tweet: Tweet{ID: 2, Text: "Recent friend tweet"}, Likes: 10, Retweets: 2, CreatedAt: now.Add(-30 * time.Minute), AuthorFollowers: 500, IsFollowed: true},
		{Tweet: Tweet{ID: 3, Text: "New viral post"}, Likes: 5000, Retweets: 1200, CreatedAt: now.Add(-1 * time.Hour), AuthorFollowers: 100_000, IsFollowed: false},
		{Tweet: Tweet{ID: 4, Text: "Breaking news"}, Likes: 200, Retweets: 80, Replies: 50, CreatedAt: now.Add(-15 * time.Minute), AuthorFollowers: 2_000_000, IsFollowed: true},
	}

	ranked := RankTimeline(tweets)
	fmt.Println("Timeline ranking (For You):")
	for i, t := range ranked {
		score := EngagementScore(t, time.Now())
		fmt.Printf("  #%d [ID=%d] score=%.3f: %s\n", i+1, t.ID, score, t.Text)
	}
}
```

#### Problem 6: Tweet Search with Full-Text Inverted Index (Medium)

*Build a simplified inverted index for full-text tweet search.*

```go
package main

import (
	"fmt"
	"slices"
	"strings"
)

type TweetDoc struct {
	ID   int64
	Text string
}

type InvertedIndex struct {
	index map[string][]int64 // term → sorted list of tweet IDs
	docs  map[int64]TweetDoc
}

func NewInvertedIndex() *InvertedIndex {
	return &InvertedIndex{
		index: make(map[string][]int64),
		docs:  make(map[int64]TweetDoc),
	}
}

func tokenize(text string) []string {
	words := strings.Fields(strings.ToLower(text))
	var tokens []string
	for _, w := range words {
		w = strings.Trim(w, ".,!?\"'")
		if len(w) > 1 {
			tokens = append(tokens, w)
		}
	}
	return tokens
}

func (idx *InvertedIndex) Add(tweet TweetDoc) {
	idx.docs[tweet.ID] = tweet
	for _, term := range tokenize(tweet.Text) {
		idx.index[term] = append(idx.index[term], tweet.ID)
	}
}

// Search returns tweet IDs matching ALL query terms (AND semantics).
func (idx *InvertedIndex) Search(query string, limit int) []TweetDoc {
	terms := tokenize(query)
	if len(terms) == 0 {
		return nil
	}

	// Start with smallest posting list
	var lists [][]int64
	for _, t := range terms {
		lists = append(lists, idx.index[t])
	}
	slices.SortFunc(lists, func(a, b []int64) int {
		return len(a) - len(b)
	})

	// Intersect posting lists
	result := make(map[int64]int)
	for _, id := range lists[0] {
		result[id] = 1
	}
	for _, list := range lists[1:] {
		for _, id := range list {
			result[id]++
		}
	}

	var matched []TweetDoc
	for id, count := range result {
		if count == len(lists) {
			matched = append(matched, idx.docs[id])
		}
	}
	slices.SortFunc(matched, func(a, b TweetDoc) int {
		if a.ID > b.ID {
			return -1
		}
		return 1
	})
	return matched[:min(limit, len(matched))]
}

func main() {
	idx := NewInvertedIndex()
	tweets := []TweetDoc{
		{1001, "Excited about the new go programming features in 1.22"},
		{1002, "Go is the best language for distributed systems programming"},
		{1003, "Python vs Go: which is better for backend systems?"},
		{1004, "Just shipped a new go microservice today!"},
		{1005, "The go garbage collector has improved so much"},
	}
	for _, t := range tweets {
		idx.Add(t)
	}

	results := idx.Search("go systems", 5)
	fmt.Printf("Search 'go systems' → %d results:\n", len(results))
	for _, r := range results {
		fmt.Printf("  [%d] %s\n", r.ID, r.Text)
	}
}
```

#### Problem 7: Real-Time Stream Processing - Tweet Velocity Monitor (Medium)

*Detect viral tweet breakouts by monitoring tweet velocity (rate of change of engagement).*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type TweetMetrics struct {
	TweetID   int64
	Likes     int
	Retweets  int
	Timestamp time.Time
}

type VelocityTracker struct {
	mu       sync.Mutex
	history  map[int64][]TweetMetrics
	window   time.Duration
}

func NewVelocityTracker(window time.Duration) *VelocityTracker {
	return &VelocityTracker{
		history: make(map[int64][]TweetMetrics),
		window:  window,
	}
}

func (vt *VelocityTracker) Record(m TweetMetrics) {
	vt.mu.Lock()
	defer vt.mu.Unlock()
	cutoff := m.Timestamp.Add(-vt.window)
	h := vt.history[m.TweetID]
	start := 0
	for start < len(h) && h[start].Timestamp.Before(cutoff) {
		start++
	}
	h = h[start:]
	vt.history[m.TweetID] = append(h, m)
}

type VelocityResult struct {
	TweetID       int64
	LikeVelocity  float64 // likes per minute
	RTVelocity    float64 // RTs per minute
	IsBreakout    bool
}

func (vt *VelocityTracker) Velocity(tweetID int64) VelocityResult {
	vt.mu.Lock()
	defer vt.mu.Unlock()

	h := vt.history[tweetID]
	if len(h) < 2 {
		return VelocityResult{TweetID: tweetID}
	}
	first, last := h[0], h[len(h)-1]
	duration := last.Timestamp.Sub(first.Timestamp).Minutes()
	if duration == 0 {
		return VelocityResult{TweetID: tweetID}
	}

	likeVel := float64(last.Likes-first.Likes) / duration
	rtVel := float64(last.Retweets-first.Retweets) / duration

	return VelocityResult{
		TweetID:      tweetID,
		LikeVelocity: likeVel,
		RTVelocity:   rtVel,
		IsBreakout:   likeVel > 1000 || rtVel > 200, // thresholds for viral detection
	}
}

func main() {
	tracker := NewVelocityTracker(10 * time.Minute)
	now := time.Now()

	// Simulate a tweet going viral
	tweetID := int64(98765)
	snapshots := []TweetMetrics{
		{tweetID, 100, 20, now.Add(-8 * time.Minute)},
		{tweetID, 2000, 400, now.Add(-5 * time.Minute)},
		{tweetID, 8500, 1800, now.Add(-2 * time.Minute)},
		{tweetID, 15000, 3200, now},
	}
	for _, s := range snapshots {
		tracker.Record(s)
	}

	v := tracker.Velocity(tweetID)
	fmt.Printf("Tweet %d velocity:\n", v.TweetID)
	fmt.Printf("  Likes/min: %.0f\n", v.LikeVelocity)
	fmt.Printf("  RTs/min:   %.0f\n", v.RTVelocity)
	fmt.Printf("  Breakout:  %v\n", v.IsBreakout)
}
```

#### Problem 8: Distributed Tweet Aggregation with HyperLogLog (Hard)

*Estimate unique viewer counts for tweets using HyperLogLog - Twitter's approach to counting unique impressions at scale.*

```go
package main

import (
	"fmt"
	"hash/fnv"
	"math"
	"math/bits"
)

// HyperLogLog approximates cardinality (unique count) using O(m) space.
type HyperLogLog struct {
	m         int     // number of registers (must be power of 2)
	registers []uint8 // max leading zeros seen per register
	b         int     // bits to identify register (log2(m))
}

func NewHyperLogLog(precision int) *HyperLogLog {
	m := 1 << precision
	return &HyperLogLog{m: m, registers: make([]uint8, m), b: precision}
}

func (h *HyperLogLog) hash(item string) uint64 {
	f := fnv.New64a()
	_, _ = f.Write([]byte(item))
	return f.Sum64()
}

func (h *HyperLogLog) Add(item string) {
	hv := h.hash(item)
	registerIdx := hv >> (64 - h.b)
	remainder := hv << h.b
	leadingZeros := uint8(bits.LeadingZeros64(remainder)) + 1
	if leadingZeros > h.registers[registerIdx] {
		h.registers[registerIdx] = leadingZeros
	}
}

func (h *HyperLogLog) Estimate() float64 {
	m := float64(h.m)
	alpha := 0.7213 / (1 + 1.079/m) // bias correction

	var sum float64
	for _, reg := range h.registers {
		sum += math.Pow(2, -float64(reg))
	}
	estimate := alpha * m * m / sum

	// Small range correction
	if estimate <= 2.5*m {
		zeros := 0
		for _, r := range h.registers {
			if r == 0 {
				zeros++
			}
		}
		if zeros > 0 {
			estimate = m * math.Log(m/float64(zeros))
		}
	}
	return estimate
}

func main() {
	hll := NewHyperLogLog(10) // 2^10 = 1024 registers, ~1.5% error

	// Simulate 10,000 unique user impressions for a viral tweet
	totalImpressed := 10_000
	for i := range totalImpressed {
		hll.Add(fmt.Sprintf("user_%d", i))
	}

	estimate := hll.Estimate()
	errorPct := math.Abs(estimate-float64(totalImpressed)) / float64(totalImpressed) * 100

	fmt.Printf("Actual unique viewers: %d\n", totalImpressed)
	fmt.Printf("HLL estimate:          %.0f\n", estimate)
	fmt.Printf("Error:                 %.2f%%\n", errorPct)
	fmt.Printf("Memory used:           %d bytes (vs %d bytes for exact set)\n",
		len(hll.registers), totalImpressed*8)
}
```

#### Problem 9: Rate-Limited Twitter API Gateway (Hard)

*Build an API gateway with per-endpoint rate limiting supporting Twitter's tiered access levels (Free, Basic, Pro, Enterprise).*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type Tier struct {
	Name       string
	ReadLimit  int // requests per 15 minutes per endpoint
	WriteLimit int
}

var tiers = map[string]Tier{
	"free":       {"Free", 15, 5},
	"basic":      {"Basic", 100, 50},
	"pro":        {"Pro", 1000, 300},
	"enterprise": {"Enterprise", 10000, 1000},
}

type APIKey struct {
	Key  string
	Tier string
}

type EndpointLimiter struct {
	mu       sync.Mutex
	windows  map[string][]time.Time // key:endpoint → timestamps
	duration time.Duration
}

func NewEndpointLimiter(duration time.Duration) *EndpointLimiter {
	return &EndpointLimiter{
		windows:  make(map[string][]time.Time),
		duration: duration,
	}
}

func (el *EndpointLimiter) Allow(apiKey, endpoint, method string, limit int) (bool, int) {
	key := apiKey + ":" + endpoint + ":" + method
	el.mu.Lock()
	defer el.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-el.duration)
	ts := el.windows[key]
	start := 0
	for start < len(ts) && ts[start].Before(cutoff) {
		start++
	}
	ts = ts[start:]

	if len(ts) >= limit {
		return false, 0
	}
	el.windows[key] = append(ts, now)
	return true, limit - len(ts) - 1
}

type APIGateway struct {
	limiter *EndpointLimiter
	keys    map[string]APIKey
}

func NewAPIGateway() *APIGateway {
	return &APIGateway{
		limiter: NewEndpointLimiter(15 * time.Minute),
		keys: map[string]APIKey{
			"free-key-123":  {"free-key-123", "free"},
			"basic-key-456": {"basic-key-456", "basic"},
			"pro-key-789":   {"pro-key-789", "pro"},
		},
	}
}

type APIResponse struct {
	Status    int
	Remaining int
	ResetIn   time.Duration
}

func (gw *APIGateway) HandleRequest(apiKeyStr, endpoint, method string) APIResponse {
	apiKey, ok := gw.keys[apiKeyStr]
	if !ok {
		return APIResponse{Status: 401}
	}
	tier := tiers[apiKey.Tier]

	limit := tier.ReadLimit
	if method == "POST" || method == "DELETE" {
		limit = tier.WriteLimit
	}

	allowed, remaining := gw.limiter.Allow(apiKeyStr, endpoint, method, limit)
	if !allowed {
		return APIResponse{Status: 429, Remaining: 0, ResetIn: 15 * time.Minute}
	}
	return APIResponse{Status: 200, Remaining: remaining}
}

func main() {
	gw := NewAPIGateway()

	// Simulate free tier user hitting the rate limit
	fmt.Println("Free tier user (limit=15 per 15min):")
	for i := range 18 {
		resp := gw.HandleRequest("free-key-123", "/2/tweets/search/recent", "GET")
		if i < 3 || i >= 14 {
			fmt.Printf("  Request %2d: status=%d remaining=%d\n", i+1, resp.Status, resp.Remaining)
		}
	}

	// Pro tier has higher limits
	fmt.Println("\nPro tier user (limit=1000 per 15min):")
	resp := gw.HandleRequest("pro-key-789", "/2/tweets/search/recent", "GET")
	fmt.Printf("  Request 1: status=%d remaining=%d\n", resp.Status, resp.Remaining)
}
```

#### Problem 10: Graph-Based Who-To-Follow Recommendation (Hard)

*Recommend users to follow using Personalized PageRank on the Twitter social graph.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
)

// PersonalizedPageRank computes PPR scores from a source node.
// Returns top K recommended nodes (not already followed by source).
func PersonalizedPageRank(
	graph map[string][]string, // node → list of outgoing edges
	source string,
	alreadyFollows map[string]bool,
	damping float64,
	iterations int,
	topK int,
) []struct{ User string; Score float64 } {
	nodes := make(map[string]bool)
	nodes[source] = true
	for node, neighbors := range graph {
		nodes[node] = true
		for _, nb := range neighbors {
			nodes[nb] = true
		}
	}

	// Initialize scores uniformly
	scores := make(map[string]float64)
	for node := range nodes {
		scores[node] = 0
	}
	scores[source] = 1.0

	// Power iteration
	for range iterations {
		newScores := make(map[string]float64)
		for node := range nodes {
			newScores[node] = (1 - damping) * func() float64 {
				if node == source { return 1.0 }
				return 0.0
			}()
		}
		for node, neighbors := range graph {
			if len(neighbors) == 0 {
				continue
			}
			share := damping * scores[node] / float64(len(neighbors))
			for _, nb := range neighbors {
				newScores[nb] += share
			}
		}
		// Normalize
		var total float64
		for _, s := range newScores {
			total += s
		}
		if total > 0 {
			for node := range newScores {
				newScores[node] /= total
			}
		}
		scores = newScores
	}

	type scored struct {
		user  string
		score float64
	}
	var candidates []scored
	for user, score := range scores {
		if user != source && !alreadyFollows[user] && score > 0 {
			candidates = append(candidates, scored{user, score})
		}
	}
	slices.SortFunc(candidates, func(a, b scored) int {
		if a.score > b.score { return -1 } else if a.score < b.score { return 1 }
		return 0
	})

	result := make([]struct{ User string; Score float64 }, 0, min(topK, len(candidates)))
	for _, c := range candidates[:min(topK, len(candidates))] {
		result = append(result, struct{ User string; Score float64 }{c.user, c.score})
	}
	return result
}

func main() {
	graph := map[string][]string{
		"alice": {"bob", "carol"},
		"bob":   {"alice", "dave", "eve"},
		"carol": {"alice", "frank"},
		"dave":  {"bob", "eve", "grace"},
		"eve":   {"bob", "dave"},
		"frank": {"carol", "grace"},
		"grace": {"dave", "frank"},
	}

	alreadyFollows := map[string]bool{"bob": true, "carol": true}
	recs := PersonalizedPageRank(graph, "alice", alreadyFollows, 0.85, 30, 5)

	fmt.Println("Who to follow recommendations for @alice:")
	for i, r := range recs {
		fmt.Printf("  #%d @%s (PPR score: %.4f)\n", i+1, r.User, r.Score)
	}
	_ = math.MaxFloat64
}
```

---

### System Design Topics

**Top 5 Twitter/X System Design Questions:**

1. **Design Twitter's Home Timeline** - Generate personalized timelines for 300M+ daily active users. Topics: push vs. pull fanout model, hybrid approach for celebrities (>1M followers), timeline aggregation service, ranking/scoring pipeline, cache invalidation, Redis-backed timeline storage.

2. **Design Trending Topics** - Compute trending hashtags in real time globally and per location. Topics: sliding window counters, Count-Min Sketch for memory efficiency, multi-level aggregation (city/country/global), trend decay, anti-abuse (bot amplification detection).

3. **Design Twitter's Search** - Real-time and historical tweet search at 500M tweets/day. Topics: real-time inverted index updates, early termination strategies, ranking (recency + engagement + personalization), distributed Lucene/Elasticsearch, caching popular queries.

4. **Design the Tweet Fanout System** - Deliver tweets to followers with millisecond latency. Topics: queue-based fanout (Kafka/Celery), rate limiting per follower, at-least-once delivery guarantees, backpressure for large accounts, batch vs. per-tweet fanout.

5. **Design Twitter's Rate Limiting** - Protect the API from abuse across billions of daily requests. Topics: tiered limits (free/basic/pro/enterprise), per-endpoint limits, distributed token bucket (Redis), graceful degradation, DDoS protection layering.

---

### Behavioral Focus

Twitter/X's culture (post-acquisition) emphasizes **extreme ownership, efficiency, and mission-critical reliability.** Behavioral themes:

- **Extreme ownership:** "Tell me about a time you owned a system far beyond your original scope - what was the breadth of your responsibility?"
- **Efficiency:** "Describe a time you reduced complexity or cost in a system - how did you identify the opportunity and execute?"
- **Reliability under pressure:** "Tell me about a major incident you handled. What was your role and what did you change afterward?"
- **Speed:** "Describe the fastest you've ever shipped a significant feature. What did you cut and why was that the right call?"
- **Independence:** "Tell me about a project you drove entirely independently from design to production."

---

### Insider Tips

**Common Mistakes:**
- Designing pure push fanout for all accounts - the celebrity problem is THE classic Twitter system design question.
- Not discussing Count-Min Sketch for trending topics at scale - naive counting won't scale.
- Treating Twitter search as a standard database query - it requires real-time inverted index updates.
- Underestimating the write amplification in push fanout (an account with 100M followers creates 100M writes per tweet).

**Strong Hire Signals:**
- Proactively discussing hybrid push/pull model for timeline fanout.
- Mentioning HyperLogLog or Count-Min Sketch for approximate counting at scale.
- Snowflake-style ID generation for time-sortable tweet IDs.
- Discussing timeline ranking signals (engagement prediction) without prompting.

**Red Flags:**
- Database-first approach to timeline storage (Twitter's timeline is in Redis/Memcached, not a relational DB).
- Ignoring write amplification in fanout design.
- Treating all accounts equally in fanout (celebrities need special handling).

---

### 8-Week Preparation Timeline

```
Week 1: Real-Time Systems Foundations
  Mon-Tue: Message queues (Kafka), pub/sub patterns, fan-out architecture
  Wed-Thu: Redis data structures (sorted sets, streams, pub/sub)
  Fri:     Consistent hashing, distributed caching
  Weekend: Build push fanout + timeline store in Go

Week 2: Probabilistic Data Structures
  Mon-Tue: Count-Min Sketch, Bloom filters, HyperLogLog
  Wed-Thu: Sliding window counters, time-series aggregation
  Fri:     Approximate vs. exact counting trade-offs
  Weekend: Implement HyperLogLog and trending topics system

Week 3: Algorithms - Graphs & Real-Time Processing
  Mon-Fri: 2 problems/day - graph BFS/DFS, priority queues, sliding window
  Weekend: Personalized PageRank implementation

Week 4: System Design - Twitter Systems
  Mon-Tue: Design Twitter home timeline (whiteboard)
  Wed-Thu: Design trending topics system
  Fri:     Design tweet search
  Weekend: Mock system design interview

Week 5: Distributed Systems at Twitter Scale
  Mon-Tue: Snowflake ID generation, time-sortable IDs
  Wed-Thu: Rate limiting tiers, distributed rate limiting
  Fri:     Write amplification, backpressure, flow control
  Weekend: Design the fanout system end-to-end

Week 6: Go for Real-Time Systems
  Mon-Tue: Channels for real-time stream processing
  Wed-Thu: Concurrent fanout with goroutine pools
  Fri:     Atomic operations for counters, lock-free reads
  Weekend: Build tweet velocity monitor + API gateway

Week 7: Behavioral Prep
  Mon-Tue: 5 STAR stories - ownership, efficiency, reliability, speed, independence
  Wed:     Research Twitter's engineering blog (pre-2022 technical posts)
  Thu:     Mock behavioral interview
  Fri:     Review current Twitter/X engineering challenges (post-acquisition context)
  Weekend: Full mock onsite

Week 8: Final Prep
  Mon-Tue: Weak areas review
  Wed:     Full mock onsite
  Thu:     Rest, logistics
  Fri:     Light review only
```

---


### Junior → FAANG: Twitter/X Interview Preparation Basics

Twitter/X's core engineering challenge is the social graph at scale: the tweet firehose, fan-out to followers, real-time trending, and timeline computation. System design interviews often involve tweet delivery, timeline generation, or search at scale. The engineering bar is similar to other tier-1 companies. Know Twitter's architectural history: the move from Ruby on Rails to a JVM-based microservices architecture, the timeline cache approach (Flockdb, Manhattan), and the eventual adoption of Kafka for the tweet firehose.

### Senior @ FAANG: Twitter/X Senior Engineer: Real-Time Platform Engineering

At the senior level, Twitter/X's most interesting engineering challenges involve real-time processing of billions of events per day. The tweet delivery problem is the canonical fan-out-on-write versus fan-out-on-read case study: fan-out on write precomputes timelines but struggles with celebrity accounts (10M+ followers), while fan-out on read gives consistent write latency but expensive read computation. Twitter's hybrid approach (precompute for most users, compute at read time for accounts following celebrities) is a textbook example of mixing strategies based on data characteristics. Staff candidates should also understand the real-time trending algorithm and its susceptibility to manipulation (coordinated inauthentic behavior), which requires a combination of velocity-based detection and graph-based anomaly detection.

---
