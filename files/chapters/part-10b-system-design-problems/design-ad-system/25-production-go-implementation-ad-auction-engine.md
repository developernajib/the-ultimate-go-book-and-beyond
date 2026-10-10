## Production Go Implementation: Ad Auction Engine

This section presents a production-ready implementation of the auction engine that incorporates all the concepts discussed above into a single cohesive codebase. Unlike the earlier simplified examples, this version uses integer microdollars instead of floating-point for money (avoiding rounding errors at scale), sync.Pool for object reuse, atomic counters for metrics, and pipelined Redis operations for efficiency. The code follows a clear step-by-step flow: fraud pre-check, targeting lookup, frequency cap filter, budget pre-check, parallel DSP bid collection, second-price auction, and atomic budget deduction. Each step has a strict latency budget documented in the comments.

```go
package auction

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// ============================================================
// Domain Types
// ============================================================

type BidRequest struct {
	AuctionID     string
	UserID        string
	ClientIP      string
	DeviceType    string
	GeoCountry    string
	GeoCity       string
	Publisher     string
	AdSlot        string
	SlotSize      string
	PageURL       string
	Categories    []string
	Keywords      []string
	FloorPrice    int64 // microdollars (1 USD = 1_000_000)
	Timestamp     time.Time
	UserAgentHash uint64
}

type BidResponse struct {
	DSPID      string
	CampaignID string
	CreativeID string
	BidAmount  int64 // microdollars
	AdMarkup   string
	ClickURL   string
	Latency    time.Duration
}

type AuctionResult struct {
	AuctionID    string
	Winner       *BidResponse
	WinPrice     int64 // second-price or shaded first-price
	AllBids      []BidResponse
	TotalLatency time.Duration
	DroppedDSPs  []string
	Reason       string
}

type Campaign struct {
	ID              string
	AdvertiserID    string
	DailyBudget     int64 // microdollars
	TotalBudget     int64
	BidStrategy     string // "cpm", "cpc", "cpa"
	MaxBid          int64
	TargetCountries []string
	TargetDevices   []string
	Categories      []string
	FrequencyCap    int
	FrequencyWindow time.Duration
	StartTime       time.Time
	EndTime         time.Time
	IsActive        bool
}

// ============================================================
// Auction Engine
// ============================================================

type AuctionEngine struct {
	dspClients    map[string]DSPClient
	redis         *redis.ClusterClient
	budgetSvc     *BudgetService
	fraudDetector *FraudDetector
	freqCapper    *FrequencyCapper
	targetingIdx  *TargetingIndex
	metrics       *AuctionMetrics
	bidTimeout    time.Duration
	bidPool       sync.Pool
}

type DSPClient interface {
	Bid(ctx context.Context, req *BidRequest) (*BidResponse, error)
	Name() string
	IsHealthy() bool
}

type AuctionMetrics struct {
	totalAuctions atomic.Int64
	totalBids     atomic.Int64
	noBidAuctions atomic.Int64
	timeoutBids   atomic.Int64
	lastLatencyUs atomic.Int64
	revenueMicros atomic.Int64
}

func NewAuctionEngine(
	dspClients map[string]DSPClient,
	rdb *redis.ClusterClient,
	bidTimeout time.Duration,
) *AuctionEngine {
	return &AuctionEngine{
		dspClients:    dspClients,
		redis:         rdb,
		budgetSvc:     NewBudgetService(rdb),
		fraudDetector: NewFraudDetector(rdb),
		freqCapper:    NewFrequencyCapper(rdb),
		targetingIdx:  NewTargetingIndex(rdb),
		metrics:       &AuctionMetrics{},
		bidTimeout:    bidTimeout,
		bidPool: sync.Pool{
			New: func() any {
				return make([]BidResponse, 0, 16)
			},
		},
	}
}

// RunAuction executes a full second-price auction with parallel DSP calls.
// Latency budget: ~100ms total (2ms parse + 3ms targeting + 2ms freq + 2ms budget
// + 70ms DSP calls + 1ms auction + 3ms deduct + 2ms fraud + 5ms network + 10ms buffer).
func (e *AuctionEngine) RunAuction(ctx context.Context, req *BidRequest) (*AuctionResult, error) {
	start := time.Now()
	e.metrics.totalAuctions.Add(1)

	// Step 1: Quick fraud pre-check (2ms budget)
	if suspicious, err := e.fraudDetector.QuickCheck(ctx, req); err != nil || suspicious {
		return &AuctionResult{AuctionID: req.AuctionID, Reason: "fraud_precheck_blocked"}, err
	}

	// Step 2: Find eligible campaigns via targeting index (3ms budget)
	eligible, err := e.targetingIdx.FindEligible(ctx, req)
	if err != nil || len(eligible) == 0 {
		return &AuctionResult{AuctionID: req.AuctionID, Reason: "no_eligible_campaigns"}, err
	}

	// Step 3: Frequency cap filter (2ms budget)
	eligible, err = e.freqCapper.Filter(ctx, req.UserID, eligible)
	if err != nil {
		return nil, fmt.Errorf("frequency cap filter: %w", err)
	}

	// Step 4: Budget pre-check filter (2ms budget)
	eligible, err = e.budgetSvc.FilterByBudget(ctx, eligible)
	if err != nil {
		return nil, fmt.Errorf("budget filter: %w", err)
	}

	if len(eligible) == 0 {
		e.metrics.noBidAuctions.Add(1)
		return &AuctionResult{AuctionID: req.AuctionID, Reason: "all_filtered"}, nil
	}

	// Step 5: Parallel DSP bid requests (70ms budget, 80ms timeout)
	bids := e.collectBids(ctx, req, eligible)
	if len(bids) == 0 {
		e.metrics.noBidAuctions.Add(1)
		return &AuctionResult{AuctionID: req.AuctionID, Reason: "no_bids"}, nil
	}

	// Step 6: Run second-price auction
	result := e.secondPriceAuction(req, bids)
	result.TotalLatency = time.Since(start)

	// Step 7: Atomic budget deduction for winner
	if result.Winner != nil {
		if err := e.budgetSvc.DeductBudget(ctx, result.Winner.CampaignID, result.WinPrice); err != nil {
			return &AuctionResult{AuctionID: req.AuctionID, Reason: "budget_deduction_failed"}, err
		}
		e.metrics.revenueMicros.Add(result.WinPrice)
	}

	e.metrics.lastLatencyUs.Store(result.TotalLatency.Microseconds())
	return result, nil
}

// collectBids fans out bid requests to all healthy DSPs in parallel
// and collects responses within the bid timeout window.
func (e *AuctionEngine) collectBids(ctx context.Context, req *BidRequest, eligible []Campaign) []BidResponse {
	bidCtx, cancel := context.WithTimeout(ctx, e.bidTimeout)
	defer cancel()

	var mu sync.Mutex
	bidsSlice := e.bidPool.Get().([]BidResponse)
	bidsSlice = bidsSlice[:0]

	var wg sync.WaitGroup
	var dropped []string

	for dspID, client := range e.dspClients {
		if !client.IsHealthy() {
			dropped = append(dropped, dspID)
			continue
		}
		wg.Add(1)
		go func(id string, c DSPClient) {
			defer wg.Done()
			resp, err := c.Bid(bidCtx, req)
			if err != nil {
				e.metrics.timeoutBids.Add(1)
				return
			}
			if resp != nil && resp.BidAmount >= req.FloorPrice {
				mu.Lock()
				bidsSlice = append(bidsSlice, *resp)
				mu.Unlock()
				e.metrics.totalBids.Add(1)
			}
		}(dspID, client)
	}
	wg.Wait()

	result := make([]BidResponse, len(bidsSlice))
	copy(result, bidsSlice)
	e.bidPool.Put(bidsSlice)
	return result
}

// secondPriceAuction selects the highest bidder but charges the second-highest price.
// This incentivizes truthful bidding (Vickrey auction property).
func (e *AuctionEngine) secondPriceAuction(req *BidRequest, bids []BidResponse) *AuctionResult {
	sort.Slice(bids, func(i, j int) bool {
		return bids[i].BidAmount > bids[j].BidAmount
	})

	winner := bids[0]
	var winPrice int64
	if len(bids) > 1 {
		// Second price = second-highest bid + 1 microdollar
		winPrice = bids[1].BidAmount + 1
	} else {
		// Only one bid: win price = floor price
		winPrice = req.FloorPrice
	}

	return &AuctionResult{
		AuctionID: req.AuctionID,
		Winner:    &winner,
		WinPrice:  winPrice,
		AllBids:   bids,
		Reason:    "auction_complete",
	}
}

// ============================================================
// Budget Service (Redis Lua atomic operations)
// ============================================================

type BudgetService struct {
	redis *redis.ClusterClient
}

func NewBudgetService(rdb *redis.ClusterClient) *BudgetService {
	return &BudgetService{redis: rdb}
}

// deductBudgetScript atomically checks and deducts budget in a single Redis roundtrip.
// Returns 1 if successful, 0 if insufficient budget.
var deductBudgetScript = redis.NewScript(`
	local key = KEYS[1]
	local amount = tonumber(ARGV[1])
	local current = tonumber(redis.call("GET", key) or "0")
	if current >= amount then
		redis.call("DECRBY", key, amount)
		return 1
	end
	return 0
`)

func (b *BudgetService) DeductBudget(ctx context.Context, campaignID string, amount int64) error {
	key := fmt.Sprintf("budget:daily:%s", campaignID)
	result, err := deductBudgetScript.Run(ctx, b.redis, []string{key}, amount).Int()
	if err != nil {
		return fmt.Errorf("budget deduction script: %w", err)
	}
	if result == 0 {
		return fmt.Errorf("insufficient budget for campaign %s", campaignID)
	}
	return nil
}

// FilterByBudget uses pipelined Redis GETs to check remaining budgets for all
// candidate campaigns in a single network roundtrip.
func (b *BudgetService) FilterByBudget(ctx context.Context, campaigns []Campaign) ([]Campaign, error) {
	pipe := b.redis.Pipeline()
	cmds := make([]*redis.StringCmd, len(campaigns))
	for i, c := range campaigns {
		cmds[i] = pipe.Get(ctx, fmt.Sprintf("budget:daily:%s", c.ID))
	}
	_, _ = pipe.Exec(ctx)

	var eligible []Campaign
	for i, cmd := range cmds {
		val, err := cmd.Int64()
		if err == nil && val > campaigns[i].MaxBid {
			eligible = append(eligible, campaigns[i])
		}
	}
	return eligible, nil
}

// ============================================================
// Fraud Detector (quick in-path + async deep analysis)
// ============================================================

type FraudDetector struct {
	redis *redis.ClusterClient
}

func NewFraudDetector(rdb *redis.ClusterClient) *FraudDetector {
	return &FraudDetector{redis: rdb}
}

// fraudCheckScript tracks request velocity per IP and user-agent hash.
// If either exceeds threshold in a 60-second window, flag as suspicious.
var fraudCheckScript = redis.NewScript(`
	local ip_key = KEYS[1]
	local ua_key = KEYS[2]
	local ip_count = tonumber(redis.call("INCR", ip_key))
	if ip_count == 1 then redis.call("EXPIRE", ip_key, 60) end
	local ua_count = tonumber(redis.call("INCR", ua_key))
	if ua_count == 1 then redis.call("EXPIRE", ua_key, 60) end
	if ip_count > 100 or ua_count > 50 then return 1 end
	return 0
`)

func (f *FraudDetector) QuickCheck(ctx context.Context, req *BidRequest) (bool, error) {
	// Hash tag {fraud:<ip>} keeps both keys in the same cluster slot
	// so the multi-key Lua script is valid on Redis Cluster.
	ipKey := fmt.Sprintf("{fraud:%s}:ip", req.ClientIP)
	uaKey := fmt.Sprintf("{fraud:%s}:ua:%d", req.ClientIP, req.UserAgentHash)
	result, err := fraudCheckScript.Run(ctx, f.redis, []string{ipKey, uaKey}).Int()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

// ============================================================
// Frequency Capper
// ============================================================

type FrequencyCapper struct {
	redis *redis.ClusterClient
}

func NewFrequencyCapper(rdb *redis.ClusterClient) *FrequencyCapper {
	return &FrequencyCapper{redis: rdb}
}

// Filter removes campaigns where the user has already seen the ad
// more than FrequencyCap times within the configured window.
func (fc *FrequencyCapper) Filter(ctx context.Context, userID string, campaigns []Campaign) ([]Campaign, error) {
	pipe := fc.redis.Pipeline()
	cmds := make([]*redis.StringCmd, len(campaigns))
	for i, c := range campaigns {
		key := fmt.Sprintf("freq:%s:%s", userID, c.ID)
		cmds[i] = pipe.Get(ctx, key)
	}
	_, _ = pipe.Exec(ctx)

	var eligible []Campaign
	for i, cmd := range cmds {
		count, _ := cmd.Int64()
		if int(count) < campaigns[i].FrequencyCap {
			eligible = append(eligible, campaigns[i])
		}
	}
	return eligible, nil
}

// IncrementFrequency records an impression for frequency tracking.
// Called after an ad is served, not during the auction.
func (fc *FrequencyCapper) IncrementFrequency(ctx context.Context, userID, campaignID string, window time.Duration) error {
	key := fmt.Sprintf("freq:%s:%s", userID, campaignID)
	pipe := fc.redis.Pipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, window)
	_, err := pipe.Exec(ctx)
	return err
}

// ============================================================
// Targeting Index (pre-computed in Redis, refreshed every 5 min)
// ============================================================

type TargetingIndex struct {
	redis *redis.ClusterClient
}

func NewTargetingIndex(rdb *redis.ClusterClient) *TargetingIndex {
	return &TargetingIndex{redis: rdb}
}

// FindEligible uses Redis sorted set intersection to find campaigns
// matching the request's country, device type, and publisher in a
// single Redis operation (O(N*K) where K = number of intersected sets).
// The {targeting} hash tag pins all index keys to one cluster slot,
// which Redis Cluster requires for multi-key commands like ZINTERSTORE.
// The trade-off is that the whole index lives on one shard, so very
// large deployments replicate the index per shard instead.
func (t *TargetingIndex) FindEligible(ctx context.Context, req *BidRequest) ([]Campaign, error) {
	keys := []string{
		fmt.Sprintf("{targeting}:country:%s", req.GeoCountry),
		fmt.Sprintf("{targeting}:device:%s", req.DeviceType),
		fmt.Sprintf("{targeting}:publisher:%s", req.Publisher),
	}

	destKey := fmt.Sprintf("{targeting}:result:%s", req.AuctionID)
	store := &redis.ZStore{Keys: keys, Aggregate: "MIN"}
	count, err := t.redis.ZInterStore(ctx, destKey, store).Result()
	if err != nil {
		return nil, err
	}
	t.redis.Expire(ctx, destKey, 10*time.Second)

	if count == 0 {
		return nil, nil
	}

	ids, err := t.redis.ZRange(ctx, destKey, 0, -1).Result()
	if err != nil {
		return nil, err
	}

	campaigns := make([]Campaign, 0, len(ids))
	for _, id := range ids {
		campaigns = append(campaigns, Campaign{ID: id, IsActive: true})
	}
	return campaigns, nil
}
```

---
