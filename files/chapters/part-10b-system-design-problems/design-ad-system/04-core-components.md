## Core Components

### 1. Auction Engine

The Auction Engine implements the OpenRTB protocol, running a sealed-bid second-price auction in under 100 milliseconds per impression. It fans out bid requests to all registered Demand-Side Platforms (DSPs) in parallel using goroutines with a strict timeout, then selects the winning bid based on price floor and auction type. Fraud detection runs before the winner is notified, and every auction outcome is logged asynchronously to avoid adding latency to the critical path.

```go
package auction

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

type AdSelector interface {
	SelectAds(ctx context.Context, req BidRequest) ([]Bid, error)
}

type DSPClient interface {
	GetBid(ctx context.Context, req BidRequest) (Bid, error)
}

type BudgetService interface {
	DeductBudget(ctx context.Context, adID string, clearPrice float64) error
}

type FraudDetector interface {
	IsBot(user *User, device *Device) bool
}

type ImpressionEvent struct {
	AuctionID string
	AdID      string
	DSP       string
	WinPrice  float64
	UserID    string
	Domain    string
	Timestamp time.Time
	LatencyMs int64
}

type EventLogger interface {
	LogImpression(ctx context.Context, event ImpressionEvent)
}

type App struct{}
type Device struct{}
type Banner struct{}
type Video struct{}

// AuctionEngine runs the RTB auction for each ad impression
type AuctionEngine struct {
	adSelector  AdSelector     // own demand selection
	dspClients  []DSPClient    // external DSP bidders
	budgetSvc   BudgetService
	fraudDetect FraudDetector
	eventLog    EventLogger
}

// BidRequest is the auction request (follows OpenRTB spec)
type BidRequest struct {
	ID          string        `json:"id"`
	Impressions []Impression  `json:"imp"`
	Site        *Site         `json:"site,omitempty"`
	App         *App          `json:"app,omitempty"`
	User        *User         `json:"user,omitempty"`
	Device      *Device       `json:"device,omitempty"`
	AT          int           `json:"at"`    // 1=first price, 2=second price
	Tmax        int           `json:"tmax"`  // max response time in ms
}

// Impression is the ad slot being auctioned
type Impression struct {
	ID     string  `json:"id"`
	Banner *Banner `json:"banner,omitempty"`
	Video  *Video  `json:"video,omitempty"`
	Bidfloor float64 `json:"bidfloor"` // minimum bid price (CPM)
}

// Site contains page-level targeting info
type Site struct {
	Domain   string   `json:"domain"`
	Page     string   `json:"page"`
	Keywords []string `json:"keywords"`
	Cat      []string `json:"cat"` // IAB content categories
}

// User contains user targeting info
type User struct {
	ID         string   `json:"id"`    // hashed user ID
	Age        int      `json:"age"`
	Gender     string   `json:"gender"`
	Interests  []string `json:"interests"`
	Geo        *Geo     `json:"geo"`
}

// Geo contains location info
type Geo struct {
	Country string  `json:"country"`
	Region  string  `json:"region"`
	City    string  `json:"city"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
}

// Bid is a response from a DSP
type Bid struct {
	DSP       string  `json:"dsp"`
	ImpID     string  `json:"impid"`
	Price     float64 `json:"price"`  // CPM bid in USD
	AdID      string  `json:"adid"`
	CrID      string  `json:"crid"`   // creative ID
	AdMarkup  string  `json:"adm"`    // ad HTML/VAST
}

// AuctionResult is the winner of an impression
type AuctionResult struct {
	WinnerBid    Bid
	ClearPrice   float64 // actual price charged (second-price auction)
	AuctionType  int     // 1=first-price, 2=second-price
}

// RunAuction executes the full RTB auction
func (e *AuctionEngine) RunAuction(ctx context.Context, req BidRequest) (*AuctionResult, error) {
	start := time.Now()
	if len(req.Impressions) == 0 {
		return nil, fmt.Errorf("bid request %s has no impressions", req.ID)
	}
	budget := time.Duration(req.Tmax) * time.Millisecond
	if budget == 0 {
		budget = 80 * time.Millisecond // default 80ms for bidding
	}

	auctionCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	// 1. Fraud/bot check (fast, < 5ms)
	if e.fraudDetect.IsBot(req.User, req.Device) {
		return nil, fmt.Errorf("bot detected, no auction")
	}

	// 2. Collect bids from all DSPs in parallel
	var (
		bids []Bid
		mu   sync.Mutex
		wg   sync.WaitGroup
	)

	// Solicit bids from external DSPs
	for _, dsp := range e.dspClients {
		wg.Add(1)
		go func(client DSPClient) {
			defer wg.Done()
			bid, err := client.GetBid(auctionCtx, req)
			if err != nil {
				return // DSP timed out or no bid
			}
			if bid.Price >= req.Impressions[0].Bidfloor {
				mu.Lock()
				bids = append(bids, bid)
				mu.Unlock()
			}
		}(dsp)
	}

	// 3. Also get own-demand candidates
	ownBids, err := e.adSelector.SelectAds(auctionCtx, req)
	if err == nil {
		mu.Lock()
		bids = append(bids, ownBids...)
		mu.Unlock()
	}

	wg.Wait()

	if len(bids) == 0 {
		return nil, fmt.Errorf("no bids received")
	}

	// 4. Run auction (second-price Vickrey auction)
	result := e.runSecondPriceAuction(bids, req.Impressions[0].Bidfloor)
	if result == nil {
		return nil, fmt.Errorf("no valid winner")
	}

	// 5. Deduct from winner's budget
	if err := e.budgetSvc.DeductBudget(ctx, result.WinnerBid.AdID, result.ClearPrice); err != nil {
		return nil, fmt.Errorf("budget deduction failed: %w", err)
	}

	// 6. Log impression event (async)
	// User and Site are optional in OpenRTB (app traffic has no Site),
	// so extract fields defensively before the goroutine captures them.
	var userID, domain string
	if req.User != nil {
		userID = req.User.ID
	}
	if req.Site != nil {
		domain = req.Site.Domain
	}
	go e.eventLog.LogImpression(context.Background(), ImpressionEvent{
		AuctionID:  req.ID,
		AdID:       result.WinnerBid.AdID,
		DSP:        result.WinnerBid.DSP,
		WinPrice:   result.ClearPrice,
		UserID:     userID,
		Domain:     domain,
		Timestamp:  time.Now(),
		LatencyMs:  time.Since(start).Milliseconds(),
	})

	return result, nil
}

// runSecondPriceAuction implements a Vickrey second-price auction.
// The highest bidder wins and is charged the second-highest bid + $0.01.
func (e *AuctionEngine) runSecondPriceAuction(bids []Bid, floorPrice float64) *AuctionResult {
	if len(bids) == 0 {
		return nil
	}

	// Sort by price descending
	sort.Slice(bids, func(i, j int) bool {
		return bids[i].Price > bids[j].Price
	})

	winner := bids[0]
	if winner.Price < floorPrice {
		return nil // floor not met
	}

	var clearPrice float64
	if len(bids) == 1 {
		clearPrice = floorPrice // only one bidder pays floor
	} else {
		clearPrice = bids[1].Price + 0.01 // second price + $0.01
	}

	return &AuctionResult{
		WinnerBid:   winner,
		ClearPrice:  clearPrice,
		AuctionType: 2,
	}
}
```

### 2. Budget Service

The Budget Service enforces real-time spend limits using Redis atomic operations to prevent advertisers from exceeding their daily or campaign budgets. Each ad impression deducts spend through a Lua script wrapping `HINCRBYFLOAT`, and the service gates auction participation by checking remaining budget before sending bid requests. A local in-memory cache with a short TTL reduces Redis round-trips for high-frequency checks, while a background sync job reconciles in-memory state with the authoritative Redis values.

```go
package budget

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// BudgetService manages advertiser spending with pacing
type BudgetService struct {
	rdb *redis.Client
}

// Campaign budget state
type CampaignBudget struct {
	CampaignID    string
	DailyBudget   float64
	SpentToday    float64
	PacingGoal    float64 // target spend rate (budget / 24h)
	LastUpdated   time.Time
}

// DeductBudget atomically deducts a spend amount from campaign budget
func (s *BudgetService) DeductBudget(ctx context.Context, campaignID string, amount float64) error {
	key := budgetKey(campaignID)
	script := redis.NewScript(`
		local remaining = tonumber(redis.call('HGET', KEYS[1], 'remaining'))
		if remaining == nil then
			return redis.error_reply('budget not found')
		end
		if remaining < tonumber(ARGV[1]) then
			return redis.error_reply('insufficient budget')
		end
		redis.call('HINCRBYFLOAT', KEYS[1], 'spent', tonumber(ARGV[1]))
		redis.call('HINCRBYFLOAT', KEYS[1], 'remaining', -tonumber(ARGV[1]))
		return 1
	`)

	result, err := script.Run(ctx, s.rdb, []string{key}, amount).Int()
	if err != nil {
		return fmt.Errorf("budget deduction failed: %w", err)
	}
	if result != 1 {
		return fmt.Errorf("insufficient budget")
	}
	return nil
}

// CanSpend checks if a campaign has remaining budget (without deducting)
func (s *BudgetService) CanSpend(ctx context.Context, campaignID string, amount float64) (bool, error) {
	remaining, err := s.rdb.HGet(ctx, budgetKey(campaignID), "remaining").Float64()
	if err != nil {
		return false, nil
	}
	return remaining >= amount, nil
}

// LoadBudget initializes daily budget for a campaign
func (s *BudgetService) LoadBudget(ctx context.Context, campaignID string, dailyBudget float64) error {
	key := budgetKey(campaignID)
	pipe := s.rdb.Pipeline()
	pipe.HSet(ctx, key,
		"daily_budget", dailyBudget,
		"remaining", dailyBudget,
		"spent", 0.0,
		"date", time.Now().Format("20060102"),
	)
	// Expire at midnight
	secondsToMidnight := secondsUntilMidnight()
	pipe.Expire(ctx, key, time.Duration(secondsToMidnight)*time.Second)
	_, err := pipe.Exec(ctx)
	return err
}

// GetPacedBidModifier returns a bid adjustment for budget pacing
// Returns values < 1.0 when ahead of pace, 1.0 when on pace
// Prevents blowing the daily budget in the first few hours
func (s *BudgetService) GetPacedBidModifier(ctx context.Context, campaignID string) float64 {
	data, err := s.rdb.HGetAll(ctx, budgetKey(campaignID)).Result()
	if err != nil {
		return 1.0
	}

	var dailyBudget, spent float64
	fmt.Sscanf(data["daily_budget"], "%f", &dailyBudget)
	fmt.Sscanf(data["spent"], "%f", &spent)

	if dailyBudget == 0 {
		return 1.0
	}

	// How much of the day has passed
	now := time.Now()
	dayProgress := float64(now.Hour()*3600+now.Minute()*60+now.Second()) / 86400.0

	// Target spend ratio
	targetSpent := dailyBudget * dayProgress
	actualSpent := spent

	if actualSpent > targetSpent*1.1 { // 10% over target = slow down
		return 0.5
	}
	if actualSpent < targetSpent*0.7 { // 30% behind target = speed up
		return 1.5
	}
	return 1.0
}

func budgetKey(campaignID string) string {
	return fmt.Sprintf("budget:%s:%s", campaignID, time.Now().Format("20060102"))
}

func secondsUntilMidnight() int {
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
	return int(midnight.Sub(now).Seconds())
}
```

### 3. Ad Targeting and Selection

Ad targeting matches the incoming impression's audience signals, demographics, interests, geographic location, and behavioral categories, against the targeting criteria stored for each active campaign. The `TargetingEngine` queries Redis for pre-indexed candidate ad sets using bitmap intersections on interest and geo segments, then applies fine-grained eligibility checks and a relevance score ranking. This two-phase approach (coarse retrieval from Redis, fine scoring in memory) keeps the targeting pipeline well within the 100ms auction deadline.

```go
package targeting

import (
	"context"
	"sort"

	"github.com/redis/go-redis/v9"
)

type BudgetService struct{}

func (b *BudgetService) CanSpend(ctx context.Context, campaignID string, amount float64) (bool, error) {
	return true, nil
}

func (b *BudgetService) GetPacedBidModifier(ctx context.Context, campaignID string) float64 {
	return 1.0
}

type BidRequest struct {
	Impressions []Impression
	User        *User
	Device      *Device
	Site        *Site
}

type Impression struct {
	ID string
}

type User struct {
	ID        string
	Interests []string
	Geo       *Geo
}

type Geo struct {
	Country string
	City    string
}

type Device struct {
	Type string
}

type Site struct {
	Cat []string
}

type Bid struct {
	DSP   string
	ImpID string
	Price float64
	AdID  string
	CrID  string
}

// AdSelector picks relevant ads from own inventory
type AdSelector struct {
	rdb      *redis.Client
	budgetSvc *BudgetService
}

// AdCandidate is a potential ad for an impression
type AdCandidate struct {
	CampaignID  string
	CreativeID  string
	BidPrice    float64 // CPM
	Score       float64 // relevance × bid × pacing
}

// SelectAds finds relevant ads for an impression
func (s *AdSelector) SelectAds(ctx context.Context, req BidRequest) ([]Bid, error) {
	// 1. Find matching campaigns
	candidates, err := s.findMatchingCampaigns(ctx, req)
	if err != nil || len(candidates) == 0 {
		return nil, err
	}

	// 2. Score candidates
	scored := s.scoreCandidates(ctx, candidates, req)

	// 3. Filter by budget
	var valid []AdCandidate
	for _, c := range scored {
		ok, _ := s.budgetSvc.CanSpend(ctx, c.CampaignID, c.BidPrice/1000) // CPM → per impression
		if ok {
			valid = append(valid, c)
		}
	}

	// 4. Convert top-N to bids
	bids := make([]Bid, 0, min(len(valid), 5))
	for _, c := range valid[:min(len(valid), 5)] {
		bids = append(bids, Bid{
			DSP:   "own",
			ImpID: req.Impressions[0].ID,
			Price: c.BidPrice,
			AdID:  c.CampaignID,
			CrID:  c.CreativeID,
		})
	}
	return bids, nil
}

// findMatchingCampaigns retrieves campaigns targeting this impression
func (s *AdSelector) findMatchingCampaigns(ctx context.Context, req BidRequest) ([]AdCandidate, error) {
	// In production: campaign index stored in Redis or in-memory index
	// Targeting dimensions: geo, age, gender, interests, device, hour-of-day, keywords

	var keys []string

	// Geo targeting
	if req.User != nil && req.User.Geo != nil {
		keys = append(keys,
			"campaigns:geo:"+req.User.Geo.Country,
			"campaigns:geo:"+req.User.Geo.City,
		)
	}

	// Interest targeting
	if req.User != nil {
		for _, interest := range req.User.Interests {
			keys = append(keys, "campaigns:interest:"+interest)
		}
	}

	// Site/app targeting
	if req.Site != nil {
		for _, cat := range req.Site.Cat {
			keys = append(keys, "campaigns:category:"+cat)
		}
	}

	if len(keys) == 0 {
		keys = []string{"campaigns:all"}
	}

	// Union of matching campaign IDs
	campaignIDs, err := s.rdb.SUnion(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}

	candidates := make([]AdCandidate, 0, len(campaignIDs))
	for _, id := range campaignIDs {
		// Get campaign bid price
		price, _ := s.rdb.HGet(ctx, "campaign:"+id, "cpm_bid").Float64()
		creativeID, _ := s.rdb.HGet(ctx, "campaign:"+id, "creative_id").Result()
		candidates = append(candidates, AdCandidate{
			CampaignID: id,
			CreativeID: creativeID,
			BidPrice:   price,
		})
	}
	return candidates, nil
}

// scoreCandidates ranks ads by expected value
func (s *AdSelector) scoreCandidates(ctx context.Context, candidates []AdCandidate, req BidRequest) []AdCandidate {
	for i, c := range candidates {
		// Expected value = CPM × predicted CTR × pacing modifier
		predictedCTR := s.predictCTR(ctx, c.CampaignID, req)
		pacingMod := s.budgetSvc.GetPacedBidModifier(ctx, c.CampaignID)
		candidates[i].Score = c.BidPrice * predictedCTR * pacingMod
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})
	return candidates
}

// predictCTR estimates click-through rate for an ad/user combination
func (s *AdSelector) predictCTR(ctx context.Context, campaignID string, req BidRequest) float64 {
	// In production: ML model (logistic regression / gradient boosting)
	// Features: ad creative, user interests, device, time of day, publisher domain
	// Simplified: return historical CTR
	ctr, _ := s.rdb.HGet(ctx, "campaign:stats:"+campaignID, "ctr").Float64()
	if ctr == 0 {
		return 0.001 // default 0.1% CTR
	}
	return ctr
}
```

### 4. Click and Conversion Tracking

Click and conversion tracking closes the attribution loop between ad impressions and measurable user actions. The tracking server must handle high write throughput, tens of thousands of click events per second at our estimated scale, while remaining resilient to duplicate submissions from network retries. This implementation stores each impression under a short-lived Redis key that acts as a one-time click token to prevent double-counting, and publishes click events to Kafka for downstream attribution pipelines. Conversion recording follows the same pattern, matching back to the originating impression through the click ID.

```go
package tracking

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/redis/go-redis/v9"
)

type FraudDetector interface {
	IsClickFraud(ctx context.Context, signals FraudSignals) bool
}

// TrackingService handles impression/click/conversion events
type TrackingService struct {
	kafka     *kgo.Client
	rdb       *redis.Client
	fraud     FraudDetector
}

// ImpressionEvent is logged when an ad is shown
type ImpressionEvent struct {
	AuctionID  string    `json:"auction_id"`
	AdID       string    `json:"ad_id"`
	DSP        string    `json:"dsp"`
	WinPrice   float64   `json:"win_price"`
	UserID     string    `json:"user_id"`
	Domain     string    `json:"domain"`
	Timestamp  time.Time `json:"timestamp"`
	LatencyMs  int64     `json:"latency_ms"`
}

// ClickEvent is logged when a user clicks an ad
type ClickEvent struct {
	ImpressionID string    `json:"impression_id"`
	AdID         string    `json:"ad_id"`
	UserID       string    `json:"user_id"`
	Domain       string    `json:"domain"`
	DestURL      string    `json:"dest_url"`
	Timestamp    time.Time `json:"timestamp"`
	IP           string    `json:"ip"`
	UserAgent    string    `json:"user_agent"`
	IsFraud      bool      `json:"is_fraud"`
}

// HandleClick processes an ad click (called when user clicks the ad)
func (s *TrackingService) HandleClick(w http.ResponseWriter, r *http.Request) {
	impressionID := r.URL.Query().Get("imp")
	adID := r.URL.Query().Get("ad")
	userID := r.Header.Get("X-User-ID")
	destURL := r.URL.Query().Get("dest")

	// Validate impression (prevent click injection)
	if !s.validateImpression(r.Context(), impressionID, adID) {
		http.Redirect(w, r, destURL, http.StatusFound)
		return
	}

	// Check for click fraud
	isFraud := s.fraud.IsClickFraud(r.Context(), FraudSignals{
		UserID:    userID,
		IP:        r.RemoteAddr,
		UserAgent: r.UserAgent(),
		AdID:      adID,
	})

	event := ClickEvent{
		ImpressionID: impressionID,
		AdID:         adID,
		UserID:       userID,
		Domain:       r.Referer(),
		DestURL:      destURL,
		Timestamp:    time.Now(),
		IP:           r.RemoteAddr,
		UserAgent:    r.UserAgent(),
		IsFraud:      isFraud,
	}

	// Log to Kafka (async, don't block redirect)
	go s.logClickEvent(context.Background(), event)

	// Redirect user to advertiser's page
	http.Redirect(w, r, destURL, http.StatusFound)
}

// validateImpression ensures click corresponds to a real impression
func (s *TrackingService) validateImpression(ctx context.Context, impressionID, adID string) bool {
	key := fmt.Sprintf("imp:%s", impressionID)
	storedAdID, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		return false // impression not found or expired
	}
	// One-time validation: delete after first click to prevent double-clicks
	s.rdb.Del(ctx, key)
	return storedAdID == adID
}

// LogImpression records an impression event
func (s *TrackingService) LogImpression(ctx context.Context, event ImpressionEvent) {
	// Store impression for click validation (TTL = max time between impression and click)
	impKey := fmt.Sprintf("imp:%s", event.AuctionID)
	s.rdb.Set(ctx, impKey, event.AdID, 2*time.Hour)

	// Log to Kafka
	data, _ := json.Marshal(event)
	s.kafka.ProduceSync(ctx, &kgo.Record{
		Topic: "ad-impressions",
		Key:   []byte(event.AdID),
		Value: data,
	})
}

func (s *TrackingService) logClickEvent(ctx context.Context, event ClickEvent) {
	data, _ := json.Marshal(event)
	s.kafka.ProduceSync(ctx, &kgo.Record{
		Topic: "ad-clicks",
		Key:   []byte(event.AdID),
		Value: data,
	})
}

type FraudSignals struct {
	UserID    string
	IP        string
	UserAgent string
	AdID      string
}
```

---
